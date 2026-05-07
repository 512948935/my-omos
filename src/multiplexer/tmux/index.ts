/**
 * Tmux multiplexer implementation
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';

// [CUSTOM] Coalesce bursty layout updates to reduce tmux flicker.
const TMUX_REFLOW_DEBOUNCE_MS = 120;
// [CUSTOM] right-even-2col 更强调稳定，使用更长防抖窗口。
const TMUX_REFLOW_DEBOUNCE_RIGHT_EVEN_TWO_COL_MS = 400;
// [CUSTOM] First subagent panel column stays near one-third width.
const TMUX_PANEL_WIDTH_PERCENT = 33;
// [CUSTOM] Creating column-2 from main@67% with 50% split => ~33% width.
const TMUX_SECOND_PANEL_FROM_MAIN_PERCENT = 50;
// [CUSTOM] Fixed panel columns; rows-per-column is user configurable.
const TMUX_PANEL_COLUMNS = 2;
// [CUSTOM] Default visible panel cap (can be overridden by config).
const TMUX_DEFAULT_MAX_PANEL_PANES = 8;
// [CUSTOM] Hard limit for visible panel panes (overflow goes to queue).
const TMUX_MAX_PANEL_PANES_HARD_LIMIT = 8;
// [CUSTOM] Split panel panes with even 1/2 ratio.
const TMUX_BINARY_SPLIT_PERCENT = 50;
// [CUSTOM] right-even layout keeps main pane fixed at 1/2 width.
const TMUX_RIGHT_EVEN_MAIN_PERCENT = 50;
// [CUSTOM] right-even-2col: 1~4 田字阶段，5+ 触发一次均分重构后继续堆叠。
const TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD = 4;

interface PaneGeometry {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export class TmuxMultiplexer implements Multiplexer {
  readonly type = 'tmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  private targetPane = process.env.TMUX_PANE;
  // [CUSTOM] Serialize pane mutations at window scope.
  private mutationQueue: Promise<unknown> = Promise.resolve();
  // [CUSTOM] Track pending reflow requests for debounce/coalescing.
  private reflowTimer: ReturnType<typeof setTimeout> | undefined;
  // [CUSTOM] Resolve all callers once coalesced reflow finishes.
  private reflowWaiters: Array<() => void> = [];
  // [CUSTOM] User-configured rows per column (2-5), used for pane cap.
  private panelRowsPerColumn: number;
  // [CUSTOM] Global panel cap, clamped to 1-8.
  private configuredMaxPanelPanes: number;
  // [CUSTOM] Track currently open subagent panes to drive cap/status toggles.
  private openPanelPaneCount = 0;
  // [CUSTOM] Restore status bar only when we were the one hiding it.
  private statusHiddenByPlugin = false;
  // [CUSTOM] Snapshot tmux status option before first panel opens.
  private statusBeforePanel: string | null = null;
  // [CUSTOM] Track pane-to-column ownership for 2-column panel behavior.
  private paneColumnById = new Map<string, 0 | 1>();
  // [CUSTOM] Keep insertion order per column for follow-up vertical splits.
  private paneIdsByColumn: [string[], string[]] = [[], []];
  // [CUSTOM] right-even layout tracks right-panel panes in insertion order.
  private rightEvenPaneIds: string[] = [];
  // [CUSTOM] right-even-2col tracks pane order per right-side column.
  private rightEvenTwoColPaneIds: [string[], string[]] = [[], []];
  // [CUSTOM] right-even-2col pane -> column ownership map.
  private rightEvenTwoColColumnById = new Map<string, 0 | 1>();
  // [CUSTOM] right-even-2col 是否已进入 5+ 单列阶段（用于阈值触发一次重构）。
  private rightEvenTwoColInSingleColumnPhase = false;

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    panelRowsPerColumn = 3,
    maxPanelPanes = TMUX_DEFAULT_MAX_PANEL_PANES,
  ) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
    // [CUSTOM] Clamp to requested 2-5 per-column capacity range.
    this.panelRowsPerColumn = clamp(panelRowsPerColumn, 2, 5);
    // [CUSTOM] Clamp configured max panels to 1-8.
    this.configuredMaxPanelPanes = clamp(
      maxPanelPanes,
      1,
      TMUX_MAX_PANEL_PANES_HARD_LIMIT,
    );
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await this.findBinary();
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.TMUX;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] spawnPane: tmux binary not found');
      return { success: false, reason: 'error' };
    }

    const paneResult = await this.enqueueMutation<PaneResult>(async () => {
      // [CUSTOM] Retry hide until it actually succeeds in tmux.
      const shouldEnsureStatusHidden = !this.statusHiddenByPlugin;

      try {
        const activePanelPaneCount = this.currentPanelPaneCount();

        // [CUSTOM] Cap panel capacity based on active layout strategy.
        if (activePanelPaneCount >= this.maxPanelPanes()) {
          log('[tmux] spawnPane: panel capacity reached, skipping pane spawn', {
            openPanelPaneCount: activePanelPaneCount,
            maxPanelPanes: this.maxPanelPanes(),
            panelRowsPerColumn: this.panelRowsPerColumn,
          });
          return { success: false, reason: 'capacity' };
        }

        // [CUSTOM] Ensure tmux status bar is hidden before opening panels.
        if (shouldEnsureStatusHidden) {
          await this.hideStatusBarNow(tmux);
        }

        const splitPlan = await this.buildSplitPlan(tmux);

        // Build the attach command
        const quotedDirectory = quoteShellArg(directory);
        const quotedUrl = quoteShellArg(serverUrl);
        const quotedSessionId = quoteShellArg(sessionId);

        const opencodeCmd = [
          'opencode',
          'attach',
          quotedUrl,
          '--session',
          quotedSessionId,
          '--dir',
          quotedDirectory,
        ].join(' ');

        if (!splitPlan) {
          log('[tmux] spawnPane: unable to resolve split target for column', {
            layout: this.storedLayout,
            openPanelPaneCount: this.currentPanelPaneCount(),
            paneIdsByColumn: this.paneIdsByColumn,
            rightEvenPaneIds: this.rightEvenPaneIds,
            rightEvenTwoColPaneIds: this.rightEvenTwoColPaneIds,
          });
          if (this.currentPanelPaneCount() === 0) {
            await this.restoreStatusBarNow(tmux);
          }
          return { success: false, reason: 'error' };
        }

        // [CUSTOM] split args are resolved by active layout strategy.
        const args = [
          'split-window',
          ...splitPlan.splitArgs,
          '-d', // Don't switch focus
          '-P', // Print pane info
          '-F',
          '#{pane_id}', // Format: just the pane ID
          opencodeCmd,
        ];

        log('[tmux] spawnPane: executing', { tmux, args });

        const proc = crossSpawn([tmux, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const exitCode = await proc.exited;
        const stdout = await proc.stdout();
        const stderr = await proc.stderr();
        const paneId = stdout.trim();

        log('[tmux] spawnPane: result', {
          exitCode,
          paneId,
          stderr: stderr.trim(),
        });

        if (exitCode === 0 && paneId) {
          // Rename the pane for visibility
          const renameProc = crossSpawn(
            [tmux, 'select-pane', '-t', paneId, '-T', description.slice(0, 30)],
            { stdout: 'ignore', stderr: 'ignore' },
          );
          await renameProc.exited;

          // [CUSTOM] Track panel membership for capacity + 2-column behavior.
          this.trackPanelPane(paneId, splitPlan);

          log('[tmux] spawnPane: SUCCESS', { paneId });
          return { success: true, paneId };
        }

        // [CUSTOM] If no panel exists after failure, restore status bar.
        if (this.currentPanelPaneCount() === 0) {
          await this.restoreStatusBarNow(tmux);
        }

        return { success: false, reason: 'error' };
      } catch (err) {
        if (this.currentPanelPaneCount() === 0) {
          await this.restoreStatusBarNow(tmux);
        }
        log('[tmux] spawnPane: exception', { error: String(err) });
        return { success: false, reason: 'error' };
      }
    });

    if (paneResult.success && paneResult.paneId) {
      if (this.storedLayout === 'right-even-2col-4') {
        // [CUSTOM] 仅在跨入 5+ 阶段时触发一次重构，后续维持堆叠。
        const isCurrentlyInSingleColumnPhase =
          this.rightEvenTwoColInSingleColumnPhase;
        const countAfterSpawn = this.currentPanelPaneCount();
        const shouldEnterSingleColumnPhase =
          !isCurrentlyInSingleColumnPhase &&
          countAfterSpawn > TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD;

        if (shouldEnterSingleColumnPhase) {
          log(
            '[tmux] right-even-2col-4 entering >4 single column phase, scheduling reflow',
          );
          this.rightEvenTwoColInSingleColumnPhase = true;
          this.requestRightEvenTwoColBoundaryReflow().catch((e) =>
            log('[tmux] right-even-2col boundary reflow error:', e),
          );
        } else if (!isCurrentlyInSingleColumnPhase) {
          this.requestReflow();
        }
      } else {
        this.requestReflow();
      }
    }

    return paneResult;
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId) {
      log('[tmux] closePane: no paneId provided');
      return false;
    }

    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] closePane: tmux binary not found');
      return false;
    }

    let paneCountAdjusted = false;

    const closed = await this.enqueueMutation(async () => {
      const unregisterTrackedPane = (allowFallback: boolean) => {
        const removed = this.untrackPanelPane(paneId);
        if (removed) {
          paneCountAdjusted = true;
          return true;
        }

        if (!allowFallback) {
          return false;
        }

        if (this.storedLayout === 'right-even-8') {
          // [CUSTOM] right-even 同样依赖 paneId 列表，不做盲目计数回退。
          return false;
        }

        if (this.storedLayout === 'right-even-2col-4') {
          // [CUSTOM] right-even-2col 同样依赖 paneId 列表，不做盲目计数回退。
          return false;
        }

        if (this.openPanelPaneCount > 0) {
          // [CUSTOM] Fallback for externally-closed panes not in local map.
          this.openPanelPaneCount -= 1;
          paneCountAdjusted = true;
          return true;
        }

        return false;
      };

      try {
        // Send Ctrl+C for graceful shutdown
        log('[tmux] closePane: sending Ctrl+C', { paneId });
        const ctrlCProc = crossSpawn([tmux, 'send-keys', '-t', paneId, 'C-c'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await ctrlCProc.exited;

        // Wait for graceful shutdown
        await new Promise((r) => setTimeout(r, 250));

        // Kill the pane
        log('[tmux] closePane: killing pane', { paneId });
        const proc = crossSpawn([tmux, 'kill-pane', '-t', paneId], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const exitCode = await proc.exited;
        const stderr = await proc.stderr();

        log('[tmux] closePane: result', { exitCode, stderr: stderr.trim() });

        if (exitCode === 0) {
          unregisterTrackedPane(true);

          if (this.currentPanelPaneCount() === 0) {
            // [CUSTOM] Restore status bar after the last panel closes.
            await this.restoreStatusBarNow(tmux);
          }

          return true;
        }

        // Pane might already be closed
        log('[tmux] closePane: failed (pane may already be closed)', {
          paneId,
        });

        // [CUSTOM] kill-pane 失败时仅移除已追踪 pane，避免重复关闭导致误减计数。
        unregisterTrackedPane(false);

        if (this.currentPanelPaneCount() === 0) {
          // [CUSTOM] Restore status bar after the last panel closes.
          await this.restoreStatusBarNow(tmux);
        }

        return false;
      } catch (err) {
        // [CUSTOM] 异常路径同样避免盲目计数回退。
        unregisterTrackedPane(false);

        if (this.currentPanelPaneCount() === 0) {
          // [CUSTOM] Restore status bar after the last panel closes.
          await this.restoreStatusBarNow(tmux);
        }

        log('[tmux] closePane: exception', { error: String(err) });
        return false;
      }
    });

    if (closed || paneCountAdjusted) {
      if (this.storedLayout === 'right-even-2col-4') {
        // [CUSTOM] 退出 5+ 阶段后，下一次 <5 结构化重构由 session-manager 执行。
        const count = this.currentPanelPaneCount();
        if (count <= TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD) {
          this.rightEvenTwoColInSingleColumnPhase = false;
        }
      } else {
        // [CUSTOM] Coalesce layout updates instead of immediate per-close reflow.
        void this.requestReflow();
      }
    }

    return closed;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    // [CUSTOM] Store latest desired layout and defer to coalesced reflow.
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    if (layout === 'right-even-2col-4') {
      const isCurrentlyInSingleColumnPhase =
        this.rightEvenTwoColInSingleColumnPhase;
      const count = this.currentPanelPaneCount();
      const shouldBeInSingleColumnPhase =
        count > TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD;

      if (shouldBeInSingleColumnPhase && !isCurrentlyInSingleColumnPhase) {
        log(
          '[tmux] right-even-2col-4 applyLayout entering >4 single column phase, scheduling boundary reflow',
        );
        this.rightEvenTwoColInSingleColumnPhase = true;
        await this.requestRightEvenTwoColBoundaryReflow();
      } else if (!isCurrentlyInSingleColumnPhase) {
        this.requestReflow();
      }
      return;
    }

    this.requestReflow();
  }

  // [CUSTOM] Serialize all pane mutations/layout operations per tmux target.
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // [CUSTOM] Debounce frequent reflow requests from bursty spawn/close events.
  private requestReflow(): Promise<void> {
    return new Promise((resolve) => {
      this.reflowWaiters.push(resolve);

      if (this.reflowTimer) {
        clearTimeout(this.reflowTimer);
      }

      this.reflowTimer = setTimeout(
        () => {
          this.reflowTimer = undefined;
          const waiters = this.reflowWaiters.splice(0);

          void this.enqueueMutation(async () => {
            await this.applyLayoutNow(
              this.storedLayout,
              this.storedMainPaneSize,
            );
          }).finally(() => {
            for (const done of waiters) {
              done();
            }
          });
        },
        this.storedLayout === 'right-even-2col-4'
          ? TMUX_REFLOW_DEBOUNCE_RIGHT_EVEN_TWO_COL_MS
          : TMUX_REFLOW_DEBOUNCE_MS,
      );
    });
  }

  // [CUSTOM] Cancel pending debounce requests and release waiters.
  private cancelPendingReflowRequest(): void {
    if (this.reflowTimer) {
      clearTimeout(this.reflowTimer);
      this.reflowTimer = undefined;
    }

    if (this.reflowWaiters.length > 0) {
      const waiters = this.reflowWaiters.splice(0);
      for (const done of waiters) {
        done();
      }
    }
  }

  // [CUSTOM] right-even-2col 阈值切换时执行一次即时重构。
  private async requestRightEvenTwoColBoundaryReflow(): Promise<void> {
    this.cancelPendingReflowRequest();

    await this.enqueueMutation(async () => {
      await this.applyLayoutNow(this.storedLayout, this.storedMainPaneSize);
    });
  }

  // [CUSTOM] Authoritative active panel count by layout strategy.
  private currentPanelPaneCount(): number {
    if (this.storedLayout === 'right-even-8') {
      return this.rightEvenPaneIds.length;
    }

    if (this.storedLayout === 'right-even-2col-4') {
      return (
        this.rightEvenTwoColPaneIds[0].length +
        this.rightEvenTwoColPaneIds[1].length
      );
    }

    return this.openPanelPaneCount;
  }

  // [CUSTOM] Panel capacity differs by layout strategy.
  private maxPanelPanes(): number {
    const layoutCap = this.layoutPanelCap();
    return Math.min(layoutCap, this.configuredMaxPanelPanes);
  }

  // [CUSTOM] Layout-intrinsic pane caps before user/global cap applies.
  private layoutPanelCap(): number {
    if (
      this.storedLayout === 'right-even-8' ||
      this.storedLayout === 'right-even-2col-4'
    ) {
      // [CUSTOM] right-even/right-even-2col 可见 pane 固定上限 8。
      return TMUX_MAX_PANEL_PANES_HARD_LIMIT;
    }

    // 2 columns × rows (rows in [2-5] => total [4-10]).
    return TMUX_PANEL_COLUMNS * this.panelRowsPerColumn;
  }

  // [CUSTOM] Build split plan for active pane layout mode.
  private async buildSplitPlan(
    tmux: string,
  ): Promise<
    | { mode: 'column'; column: 0 | 1; splitArgs: string[] }
    | { mode: 'right-even'; splitArgs: string[] }
    | { mode: 'right-even-2col'; column: 0 | 1; splitArgs: string[] }
    | null
  > {
    if (this.storedLayout === 'right-even-8') {
      const splitArgs = this.buildSplitArgsForRightEven();
      if (!splitArgs) {
        return null;
      }

      return { mode: 'right-even', splitArgs };
    }

    if (this.storedLayout === 'right-even-2col-4') {
      const plan = await this.buildSplitArgsForRightEvenTwoCol(tmux);
      if (!plan) {
        return null;
      }

      return { mode: 'right-even-2col', ...plan };
    }

    const column = this.resolveTargetColumn();
    const splitArgs = this.buildSplitArgsForColumn(column);
    if (!splitArgs) {
      return null;
    }

    return { mode: 'column', column, splitArgs };
  }

  // [CUSTOM] Fill column-1 first, then column-2.
  private resolveTargetColumn(): 0 | 1 {
    return this.paneIdsByColumn[0].length < this.panelRowsPerColumn ? 0 : 1;
  }

  // [CUSTOM] right-even: first split keeps right panel at 1/2, then stack.
  private buildSplitArgsForRightEven(): string[] | null {
    const count = this.currentPanelPaneCount();

    if (count === 0) {
      return [
        '-h',
        '-p',
        `${TMUX_RIGHT_EVEN_MAIN_PERCENT}`,
        ...this.targetArgs(),
      ];
    }

    const targetPaneId =
      this.rightEvenPaneIds[this.rightEvenPaneIds.length - 1];
    if (!targetPaneId) {
      return null;
    }

    return [
      '-v',
      '-p',
      `${TMUX_BINARY_SPLIT_PERCENT}`,
      ...this.targetArgsFor(targetPaneId),
    ];
  }

  // [CUSTOM] right-even-2col: split 路径为 <=3 过渡，4 为田字，5~8 先纵向追加。
  private async buildSplitArgsForRightEvenTwoCol(tmux: string): Promise<{
    column: 0 | 1;
    splitArgs: string[];
  } | null> {
    const count = this.currentPanelPaneCount();
    const geometries = await this.listKnownRightEvenTwoColPaneGeometries(tmux);

    if (count === 0) {
      return {
        column: 0,
        splitArgs: [
          '-h',
          '-p',
          `${TMUX_RIGHT_EVEN_MAIN_PERCENT}`,
          ...this.targetArgs(),
        ],
      };
    }

    if (count === 1) {
      const targetPaneId =
        this.pickRightEvenTwoColPaneByVerticalPosition(0, geometries, 'top') ??
        this.rightEvenTwoColPaneIds[0][0] ??
        null;
      if (!targetPaneId) {
        return null;
      }

      return {
        column: 0,
        splitArgs: [
          '-v',
          '-p',
          `${TMUX_BINARY_SPLIT_PERCENT}`,
          ...this.targetArgsFor(targetPaneId),
        ],
      };
    }

    if (count === 2 && this.rightEvenTwoColPaneIds[1].length === 0) {
      // [CUSTOM] 第 3 个 pane：横切 (-h) 上半区，分出右上。
      const topLeftPaneId =
        this.pickRightEvenTwoColPaneByVerticalPosition(0, geometries, 'top') ??
        this.rightEvenTwoColPaneIds[0][0] ??
        null;
      if (!topLeftPaneId) {
        return null;
      }

      return {
        column: 1,
        splitArgs: [
          '-h',
          '-p',
          `${TMUX_BINARY_SPLIT_PERCENT}`,
          ...this.targetArgsFor(topLeftPaneId),
        ],
      };
    }

    if (count === 3 && this.rightEvenTwoColPaneIds[1].length === 1) {
      // [CUSTOM] 第 4 个 pane：横切 (-h) 左列下半区，分出右下，补齐田字。
      const bottomLeftPaneId =
        this.pickRightEvenTwoColPaneByVerticalPosition(
          0,
          geometries,
          'bottom',
        ) ??
        this.rightEvenTwoColPaneIds[0][
          this.rightEvenTwoColPaneIds[0].length - 1
        ];
      if (!bottomLeftPaneId) {
        return null;
      }

      return {
        column: 1,
        splitArgs: [
          '-h',
          '-p',
          `${TMUX_BINARY_SPLIT_PERCENT}`,
          ...this.targetArgsFor(bottomLeftPaneId),
        ],
      };
    }

    // [CUSTOM] 第 5~8 个 pane：先在当前结构上纵向追加，随后由严格重构收敛。
    if (count >= TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD) {
      const targetPaneId =
        this.pickRightEvenTwoColPaneByVerticalPosition(
          0,
          geometries,
          'bottom',
        ) ??
        this.rightEvenTwoColPaneIds[0][
          this.rightEvenTwoColPaneIds[0].length - 1
        ];

      if (!targetPaneId) {
        return null;
      }

      return {
        column: 0,
        splitArgs: [
          '-v',
          '-p',
          `${TMUX_BINARY_SPLIT_PERCENT}`,
          ...this.targetArgsFor(targetPaneId),
        ],
      };
    }

    const column = this.resolveRightEvenTwoColTargetColumn();
    const targetPaneId =
      this.pickRightEvenTwoColTallestPaneInColumn(column, geometries) ??
      this.rightEvenTwoColPaneIds[column][
        this.rightEvenTwoColPaneIds[column].length - 1
      ];
    if (!targetPaneId) {
      return null;
    }

    return {
      column,
      splitArgs: [
        '-v',
        '-p',
        `${TMUX_BINARY_SPLIT_PERCENT}`,
        ...this.targetArgsFor(targetPaneId),
      ],
    };
  }

  // [CUSTOM] 依据实时几何位置在列内选最上/最下 pane。
  private pickRightEvenTwoColPaneByVerticalPosition(
    column: 0 | 1,
    geometries: PaneGeometry[],
    direction: 'top' | 'bottom',
  ): string | null {
    const panes = this.resolveRightEvenTwoColPaneGeometries(column, geometries);
    if (panes.length === 0) {
      return null;
    }

    panes.sort((a, b) => {
      if (a.top !== b.top) {
        return direction === 'top' ? a.top - b.top : b.top - a.top;
      }

      if (a.left !== b.left) {
        return a.left - b.left;
      }

      return b.height - a.height;
    });

    return panes[0]?.paneId ?? null;
  }

  // [CUSTOM] 选列内“最高”的 pane 做纵向切分，降低高度漂移。
  private pickRightEvenTwoColTallestPaneInColumn(
    column: 0 | 1,
    geometries: PaneGeometry[],
  ): string | null {
    const panes = this.resolveRightEvenTwoColPaneGeometries(column, geometries);
    if (panes.length === 0) {
      return null;
    }

    panes.sort((a, b) => {
      if (a.height !== b.height) {
        return b.height - a.height;
      }

      if (a.top !== b.top) {
        return a.top - b.top;
      }

      return a.left - b.left;
    });

    return panes[0]?.paneId ?? null;
  }

  // [CUSTOM] 读取某列已跟踪 pane 的实时几何信息。
  private resolveRightEvenTwoColPaneGeometries(
    column: 0 | 1,
    geometries: PaneGeometry[],
  ): PaneGeometry[] {
    if (geometries.length === 0) {
      return [];
    }

    const paneIds = new Set(this.rightEvenTwoColPaneIds[column]);
    return geometries.filter((pane) => paneIds.has(pane.paneId));
  }

  // [CUSTOM] 同步 right-even-2col pane 几何并清理失效 paneId。
  private async listKnownRightEvenTwoColPaneGeometries(
    tmux: string,
  ): Promise<PaneGeometry[]> {
    if (
      this.rightEvenTwoColPaneIds[0].length === 0 &&
      this.rightEvenTwoColPaneIds[1].length === 0
    ) {
      return [];
    }

    try {
      const proc = crossSpawn(
        [
          tmux,
          'list-panes',
          ...this.targetArgs(),
          '-F',
          '#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}',
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return [];
      }

      const stdout = await proc.stdout();
      const parsed = stdout
        .split('\n')
        .map((line) => this.parsePaneGeometryLine(line.trim()))
        .filter((pane): pane is PaneGeometry => pane !== null);

      if (parsed.length === 0) {
        return [];
      }

      const geometryByPaneId = new Map(
        parsed.map((pane) => [pane.paneId, pane]),
      );
      const nextColumns: [string[], string[]] = [
        this.rightEvenTwoColPaneIds[0].filter((paneId) =>
          geometryByPaneId.has(paneId),
        ),
        this.rightEvenTwoColPaneIds[1].filter((paneId) =>
          geometryByPaneId.has(paneId),
        ),
      ];

      this.rightEvenTwoColPaneIds = nextColumns;
      this.rightEvenTwoColColumnById.clear();
      for (const paneId of nextColumns[0]) {
        this.rightEvenTwoColColumnById.set(paneId, 0);
      }
      for (const paneId of nextColumns[1]) {
        this.rightEvenTwoColColumnById.set(paneId, 1);
      }
      this.openPanelPaneCount = nextColumns[0].length + nextColumns[1].length;

      return [...nextColumns[0], ...nextColumns[1]]
        .map((paneId) => geometryByPaneId.get(paneId))
        .filter((pane): pane is PaneGeometry => pane !== undefined);
    } catch {
      return [];
    }
  }

  // [CUSTOM] 对 right-even-2col 双列阶段执行列内高度均衡。
  private async rebalanceRightEvenTwoColHeights(tmux: string): Promise<void> {
    const geometries = await this.listKnownRightEvenTwoColPaneGeometries(tmux);
    if (geometries.length === 0) {
      return;
    }

    for (const column of [0, 1] as const) {
      const panes = this.resolveRightEvenTwoColPaneGeometries(
        column,
        geometries,
      ).sort((a, b) => {
        if (a.top !== b.top) {
          return a.top - b.top;
        }
        return a.left - b.left;
      });

      if (panes.length <= 1) {
        continue;
      }

      const totalHeight = panes.reduce((sum, pane) => sum + pane.height, 0);
      if (totalHeight <= 0) {
        continue;
      }

      const paneCount = panes.length;
      const baseHeight = Math.floor(totalHeight / paneCount);
      let remainder = totalHeight % paneCount;

      // [CUSTOM] 最后一个 pane 让 tmux 自然兜底，避免边界高度抖动。
      for (let index = 0; index < panes.length - 1; index += 1) {
        const pane = panes[index];
        if (!pane) {
          continue;
        }

        const targetHeight = baseHeight + (remainder > 0 ? 1 : 0);
        if (remainder > 0) {
          remainder -= 1;
        }

        if (targetHeight <= 0 || pane.height === targetHeight) {
          continue;
        }

        const resizeProc = crossSpawn(
          [tmux, 'resize-pane', '-t', pane.paneId, '-y', `${targetHeight}`],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        await resizeProc.exited;
      }
    }
  }

  // [CUSTOM] right-even-2col 在 5+ pane 时使用单列均分（按总数平均）。
  private async rebalanceRightEvenTwoColSingleColumn(
    tmux: string,
  ): Promise<void> {
    const beforeReflow =
      await this.listKnownRightEvenTwoColPaneGeometries(tmux);
    if (
      beforeReflow.length <= TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD
    ) {
      return;
    }

    const mainVerticalLayout = 'main-vertical';
    const mainPaneWidthPercent = `${100 - TMUX_RIGHT_EVEN_MAIN_PERCENT}%`;

    const selectLayoutProc = crossSpawn(
      [tmux, 'select-layout', ...this.targetArgs(), mainVerticalLayout],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    await selectLayoutProc.exited;

    const sizeProc = crossSpawn(
      [
        tmux,
        'set-window-option',
        ...this.targetArgs(),
        'main-pane-width',
        mainPaneWidthPercent,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    await sizeProc.exited;

    const reapplyProc = crossSpawn(
      [tmux, 'select-layout', ...this.targetArgs(), mainVerticalLayout],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    await reapplyProc.exited;

    // [CUSTOM] Reflow 后按几何顺序收敛到单列，避免后续 split 继续使用旧列映射。
    const afterReflow = await this.listKnownRightEvenTwoColPaneGeometries(tmux);
    if (afterReflow.length === 0) {
      return;
    }

    const orderedPaneIds = [...afterReflow]
      .sort((a, b) => {
        if (a.top !== b.top) {
          return a.top - b.top;
        }

        if (a.left !== b.left) {
          return a.left - b.left;
        }

        return a.paneId.localeCompare(b.paneId);
      })
      .map((pane) => pane.paneId);

    this.rightEvenTwoColPaneIds = [orderedPaneIds, []];
    this.rightEvenTwoColColumnById.clear();
    for (const paneId of orderedPaneIds) {
      this.rightEvenTwoColColumnById.set(paneId, 0);
    }
    this.openPanelPaneCount = orderedPaneIds.length;
  }

  // [CUSTOM] right-even-2col chooses the shorter column; ties prefer column-0.
  private resolveRightEvenTwoColTargetColumn(): 0 | 1 {
    const leftColumnCount = this.rightEvenTwoColPaneIds[0].length;
    const rightColumnCount = this.rightEvenTwoColPaneIds[1].length;
    return leftColumnCount <= rightColumnCount ? 0 : 1;
  }

  // [CUSTOM] Parse one list-panes geometry row.
  private parsePaneGeometryLine(line: string): PaneGeometry | null {
    if (!line) {
      return null;
    }

    const [paneId, left, top, width, height] = line.split('\t');
    if (!paneId || !left || !top || !width || !height) {
      return null;
    }

    const parsedLeft = Number.parseInt(left, 10);
    const parsedTop = Number.parseInt(top, 10);
    const parsedWidth = Number.parseInt(width, 10);
    const parsedHeight = Number.parseInt(height, 10);

    if (
      Number.isNaN(parsedLeft) ||
      Number.isNaN(parsedTop) ||
      Number.isNaN(parsedWidth) ||
      Number.isNaN(parsedHeight)
    ) {
      return null;
    }

    return {
      paneId,
      left: parsedLeft,
      top: parsedTop,
      width: parsedWidth,
      height: parsedHeight,
    };
  }

  // [CUSTOM] Column-aware split strategy to keep each column near one-third.
  private buildSplitArgsForColumn(column: 0 | 1): string[] | null {
    const paneIds = this.paneIdsByColumn[column];

    if (paneIds.length === 0) {
      // [CUSTOM] First pane in a column: horizontal split from main pane.
      const widthPercent =
        column === 0
          ? TMUX_PANEL_WIDTH_PERCENT
          : TMUX_SECOND_PANEL_FROM_MAIN_PERCENT;
      return ['-h', '-p', `${widthPercent}`, ...this.targetArgs()];
    }

    const targetPaneId = paneIds[paneIds.length - 1];
    if (!targetPaneId) {
      return null;
    }

    // [CUSTOM] Additional panes in a column stack vertically in that column.
    return ['-v', '-p', '50', ...this.targetArgsFor(targetPaneId)];
  }

  // [CUSTOM] Persist pane ownership for active split strategy.
  private trackPanelPane(
    paneId: string,
    plan:
      | { mode: 'column'; column: 0 | 1; splitArgs: string[] }
      | { mode: 'right-even'; splitArgs: string[] }
      | { mode: 'right-even-2col'; column: 0 | 1; splitArgs: string[] },
  ): void {
    if (plan.mode === 'right-even') {
      this.rightEvenPaneIds.push(paneId);
      this.openPanelPaneCount = this.rightEvenPaneIds.length;
      return;
    }

    if (plan.mode === 'right-even-2col') {
      this.rightEvenTwoColColumnById.set(paneId, plan.column);
      this.rightEvenTwoColPaneIds[plan.column].push(paneId);
      this.openPanelPaneCount =
        this.rightEvenTwoColPaneIds[0].length +
        this.rightEvenTwoColPaneIds[1].length;
      return;
    }

    const column = plan.column;
    this.paneColumnById.set(paneId, column);
    this.paneIdsByColumn[column].push(paneId);
    this.openPanelPaneCount += 1;
  }

  // [CUSTOM] Remove pane ownership and keep counters consistent.
  private untrackPanelPane(paneId: string): boolean {
    if (this.storedLayout === 'right-even-8') {
      return this.untrackRightEvenPane(paneId);
    }

    if (this.storedLayout === 'right-even-2col-4') {
      return this.untrackRightEvenTwoColPane(paneId);
    }

    const column = this.paneColumnById.get(paneId);
    if (column === undefined) {
      return false;
    }

    this.paneColumnById.delete(paneId);

    const paneIds = this.paneIdsByColumn[column];
    const index = paneIds.indexOf(paneId);
    if (index >= 0) {
      paneIds.splice(index, 1);
    }

    if (this.openPanelPaneCount > 0) {
      this.openPanelPaneCount -= 1;
    }

    if (
      this.paneIdsByColumn[0].length === 0 &&
      this.paneIdsByColumn[1].length
    ) {
      // [CUSTOM] Compact remaining panes back to column-1 after removals.
      const movedPaneIds = [...this.paneIdsByColumn[1]];
      this.paneIdsByColumn = [movedPaneIds, []];
      for (const id of movedPaneIds) {
        this.paneColumnById.set(id, 0);
      }
    }

    if (this.openPanelPaneCount === 0) {
      // [CUSTOM] Reset bookkeeping to avoid stale pane references.
      this.rightEvenPaneIds = [];
      this.rightEvenTwoColColumnById.clear();
      this.rightEvenTwoColPaneIds = [[], []];
      this.rightEvenTwoColInSingleColumnPhase = false;
      this.paneColumnById.clear();
      this.paneIdsByColumn = [[], []];
    }

    return true;
  }

  // [CUSTOM] Remove right-even pane ownership and keep counters consistent.
  private untrackRightEvenPane(paneId: string): boolean {
    const index = this.rightEvenPaneIds.indexOf(paneId);
    if (index < 0) {
      return false;
    }

    this.rightEvenPaneIds.splice(index, 1);
    this.openPanelPaneCount = this.rightEvenPaneIds.length;

    if (this.rightEvenPaneIds.length === 0) {
      this.rightEvenPaneIds = [];
      this.rightEvenTwoColColumnById.clear();
      this.rightEvenTwoColPaneIds = [[], []];
      this.rightEvenTwoColInSingleColumnPhase = false;
      this.paneColumnById.clear();
      this.paneIdsByColumn = [[], []];
    }

    return true;
  }

  // [CUSTOM] Remove right-even-2col pane ownership with column compaction.
  private untrackRightEvenTwoColPane(paneId: string): boolean {
    const column = this.rightEvenTwoColColumnById.get(paneId);
    if (column === undefined) {
      return false;
    }

    this.rightEvenTwoColColumnById.delete(paneId);
    const paneIds = this.rightEvenTwoColPaneIds[column];
    const index = paneIds.indexOf(paneId);
    if (index >= 0) {
      paneIds.splice(index, 1);
    }

    if (
      this.rightEvenTwoColPaneIds[0].length === 0 &&
      this.rightEvenTwoColPaneIds[1].length > 0
    ) {
      // [CUSTOM] Keep remaining panes in column-0 after left column drains.
      const movedPaneIds = [...this.rightEvenTwoColPaneIds[1]];
      this.rightEvenTwoColPaneIds = [movedPaneIds, []];
      this.rightEvenTwoColColumnById.clear();
      for (const id of movedPaneIds) {
        this.rightEvenTwoColColumnById.set(id, 0);
      }
    }

    this.openPanelPaneCount =
      this.rightEvenTwoColPaneIds[0].length +
      this.rightEvenTwoColPaneIds[1].length;

    if (this.openPanelPaneCount === 0) {
      this.rightEvenTwoColColumnById.clear();
      this.rightEvenTwoColPaneIds = [[], []];
      this.rightEvenTwoColInSingleColumnPhase = false;
      this.rightEvenPaneIds = [];
      this.paneColumnById.clear();
      this.paneIdsByColumn = [[], []];
    }

    return true;
  }

  // [CUSTOM] Count currently active panel columns (0-2).
  private activePanelColumnCount(): number {
    let count = 0;
    if (this.paneIdsByColumn[0].length > 0) {
      count += 1;
    }
    if (this.paneIdsByColumn[1].length > 0) {
      count += 1;
    }
    return count;
  }

  // [CUSTOM] Hide status bar before the first subagent panel opens.
  private async hideStatusBarNow(tmux: string): Promise<void> {
    if (this.statusHiddenByPlugin) {
      return;
    }

    const statusValue = await this.readStatusOption(tmux);
    this.statusBeforePanel = statusValue;

    if (statusValue === 'off' || statusValue === '0') {
      return;
    }

    const hidden = await this.setStatusOption(tmux, 'off');
    if (hidden) {
      this.statusHiddenByPlugin = true;
      log('[tmux] status bar hidden for subagent panel');
    }
  }

  // [CUSTOM] Restore status bar when the last subagent panel closes.
  private async restoreStatusBarNow(tmux: string): Promise<void> {
    if (!this.statusHiddenByPlugin) {
      return;
    }

    const restoreValue = this.statusBeforePanel ?? 'on';
    const restored = await this.setStatusOption(tmux, restoreValue);
    if (restored) {
      this.statusHiddenByPlugin = false;
      this.statusBeforePanel = null;
      log('[tmux] status bar restored after subagent panel closed');
    }
  }

  // [CUSTOM] Read status option so we can restore user preference safely.
  private async readStatusOption(tmux: string): Promise<string | null> {
    for (const targetArgs of this.statusTargetCandidates()) {
      const localValue = await this.readStatusOptionForTarget(
        tmux,
        targetArgs,
        false,
      );
      if (localValue !== null) {
        return localValue;
      }

      const globalValue = await this.readStatusOptionForTarget(
        tmux,
        targetArgs,
        true,
      );
      if (globalValue !== null) {
        return globalValue;
      }
    }

    return null;
  }

  // [CUSTOM] Try status reads against pane-target then fallback default target.
  private statusTargetCandidates(): string[][] {
    const targetedArgs = this.targetArgs();
    if (targetedArgs.length === 0) {
      return [[]];
    }
    return [targetedArgs, []];
  }

  // [CUSTOM] Read status option for one target and scope.
  private async readStatusOptionForTarget(
    tmux: string,
    targetArgs: string[],
    global: boolean,
  ): Promise<string | null> {
    try {
      const scopeFlag = global ? '-gv' : '-v';
      const proc = crossSpawn(
        [tmux, 'show-options', scopeFlag, ...targetArgs, 'status'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return null;
      }

      const stdout = await proc.stdout();
      const value = stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  // [CUSTOM] Set status option with fallback target for robustness.
  private async setStatusOption(tmux: string, value: string): Promise<boolean> {
    for (const targetArgs of this.statusTargetCandidates()) {
      const proc = crossSpawn(
        [tmux, 'set-option', '-q', ...targetArgs, 'status', value],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        return true;
      }
    }

    return false;
  }

  // [CUSTOM] Centralized low-level layout application for tmux commands.
  private async applyLayoutNow(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    const tmux = await this.getBinary();
    if (!tmux) return;

    if (layout === 'right-even-2col-4') {
      // [CUSTOM] 5+ 阶段在重构路径按总数均分（单列），避免高度长期偏斜。
      if (
        this.currentPanelPaneCount() >
        TMUX_RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD
      ) {
        await this.rebalanceRightEvenTwoColSingleColumn(tmux);
        return;
      }

      // [CUSTOM] 双列阶段跳过 tmux preset，避免被压扁。
      await this.rebalanceRightEvenTwoColHeights(tmux);
      return;
    }

    // [CUSTOM] right-even 复用 tmux main-vertical 的均分行为。
    const tmuxLayout: MultiplexerLayout =
      layout === 'right-even-8' ? 'main-vertical' : layout;

    const activePanelColumns = this.activePanelColumnCount();

    if (layout === 'main-vertical' && activePanelColumns > 1) {
      // [CUSTOM] Avoid flattening 2-column panel back to a single right stack.
      log('[tmux] applyLayout: skip main-vertical reflow for 2-column panel', {
        activePanelColumns,
      });
      return;
    }

    try {
      // Apply the layout
      const layoutProc = crossSpawn(
        [tmux, 'select-layout', ...this.targetArgs(), tmuxLayout],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      await layoutProc.exited;

      // [CUSTOM] Keep custom right-panel layouts at fixed target widths.
      const effectiveMainPaneSize =
        layout === 'main-vertical' && this.openPanelPaneCount > 0
          ? 100 - TMUX_PANEL_WIDTH_PERCENT
          : layout === 'right-even-8' && this.currentPanelPaneCount() > 0
            ? 100 - TMUX_RIGHT_EVEN_MAIN_PERCENT
            : mainPaneSize;

      // For main-* layouts, set the main pane size
      if (tmuxLayout === 'main-horizontal' || tmuxLayout === 'main-vertical') {
        const sizeOption =
          tmuxLayout === 'main-horizontal'
            ? 'main-pane-height'
            : 'main-pane-width';

        const sizeProc = crossSpawn(
          [
            tmux,
            'set-window-option',
            ...this.targetArgs(),
            sizeOption,
            `${effectiveMainPaneSize}%`,
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        await sizeProc.exited;

        // Reapply layout to use the new size
        const reapplyProc = crossSpawn(
          [tmux, 'select-layout', ...this.targetArgs(), tmuxLayout],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        await reapplyProc.exited;
      }

      log('[tmux] applyLayout: applied', {
        layout,
        tmuxLayout,
        mainPaneSize,
        effectiveMainPaneSize,
      });
    } catch (err) {
      log('[tmux] applyLayout: exception', { error: String(err) });
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private targetArgs(): string[] {
    return this.targetPane ? ['-t', this.targetPane] : [];
  }

  // [CUSTOM] Build target args for pane-specific split operations.
  private targetArgsFor(paneId: string): string[] {
    return paneId ? ['-t', paneId] : this.targetArgs();
  }

  private async findBinary(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';

    try {
      const proc = crossSpawn([cmd, 'tmux'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log("[tmux] findBinary: 'which tmux' failed", { exitCode });
        return null;
      }

      const stdout = await proc.stdout();
      const path = stdout.trim().split('\n')[0];
      if (!path) {
        log('[tmux] findBinary: no path in output');
        return null;
      }

      // Verify it works
      const verifyProc = crossSpawn([path, '-V'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const verifyExit = await verifyProc.exited;
      if (verifyExit !== 0) {
        log('[tmux] findBinary: tmux -V failed', { path, verifyExit });

        // [CUSTOM] If shim path cannot verify directly, try PATH tmux fallback.
        if (path !== 'tmux') {
          const fallbackProc = crossSpawn(['tmux', '-V'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const fallbackExit = await fallbackProc.exited;
          if (fallbackExit === 0) {
            log('[tmux] findBinary: fallback succeeded', { path: 'tmux' });
            return 'tmux';
          }
        }

        return null;
      }

      log('[tmux] findBinary: found', { path });
      return path;
    } catch (err) {
      log('[tmux] findBinary: exception', { error: String(err) });
      return null;
    }
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
