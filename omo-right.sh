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

resolve_right_pane_cap() {
  local raw="${OMO_RIGHT_MAX_PANES:-5}"
  local cap=5

  if [[ "$raw" =~ ^[0-9]+$ ]] && (( raw >= 1 )); then
    cap=$raw
  fi

  if (( cap > 8 )); then
    cap=8
  fi

  printf '%s' "$cap"
}

can_spawn_subagent_pane() {
  local max_right
  max_right="$(resolve_right_pane_cap)"

  local target_pane=''
  target_pane="$(extract_target_pane "$@")"
  if [[ -z "$target_pane" ]]; then
    return 0
  fi

  local window_id=''
  window_id="$("$real_tmux" display-message -p -t "$target_pane" '#{window_id}' 2>/dev/null || true)"
  if [[ -z "$window_id" ]]; then
    return 0
  fi

  local pane_count=0
  while IFS= read -r _pane_id; do
    [[ -n "$_pane_id" ]] || continue
    ((pane_count += 1))
  done < <("$real_tmux" list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null || true)

  local right_count=0
  if (( pane_count > 0 )); then
    right_count=$((pane_count - 1))
  fi

  (( right_count < max_right ))
}

queued_subagent_split() {
  local target_pane=''
  target_pane="$(extract_target_pane "$@")"

  if [[ -z "$target_pane" ]]; then
    "$real_tmux" "$@"
    return $?
  fi

  local window_id=''
  window_id="$("$real_tmux" display-message -p -t "$target_pane" '#{window_id}' 2>/dev/null || true)"
  if [[ -z "$window_id" ]]; then
    "$real_tmux" "$@"
    return $?
  fi

  local max_right
  max_right="$(resolve_right_pane_cap)"

  # 默认 0：无限等待队列空位。
  local wait_timeout_raw="${OMO_QUEUE_WAIT_TIMEOUT_SEC:-0}"
  local wait_timeout=0
  if [[ "$wait_timeout_raw" =~ ^[0-9]+$ ]] && (( wait_timeout_raw >= 0 )); then
    wait_timeout=$wait_timeout_raw
  fi

  local poll_raw="${OMO_QUEUE_POLL_INTERVAL_SEC:-0.2}"
  local poll_interval='0.2'
  if [[ "$poll_raw" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    poll_interval="$poll_raw"
  fi

  local lock_name="omo-right-pane-queue-${window_id//@/_}"
  "$real_tmux" wait-for -L "$lock_name" >/dev/null 2>&1 || true

  local rc=0
  local split_done='0'
  local start_ts now_ts elapsed pane_count right_count
  start_ts=$(date +%s)

  while [[ "$split_done" != '1' ]]; do
    pane_count=0
    while IFS= read -r _pane_id; do
      [[ -n "$_pane_id" ]] || continue
      ((pane_count += 1))
    done < <("$real_tmux" list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null || true)

    right_count=0
    if (( pane_count > 0 )); then
      right_count=$((pane_count - 1))
    fi

    if (( right_count < max_right )); then
      if "$real_tmux" "$@"; then
        rc=0
      else
        rc=$?
      fi
      split_done='1'
      break
    fi

    if (( wait_timeout > 0 )); then
      now_ts=$(date +%s)
      elapsed=$((now_ts - start_ts))
      if (( elapsed >= wait_timeout )); then
        echo "[omo-right] pane queue timeout (${wait_timeout}s): right cap=${max_right}. Set OMO_QUEUE_WAIT_TIMEOUT_SEC=0 for unlimited queue wait." >&2
        rc=1
        split_done='1'
        break
      fi
    fi

    sleep "$poll_interval"
  done

  "$real_tmux" wait-for -U "$lock_name" >/dev/null 2>&1 || true
  return "$rc"
}

count_subagent_panes_in_window() {
  local window_id="$1"
  local pane_count=0

  while IFS= read -r _pane_id; do
    [[ -n "$_pane_id" ]] || continue
    ((pane_count += 1))
  done < <("$real_tmux" list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null || true)

  if (( pane_count <= 1 )); then
    printf '0'
  else
    printf '%s' "$((pane_count - 1))"
  fi
}

pick_leftmost_pane_in_window() {
  local window_id="$1"
  local best_id=''
  local best_left=''
  local best_top=''
  local pane_id=''
  local pane_left=''
  local pane_top=''

  while IFS=' ' read -r pane_id pane_left pane_top; do
    [[ -n "$pane_id" ]] || continue
    [[ "$pane_left" =~ ^[0-9]+$ ]] || continue
    [[ "$pane_top" =~ ^[0-9]+$ ]] || continue

    if [[ -z "$best_id" ]]; then
      best_id="$pane_id"
      best_left="$pane_left"
      best_top="$pane_top"
      continue
    fi

    if (( pane_left < best_left )) || { (( pane_left == best_left )) && (( pane_top < best_top )); }; then
      best_id="$pane_id"
      best_left="$pane_left"
      best_top="$pane_top"
    fi
  done < <("$real_tmux" list-panes -t "$window_id" -F '#{pane_id} #{pane_left} #{pane_top}' 2>/dev/null || true)

  printf '%s' "$best_id"
}

active_pane_in_window() {
  local window_id="$1"
  local pane_id=''
  local pane_active=''

  while IFS=' ' read -r pane_id pane_active; do
    [[ -n "$pane_id" ]] || continue
    if [[ "$pane_active" == '1' ]]; then
      printf '%s' "$pane_id"
      return
    fi
  done < <("$real_tmux" list-panes -t "$window_id" -F '#{pane_id} #{pane_active}' 2>/dev/null || true)

  printf ''
}

pane_current_command() {
  local pane_id="$1"
  local command=''
  [[ -n "$pane_id" ]] || return 1

  command="$($real_tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)"
  [[ -n "$command" ]] || return 1

  printf '%s' "$command"
}

# 用于触发 OpenCode 状态栏切换的按键序列（可配置）。
send_statusbar_toggle_keys() {
  local window_id="$1"
  local target_pane="$2"
  local key_spec="${OMO_STATUSBAR_TOGGLE_KEYS:-C-x B}"
  local leftmost_pane=''
  local active_pane=''
  local pane_id=''
  local pane_cmd=''
  local first_candidate=''
  local chosen_pane=''
  local sent=' '
  local -a keys=()
  local -a candidates=()

  read -r -a keys <<< "$key_spec"
  if (( ${#keys[@]} == 0 )); then
    keys=('C-x' 'B')
  fi

  if [[ -n "$window_id" ]]; then
    leftmost_pane="$(pick_leftmost_pane_in_window "$window_id")"
    active_pane="$(active_pane_in_window "$window_id")"
  fi

  # 优先目标 pane，再回退 active/leftmost。
  [[ -n "$target_pane" ]] && candidates+=("$target_pane")
  [[ -n "$active_pane" ]] && candidates+=("$active_pane")
  [[ -n "$leftmost_pane" ]] && candidates+=("$leftmost_pane")

  for pane_id in "${candidates[@]}"; do
    [[ -n "$pane_id" ]] || continue
    if [[ "$sent" == *" $pane_id "* ]]; then
      continue
    fi
    sent+="$pane_id "

    if [[ -z "$first_candidate" ]]; then
      first_candidate="$pane_id"
    fi

    pane_cmd="$(pane_current_command "$pane_id" || true)"
    if [[ "$pane_cmd" == 'opencode' ]]; then
      chosen_pane="$pane_id"
      break
    fi
  done

  if [[ -z "$chosen_pane" ]]; then
    chosen_pane="$first_candidate"
  fi
  [[ -n "$chosen_pane" ]] || return 1

  if (( ${#keys[@]} > 1 )); then
    "$real_tmux" send-keys -t "$chosen_pane" "${keys[0]}" >/dev/null 2>&1 || return 1
    sleep 0.03
    "$real_tmux" send-keys -t "$chosen_pane" "${keys[@]:1}" >/dev/null 2>&1 || return 1
  else
    "$real_tmux" send-keys -t "$chosen_pane" "${keys[@]}" >/dev/null 2>&1 || return 1
  fi

  return 0
}

# 有 subagent pane 时隐藏状态栏；全部结束后恢复。
sync_opencode_statusbar() {
  local target_pane="$1"
  local window_id=''
  local lock_name=''
  local hidden=''
  local sub_count=0

  if [[ -z "$target_pane" ]]; then
    target_pane="$("$real_tmux" display-message -p '#{pane_id}' 2>/dev/null || true)"
  fi
  [[ -n "$target_pane" ]] || return 0

  window_id="$("$real_tmux" display-message -p -t "$target_pane" '#{window_id}' 2>/dev/null || true)"
  if [[ -z "$window_id" ]]; then
    window_id="$("$real_tmux" display-message -p '#{window_id}' 2>/dev/null || true)"
  fi
  [[ -n "$window_id" ]] || return 0

  lock_name="omo-right-statusbar-lock-${window_id//@/_}"
  "$real_tmux" wait-for -L "$lock_name" >/dev/null 2>&1 || true

  hidden="$("$real_tmux" show-options -w -v -t "$window_id" @omo_right_statusbar_hidden 2>/dev/null || true)"
  sub_count="$(count_subagent_panes_in_window "$window_id")"

  if (( sub_count > 0 )) && [[ "$hidden" != '1' ]]; then
    if send_statusbar_toggle_keys "$window_id" "$target_pane"; then
      "$real_tmux" set-option -w -t "$window_id" @omo_right_statusbar_hidden 1 >/dev/null 2>&1 || true
    fi
  elif (( sub_count == 0 )) && [[ "$hidden" == '1' ]]; then
    if send_statusbar_toggle_keys "$window_id" "$target_pane"; then
      "$real_tmux" set-option -wu -t "$window_id" @omo_right_statusbar_hidden >/dev/null 2>&1 || true
    fi
  fi

  "$real_tmux" wait-for -U "$lock_name" >/dev/null 2>&1 || true
}

# --- Phase 1: tmux wrapper mode ------------------------------------------------
if [[ "${1:-}" == '___OMO_WRAPPER___' ]]; then
  shift

  real_tmux="$(find_real_tmux || true)"
  if [[ -z "$real_tmux" ]]; then
    echo '[omo-right] Cannot find real tmux binary.' >&2
    exit 127
  fi

  cmd="${1:-}"

  # Right-side wrapper: keep the upstream command unchanged.
  # subagent split already arrives with -h, so do not inject -b.
  if [[ "$cmd" == 'split-window' ]] && is_subagent_split "$@"; then
    split_target_pane="$(extract_target_pane "$@")"
    if queued_subagent_split "$@"; then
      sync_opencode_statusbar "$split_target_pane"
      exit 0
    else
      split_rc=$?
      exit "$split_rc"
    fi
  fi

  if [[ "$cmd" == 'kill-pane' ]]; then
    kill_target_pane="$(extract_target_pane "$@")"
    kill_window_id=''
    fallback_pane=''

    if [[ -n "$kill_target_pane" ]]; then
      kill_window_id="$("$real_tmux" display-message -p -t "$kill_target_pane" '#{window_id}' 2>/dev/null || true)"
    fi

    if "$real_tmux" "$@"; then
      rc=0
    else
      rc=$?
    fi

    if (( rc != 0 )); then
      exit "$rc"
    fi

    if [[ -n "$kill_window_id" ]]; then
      while IFS= read -r _pane_id; do
        [[ -n "$_pane_id" ]] || continue
        fallback_pane="$_pane_id"
        break
      done < <("$real_tmux" list-panes -t "$kill_window_id" -F '#{pane_id}' 2>/dev/null || true)
    fi

    if [[ -n "$fallback_pane" ]]; then
      sync_opencode_statusbar "$fallback_pane"
    fi

    exit "$rc"
  fi

  # Override plugin layout with custom right-column layout only on select-layout.
  if [[ "$cmd" == 'select-layout' ]]; then
    requested_layout="${@: -1}"
    if [[ "$requested_layout" == 'main-vertical' || "$requested_layout" == 'main-horizontal' ]]; then
      target_pane="$(extract_target_pane "$@")"
      sync_opencode_statusbar "$target_pane"

      if OMO_TARGET_PANE="$target_pane" OMO_RIGHT_MAX_PANES="$(resolve_right_pane_cap)" REAL_TMUX_BIN="$real_tmux" python3 - <<'PY'
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


def list_panes(window_id=''):
    args = ['list-panes']
    if window_id:
        args.extend(['-t', window_id])
    args.extend([
        '-F',
        '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_active}',
    ])

    ok, out = run_ok(args)
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

    # Fallback: choose left-most pane as main.
    panes_sorted = sorted(panes, key=lambda p: (p['left'], p['top']))
    return panes_sorted[0]['id']


def get_window_width(window_id=''):
    args = ['display-message', '-p']
    if window_id:
        args.extend(['-t', window_id])
    args.append('#{window_width}')

    ok, out = run_ok(args)
    if not ok:
        return 0
    try:
        return int(out)
    except ValueError:
        return 0


def get_window_id_for_pane(pane_id):
    if not pane_id:
        return ''
    ok, out = run_ok(['display-message', '-p', '-t', pane_id, '#{window_id}'])
    if not ok:
        return ''
    return out.strip()


def first_pane_in_window(window_id):
    ok, out = run_ok(['list-panes', '-t', window_id, '-F', '#{pane_id}'])
    if not ok or not out:
        return ''
    lines = [line.strip() for line in out.splitlines() if line.strip()]
    return lines[0] if lines else ''


def pane_ids_in_window(window_id):
    ok, out = run_ok(['list-panes', '-t', window_id, '-F', '#{pane_id}'])
    if not ok or not out:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


def move_pane_best_effort(src_pane, target_pane):
    if not src_pane or not target_pane:
        return False

    ok, _ = run_ok(['join-pane', '-d', '-h', '-s', src_pane, '-t', target_pane])
    if ok:
        return True

    ok, _ = run_ok(['join-pane', '-d', '-v', '-s', src_pane, '-t', target_pane])
    if ok:
        return True

    ok, _ = run_ok(['join-pane', '-d', '-s', src_pane, '-t', target_pane])
    return ok


def close_tmp_window_safely(tmp_window, main_pane, original_sub_panes):
    if not tmp_window:
        return True

    # Try to move any real subagent pane IDs back before deleting tmp window.
    if main_pane and original_sub_panes:
        for _ in range(len(original_sub_panes) + 2):
            tmp_ids = set(pane_ids_in_window(tmp_window))
            trapped = [pane_id for pane_id in original_sub_panes if pane_id in tmp_ids]
            if not trapped:
                break

            moved_any = False
            for pane_id in trapped:
                if move_pane_best_effort(pane_id, main_pane):
                    moved_any = True
            if not moved_any:
                break

    remaining_ids = set(pane_ids_in_window(tmp_window))
    trapped = [pane_id for pane_id in original_sub_panes if pane_id in remaining_ids]
    if trapped:
        return False

    run(['kill-window', '-t', tmp_window])
    return True


time.sleep(0.08)
target_window_id = get_window_id_for_pane(TARGET) if TARGET else ''
panes = list_panes(target_window_id)
if len(panes) <= 1:
    sys.exit(0)

main_pane = pick_main(panes)
if not main_pane:
    sys.exit(0)

if not target_window_id:
    target_window_id = get_window_id_for_pane(main_pane)

sub_panes = [p['id'] for p in panes if p['id'] != main_pane]
if not sub_panes:
    sys.exit(0)

window_w = get_window_width(target_window_id)
if window_w <= 0:
    sys.exit(0)


def newest_pane_id(before_ids, window_id=''):
    args = ['list-panes']
    if window_id:
        args.extend(['-t', window_id])
    args.extend(['-F', '#{pane_id}'])
    ok, out = run_ok(args)
    if not ok:
        return ''

    after_ids = {line.strip() for line in out.splitlines() if line.strip()}
    created = [pid for pid in after_ids if pid not in before_ids]
    return created[0] if created else ''


def created_pane_ids(before_ids, window_id=''):
    args = ['list-panes']
    if window_id:
        args.extend(['-t', window_id])
    args.extend(['-F', '#{pane_id}'])
    ok, out = run_ok(args)
    if not ok:
        return []
    after_ids = [line.strip() for line in out.splitlines() if line.strip()]
    return [pid for pid in after_ids if pid not in before_ids]

# Create pool window and move all sub-panes out of current window.
ok, tmp_window = run_ok(['new-window', '-d', '-P', '-F', '#{window_id}'])
if not ok or not tmp_window:
    sys.exit(0)

ok, placeholder = run_ok(['list-panes', '-t', tmp_window, '-F', '#{pane_id}'])
placeholder_id = ''
if ok and placeholder:
    placeholder_id = placeholder.splitlines()[0]

# Move all sub panes to temporary window first.
for pane_id in sub_panes:
    pool_target = first_pane_in_window(tmp_window)
    if not pool_target:
        break
    if not move_pane_best_effort(pane_id, pool_target):
        continue

# Remove initial placeholder pane so tmp window keeps only moved sub panes.
if placeholder_id:
    run(['kill-pane', '-t', placeholder_id])

pool_panes = pane_ids_in_window(tmp_window)
if not pool_panes:
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

# Right column keeps at most one vertical stack area.
right_w = max(window_w // 3, 20)
max_right_w = max(window_w - 20, 0)
if right_w > max_right_w:
    right_w = max_right_w
if right_w < 20:
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

main_w = max(window_w - right_w, 20)

before_ids = {p['id'] for p in list_panes(target_window_id)}
ok, target_window_id = run_ok(['display-message', '-p', '-t', main_pane, '#{window_id}'])
if not ok or not target_window_id:
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

ok, _ = run_ok(
    [
        'split-window',
        '-d',
        '-h',
        '-l',
        str(right_w),
        '-t',
        main_pane,
    ]
)
if not ok:
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

right_column_root = newest_pane_id(before_ids, target_window_id)
if not right_column_root:
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

first_src = pool_panes[0]
first_swap_ok, _ = run_ok(['swap-pane', '-d', '-s', first_src, '-t', right_column_root])
if not first_swap_ok:
    run(['kill-pane', '-t', right_column_root])
    close_tmp_window_safely(tmp_window, main_pane, sub_panes)
    sys.exit(0)

# Keep a single right column and split the tallest pane to avoid tiny bottom pane.
panes_now = list_panes(target_window_id)
first_meta = next((p for p in panes_now if p['id'] == first_src), None)
column_left = first_meta['left'] if first_meta else None

for src in pool_panes[1:]:
    panes_now = list_panes(target_window_id)
    candidates = [p for p in panes_now if p['id'] != main_pane]
    if column_left is not None:
        same_column = [p for p in candidates if p['left'] == column_left]
        if same_column:
            candidates = same_column
    if not candidates:
        break

    split_target = max(candidates, key=lambda p: p['height'])['id']

    before_ids = set(pane_ids_in_window(target_window_id))
    ok, _ = run_ok(['split-window', '-d', '-v', '-t', split_target])
    if not ok:
        break

    new_slot = newest_pane_id(before_ids, target_window_id)
    if not new_slot:
        for leaked in created_pane_ids(before_ids, target_window_id):
            run(['kill-pane', '-t', leaked])
        break

    swap_ok, _ = run_ok(['swap-pane', '-d', '-s', src, '-t', new_slot])
    if not swap_ok:
        run(['kill-pane', '-t', new_slot])
        break

# Ensure no real subagent pane remains trapped in tmp window.
tmp_remaining_ids = set(pane_ids_in_window(tmp_window))
for pane_id in sub_panes:
    if pane_id in tmp_remaining_ids:
        move_pane_best_effort(pane_id, main_pane)

# Final sweep: keep only main + original subagent pane IDs.
valid_sub_ids = set(sub_panes)
for pane in list_panes(target_window_id):
    pane_id = pane['id']
    if pane_id == main_pane:
        continue
    if pane_id not in valid_sub_ids:
        run(['kill-pane', '-t', pane_id])

# Resize main pane to remaining width.
run(['resize-pane', '-x', str(main_w), '-t', main_pane])

# Best-effort cleanup.
close_tmp_window_safely(tmp_window, main_pane, sub_panes)
PY
      then
        sync_opencode_statusbar "$target_pane"
        exit 0
      else
        py_exit=$?
        sync_opencode_statusbar "$target_pane"
        exit "$py_exit"
      fi
    fi
  fi

  exec "$real_tmux" "$@"
fi

# --- Phase 2: launcher mode -----------------------------------------------------
if [[ "${1:-}" == '___OMO_LAUNCHER___' ]]; then
  shift || true

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
  echo '[omo-right] tmux not found at /usr/bin/tmux or /bin/tmux' >&2
  exit 127
fi
export REAL_TMUX_BIN

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
TMP_BIN_DIR="$(mktemp -d)"

cat <<WRAP_EOF > "$TMP_BIN_DIR/tmux"
#!/usr/bin/env bash
exec "$SCRIPT_PATH" ___OMO_WRAPPER___ "\$@"
WRAP_EOF
chmod +x "$TMP_BIN_DIR/tmux"

cat <<LAUNCH_EOF > "$TMP_BIN_DIR/omo-right-launcher"
#!/usr/bin/env bash
export PATH="$TMP_BIN_DIR:$PATH"
export REAL_TMUX_BIN="$REAL_TMUX_BIN"
exec "$SCRIPT_PATH" ___OMO_LAUNCHER___
LAUNCH_EOF
chmod +x "$TMP_BIN_DIR/omo-right-launcher"

LAUNCH_CMD="$TMP_BIN_DIR/omo-right-launcher"

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
