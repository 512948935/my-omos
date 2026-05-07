# oh-my-opencode-slim

OpenCode 的轻量编排插件（TypeScript + Bun + Biome）。

目标：在保持可维护性的前提下，提供更强的子代理协作、
multiplexer 可视化、配置灵活性与工作流自动化能力。

---

## 快速安装

```bash
bunx oh-my-opencode-slim@latest install
```

无交互安装：

```bash
bunx oh-my-opencode-slim@latest install --no-tui --skills=yes
```

安装后：

```bash
opencode auth login
opencode models --refresh
```

---

## 完整使用步骤（tmux + omos 插件）

下面是一套从 0 到可用的完整流程。

### 步骤 1：安装 tmux

按你的系统选一个命令执行：

```bash
# macOS
brew install tmux

# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y tmux

# Fedora
sudo dnf install -y tmux
```

### 步骤 2：（可选）增加 tmux 常用配置

编辑 `~/.tmux.conf`，加入：

```tmux
set -g mouse on
set -g history-limit 100000
setw -g mode-keys vi
set -g base-index 1
setw -g pane-base-index 1
set -g escape-time 0
bind | split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"
bind r source-file ~/.tmux.conf \; display-message "tmux.conf reloaded"
```

应用配置：

```bash
tmux source-file ~/.tmux.conf
```

### 步骤 3：安装并配置 omos 插件

```bash
bunx oh-my-opencode-slim@latest install
```

如果你希望覆盖旧配置并重新初始化：

```bash
bunx oh-my-opencode-slim@latest install --reset
```

### 步骤 4：登录模型提供商

```bash
opencode auth login
opencode models --refresh
```

### 步骤 5：增加配置项

编辑 `~/.config/opencode/oh-my-opencode-slim.json`（或 `.jsonc`）：

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "multiplexer": {
    "type": "tmux",
    "layout": "right-even-2col-4",
    "max_panel_panes": 8
  }
}
```

### 步骤 6：配置 `omos` 启动函数（自动设置环境变量）

把下面函数加入 `~/.bashrc` / `~/.zshrc`：

```bash
omos() {
  local port

  while :; do
    port=$(shuf -i 49152-65535 -n 1)

    # 优先用 lsof 检查端口是否被占用
    if command -v lsof >/dev/null 2>&1; then
      lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || break
      continue
    fi

    # 没有 lsof 时，尝试用 ss
    if command -v ss >/dev/null 2>&1; then
      ss -ltn "( sport = :$port )" | grep -q LISTEN || break
      continue
    fi

    # 都没有时直接使用随机端口
    break
  done

  # 可选：同步到当前 tmux session 环境
  tmux setenv -g OPENCODE_PORT "$port" 2>/dev/null || true

  OPENCODE_PORT="$port" opencode --port "$port" "$@"
}
```

然后重新加载 shell 配置：

```bash
source ~/.bashrc   # 或 source ~/.zshrc
```

说明：这里会确保 `OPENCODE_PORT` 与 `--port` 使用同一个值，并尽量避开已占用端口。

### 步骤 7：启动 OpenCode（推荐 `omos`）

关键点：`OPENCODE_PORT` 必须与 `opencode --port` 一致。

```bash
tmux
omos
```

如果你不使用 `omos` 函数，也可以手动启动：

```bash
tmux
export OPENCODE_PORT=4096
opencode --port 4096
```

### 步骤 8：验证是否生效

在 OpenCode 里执行：

```text
ping all agents
```

然后发一个会触发子代理的任务，确认 tmux pane 正常出现。

> 可选：如果你同时开多个 OpenCode 会话，建议每次使用不同端口。
> 详见 `docs/multiplexer-integration.md`。

---

## 重新初始化（重置配置）

如果你想重新初始化配置（覆盖旧配置）：

```bash
bunx oh-my-opencode-slim@latest install --reset
```

说明：会先生成 `.bak` 备份，再覆盖。

---

## Multiplexer 部署方式清单（`multiplexer.type`）

| 类型 | 效果 | 推荐场景 |
|---|---|---|
| `auto` | 自动识别 tmux/zellij | 混合环境、默认推荐 |
| `tmux` | 强制走 tmux 布局体系 | 需要完整布局控制 |
| `zellij` | 强制走 zellij 集成 | 主要使用 zellij |
| `none` | 关闭 pane 镜像 | 不需要可视化子面板 |

---

## Tmux 布局清单（`multiplexer.layout`）

| 布局 | 效果介绍 | 适用场景 |
|---|---|---|
| `main-vertical` | 主 pane 在左，子 pane 在右堆叠 | 通用默认 |
| `main-horizontal` | 主 pane 在上，子 pane 在下堆叠 | 宽屏/横向工作流 |
| `right-even-8` | 左右固定 `1/2`；右侧单列均分 | 稳定+均分优先 |
| `right-even-2col-4` | 左右固定 `1/2`；`1-4` 保持田字（`3` 上二下一，`4` 2x2）；`4→5` 触发一次单列均分重构，`5-8` 后续继续纵向堆叠；回落到 `<5` 时再触发一次重构回田字 | 阈值触发策略 |
| `tiled` | 全部 pane 网格均分 | 最大并行可视化 |
| `even-horizontal` | 所有 pane 横向并排 | 超宽屏 |
| `even-vertical` | 所有 pane 纵向堆叠 | 简单快速 |

补充：

- `right-even-8` / `right-even-2col-4`
  不使用 `panel_rows_per_column`。
- 这两个 `right-*` 布局可见 pane 上限固定 `8`
  （同时仍受 `max_panel_panes` 约束）。

---

## 推荐配置（阈值模式：`4→5` 均分重构一次，`5-8` 继续堆叠）

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "multiplexer": {
    "type": "tmux",
    "layout": "right-even-2col-4",
    "max_panel_panes": 8
  }
}
```

> 使用 multiplexer 时，请确保 `opencode --port` 与 `OPENCODE_PORT` 一致。

---

## 本地开发命令

| 命令 | 说明 |
|---|---|
| `bun run build` | 完整构建（plugin + cli + d.ts + schema） |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test` | 运行全部测试 |
| `bun run check:ci` | Biome lint + format 检查（CI 模式） |
| `bun run check` | Biome 自动修复检查 |
| `bun run dev` | 构建后启动 OpenCode |

单测筛选：

```bash
bun test -t "pattern"
```

推荐验证顺序：`lint → typecheck → test → build`

---

## 文档索引

- 安装：`docs/installation.md`
- 配置总览：`docs/configuration.md`
- Multiplexer：`docs/multiplexer-integration.md`
- Council：`docs/council.md`
- Interview：`docs/interview.md`
- Session 管理：`docs/session-management.md`
- Preset 切换：`docs/preset-switching.md`
- 技能与 MCP：`docs/skills.md` / `docs/mcps.md`
- 快速索引页：`docs/quick-reference.md`

---

## 排错入口

优先看：`docs/installation.md` 的 Troubleshooting 章节。

常见项：

- 鉴权失败：`opencode auth status` / `opencode auth login`
- 模型未刷新：`opencode models --refresh`
- tmux 不生效：检查 `OPENCODE_PORT` 与 `--port` 是否一致

---

## License

MIT
