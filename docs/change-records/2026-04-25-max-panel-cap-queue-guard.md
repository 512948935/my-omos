# 2026-04-25 - max_panel_panes 严格上限与排队保护

## 改了什么

- 将 `max_panel_panes` 的配置范围恢复并固定为 `1-8`：
  - `multiplexer.max_panel_panes`：`1-8`
  - `tmux.max_panel_panes`（legacy）：`1-8`
- tmux 后端的可见 pane 数硬上限固定为 8：
  - 当达到上限时，`spawnPane` 返回 `reason: 'capacity'`，不再创建新 panel。
- 会话管理层维持“容量满即入队”的既有行为：
  - 超过 `max_panel_panes` 的子会话进入 `pendingQueue`；
  - 有空位后按 FIFO 自动补位。

## 为什么改

- 需求明确：`max_panel_panes` 必须严格生效，超额不能继续开 pane，
  必须进入队列等待。

## 涉及文件

- `src/config/schema.ts`
- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

1. `bun run typecheck`
2. `bun test`
3. `bun run build`

重点检查：

- `max_panel_panes` 在 schema 中最大值为 `8`；
- `right-binary-8` 与其它布局达到上限后新增 pane 失败（capacity）；
- `session-manager` 在 capacity 情况下将会话加入等待队列。
