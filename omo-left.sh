#!/usr/bin/env bash
set -euo pipefail

find_real_tmux() {
  if [[ -n "${REAL_TMUX_BIN:-}" && -x "${REAL_TMUX_BIN}" ]]; then
    printf '%s' "${REAL_TMUX_BIN}"
    return
  fi
  if [[ -x "/usr/bin/tmux" ]]; then
    printf '%s' "/usr/bin/tmux"
    return
  fi
  if [[ -x "/bin/tmux" ]]; then
    printf '%s' "/bin/tmux"
    return
  fi
  return 1
}

extract_target_pane() {
  local prev=''
  local arg=''
  for arg in "$@"; do
    if [[ "$prev" == '-t' ]]; then
      printf '%s' "$arg"
      return
    fi
    prev="$arg"
  done
  printf ''
}

is_subagent_split() {
  local raw="$*"
  [[ "$raw" == *"opencode attach"* && "$raw" == *"--session"* ]]
}

# --- Phase 1: tmux wrapper mode ------------------------------------------------
if [[ "${1:-}" == '___OMO_WRAPPER___' ]]; then
  shift

  real_tmux="$(find_real_tmux || true)"
  if [[ -z "$real_tmux" ]]; then
    echo '[omo-left] Cannot find real tmux binary.' >&2
    exit 127
  fi

  cmd="${1:-}"

  # 1) Force subagent split to LEFT.
  if [[ "$cmd" == 'split-window' ]] && is_subagent_split "$@"; then
    local_has_h=0
    filtered_args=()
    for arg in "$@"; do
      case "$arg" in
        split-window) continue ;;
        -h) local_has_h=1; continue ;;
        -b) continue ;;
      esac
      filtered_args+=("$arg")
    done

    if [[ $local_has_h -eq 1 ]]; then
      exec "$real_tmux" split-window -b -h "${filtered_args[@]}"
    fi
  fi

  # 2) Override plugin layout with custom layout only on select-layout.
  if [[ "$cmd" == 'select-layout' ]]; then
    requested_layout="${@: -1}"
    if [[ "$requested_layout" == 'main-vertical' || "$requested_layout" == 'main-horizontal' ]]; then
      target_pane="$(extract_target_pane "$@")"
      OMO_TARGET_PANE="$target_pane" REAL_TMUX_BIN="$real_tmux" python3 - <<'PY'
import os
import sys
import time
import subprocess

TMUX = os.environ.get('REAL_TMUX_BIN', '/usr/bin/tmux')
TARGET = os.environ.get('OMO_TARGET_PANE', '')


def run(args):
    proc = subprocess.run([TMUX, *args], capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def run_ok(args):
    code, out, _ = run(args)
    return code == 0, out


def list_panes():
    ok, out = run_ok([
        'list-panes',
        '-F',
        '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_active}',
    ])
    if not ok or not out:
        return []

    panes = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) != 6:
            continue
        pane_id, left, top, width, height, active = parts
        try:
            panes.append(
                {
                    'id': pane_id,
                    'left': int(left),
                    'top': int(top),
                    'width': int(width),
                    'height': int(height),
                    'active': active == '1',
                }
            )
        except ValueError:
            continue
    return panes


def pick_main(panes):
    ids = {p['id'] for p in panes}
    if TARGET and TARGET in ids:
        return TARGET

    active = [p['id'] for p in panes if p['active']]
    if active:
        return active[0]

    # Fallback: choose right-most pane as main.
    panes_sorted = sorted(panes, key=lambda p: (p['left'], p['top']))
    return panes_sorted[-1]['id']


def get_window_width():
    ok, out = run_ok(['display-message', '-p', '#{window_width}'])
    if not ok:
        return 0
    try:
        return int(out)
    except ValueError:
        return 0


time.sleep(0.08)
panes = list_panes()
if len(panes) <= 1:
    sys.exit(0)

main_pane = pick_main(panes)
sub_panes = [p['id'] for p in panes if p['id'] != main_pane]
if not sub_panes:
    sys.exit(0)

window_w = get_window_width()
if window_w <= 0:
    sys.exit(0)

