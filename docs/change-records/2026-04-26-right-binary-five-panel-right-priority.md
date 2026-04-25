# 2026-04-26 - right-binary 5~8 pane 扩展改为右列优先

## 改了什么

- 调整 `right-binary-8` 在第 5~8 个 pane 的扩展目标顺序：
  - 从 `TL -> TR -> BL -> BR`
  - 改为 `TR -> TL -> BR -> BL`
- 目标是减少 5-pane 阶段“先向左侧挤压”的视觉问题。
- 更新 tmux right-binary 相关单测断言，覆盖新的目标顺序。

## 为什么改

- 反馈指出 right-binary 在 5 pane 时仍会出现明显布局紊乱，且有“挤到左边”的观感。
- 5-pane 是首个超出田字的扩展节点，优先从右列扩展可降低左侧先拥挤。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`

## 如何验证

1. `bun test -t "right-binary"`
2. `bun test`
3. `bun run typecheck`
4. `bun run build`

重点检查：

- right-binary 5~8 阶段 split target 顺序为 `%3, %1, %4, %2`；
- 5-pane 阶段不再优先向左侧聚集。
