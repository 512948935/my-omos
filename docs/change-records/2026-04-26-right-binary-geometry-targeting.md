# 2026-04-26 - right-binary 增加几何校准选 target（低闪动）

## 改了什么

- `TmuxMultiplexer` 在 `right-binary-8` 下新增几何校准：
  - `spawnPane` 选 split target 时先读取 tmux 实时 `list-panes` 几何；
  - 基于坐标决定 top/bottom 与 TL/TR/BL/BR 目标，而不是仅依赖历史插入顺序。
- right-binary 几何读取失败时保留原有顺序回退逻辑，避免行为中断。
- 新增回归测试：
  - 注入 stale `binaryPaneIds` 顺序后，仍应按实时几何命中 TR 目标。

## 为什么改

- 用户反馈 5 pane 场景在 churn 后仍会“挤到左边”，说明仅靠顺序数组仍可能漂移。
- 几何校准可直接以 tmux 当前布局为准，稳定性更高，同时不需要全量重排，减少闪动。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`

## 如何验证

1. `bun test -t "uses live geometry when right-binary tracked order is stale"`
2. `bun test -t "right-binary"`
3. `bun test`
4. `bun run typecheck`
5. `bun run build`

重点检查：

- stale 顺序下 split target 仍命中 `%tr`；
- 5-pane churn 场景目标选择不再偏向错误分支。