# Column model: 3 subagents per column, each column aims for 1/3 width.
col_w = max(window_w // 3, 20)
cols = (len(sub_panes) + 2) // 3
left_w = cols * col_w
if left_w >= window_w:
    left_w = window_w - 20
main_w = max(window_w - left_w, 20)

# Create pool window and move all sub-panes out of current window.
ok, tmp_window = run_ok(['new-window', '-d', '-P', '-F', '#{window_id}'])
if not ok or not tmp_window:
    sys.exit(0)

ok, placeholder = run_ok(['list-panes', '-t', tmp_window, '-F', '#{pane_id}'])
placeholder_id = ''
if ok and placeholder:
    placeholder_id = placeholder.splitlines()[0]

for pane_id in sub_panes:
    run(['join-pane', '-d', '-s', pane_id, '-t', placeholder_id or f'{tmp_window}.0'])

# Remove placeholder pane so pool contains only moved subagent panes.
if placeholder_id:
    run(['kill-pane', '-t', placeholder_id])

# Split groups: first 3 should stay nearest to main; extras continue to the LEFT.
groups = [sub_panes[i:i + 3] for i in range(0, len(sub_panes), 3)]

# Create columns from far-left to near-main (reverse creation order).
for group in reversed(groups):
    if not group:
        continue

    ok, seed = run_ok(
        [
            'join-pane',
            '-d',
            '-h',
            '-b',
            '-l',
            str(col_w),
            '-s',
            f'{tmp_window}.0',
            '-t',
            main_pane,
            '-P',
            '-F',
            '#{pane_id}',
        ]
    )
    if not ok or not seed:
        continue

    # Fill this column top->down with remaining panes in the same group.
    for _ in group[1:]:
        panes_now = list_panes()
        seed_meta = next((p for p in panes_now if p['id'] == seed), None)
        target = seed
        if seed_meta:
            same_col = [
                p for p in panes_now
                if p['id'] != main_pane and p['left'] == seed_meta['left']
            ]
            if same_col:
                # Split the tallest pane to keep distribution stable.
                target = max(same_col, key=lambda p: p['height'])['id']

        run(['join-pane', '-d', '-v', '-s', f'{tmp_window}.0', '-t', target])

# Resize main pane to remaining width.
run(['resize-pane', '-x', str(main_w), '-t', main_pane])

# Best-effort cleanup.
run(['kill-window', '-t', tmp_window])
PY
      exit 0
    fi
  fi

  exec "$real_tmux" "$@"
fi

# --- Phase 2: launcher mode -----------------------------------------------------
if [[ "${1:-}" == '___OMO_LAUNCHER___' ]]; then
  shift || true

  # Load shell profile for user-defined omos (may no-op in non-interactive bashrc).
  source ~/.bashrc >/dev/null 2>&1 || true

  if declare -F omos >/dev/null 2>&1; then
    exec omos "$@"
  fi

  if command -v shuf >/dev/null 2>&1; then
    port="$(shuf -i 49152-65535 -n 1)"
  else
    port="$(awk 'BEGIN { srand(); print int(49152 + rand() * (65535 - 49152 + 1)) }')"
  fi

  exec env OPENCODE_PORT="$port" opencode --port "$port" "$@"
fi

# --- Phase 3: normal entry ------------------------------------------------------
WORKDIR="${1:-$PWD}"
SESSION="${2:-omo}"

REAL_TMUX_BIN="$(find_real_tmux || true)"
if [[ -z "$REAL_TMUX_BIN" ]]; then
  echo '[omo-left] tmux not found at /usr/bin/tmux or /bin/tmux' >&2
  exit 127
fi
export REAL_TMUX_BIN

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
TMP_BIN_DIR="$(mktemp -d)"

# Wrapper command injected into PATH (for opencode child process to resolve tmux).
cat <<WRAP_EOF > "$TMP_BIN_DIR/tmux"
#!/usr/bin/env bash
exec "$SCRIPT_PATH" ___OMO_WRAPPER___ "\$@"
WRAP_EOF
chmod +x "$TMP_BIN_DIR/tmux"

# Launcher shim so tmux always starts opencode with wrapper PATH.
cat <<LAUNCH_EOF > "$TMP_BIN_DIR/omo-left-launcher"
#!/usr/bin/env bash
export PATH="$TMP_BIN_DIR:$PATH"
export REAL_TMUX_BIN="$REAL_TMUX_BIN"
exec "$SCRIPT_PATH" ___OMO_LAUNCHER___
LAUNCH_EOF
chmod +x "$TMP_BIN_DIR/omo-left-launcher"

LAUNCH_CMD="$TMP_BIN_DIR/omo-left-launcher"

# Also inject env into running tmux server (critical when server already exists).
"$REAL_TMUX_BIN" set-environment -g PATH "$TMP_BIN_DIR:$PATH" >/dev/null 2>&1 || true
"$REAL_TMUX_BIN" set-environment -g REAL_TMUX_BIN "$REAL_TMUX_BIN" >/dev/null 2>&1 || true

if [[ -n "${TMUX:-}" ]] && "$REAL_TMUX_BIN" display-message -p '#{session_name}' >/dev/null 2>&1; then
  "$REAL_TMUX_BIN" new-window -c "$WORKDIR" "$LAUNCH_CMD"
else
  if "$REAL_TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
    "$REAL_TMUX_BIN" new-window -t "$SESSION" -c "$WORKDIR" "$LAUNCH_CMD"
    exec "$REAL_TMUX_BIN" attach-session -t "$SESSION"
  else
    exec "$REAL_TMUX_BIN" new-session -s "$SESSION" -c "$WORKDIR" "$LAUNCH_CMD"
  fi
fi
