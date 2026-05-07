# 2026-04-26 - pane 创建串行限流（防并发顺序错乱）

## 改了什么

- 在 session manager 增加 pane 创建串行队列，保证创建顺序稳定：
  - `src/multiplexer/session-manager.ts`
  - 新增 `runSerializedSpawnOperation()`
- 在 pane 创建前增加轻量限流间隔（40ms），降低 burst 并发导致的顺序抖动：
  - `src/multiplexer/session-manager.ts`
  - 新增 `waitForPanelSpawnGap()` / `markPanelSpawnAttempt()`
- 统一把重排重建场景也走同一套 spawn 限流策略，避免重建时的抢占：
  - `src/multiplexer/session-manager.ts`
- 通过 token 化 in-flight 标记避免 cleanup 与重复创建的交叉释放问题：
  - `src/multiplexer/session-manager.ts`

## 为什么改

- 用户反馈 pane 创建并发时会出现顺序不对、阶段性闪烁。
- 需要在不破坏现有阈值重排策略前提下，为创建路径增加“串行 + 限流”保护。

## 涉及文件

- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`

## 如何验证

- `bun run typecheck`
- `bun test`
- `bun run build`
