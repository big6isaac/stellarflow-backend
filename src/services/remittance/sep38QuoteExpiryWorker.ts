import prisma from "../../lib/prisma";
import { getRedisClient } from "../../lib/redis";
import { logger } from "../../utils/logger";
import {
  SEP38_QUOTE_KEY_PREFIX,
  SEP38_QUOTE_STATUS,
  parseSep38QuoteKey,
} from "./sep38QuoteStore";

/**
 * SEP-38 Quote Expiration & Refresh Engine - garbage-collection worker
 * (Issue #1276).
 *
 * Responsibilities:
 * - Walk the `quote:sep38:*` namespace with the SCAN cursor (never KEYS) so the
 *   Redis main thread stays responsive, and purge every mirrored quote whose
 *   TTL has lapsed.
 * - Transition the matching `Sep38Quote` rows to EXPIRED so the durable
 *   lifecycle survives Redis eviction.
 * - Additionally sweep Postgres directly for ACTIVE quotes whose `expires_at`
 *   has passed, so expiry is enforced within the poll interval even when Redis
 *   is unavailable (Redis is a cache, Postgres is the source of truth).
 *
 * The default 1s interval keeps the observable expiry lag within one second of
 * the quote TTL lapsing.
 */

/** `TTL` response for a key that no longer exists. */
const KEY_MISSING = -2;
/** `TTL` response for a key that has no expiry attached. */
const KEY_NO_EXPIRY = -1;

interface Sep38QuoteExpiryConfig {
  /** Interval between expiry sweep cycles (ms) */
  sweepIntervalMs: number;
  /** Batch size for SCAN/DEL operations */
  batchSize: number;
  /** Whether to run an initial sweep cycle on start */
  runOnStart: boolean;
}

const DEFAULT_CONFIG: Sep38QuoteExpiryConfig = {
  sweepIntervalMs: 1000,
  batchSize: 500,
  runOnStart: true,
};

export interface ExpirySweepSummary {
  /** Number of Redis keys visited by the SCAN cursor this cycle. */
  scanned: number;
  /** Number of expired Redis mirror keys deleted this cycle. */
  redisKeysPurged: number;
  /** Number of quotes transitioned to EXPIRED in Postgres this cycle. */
  quotesExpired: number;
  durationMs: number;
}

export interface Sep38QuoteExpiryMetrics {
  totalCycles: number;
  totalKeysScanned: number;
  totalRedisKeysPurged: number;
  totalQuotesExpired: number;
  lastCycleAt: Date | null;
  lastCycleDurationMs: number;
  lastCycleScanned: number;
  lastCycleRedisKeysPurged: number;
  lastCycleQuotesExpired: number;
}

export class Sep38QuoteExpiryWorker {
  private config: Sep38QuoteExpiryConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isSweeping = false;
  private metrics: Sep38QuoteExpiryMetrics;

