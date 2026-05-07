# 2026-04-26 - 移除 `right-binary-8` 布局入口

## 改了什么

- 从测试中移除 `right-binary-8` 相关用例，避免继续验证已下线布局：
  - `src/multiplexer/session-manager.test.ts`
- 清理代码中的 `right-binary` 残留注释与空实现：
  - `src/multiplexer/session-manager.ts`
  - `src/multiplexer/tmux/index.ts`
- 更新文档中的布局列表，移除 `right-binary-8` 对外说明：
  - `README.md`
  - `docs/configuration.md`
  - `docs/multiplexer-integration.md`
  - `AGENTS.md`

## 为什么改

- 用户要求下线 `right-binary-8`，并强调“不要产生干扰”。
- 先前仍有 right-binary 相关测试与文档描述，导致行为与对外说明不一致。

## 涉及文件

- `src/multiplexer/session-manager.ts`
- `src/multiplexer/session-manager.test.ts`
- `src/multiplexer/tmux/index.ts`
- `README.md`
- `docs/configuration.md`
- `docs/multiplexer-integration.md`
- `AGENTS.md`

## 如何验证

- `bun run typecheck`
- `bun test`
- `bun run build`
