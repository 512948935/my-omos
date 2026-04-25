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
const RIGHT_BINARY_LAYOUT = 'right-binary-8' as const;
const RIGHT_BINARY_REBALANCE_WAIT_MS = 15;

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
  private spawningSessions = new Set<string>();
  // [CUSTOM] Deduplicate concurrent close requests for the same session.
  private closingSessions = new Set<string>();
  // [CUSTOM] Queue sessions waiting for pane capacity.
  private pendingQueue: string[] = [];
  private pendingSessionIds = new Set<string>();
  private drainingPendingQueue = false;
  // [CUSTOM] Guard against nested right-binary rebalance cycles.
  private rebalancingRightBinaryLayout = false;
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

    try {
      // [CUSTOM] 等待 right-binary 重排完成，避免使用重排中的过期 paneId。
      await this.waitForRightBinaryRebalance();

      const tracked = this.sessions.get(sessionId);
      if (!tracked || !this.multiplexer) return;

      log('[multiplexer-session-manager] closing session pane', {
        sessionId,
        paneId: tracked.paneId,
      });

      await this.multiplexer.closePane(tracked.paneId);
      this.sessions.delete(sessionId);

      // [CUSTOM] right-binary 布局在 pane 数变化后需要重算并重排。
      await this.rebalanceRightBinaryLayoutIfNeeded();

      if (this.sessions.size === 0) {
        this.stopPolling();
      }

      await this.drainPendingQueue();
    } finally {
      this.closingSessions.delete(sessionId);
    }
  }

  // [CUSTOM] Whether we should rebuild pane placement for right-binary mode.
  private shouldRebalanceRightBinaryLayout(): boolean {
    return this.multiplexerLayout === RIGHT_BINARY_LAYOUT;
  }

  // [CUSTOM] Block churn handling until right-binary rebalance finishes.
  private async waitForRightBinaryRebalance(): Promise<void> {
    if (!this.shouldRebalanceRightBinaryLayout()) return;

    while (this.rebalancingRightBinaryLayout) {
      await new Promise((resolve) =>
        setTimeout(resolve, RIGHT_BINARY_REBALANCE_WAIT_MS),
      );
    }
  }

  // [CUSTOM] Rebuild remaining right-binary panes to keep equal splits.
  private async rebalanceRightBinaryLayoutIfNeeded(): Promise<void> {
    if (!this.multiplexer) return;
    if (!this.shouldRebalanceRightBinaryLayout()) return;
    if (this.rebalancingRightBinaryLayout) return;
    if (this.sessions.size <= 1) return;

    this.rebalancingRightBinaryLayout = true;

    try {
      const survivors = Array.from(this.sessions.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((tracked) => ({ ...tracked }));

      log('[multiplexer-session-manager] rebalancing right-binary panes', {
        count: survivors.length,
      });

      // [CUSTOM] 先清空旧 pane，再按当前会话顺序重新挂载，确保均分。
      for (const tracked of survivors) {
        await this.multiplexer.closePane(tracked.paneId);
      }

      for (const tracked of survivors) {
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
          continue;
        }

        log('[multiplexer-session-manager] rebalance deferred to queue', {
          sessionId: tracked.sessionId,
          reason: paneResult.reason ?? 'unknown',
        });

        this.sessions.delete(tracked.sessionId);
        this.enqueuePendingSession(tracked.sessionId);
      }
    } finally {
      this.rebalancingRightBinaryLayout = false;
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
    // [CUSTOM] 等待 right-binary 重排完成，避免重排与新增 pane 交错。
    await this.waitForRightBinaryRebalance();

    if (!this.multiplexer) return 'skipped';
    if (this.isTrackedOrSpawning(sessionId)) return 'skipped';

    this.spawningSessions.add(sessionId);

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
        created: '[multiplexer-session-manager] child session created, spawning pane',
        busy: '[multiplexer-session-manager] child session busy again, respawning pane',
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
      this.spawningSessions.delete(sessionId);
    }
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
    this.rebalancingRightBinaryLayout = false;

    log('[multiplexer-session-manager] cleanup complete');
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
