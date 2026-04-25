# 2026-04-25 - right-binary 在子会话结束后的自动重排

## 改了什么

- 在 `MultiplexerSessionManager` 增加 right-binary 的关闭后重排逻辑：
  - 当 `layout = right-binary-8` 且某个 subagent pane 关闭后，
    若仍有多个活动子会话，自动重建剩余 pane 布局；
  - 通过“关闭剩余 pane → 按既有会话顺序重新 attach”实现，
    保证 pane 数变化后继续按当前 right-binary 规则均分。
- 增加重排过程并发保护，避免嵌套重排。
- 新增测试覆盖：
  - 验证一条子会话结束后会触发 right-binary 重排；
  - 验证重排后 `session -> paneId` 映射更新生效。

## 为什么改

- 反馈指出：子会话完成后 pane 消失，剩余 pane 若不重算会出现不均分或布局紊乱。
- right-binary 的目标是“数量变化后仍保持均分递进”，因此在关闭路径增加重排。

## 涉及文件

- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`

## 如何验证

1. `bun run typecheck`
2. `bun test`
3. `bun run build`

重点检查：

- `src/multiplexer/session-manager.test.ts` 的 right-binary 重排用例通过；
- 真实 tmux 中子会话结束后，剩余 pane 会自动重排恢复均分。
