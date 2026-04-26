# 2026-04-26 - 新增 right-even-2col-4 布局（推荐）

## 改了什么

- 新增 tmux 布局：`right-even-2col-4`
  - 主窗格固定左侧 `1/2`；
  - subagent panel 固定右侧 `1/2`；
  - 右侧按阈值展开：
    - `1-4` 维持田字阶段（`3` 为上二下一，`4` 为 2x2）；
    - `5-8` 无需重构，直接纵向堆叠。
  - 可见 pane 上限固定 `8`。
- `TmuxMultiplexer` 增加 `right-even-2col-4` 的 split 路由、计数与
  pane 跟踪逻辑：
  - 新增 `right-even-2col` 计划模式；
  - split target 改为“优先实时几何”，避免快速增删后的 stale paneId；
  - 关闭 pane 时按该布局的专用列映射移除，避免盲目计数回退；
  - `<=4` 时跳过 tmux preset reflow，保持田字阶段结构；
  - `5+` 时不切换到 `main-vertical`，保持当前布局直接堆叠。
- `MultiplexerSessionManager` 将 `right-even-2col-4` 纳入结构化重建路径：
  - 关闭导致 pane 拓扑变化时，会按当前存活会话顺序重建 pane；
  - 重建期间新 session 会等待，避免“快速添加/移除”造成布局漂移。
- `right-even-2col-4` 的 reflow 防抖窗口加长（400ms），减少快速切换抖动。
- `MultiplexerSessionManager` 对结构化重建新增防抖窗口（600ms）：
  - 连续 close 事件会合并到一次重建，减少“频繁切换布局”；
  - close 流程开始到重建完成期间，新 spawn 会等待，避免插队抖动。
  - 重建时新增 pane 之间加入 120ms 节流，降低视觉跳变速度。
  - 当 queue 可立即补齐容量时，跳过同布局重建，避免反复重构。
- 配置 schema 增加 `multiplexer.layout = "right-even-2col-4"`。
- 文档更新：`docs/configuration.md`、`docs/multiplexer-integration.md`
  补充布局说明和参数适用范围。

## 为什么改

- `right-even-8` 解决了“单列均分稳定”，但会失去两列可视布局。
- 新增 `right-even-2col-4` 后，用户可以在“固定主窗格半宽”的前提下，
  采用 `1-4` 田字 + `5-8` 直接堆叠的混合模式。

## 涉及文件

- `src/config/schema.ts`
- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

1. `bun test -t "right-even-2col-4"`
2. `bun run typecheck`
3. `bun run build`

重点检查：

- split 方向顺序为 `h, v, h, h, ...`；
- `1-4` 维持田字阶段（`3` 为上二下一，`4` 为 2x2）；
- `5-8` 无需重构、直接纵向堆叠；
- pane 数超过 `8` 时新增请求返回 capacity。
- 快速添加/移除时，布局可回到当前规则的 canonical 形态。
- queue 回补后数量不变时，避免重复重构同一布局。
- subagent 快速切换时，重建会被防抖合并，不会每次 close 都立刻重建。