  constructor(config?: Partial<Sep38QuoteExpiryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalCycles: 0,
      totalKeysScanned: 0,
      totalRedisKeysPurged: 0,
      totalQuotesExpired: 0,
      lastCycleAt: null,
      lastCycleDurationMs: 0,
      lastCycleScanned: 0,
      lastCycleRedisKeysPurged: 0,
      lastCycleQuotesExpired: 0,
    };
  }

  /**
   * Start the scheduled quote expiry worker (1s by default).
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("[Sep38QuoteExpiryWorker] Already running");
      return;
    }

    this.isRunning = true;

    if (this.config.runOnStart) {
      void this.runSweepCycle();
    }

    this.timer = setInterval(() => {
      void this.runSweepCycle();
    }, this.config.sweepIntervalMs);

    logger.info(
      `[Sep38QuoteExpiryWorker] Started with ${this.config.sweepIntervalMs}ms interval`,
    );
  }

  /**
   * Stop the scheduled quote expiry worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info("[Sep38QuoteExpiryWorker] Stopped");
  }

  isActive(): boolean {
    return this.isRunning;
  }

  isSweepCycleRunning(): boolean {
    return this.isSweeping;
  }

  getMetrics(): Sep38QuoteExpiryMetrics {
    return { ...this.metrics };
  }

  /**
   * Run a single expiry sweep cycle.
   *
   * Scans the Redis mirror namespace for lapsed TTLs, deletes the orphaned
   * keys, and reconciles the durable store for both the deleted ids and any
   * ACTIVE row whose `expires_at` has already passed.
   *
   * @returns the cycle summary, or `null` when the cycle was skipped/failed.
   */
  async runSweepCycle(): Promise<ExpirySweepSummary | null> {
    if (this.isSweeping) {
      logger.debug("[Sep38QuoteExpiryWorker] Sweep already in progress, skipping");
      return null;
    }

    this.isSweeping = true;
    const startTime = Date.now();
    const now = new Date();

    try {
      const redisResult = await this.purgeExpiredRedisKeys();
      const quotesExpired = await this.expireQuotesInDb(
        redisResult.expiredIds,
        now,
      );

      const summary: ExpirySweepSummary = {
        scanned: redisResult.scanned,
        redisKeysPurged: redisResult.purged,
        quotesExpired,
        durationMs: Date.now() - startTime,
      };

      this.metrics.totalCycles++;
      this.metrics.totalKeysScanned += summary.scanned;
      this.metrics.totalRedisKeysPurged += summary.redisKeysPurged;
      this.metrics.totalQuotesExpired += summary.quotesExpired;
      this.metrics.lastCycleAt = new Date();
      this.metrics.lastCycleDurationMs = summary.durationMs;
      this.metrics.lastCycleScanned = summary.scanned;
      this.metrics.lastCycleRedisKeysPurged = summary.redisKeysPurged;
      this.metrics.lastCycleQuotesExpired = summary.quotesExpired;

      if (summary.redisKeysPurged > 0 || summary.quotesExpired > 0) {
        logger.info(
          `[Sep38QuoteExpiryWorker] Sweep cycle complete: expired=${summary.quotesExpired} ` +
            `redisPurged=${summary.redisKeysPurged} scanned=${summary.scanned} ` +
            `durationMs=${summary.durationMs}`,
        );
      } else {
        logger.debug(
          `[Sep38QuoteExpiryWorker] Sweep cycle complete: nothing to expire ` +
            `scanned=${summary.scanned} durationMs=${summary.durationMs}`,
        );
      }

      return summary;
    } catch (error) {
      logger.error("[Sep38QuoteExpiryWorker] Sweep cycle failed:", error);
      return null;
    } finally {
      this.isSweeping = false;
    }
  }

  /**
   * SCAN the mirror namespace and delete keys whose TTL has lapsed. Returns the
   * scan/purge counts plus the quote ids that must be transitioned to EXPIRED.
   *
   * Redis being unavailable is not fatal: the caller still reconciles Postgres.
   */
  private async purgeExpiredRedisKeys(): Promise<{
    scanned: number;
    purged: number;
    expiredIds: string[];
  }> {
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      logger.warn(
        "[Sep38QuoteExpiryWorker] Redis not available, relying on Postgres sweep",
      );
      return { scanned: 0, purged: 0, expiredIds: [] };
    }

    const pattern = `${SEP38_QUOTE_KEY_PREFIX}*`;
    let scanned = 0;
    let purged = 0;
    const expiredIds: string[] = [];

    for await (const keys of redis.scanIterator({
      MATCH: pattern,
      COUNT: this.config.batchSize,
    })) {
      scanned += keys.length;

      const staleKeys: string[] = [];
      for (const key of keys) {
        const quoteId = parseSep38QuoteKey(key);
        if (!quoteId) continue;

        const ttl = await redis.ttl(key);
        if (ttl === KEY_MISSING) continue;

        if (ttl === KEY_NO_EXPIRY || ttl <= 0) {
          staleKeys.push(key);
          expiredIds.push(quoteId);
        }
      }

      if (staleKeys.length > 0) {
        purged += await redis.del(staleKeys);
      }
    }

    return { scanned, purged, expiredIds };
  }

  /**
   * Transition ACTIVE quotes to EXPIRED: every id whose Redis mirror lapsed,
   * plus every ACTIVE row past its `expires_at`. Safe to run repeatedly.
   *
   * @returns the number of rows moved to EXPIRED.
   */
  private async expireQuotesInDb(
    expiredIds: string[],
    now: Date,
  ): Promise<number> {
    try {
      const result = await prisma.sep38Quote.updateMany({
        where:
          expiredIds.length > 0
            ? {
                status: SEP38_QUOTE_STATUS.ACTIVE,
                OR: [
                  { expiresAt: { lt: now } },
                  { id: { in: expiredIds } },
                ],
              }
            : {
                status: SEP38_QUOTE_STATUS.ACTIVE,
                expiresAt: { lt: now },
              },
        data: { status: SEP38_QUOTE_STATUS.EXPIRED },
      });

      return result.count;
    } catch (error) {
      logger.error(
        `[Sep38QuoteExpiryWorker] Failed to expire quotes in Postgres: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}

let workerInstance: Sep38QuoteExpiryWorker | null = null;

export function getSep38QuoteExpiryWorker(
  config?: Partial<Sep38QuoteExpiryConfig>,
): Sep38QuoteExpiryWorker {
  if (!workerInstance) {
    workerInstance = new Sep38QuoteExpiryWorker(config);
  }
  return workerInstance;
}

export function resetSep38QuoteExpiryWorker(): void {
  if (workerInstance) {
    workerInstance.stop();
    workerInstance = null;
  }
}
