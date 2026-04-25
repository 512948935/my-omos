/**
 * Tmux multiplexer implementation
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';

// [CUSTOM] Coalesce bursty layout updates to reduce tmux flicker.
const TMUX_REFLOW_DEBOUNCE_MS = 120;
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
// [CUSTOM] Right-binary layout always uses even 1/2 splits.
const TMUX_BINARY_SPLIT_PERCENT = 50;

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
  // [CUSTOM] In right-binary layout, keep deterministic pane spawn order.
  private binaryPaneIds: string[] = [];

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
      const splitPlan = this.buildSplitPlan();

      try {
        // [CUSTOM] Cap panel capacity based on active layout strategy.
        if (this.openPanelPaneCount >= this.maxPanelPanes()) {
          log('[tmux] spawnPane: panel capacity reached, skipping pane spawn', {
            openPanelPaneCount: this.openPanelPaneCount,
            maxPanelPanes: this.maxPanelPanes(),
            panelRowsPerColumn: this.panelRowsPerColumn,
          });
          return { success: false, reason: 'capacity' };
        }

        // [CUSTOM] Ensure tmux status bar is hidden before opening panels.
        if (shouldEnsureStatusHidden) {
          await this.hideStatusBarNow(tmux);
        }

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
            openPanelPaneCount: this.openPanelPaneCount,
            paneIdsByColumn: this.paneIdsByColumn,
            binaryPaneIds: this.binaryPaneIds,
          });
          if (this.openPanelPaneCount === 0) {
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
        if (this.openPanelPaneCount === 0) {
          await this.restoreStatusBarNow(tmux);
        }

        return { success: false, reason: 'error' };
      } catch (err) {
        if (this.openPanelPaneCount === 0) {
          await this.restoreStatusBarNow(tmux);
        }
        log('[tmux] spawnPane: exception', { error: String(err) });
        return { success: false, reason: 'error' };
      }
    });

    if (paneResult.success && paneResult.paneId) {
      // [CUSTOM] Coalesce layout updates instead of immediate per-spawn reflow.
      void this.requestReflow();
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
      const unregisterTrackedPane = () => {
        const removed = this.untrackPanelPane(paneId);
        if (removed) {
          paneCountAdjusted = true;
          return true;
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
          unregisterTrackedPane();

          if (this.openPanelPaneCount === 0) {
            // [CUSTOM] Restore status bar after the last panel closes.
            await this.restoreStatusBarNow(tmux);
          }

          return true;
        }

        // Pane might already be closed
        log('[tmux] closePane: failed (pane may already be closed)', {
          paneId,
        });

        unregisterTrackedPane();

        if (this.openPanelPaneCount === 0) {
          // [CUSTOM] Restore status bar after the last panel closes.
          await this.restoreStatusBarNow(tmux);
        }

        return false;
      } catch (err) {
        unregisterTrackedPane();

        if (this.openPanelPaneCount === 0) {
          // [CUSTOM] Restore status bar after the last panel closes.
          await this.restoreStatusBarNow(tmux);
        }

        log('[tmux] closePane: exception', { error: String(err) });
        return false;
      }
    });

    if (closed || paneCountAdjusted) {
      // [CUSTOM] Coalesce layout updates instead of immediate per-close reflow.
      void this.requestReflow();
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

    await this.requestReflow();
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

      this.reflowTimer = setTimeout(() => {
        this.reflowTimer = undefined;
        const waiters = this.reflowWaiters.splice(0);

        void this.enqueueMutation(async () => {
          await this.applyLayoutNow(this.storedLayout, this.storedMainPaneSize);
        }).finally(() => {
          for (const done of waiters) {
            done();
          }
        });
      }, TMUX_REFLOW_DEBOUNCE_MS);
    });
  }

  // [CUSTOM] Panel capacity differs by layout strategy.
  private maxPanelPanes(): number {
    const layoutCap = this.layoutPanelCap();
    return Math.min(layoutCap, this.configuredMaxPanelPanes);
  }

  // [CUSTOM] Layout-intrinsic pane caps before user/global cap applies.
  private layoutPanelCap(): number {
    if (this.storedLayout === 'right-binary-8') {
      // [CUSTOM] right-binary 可见 pane 固定上限 8。
      return TMUX_MAX_PANEL_PANES_HARD_LIMIT;
    }

    // 2 columns × rows (rows in [2-5] => total [4-10]).
    return TMUX_PANEL_COLUMNS * this.panelRowsPerColumn;
  }

  // [CUSTOM] Build split plan for either column mode or right-binary mode.
  private buildSplitPlan():
    | { mode: 'column'; column: 0 | 1; splitArgs: string[] }
    | { mode: 'binary'; splitArgs: string[] }
    | null {
    if (this.storedLayout === 'right-binary-8') {
      const splitArgs = this.buildSplitArgsForRightBinary();
      if (!splitArgs) {
        return null;
      }

      return { mode: 'binary', splitArgs };
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

  // [CUSTOM] Right-binary layout: 1 -> 2 -> 4 -> 8.
  private buildSplitArgsForRightBinary(): string[] | null {
    const count = this.openPanelPaneCount;

    if (count === 0) {
      // First pane: split from main pane, left/right = 1/2.
      return ['-h', '-p', `${TMUX_BINARY_SPLIT_PERCENT}`, ...this.targetArgs()];
    }

    if (count === 1) {
      // Second pane: split right half into top/bottom.
      const target = this.pickBinaryTarget(0);
      return target
        ? ['-v', '-p', `${TMUX_BINARY_SPLIT_PERCENT}`, ...this.targetArgsFor(target)]
        : null;
    }

    if (count === 2) {
      // Third pane: split top half horizontally.
      const target = this.pickBinaryTarget(0);
      return target
        ? ['-h', '-p', `${TMUX_BINARY_SPLIT_PERCENT}`, ...this.targetArgsFor(target)]
        : null;
    }

    if (count === 3) {
      // Fourth pane: split bottom half horizontally => 2x2 (田字).
      const target = this.pickBinaryTarget(1);
      return target
        ? ['-h', '-p', `${TMUX_BINARY_SPLIT_PERCENT}`, ...this.targetArgsFor(target)]
        : null;
    }

    // [CUSTOM] 首个田字后（第 5~8 个 pane）按“上下 1/2”扩展。
    // [CUSTOM] 扩展顺序按行优先：TL -> TR -> BL -> BR。
    const targetIndex = this.resolveBinaryVerticalTargetIndex(count);
    const target = this.pickBinaryTarget(targetIndex);
    return target
      ? ['-v', '-p', `${TMUX_BINARY_SPLIT_PERCENT}`, ...this.targetArgsFor(target)]
      : null;
  }

  // [CUSTOM] 解析右侧“上下 1/2”扩展的目标索引顺序。
  private resolveBinaryVerticalTargetIndex(count: number): number {
    if (count >= 4 && count < 8) {
      const firstExpansionOrder = [0, 2, 1, 3];
      return firstExpansionOrder[count - 4] ?? count - 4;
    }

    return count - 4;
  }

  // [CUSTOM] Pick deterministic split target, with safe fallback.
  private pickBinaryTarget(preferredIndex: number): string | null {
    const preferred = this.binaryPaneIds[preferredIndex];
    if (preferred) {
      return preferred;
    }

    return this.binaryPaneIds[this.binaryPaneIds.length - 1] ?? null;
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
      | { mode: 'binary'; splitArgs: string[] },
  ): void {
    if (plan.mode === 'binary') {
      this.binaryPaneIds.push(paneId);
      this.openPanelPaneCount += 1;
      return;
    }

    const column = plan.column;
    this.paneColumnById.set(paneId, column);
    this.paneIdsByColumn[column].push(paneId);
    this.openPanelPaneCount += 1;
  }

  // [CUSTOM] Remove pane ownership and keep counters consistent.
  private untrackPanelPane(paneId: string): boolean {
    if (this.storedLayout === 'right-binary-8') {
      return this.untrackBinaryPane(paneId);
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

    if (this.paneIdsByColumn[0].length === 0 && this.paneIdsByColumn[1].length) {
      // [CUSTOM] Compact remaining panes back to column-1 after removals.
      const movedPaneIds = [...this.paneIdsByColumn[1]];
      this.paneIdsByColumn = [movedPaneIds, []];
      for (const id of movedPaneIds) {
        this.paneColumnById.set(id, 0);
      }
    }

    if (this.openPanelPaneCount === 0) {
      // [CUSTOM] Reset bookkeeping to avoid stale pane references.
      this.binaryPaneIds = [];
      this.paneColumnById.clear();
      this.paneIdsByColumn = [[], []];
    }

    return true;
  }

  // [CUSTOM] Remove right-binary pane ownership and keep counters consistent.
  private untrackBinaryPane(paneId: string): boolean {
    const index = this.binaryPaneIds.indexOf(paneId);
    if (index < 0) {
      return false;
    }

    this.binaryPaneIds.splice(index, 1);

    if (this.openPanelPaneCount > 0) {
      this.openPanelPaneCount -= 1;
    }

    if (this.openPanelPaneCount === 0) {
      this.binaryPaneIds = [];
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

    if (layout === 'right-binary-8') {
      // [CUSTOM] Right-binary uses explicit split targets; skip tmux presets.
      return;
    }

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
        [tmux, 'select-layout', ...this.targetArgs(), layout],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      await layoutProc.exited;

      // [CUSTOM] Keep right-side panel at one-third when using main-vertical.
      const effectiveMainPaneSize =
        layout === 'main-vertical' && this.openPanelPaneCount > 0
          ? 100 - TMUX_PANEL_WIDTH_PERCENT
          : mainPaneSize;

      // For main-* layouts, set the main pane size
      if (layout === 'main-horizontal' || layout === 'main-vertical') {
        const sizeOption =
          layout === 'main-horizontal' ? 'main-pane-height' : 'main-pane-width';

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
          [tmux, 'select-layout', ...this.targetArgs(), layout],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        await reapplyProc.exited;
      }

      log('[tmux] applyLayout: applied', {
        layout,
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
