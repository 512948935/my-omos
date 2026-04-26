# 2026-04-26 - right-even-2col-4 在 5+ 阶段按总数均分

## 改了什么

- `right-even-2col-4` 改为阈值触发策略：
  - `4→5`：触发一次单列均分重构（按 pane 总数平均）；
  - `5-8`：后续继续纵向追加（不重复重构）；
  - 回落到 `<5`：再次触发一次重构，恢复田字阶段。
- `right-even-2col-4` 在 `5+` pane 的回流（reflow）路径从“跳过重构”调整为：
  - 统一收敛到 `main-vertical` 的右侧单列；
  - 按 pane 总数做均分（single-column even stack）；
  - 保持主 pane 固定 `1/2` 宽（`main-pane-width = 50%`）。
- 回流完成后，重置 `right-even-2col` 的列追踪映射：
  - 所有 pane 归并到 column-0；
  - 按实时几何顺序（top→bottom）重建 pane 顺序。
- 对应单测从“5+ 跳过 reflow”更新为“5+ 执行总数均分 reflow”。

## 为什么改

- 用户反馈“重构那次也不是按总数平均值”。
- 在 `5+` 阶段，如果仍保持递归 `-v -p 50` 堆叠，面板高度会偏离“按总数均分”的直觉。
- 既然重构不可避免，改为在回流时一次收敛到单列均分，更符合预期。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `README.md`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`
- `AGENTS.md`

## 如何验证

1. `bun test -t "reflows right-even-2col 5+ panes by total-count average"`
2. `bun test -t "supports right-even-2col-4 threshold strategy: 4->5 重构一次, 5-8 继续堆叠"`
3. `bun run typecheck`

重点检查：

- `1-4` 是否仍保持田字阶段；
- `4→5` 与 `<5` 回落是否触发阈值重构；
- `5+` 回流时是否触发 `select-layout main-vertical` + `main-pane-width 50%`；
- 回流后 pane 追踪是否归并到单列，避免后续 split 使用旧列映射。
