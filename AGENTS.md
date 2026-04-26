# Agent Coding Guidelines

**oh-my-opencode-slim** — OpenCode agent orchestration plugin. TypeScript + Bun + Biome.

## Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Full build: plugin bundle + CLI bundle + `.d.ts` emit + JSON schema generation |
| `bun run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `bun test` | Run all tests (944 tests across 60 files, ~23s) |
| `bun run check:ci` | Biome lint + format check (no auto-fix, CI mode) |
| `bun run check` | Biome check with auto-fix |
| `bun run dev` | Build then launch OpenCode with the plugin loaded |

**Single test:** `bun test -t "pattern"` — matches test name, not file path.

**Verification order (matches CI):** `lint` → `typecheck` → `test` → `build`

## Build Quirks

- `bun run build` is a 4-step chain: `build:plugin` → `build:cli` → `tsc --emitDeclarationOnly` → `generate-schema`. All must pass.
- `prepare` hook runs `bun run build` automatically on `bun install`.
- Build uses Bun's bundler with several `--external` flags (see `package.json` scripts). `@ast-grep/napi`, `@opencode-ai/plugin`, `@opencode-ai/sdk`, `jsdom`, `zod` are all externalized.
- `oh-my-opencode-slim.schema.json` is generated from `src/config/schema.ts` via `scripts/generate-schema.ts`. Regenerate after changing the config schema.

## Code Style

- **Biome** handles lint + format — config in `biome.json`
- 80-char lines, 2-space indent, single quotes, trailing commas, LF endings
- Biome auto-organizes imports; don't hand-sort
- `noExplicitAny: warn` in production code, `off` in `*.test.ts`
- **Naming:** camelCase functions/vars, PascalCase classes/interfaces, SCREAMING_SNAKE_CASE constants, kebab-case filenames
- TypeScript strict mode enabled; don't suppress with `as any` / `@ts-ignore`

## Architecture

Read `codemap.md` for the full map. Key facts:

- **Plugin entry:** `src/index.ts` — central composition root wiring agents, tools, MCPs, hooks, council, multiplexer, interview, session management
- **CLI entry:** `src/cli/index.ts` — installer, config generation, skill installation
- **Config schema source of truth:** `src/config/schema.ts` (Zod)
- Agent factories live in `src/agents/` — each agent has its own file + optional `.test.ts`
- Hooks in `src/hooks/` transform prompts/messages, handle error recovery, session aliasing, delegation retries
- `src/multiplexer/` abstracts tmux/zellij pane mirroring for child sessions
- `src/council/` handles multi-model parallel execution and synthesis
- `src/tools/` exposes AST-grep, webfetch, council tool, and preset switching
- `src/skills/` contains bundled skills shipped in the npm package (`codemap`, `simplify`)
- Published files: `dist/`, `src/skills/`, schema JSON, README, LICENSE

## Testing

- Test root is `./src` (configured in `bunfig.toml`)
- Tests co-locate with source: `foo.ts` → `foo.test.ts`
- 1 known flaky test: `TmuxMultiplexer.findBinary` fails when tmux is not installed (CI has it, local dev may not)
- No test fixtures or external services required
- Use Zod schemas for runtime validation throughout; tests often exercise schema parsing

## Tmux/Zellij Session Lifecycle

When modifying session management code, understand the shutdown sequence:

1. `session.abort()` must be called **after** extracting task results (not before)
2. Graceful shutdown: send `Ctrl+C` → wait 250ms → `kill-pane`
3. `session.deleted` event handler in `src/index.ts` triggers pane cleanup via `MultiplexerSessionManager`
4. After changes: build → test with `@explorer` / `@librarian` tasks → verify no orphaned `opencode attach` processes

## Multiplexer Layout Checklist

> [CUSTOM] Layout source of truth: `src/config/schema.ts` +
> `src/multiplexer/tmux/index.ts` +
> `docs/multiplexer-integration.md`.

### Multiplexer types

| `multiplexer.type` | Effect | Recommended when |
|---|---|---|
| `auto` | Auto-detect tmux/zellij | Default for mixed environments |
| `tmux` | Force tmux integration | Need full tmux layout control |
| `zellij` | Force zellij integration | You primarily use zellij |
| `none` | Disable pane mirroring | No multiplexer panes needed |

### Tmux layouts (with behavior)

| `multiplexer.layout` | Effect summary | Notes |
|---|---|---|
| `main-vertical` | Main pane left, panels stacked right | General default |
| `main-horizontal` | Main pane top, panels stacked bottom | Useful on wide screens |
| `right-binary-8` | Main fixed left `1/2`; right grows `1→2→4→8` | Rebalance on close; fixed max `8`; ignores `panel_rows_per_column` |
| `right-even-8` | Main fixed left `1/2`; right single-column even stack | Stable/even vertical splits; fixed max `8`; ignores `panel_rows_per_column` |
| `right-even-2col-4` | Main fixed left `1/2`; `3` is top-2/bottom-1, `4` becomes 2x2 | Threshold-triggered reflow: `4→5` reflows once to single-column average, `5-8` stacks vertically; dropping back to `<5` triggers 田字 rebuild; fixed max `8`; ignores `panel_rows_per_column` |
| `tiled` | All panes tiled evenly | Max visibility, less main focus |
| `even-horizontal` | All panes side by side | Good for ultra-wide screens |
| `even-vertical` | All panes stacked vertically | Simple, but can get short |

### Layout update checklist

When adding/modifying layout behavior, update these together:

1. `src/config/schema.ts` (enum + type)
2. `src/multiplexer/tmux/index.ts` (split/reflow/track/untrack)
3. `src/multiplexer/tmux/index.test.ts` (behavioral tests)
4. `docs/configuration.md` (option table)
5. `docs/multiplexer-integration.md` (layout guide)
6. `docs/change-records/YYYY-MM-DD-*.md` (change record)

## Development Workflow

1. Make changes
2. Update docs (`README.md`, `docs/`) if behavior/commands/config/output changed
3. `bun run check:ci` → `bun run typecheck` → `bun test` → `bun run build`
4. Before pushing: run `/review` to catch logic issues linter/tests miss

## Release

```bash
bun run release:patch   # npm version patch → git push --follow-tags → npm publish
bun run release:minor
bun run release:major
```

CI also runs `verify:release` (package artifact check) and `verify:host-smoke` (OpenCode host load test) on every PR.


## ⚠️ 二开规范（必读）

本仓库是基于 LobeHub 官方版本的二次开发，需要定期合并上游更新。所有改动必须遵循以下原则：

### 1. 最小侵入原则

- 不需要的功能优先通过配置项关闭，不要删代码
- 没有配置项的，注释掉 UI 入口即可（加 `// [CUSTOM] 隐藏xxx入口` 注释）
- 禁止大规模重构或删除官方代码，避免合并冲突

### 2. 新增功能

- 代码中添加 `// [CUSTOM]` 注释标记所有新增/修改点
- 在 `docs/change-records/` 下创建变更记录，格式：`YYYY-MM-DD-简要描述.md`
- 记录内容包括：改了什么、为什么改、涉及哪些文件、如何验证

### 3. 修改现有功能

- 前提：不能影响主流程逻辑
- 所有修改点必须添加 `// [CUSTOM]` 注释，说明改动意图
- 升级官方代码后，用 `grep -rn "\[CUSTOM\]" src/ packages/types/` 检查标记是否丢失
- 丢失的标记参照 `bak/` 目录恢复

## ⚠️ 自定义修改（[CUSTOM] 标记）

本仓库有若干自定义修改，用 `// [CUSTOM]` 注释标记。**升级版本时必须保留这些修改**，否则会导致功能回退。
