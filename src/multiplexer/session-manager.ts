import type { PluginInput } from '@opencode-ai/plugin';
import { POLL_INTERVAL_BACKGROUND_MS } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getMultiplexer,
  isServerRunning,
  type Multiplexer,
} from '../multiplexer';
import { log } from '../utils/logger';

type OpencodeClient = PluginInput['client'];

interface TrackedSession {
  sessionId: string;
  paneId: string;
  parentId: string;
  title: string;
  directory: string;
  createdAt: number;
  lastSeenAt: number;
  missingSince?: number;
}

interface KnownSession {
  parentId: string;
  title: string;
  directory: string;
}

type SpawnAttemptResult = 'spawned' | 'capacity' | 'failed' | 'skipped';

interface SessionEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
      parentID?: string;
      title?: string;
      directory?: string;
    };
    sessionID?: string;
    status?: { type: string };
  };
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_MISSING_GRACE_MS = POLL_INTERVAL_BACKGROUND_MS * 3;
const RIGHT_EVEN_TWO_COL_LAYOUT = 'right-even-2col-4' as const;
const RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD = 4;
const STRUCTURED_LAYOUT_REBALANCE_WAIT_MS = 30;
// [CUSTOM] 阈值重建防抖窗口：3 秒内最多触发一次。
const STRUCTURED_LAYOUT_REBALANCE_DEBOUNCE_MS = 3000;

/**
 * Tracks child sessions and spawns/closes multiplexer panes for them.
 *
 * Uses session.status events for completion detection instead of polling,
 * with polling kept as a fallback for reliability.
 */
export class MultiplexerSessionManager {
  private client: OpencodeClient;
  private serverUrl: string;
  private directory: string;
  private multiplexer: Multiplexer | null = null;
  private multiplexerLayout: MultiplexerConfig['layout'];
  private sessions = new Map<string, TrackedSession>();
  private knownSessions = new Map<string, KnownSession>();
  // [CUSTOM] Track in-flight/queued spawn by token to avoid cross-release races.
  private spawningSessions = new Map<string, number>();
  private nextSpawnToken = 1;
  // [CUSTOM] Serialize pane spawn pipeline to keep spawn order stable.
  private spawnOperationQueue: Promise<void> = Promise.resolve();
  // [CUSTOM] Deduplicate concurrent close requests for the same session.
  private closingSessions = new Set<string>();
  // [CUSTOM] Queue sessions waiting for pane capacity.
  private pendingQueue: string[] = [];
  private pendingSessionIds = new Set<string>();
  private drainingPendingQueue = false;
  // [CUSTOM] Guard against nested structured-layout rebalance cycles.
  private rebalancingStructuredLayout = false;
  // [CUSTOM] Debounce structured-layout rebalance under rapid churn.
  private structuredRebalanceTimer: ReturnType<typeof setTimeout> | undefined;
  private structuredRebalanceWaiters: Array<() => void> = [];
  // [CUSTOM] Track structured-layout close pipelines before rebalance is scheduled.
  private structuredRebalancePendingClosures = 0;
  private pollInterval?: ReturnType<typeof setInterval>;
  private enabled = false;

  constructor(ctx: PluginInput, config: MultiplexerConfig) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    const defaultPort = process.env.OPENCODE_PORT ?? '4096';
    this.serverUrl =
      ctx.serverUrl?.toString() ?? `http://localhost:${defaultPort}`;

    this.multiplexer = getMultiplexer(config);
    this.multiplexerLayout = config.layout;
    this.enabled =
      config.type !== 'none' &&
      this.multiplexer !== null &&
      this.multiplexer.isInsideSession();

