# 2026-04-26 - right-even-2col-4 严格的边缘触发重构策略

## 改了什么

- 将 `right-even-2col-4` 布局中 `>4` 阶段的稳态行为彻底改为**完全跳过重构**。
- 在 `spawnPane` 流程中：
  - 如果处于跨越阈值的瞬间（如 `4->5`），调用 `requestRightEvenTwoColBoundaryReflow()` 执行**一次**单列总数均分重构。
  - 如果已经在 `>4` 阶段（如 `5->6`，`6->7`），完全忽略对 `requestReflow()` 的调用，纯粹依赖 tmux 自带的 split pane 分割结果，只做单纯堆叠。
  - 如果在 `<=4` 的田字构建阶段（如 `1->2`, `3->4`），仍然会调用 `requestReflow()` 以维持和调整田字格。
- 在 `closePane` 流程中：
  - 只有在关闭操作后使得总数 `<= 4` 时，才会由 `session-manager` 发出一次 `requestStructuredLayoutRebalance` 结构化重构指令，以恢复田字结构。
  - 在 `>4` 的回落期间（如 `8->7`, `6->5`），不做任何重构指令干预。

## 为什么改

- 之前的实现虽然在 `>4` 阶段改变了回流为“单列堆叠”，但用户对“重构”的容忍度极低，强烈要求在稳态（`5-8` 阶段内不管是新增还是关闭）绝对不可以触发二次重构。
- 确保在并发出现多个超过阈值的 pane 时，不会产生连续、反复闪烁的重构（flicker），真正实现跨越阈值时的“一次性重组”。
- “>4 不再干预，<5 回归田字” 是最符合用户物理直觉的预期。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/multiplexer/session-manager.ts`

## 如何验证

1. `bun test src/multiplexer/tmux/index.test.ts` 
   - 重点查看 `supports right-even-2col-4 threshold strategy: 4->5 重构一次, 5-8 继续堆叠` 测试（断言 `select-layout` 调用次数锁定为 2 次）。
2. 实机 tmux 操作：
   - 启动 1-4 个 Agent，观察右侧组成田字格。
   - 启动第 5 个 Agent，瞬间重构为单列 5 均分。
   - 继续启动第 6、7、8 个 Agent，界面没有全局重排闪烁，仅是在下方被切分出新面板。
   - 关闭第 8、7、6 个 Agent，无重排发生，下面被关掉的空间自动退还。
   - 关闭第 5 个 Agent，瞬间发生重构，右侧 4 个 pane 恢复为 `2x2` 田字格。
