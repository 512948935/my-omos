# 2026-04-25 - right-binary 布局递归扩展与分裂顺序修正

## 改了什么

- 调整 `right-binary-8` 的右侧递进分裂策略：
  - 保持前 4 步先形成“田字”；
  - 第 5~8 步改为按行优先顺序做“上下 1/2”分裂（TL → TR → BL → BR）；
  - 8 之后继续按同一递归套路向下扩展（仍为“上下 1/2”）。
- 放宽 `max_panel_panes` 配置上限：
  - `multiplexer.max_panel_panes` 从 `1-8` 调整为 `1-64`；
  - `tmux.max_panel_panes`（legacy）同步调整为 `1-64`；
  - 默认值仍为 `8`（不破坏现有行为）。
- 在 tmux 后端将右侧 binary 布局的固有上限从固定 8 改为可递归扩展，
  实际可见上限由 `max_panel_panes` 控制。
- 新增测试覆盖：
  - 验证第 5~8 步的分裂 target 顺序；
  - 验证当 `max_panel_panes > 8` 时可继续扩展（示例到 12）。

## 为什么改

- 反馈显示“首个田字后”的分裂节奏与预期不一致。
- 新要求需要“针对田字持续上下均分”，并支持在需要时显示超过 8 个 pane。
- 保持默认值 8 可以兼容既有配置，同时为高并发场景提供可扩展能力。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/config/schema.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

1. `bun run typecheck`
2. `bun test`
3. `bun run build`

重点检查：

- `src/multiplexer/tmux/index.test.ts` 中 right-binary 相关用例通过；
- `max_panel_panes` 在 schema 中允许 `1-64`；
- 文档中 `right-binary-8` 描述与上限区间同步更新。
