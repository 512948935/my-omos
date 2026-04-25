# 2026-04-26 - right-binary 计数防漂移与重复关闭加固

## 改了什么

- `TmuxMultiplexer` 在 `right-binary-8` 下改为使用 `binaryPaneIds.length` 作为活动 pane 的权威计数。
- `closePane` 在 `kill-pane` 失败/异常路径不再盲目回退计数（尤其是 right-binary）。
- `MultiplexerSessionManager` 增加并发关闭去重：同一 `sessionId` 的关闭流程并发时只执行一次。
- 新增回归测试：
  - 并发 idle/deleted 关闭不会重复 `closePane`；
  - duplicate close 后 right-binary 不会过度减计数，后续 5/6 pane 阶段仍按预期分裂。

## 为什么改

- 用户反馈“5 panel 特别容易乱并挤到左边”，且在 churn（减少再增加）后更明显。
- 根因之一是重复关闭/失败关闭导致内部计数偏移，进而让下一次 split 走错阶段。

## 涉及文件

- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/tmux/index.test.ts`
- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`

## 如何验证

1. `bun test -t "right-binary"`
2. `bun test -t "deduplicates concurrent close requests for same session"`
3. `bun test -t "does not over-decrement right-binary after duplicate close"`
4. `bun test`
5. `bun run typecheck`
6. `bun run build`

重点检查：

- 关闭/删除并发不再触发重复关闭；
- 5~6 pane 阶段不会因为历史重复关闭而走错分裂路径。
