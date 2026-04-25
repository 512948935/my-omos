# 2026-04-26 - right-binary 重排期间串行化新增/关闭

## 改了什么

- 在 `MultiplexerSessionManager` 新增 right-binary 重排等待逻辑：
  - `closeSession` 在处理关闭前，会等待正在进行的 right-binary 重排结束；
  - `spawnKnownSession` 在创建 pane 前，也会等待 right-binary 重排结束；
  - 避免“pane 减少后立即新增”与重排交错，导致 split 目标错位、布局紊乱。
- 新增回归测试：
  - 模拟 right-binary 重排进行中收到 `session.created`；
  - 验证新 session 会在重排完成后再 spawn，确保顺序为“重排 survivors → 新 session”。

## 为什么改

- 反馈指出 right-binary 在右侧 5 个 pane 场景下，数量减少再增加时会出现明显乱序。
- 根因是关闭/重排与新增 pane 存在交错窗口，容易使用到中间态 pane 结构。
- 通过串行化这两个路径，避免中间态被并发消费。

## 涉及文件

- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`

## 如何验证

1. `bun test -t "right-binary"`
2. `bun run typecheck`

重点检查：

- `waits for right-binary rebalance before spawning new session` 用例通过；
- right-binary 关闭后重排与新增 session 不再交错执行。