    log('[multiplexer-session-manager] initialized', {
      enabled: this.enabled,
      type: config.type,
      serverUrl: this.serverUrl,
    });
  }

  async onSessionCreated(event: SessionEvent): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (event.type !== 'session.created') return;

    const info = event.properties?.info;
    if (!info?.id || !info?.parentID) {
      return;
    }

    const sessionId = info.id;
    const parentId = info.parentID;
    const title = info.title ?? 'Subagent';
    const directory = info.directory ?? this.directory;
    const knownSession: KnownSession = {
      parentId,
      title,
      directory,
    };

    this.knownSessions.set(sessionId, knownSession);

    if (this.isTrackedOrSpawning(sessionId)) {
      log('[multiplexer-session-manager] session already tracked or spawning', {
        sessionId,
      });
      return;
    }

    const result = await this.spawnKnownSession(
      sessionId,
      knownSession,
      'created',
    );

    if (result === 'capacity') {
      this.enqueuePendingSession(sessionId);
    }
  }

  async onSessionStatus(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    if (event.properties?.status?.type === 'idle') {
      // [CUSTOM] If a queued session finishes before display, drop it.
      this.dequeuePendingSession(sessionId);
      await this.closeSession(sessionId);
      await this.drainPendingQueue();
      return;
    }

    if (event.properties?.status?.type === 'busy') {
      if (this.pendingSessionIds.has(sessionId)) {
        await this.drainPendingQueue();
        return;
      }

      await this.respawnIfKnown(sessionId);
    }
  }

  async onSessionDeleted(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.deleted') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    log('[multiplexer-session-manager] session deleted, closing pane', {
      sessionId,
    });

    this.dequeuePendingSession(sessionId);
    await this.closeSession(sessionId);
    this.knownSessions.delete(sessionId);
    await this.drainPendingQueue();
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(
      () => this.pollSessions(),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    log('[multiplexer-session-manager] polling started');
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      log('[multiplexer-session-manager] polling stopped');
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      this.stopPolling();
      return;
    }

    try {
      const statusResult = await this.client.session.status();
      const allStatuses = (statusResult.data ?? {}) as Record<
        string,
        { type: string }
      >;

      const now = Date.now();
      const sessionsToClose: string[] = [];

      for (const [sessionId, tracked] of this.sessions.entries()) {
        const status = allStatuses[sessionId];
        const isIdle = status?.type === 'idle';

        if (status) {
          tracked.lastSeenAt = now;
          tracked.missingSince = undefined;
        } else if (!tracked.missingSince) {
          tracked.missingSince = now;
        }

        const missingTooLong =
          !!tracked.missingSince &&
          now - tracked.missingSince >= SESSION_MISSING_GRACE_MS;
        const isTimedOut = now - tracked.createdAt > SESSION_TIMEOUT_MS;

        if (isIdle || missingTooLong || isTimedOut) {
          sessionsToClose.push(sessionId);
        }
      }

      for (const sessionId of sessionsToClose) {
        await this.closeSession(sessionId);
      }
    } catch (err) {
      log('[multiplexer-session-manager] poll error', { error: String(err) });
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    if (this.closingSessions.has(sessionId)) {
      return;
    }

    this.closingSessions.add(sessionId);
    const shouldGuardStructuredChurn = this.shouldRebalanceStructuredLayout();
    let releasedStructuredGuard = false;
    if (shouldGuardStructuredChurn) {
      this.structuredRebalancePendingClosures += 1;
    }

    try {
      // [CUSTOM] 等待结构化布局重排完成，避免使用重排中的过期 paneId。
      await this.waitForStructuredRebalance();

      const tracked = this.sessions.get(sessionId);
      if (!tracked || !this.multiplexer) return;

      log('[multiplexer-session-manager] closing session pane', {
        sessionId,
        paneId: tracked.paneId,
      });

      const trackedCountBeforeClose = this.sessions.size;
      await this.multiplexer.closePane(tracked.paneId);
      this.sessions.delete(sessionId);

      const trackedCountAfterClose = this.sessions.size;

      if (
        shouldGuardStructuredChurn &&
        this.structuredRebalancePendingClosures > 0
      ) {
        // [CUSTOM] closePane 已完成，释放 close 流水线守卫，允许后续 spawn 判定是否取消待执行重建。
        this.structuredRebalancePendingClosures -= 1;
        releasedStructuredGuard = true;
      }

      const shouldRebalanceForLayout =
        this.shouldScheduleStructuredRebalanceOnClose(
          trackedCountBeforeClose,
          trackedCountAfterClose,
        );

      const shouldSkipStructuredRebalance =
        shouldRebalanceForLayout &&
        trackedCountBeforeClose === trackedCountAfterClose + 1 &&
        this.pendingQueue.length > 0 &&
        trackedCountAfterClose > 0;

      if (shouldSkipStructuredRebalance) {
        // [CUSTOM] 数量将被 queue 立即补齐时，避免反复重建同一布局。
        log(
          '[multiplexer-session-manager] skip structured rebalance on backfill',
          {
            sessionId,
            trackedCountBeforeClose,
            trackedCountAfterClose,
            pendingQueueLength: this.pendingQueue.length,
          },
        );
      } else if (shouldRebalanceForLayout) {
        // [CUSTOM] 结构化布局在 pane 变动后做防抖重建，降低快速切换抖动。
        await this.requestStructuredLayoutRebalance();
      } else {
        // [CUSTOM] right-even-2col-4 仅在 5->4 阈值回落时触发重建。
        log(
          '[multiplexer-session-manager] skip structured rebalance on non-threshold close',
          {
            sessionId,
            trackedCountBeforeClose,
            trackedCountAfterClose,
            layout: this.multiplexerLayout,
          },
        );
      }

      if (this.sessions.size === 0) {
        this.stopPolling();
      }

      await this.drainPendingQueue();
    } finally {
      if (
        shouldGuardStructuredChurn &&
        !releasedStructuredGuard &&
        this.structuredRebalancePendingClosures > 0
      ) {
        this.structuredRebalancePendingClosures -= 1;
      }
      this.closingSessions.delete(sessionId);
    }
  }

  // [CUSTOM] Whether we should rebuild pane placement for structured layouts.
  private shouldRebalanceStructuredLayout(): boolean {
    return this.multiplexerLayout === RIGHT_EVEN_TWO_COL_LAYOUT;
  }

  // [CUSTOM] Structured rebalance on close: 2col only on 5->4 threshold crossing.
  private shouldScheduleStructuredRebalanceOnClose(
    trackedCountBeforeClose: number,
    trackedCountAfterClose: number,
  ): boolean {
    if (this.multiplexerLayout === RIGHT_EVEN_TWO_COL_LAYOUT) {
      return (
        trackedCountBeforeClose > RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD &&
        trackedCountAfterClose <= RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD
      );
    }

    return false;
  }

  // [CUSTOM] Block churn handling until structured-layout rebalance finishes.
  private async waitForStructuredRebalance(
    includeScheduled = false,
  ): Promise<void> {
    if (!this.shouldRebalanceStructuredLayout()) return;

    while (
      this.rebalancingStructuredLayout ||
      (includeScheduled &&
        (!!this.structuredRebalanceTimer ||
          this.structuredRebalancePendingClosures > 0))
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, STRUCTURED_LAYOUT_REBALANCE_WAIT_MS),
      );
    }
  }

  // [CUSTOM] Wait close pipelines to settle before deciding debounce-cancel.
  private async waitForStructuredClosePipelines(): Promise<void> {
    if (!this.shouldRebalanceStructuredLayout()) return;

    while (this.structuredRebalancePendingClosures > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, STRUCTURED_LAYOUT_REBALANCE_WAIT_MS),
      );
    }
  }

  // [CUSTOM] Clear pending structured-layout rebalance debounce requests.
  private cancelStructuredLayoutRebalanceRequest(): void {
    if (this.structuredRebalanceTimer) {
      clearTimeout(this.structuredRebalanceTimer);
      this.structuredRebalanceTimer = undefined;
    }

    if (this.structuredRebalanceWaiters.length > 0) {
      const waiters = this.structuredRebalanceWaiters.splice(0);
      for (const done of waiters) {
        done();
      }
    }
  }

  // [CUSTOM] Serialize pane spawn operations to preserve create ordering.
  private async runSerializedSpawnOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.spawnOperationQueue;
    let releaseCurrent!: () => void;

    this.spawnOperationQueue = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent();
    }
  }

  // [CUSTOM] Debounced request to rebuild structured layouts.
  private requestStructuredLayoutRebalance(): Promise<void> {
    if (!this.shouldRebalanceStructuredLayout()) {
      return Promise.resolve();
    }

    if (this.sessions.size <= 1) {
      this.cancelStructuredLayoutRebalanceRequest();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.structuredRebalanceWaiters.push(resolve);

      if (this.structuredRebalanceTimer) {
        clearTimeout(this.structuredRebalanceTimer);
      }

      this.structuredRebalanceTimer = setTimeout(() => {
        this.structuredRebalanceTimer = undefined;
        const waiters = this.structuredRebalanceWaiters.splice(0);

        void this.rebalanceStructuredLayoutIfNeeded().finally(() => {
          for (const done of waiters) {
            done();
          }
        });
      }, STRUCTURED_LAYOUT_REBALANCE_DEBOUNCE_MS);
    });
  }

  // [CUSTOM] 5->4 后若马上有新会话补回 >4，取消待执行重建，避免来回闪烁。
  private maybeCancelScheduledStructuredRebalanceBeforeSpawn(): void {
    if (!this.shouldRebalanceStructuredLayout()) {
      return;
    }

    if (!this.structuredRebalanceTimer || this.rebalancingStructuredLayout) {
      return;
    }

    // [CUSTOM] 关闭流程尚未结束时，仍保持等待，避免与 close 交错。
    if (this.structuredRebalancePendingClosures > 0) {
      return;
    }

    const projectedCountAfterSpawn = this.sessions.size + 1;
    if (
      projectedCountAfterSpawn <= RIGHT_EVEN_TWO_COL_SINGLE_COLUMN_THRESHOLD
    ) {
      return;
    }

    log(
      '[multiplexer-session-manager] cancel scheduled structured rebalance before spawn',
      {
        currentCount: this.sessions.size,
        projectedCountAfterSpawn,
      },
    );

    this.cancelStructuredLayoutRebalanceRequest();
  }

  // [CUSTOM] Rebuild remaining structured-layout panes to canonical splits.
  private async rebalanceStructuredLayoutIfNeeded(): Promise<void> {
    if (!this.multiplexer) return;
    if (!this.shouldRebalanceStructuredLayout()) return;
    if (this.rebalancingStructuredLayout) return;
    if (this.sessions.size <= 1) return;

    this.rebalancingStructuredLayout = true;

    try {
      const survivors = Array.from(this.sessions.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((tracked) => ({ ...tracked }));

      log('[multiplexer-session-manager] rebalancing structured-layout panes', {
        count: survivors.length,
        layout: this.multiplexerLayout,
      });

      // [CUSTOM] 先清空旧 pane，再按当前会话顺序重新挂载，确保均分。
      for (const tracked of survivors) {
        await this.multiplexer.closePane(tracked.paneId);
      }

      for (let index = 0; index < survivors.length; index += 1) {
        const tracked = survivors[index];
        if (!tracked) {
          continue;
        }

        const current = this.sessions.get(tracked.sessionId);
        if (!current) {
          continue;
        }

        const known = this.knownSessions.get(tracked.sessionId) ?? {
          parentId: tracked.parentId,
          title: tracked.title,
          directory: tracked.directory,
        };

        const paneResult = await this.multiplexer
          .spawnPane(
            tracked.sessionId,
            known.title,
            this.serverUrl,
            known.directory,
          )
          .catch((err) => {
            log('[multiplexer-session-manager] rebalance spawn failed', {
              sessionId: tracked.sessionId,
              error: String(err),
            });
            return { success: false as const, reason: 'error' as const };
          });

        if (paneResult.success && paneResult.paneId) {
          current.paneId = paneResult.paneId;
          current.lastSeenAt = Date.now();
          current.missingSince = undefined;
        } else {
          log('[multiplexer-session-manager] rebalance deferred to queue', {
            sessionId: tracked.sessionId,
            reason: paneResult.reason ?? 'unknown',
          });

          this.sessions.delete(tracked.sessionId);
          this.enqueuePendingSession(tracked.sessionId);
        }
      }
    } finally {
      this.rebalancingStructuredLayout = false;
    }
  }

  private async respawnIfKnown(sessionId: string): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (this.isTrackedOrSpawning(sessionId)) return;

    const known = this.knownSessions.get(sessionId);
    if (!known) return;

    const result = await this.spawnKnownSession(sessionId, known, 'busy');
    if (result === 'capacity') {
      this.enqueuePendingSession(sessionId);
    }
  }

  // [CUSTOM] Unified spawn path for created/busy/queued sessions.
  private async spawnKnownSession(
    sessionId: string,
    known: KnownSession,
    trigger: 'created' | 'busy' | 'queue',
  ): Promise<SpawnAttemptResult> {
    if (this.isTrackedOrSpawning(sessionId)) {
      return 'skipped';
    }

    const spawnToken = this.nextSpawnToken;
    this.nextSpawnToken += 1;
    this.spawningSessions.set(sessionId, spawnToken);

    return this.runSerializedSpawnOperation(async () => {
      // [CUSTOM] 先等关闭流水线结束，再决定是否跳过待执行阈值重建。
      await this.waitForStructuredRebalance();
      await this.waitForStructuredClosePipelines();

      // [CUSTOM] 5->4 阈值回落若被新会话迅速补回 >4，跳过待执行重建。
      this.maybeCancelScheduledStructuredRebalanceBeforeSpawn();

      // [CUSTOM] 等待结构化布局重排（含已调度防抖）避免新增与重建交错。
      await this.waitForStructuredRebalance(true);

      if (!this.multiplexer) return 'skipped';
      if (this.spawningSessions.get(sessionId) !== spawnToken) return 'skipped';
      if (this.sessions.has(sessionId)) return 'skipped';

      try {
        const serverRunning = await isServerRunning(this.serverUrl);
        if (!serverRunning) {
          log(
            '[multiplexer-session-manager] server not running, skipping spawn',
            {
              serverUrl: this.serverUrl,
              sessionId,
              trigger,
            },
          );
          return 'skipped';
        }

        if (this.sessions.has(sessionId)) return 'skipped';

        const logMessageByTrigger = {
          created:
            '[multiplexer-session-manager] child session created, spawning pane',
          busy:
            '[multiplexer-session-manager] child session busy again, respawning pane',
          queue:
            '[multiplexer-session-manager] dequeued child session, spawning pane',
        } as const;

        log(logMessageByTrigger[trigger], {
          sessionId,
          parentId: known.parentId,
          title: known.title,
        });

        const paneResult = await this.multiplexer
          .spawnPane(sessionId, known.title, this.serverUrl, known.directory)
          .catch((err) => {
            log('[multiplexer-session-manager] failed to spawn pane', {
              error: String(err),
              trigger,
            });
            return {
              success: false,
              paneId: undefined,
              reason: 'error',
            };
          });

        if (paneResult.success && paneResult.paneId) {
          const now = Date.now();
          this.sessions.set(sessionId, {
            sessionId,
            paneId: paneResult.paneId,
            parentId: known.parentId,
            title: known.title,
            directory: known.directory,
            createdAt: now,
            lastSeenAt: now,
          });

          log('[multiplexer-session-manager] pane spawned', {
            sessionId,
            paneId: paneResult.paneId,
            trigger,
          });

          this.startPolling();
          return 'spawned';
        }

        if (paneResult.reason === 'capacity') {
          log('[multiplexer-session-manager] pane capacity reached, queueing', {
            sessionId,
            trigger,
          });
          return 'capacity';
        }

        log('[multiplexer-session-manager] pane spawn failed', {
          sessionId,
          trigger,
          reason: paneResult.reason ?? 'unknown',
        });
        return 'failed';
      } finally {
        if (this.spawningSessions.get(sessionId) === spawnToken) {
          this.spawningSessions.delete(sessionId);
        }
      }
    });
  }

  // [CUSTOM] Enqueue a session waiting for free pane capacity.
  private enqueuePendingSession(sessionId: string): void {
    if (this.pendingSessionIds.has(sessionId)) {
      return;
    }

    if (!this.knownSessions.has(sessionId)) {
      return;
    }

    this.pendingSessionIds.add(sessionId);
    this.pendingQueue.push(sessionId);

    log('[multiplexer-session-manager] session enqueued for pane', {
      sessionId,
      queueLength: this.pendingQueue.length,
    });
  }

  // [CUSTOM] Remove a session from pending queue.
  private dequeuePendingSession(sessionId: string): boolean {
    if (!this.pendingSessionIds.has(sessionId)) {
      return false;
    }

    this.pendingSessionIds.delete(sessionId);
    this.pendingQueue = this.pendingQueue.filter((id) => id !== sessionId);

    log('[multiplexer-session-manager] session dequeued', {
      sessionId,
      queueLength: this.pendingQueue.length,
    });

    return true;
  }

  // [CUSTOM] Try to promote queued sessions when capacity frees up.
  private async drainPendingQueue(): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (this.drainingPendingQueue) return;

    this.drainingPendingQueue = true;

    try {
      while (this.pendingQueue.length > 0) {
        const sessionId = this.pendingQueue[0];
        if (!sessionId) {
          this.pendingQueue.shift();
          continue;
        }

        if (!this.pendingSessionIds.has(sessionId)) {
          this.pendingQueue.shift();
          continue;
        }

        if (this.isTrackedOrSpawning(sessionId)) {
          this.dequeuePendingSession(sessionId);
          continue;
        }

        const known = this.knownSessions.get(sessionId);
        if (!known) {
          this.dequeuePendingSession(sessionId);
          continue;
        }

        const result = await this.spawnKnownSession(sessionId, known, 'queue');

        if (result === 'spawned') {
          this.dequeuePendingSession(sessionId);
          continue;
        }

        if (result === 'capacity') {
          // Still full, keep FIFO head in queue and stop draining.
          return;
        }

        // Non-capacity failures should not block the entire queue.
        this.dequeuePendingSession(sessionId);
      }
    } finally {
      this.drainingPendingQueue = false;
    }
  }

  private isTrackedOrSpawning(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.spawningSessions.has(sessionId);
  }

  async cleanup(): Promise<void> {
    this.stopPolling();

    if (this.sessions.size > 0 && this.multiplexer) {
      log('[multiplexer-session-manager] closing all panes', {
        count: this.sessions.size,
      });
      const multiplexer = this.multiplexer;
      const closePromises = Array.from(this.sessions.values()).map((s) =>
        multiplexer.closePane(s.paneId).catch((err) =>
          log('[multiplexer-session-manager] cleanup error for pane', {
            paneId: s.paneId,
            error: String(err),
          }),
        ),
      );
      await Promise.all(closePromises);
      this.sessions.clear();
    }

    this.knownSessions.clear();
    this.spawningSessions.clear();
    this.closingSessions.clear();
    this.pendingQueue = [];
    this.pendingSessionIds.clear();
    this.drainingPendingQueue = false;
    this.rebalancingStructuredLayout = false;
    this.structuredRebalancePendingClosures = 0;
    this.cancelStructuredLayoutRebalanceRequest();

    log('[multiplexer-session-manager] cleanup complete');
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
