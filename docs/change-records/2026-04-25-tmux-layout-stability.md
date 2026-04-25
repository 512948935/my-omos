# 2026-04-25 - tmux subagent 布局稳定性优化

## 改了什么

- 在 `src/multiplexer/tmux/index.ts` 引入窗口级串行队列，统一串行执行
  pane 变更相关命令。
- 将 `spawnPane` / `closePane` 的“立即 `applyLayout`”改为
  “去抖合并 reflow 请求”，减少高并发场景下的重复重排。
- 新增 tmux panel 行为：
  - 首个 subagent pane 打开前隐藏 tmux 状态栏；
  - 最后一个 subagent pane 关闭后恢复状态栏；
  - 状态栏切换改为更稳健的读取/写入策略：
    - 读取 `status` 时先读 session 局部值，再回退全局值；
    - 对 pane target 失败时，回退默认 target 再试；
    - 若首次隐藏失败，后续 spawn 会继续重试隐藏直到成功；
  - 列宽规则改为“每列约 1/3”：
    - 第一列为约 1/3；
    - 第二列创建后，主窗格与两列 subagent 约为 1/3 + 1/3 + 1/3；
  - 新增 `right-binary-8` 布局策略：
    - 先左右 1/2；
    - 右侧按 1→2→4→8 递进分裂（先到“田字”，再到 8 格）；
    - 该布局固定最多显示 8 个 subagent pane；
  - 新增全局 pane 上限与队列策略：
    - `max_panel_panes` 上限为 8；
    - 超出可见容量的 subagent 进入等待队列；
    - 有空位时按 FIFO 自动拉起；
    - 若 subagent 在排队期间已完成，则自动退出队列；
  - panel 容量限制调整为“最多 2 列，且每列 `2-5` 行”，
    布局容量为 `2 × panel_rows_per_column`（`[4-10]`），
    最终显示上限受 `max_panel_panes`（默认 8）约束。
- 在 `findBinary` 增加 shim 校验失败时的 `tmux -V` 回退探测，
  兼容 PATH 可用但 shim 不可用的场景。
- 扩展配置项：
  - `multiplexer.max_panel_panes`（1-8，默认 8）；
  - `tmux.max_panel_panes`（legacy 别名）；
  - `multiplexer.panel_rows_per_column`（2-5，默认 3）；
  - `tmux.panel_rows_per_column`（legacy 别名）。
- 更新/新增测试覆盖：
  - `src/multiplexer/tmux/index.test.ts`：
    - 多次 `spawnPane` 的 reflow 合并行为；
    - 重叠 `applyLayout` 请求只应用最新布局的行为。
    - panel 容量限制、右侧 1/3 参数、状态栏隐藏/恢复行为。

## 为什么改

- 现有实现在高频 `split-window` / `kill-pane` / `select-layout` 场景下，
  容易产生布局抖动（闪烁）和竞争。
- 本次改动保持主流程不变，仅在 tmux 执行层增加“串行 + 去抖”机制，
  属于最小侵入稳定性优化。
- 新需求要求每列可配置 2-5 行（总容量固定 2 列），因此需要在 schema、
  loader 迁移、默认配置和文档中补齐同一字段。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/config/schema.ts`
- `src/config/loader.ts`
- `src/index.ts`
- `src/multiplexer/factory.ts`
- `src/multiplexer/factory.test.ts`
- `src/multiplexer/session-manager.test.ts`
- `src/cli/providers.ts`
- `src/cli/providers.test.ts`
- `src/config/loader.test.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

按仓库 CI 顺序执行：

1. `bun run check:ci`
2. `bun run typecheck`
3. `bun test`
4. `bun run build`

重点观察：

- `TmuxMultiplexer` 相关测试通过；
- 无类型错误；
- 构建产物和 schema 生成正常。
