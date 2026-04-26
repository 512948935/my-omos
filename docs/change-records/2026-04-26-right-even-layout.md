# 2026-04-26 - 新增 right-even-8 布局（稳定 + 右侧均分）

## 改了什么

- 新增 tmux 布局：`right-even-8`
  - 主窗格固定左侧 `1/2`；
  - subagent panel 固定右侧 `1/2`；
  - 右侧 panel 使用单列纵向堆叠，并通过 tmux `main-vertical` reflow
    维持均分高度；
  - 可见 pane 上限固定 `8`（与 `right-binary-8` 一致）。
- `TmuxMultiplexer` 新增 `right-even-8` 路由与 pane 跟踪逻辑：
  - split 规则：首个 pane 水平 `50%`，后续按纵向追加；
  - reflow 规则：将 `right-even-8` 映射到 tmux `main-vertical`，并把
    `main-pane-width` 固定为 `50%`（仅在有 panel 时）；
  - 关闭 pane 时按 `right-even` 专用列表做计数，避免盲目回退。
- 配置 schema 增加 `multiplexer.layout = "right-even-8"`。
- 文档更新：`docs/configuration.md`、`docs/multiplexer-integration.md`
  新增该布局说明与参数适用范围。

## 为什么改

- 现有 `right-binary-8` 在 `5~7` pane 阶段是递归二分过渡态，
  视觉上不会严格均分。
- 新增 `right-even-8` 作为“稳定 + 右侧均分高度”的可选策略，
  在不破坏现有布局行为的前提下提供更符合该诉求的选项。

## 涉及文件

- `src/config/schema.ts`
- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

1. `bun test -t "right-even-8"`
2. `bun run typecheck`
3. `bun run build`

重点检查：

- `right-even-8` 下首个 split 为 `-h -p 50`；
- 后续 pane 追加后 reflow 使用 `main-vertical`；
- `main-pane-width` 在有 panel 时固定 `50%`；
- pane 数超过 8 时新增请求返回 capacity。
