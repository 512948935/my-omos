# 2026-04-26 - right-even-2col-4 混合策略（1-4 田字，5-8 直接堆叠）

## 改了什么

- `right-even-2col-4` 布局规则更新：
  - `1-4`：保持田字阶段（`3` 为上二下一、`4` 为 2x2）；
  - `5-8`：无需重构，直接纵向堆叠；
  - 超过 `8`：返回 capacity，进入队列。
- `TmuxMultiplexer` 在第 5 个 pane 起不再触发 layout 重构，
  直接沿当前结构纵向堆叠。
- 对应测试更新为验证：
  - 9 次请求前 8 次成功；
  - split 序列为 `h, v, h, h, v, v, v, v`；
  - `5+` 阶段不触发 `select-layout` / `set-window-option` 重构。

## 为什么改

- 双列扩展到 `5+` 时，视觉均衡与稳定性较差。
- 通过“前 4 田字 + 后续直接堆叠”，减少反复重构导致的抖动。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/config/schema.ts`
- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`
- `README.md`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`
- `AGENTS.md`

## 如何验证

1. `bun test src/multiplexer/tmux/index.test.ts`
2. `bun test src/multiplexer/session-manager.test.ts`
3. `bun run typecheck`
4. `bun run build`

重点检查：

- `right-even-2col-4` 的 `1-4` 是否保持田字阶段；
- 第 5 个开始是否跳过重构并直接堆叠；
- 第 9 个是否走 capacity + queue；
- 文档中布局说明是否与实现一致。
