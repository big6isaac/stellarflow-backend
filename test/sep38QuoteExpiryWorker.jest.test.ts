import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";

/**
 * Fake Redis store: key -> ttl in seconds. `-2` means the key is missing,
 * `-1` means the key has no expiry attached, `0` means the TTL has elapsed.
 */
const fakeStore = new Map<string, number>();
const scanBatchSizes: number[] = [];

const fakeRedis = {
  isOpen: true,
  ttl: jest.fn(async (key: string): Promise<number> => {
    return fakeStore.get(key) ?? -2;
  }),
  del: jest.fn(async (...args: unknown[]): Promise<number> => {
    const keys = args.flat() as string[];
    let deleted = 0;
    for (const key of keys) {
      if (fakeStore.delete(key)) deleted += 1;
    }
    return deleted;
  }),
  scanIterator: jest.fn(async function* (options: {
    MATCH: string;
    COUNT: number;
  }) {
    const matcher = new RegExp(`^${options.MATCH.replaceAll("*", ".*")}$`);
    const matching = [...fakeStore.keys()].filter((key) => matcher.test(key));
    const batchSize =
      options.COUNT > 0 ? options.COUNT : Math.max(matching.length, 1);

    for (let index = 0; index < matching.length; index += batchSize) {
      const batch = matching.slice(index, index + batchSize);
      scanBatchSizes.push(batch.length);
      yield batch;
    }
  }),
};

const mockUpdateMany = jest.fn(
  async (_args?: unknown): Promise<{ count: number }> => ({ count: 0 }),
);

jest.unstable_mockModule("../src/lib/redis", () => ({
  getRedisClient: jest.fn(() => fakeRedis),
}));

jest.unstable_mockModule("../src/lib/prisma", () => ({
  prisma: {
    sep38Quote: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
  default: {
    sep38Quote: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));

jest.unstable_mockModule("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

type WorkerModule =
  typeof import("../src/services/remittance/sep38QuoteExpiryWorker");
type StoreModule =
  typeof import("../src/services/remittance/sep38QuoteStore");
type LoggerModule = typeof import("../src/utils/logger");

let workerModule: WorkerModule;
let storeModule: StoreModule;
let logger: LoggerModule["logger"];

beforeAll(async () => {
  workerModule = await import("../src/services/remittance/sep38QuoteExpiryWorker");
  storeModule = await import("../src/services/remittance/sep38QuoteStore");
  ({ logger } = await import("../src/utils/logger"));
});

function seedQuote(quoteId: string, ttl: number): string {
  const key = storeModule.sep38QuoteKey(quoteId);
  fakeStore.set(key, ttl);
  return key;
}

describe("sep38QuoteStore helpers", () => {
  it("builds a namespaced quote key", () => {
    expect(storeModule.sep38QuoteKey("sep38_q_abc")).toBe(
      "quote:sep38:sep38_q_abc",
    );
  });

  it("parses a quote id from a namespaced key", () => {
    expect(storeModule.parseSep38QuoteKey("quote:sep38:sep38_q_abc")).toBe(
      "sep38_q_abc",
    );
  });

  it("rejects keys outside the quote namespace", () => {
    expect(storeModule.parseSep38QuoteKey("sep38:quote:lock:abc")).toBeNull();
    expect(storeModule.parseSep38QuoteKey("quote:sep38:")).toBeNull();
  });
});

describe("Sep38QuoteExpiryWorker", () => {
  beforeEach(() => {
    fakeStore.clear();
    scanBatchSizes.length = 0;
    fakeRedis.isOpen = true;
    mockUpdateMany.mockReset();
    mockUpdateMany.mockResolvedValue({ count: 0 });
    workerModule.resetSep38QuoteExpiryWorker();
    jest.clearAllMocks();
  });

  afterEach(() => {
    workerModule.resetSep38QuoteExpiryWorker();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates an idle instance with zeroed metrics", () => {
      const worker = new workerModule.Sep38QuoteExpiryWorker();

      expect(worker.isActive()).toBe(false);
      expect(worker.isSweepCycleRunning()).toBe(false);
      expect(worker.getMetrics()).toEqual({
        totalCycles: 0,
        totalKeysScanned: 0,
        totalRedisKeysPurged: 0,
        totalQuotesExpired: 0,
        lastCycleAt: null,
        lastCycleDurationMs: 0,
        lastCycleScanned: 0,
        lastCycleRedisKeysPurged: 0,
        lastCycleQuotesExpired: 0,
      });
    });
  });

  describe("start/stop", () => {
    it("starts and stops the worker", () => {
      const worker = new workerModule.Sep38QuoteExpiryWorker({
        sweepIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      expect(worker.isActive()).toBe(true);

      worker.stop();
      expect(worker.isActive()).toBe(false);
    });

    it("does not start twice", () => {
      const worker = new workerModule.Sep38QuoteExpiryWorker({
        sweepIntervalMs: 1000,
        runOnStart: false,
      });

      worker.start();
      worker.start();

      expect(worker.isActive()).toBe(true);
      worker.stop();
      expect(logger.warn).toHaveBeenCalledWith(
        "[Sep38QuoteExpiryWorker] Already running",
      );
    });
  });

  describe("runSweepCycle", () => {
    it("purges expired Redis keys and expires the matching quotes", async () => {
      seedQuote("q-expired", 0);
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toEqual({
        scanned: 1,
        redisKeysPurged: 1,
        quotesExpired: 1,
        durationMs: expect.any(Number),
      });
      expect(fakeStore.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("expired=1"),
      );

      const metrics = worker.getMetrics();
      expect(metrics.totalCycles).toBe(1);
      expect(metrics.totalKeysScanned).toBe(1);
      expect(metrics.totalRedisKeysPurged).toBe(1);
      expect(metrics.totalQuotesExpired).toBe(1);
      expect(metrics.lastCycleAt).toBeInstanceOf(Date);
      expect(metrics.lastCycleQuotesExpired).toBe(1);

      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "ACTIVE",
            OR: expect.arrayContaining([
              expect.objectContaining({ id: { in: ["q-expired"] } }),
            ]),
          }),
          data: { status: "EXPIRED" },
        }),
      );
    });

    it("retains quotes whose TTL is still live", async () => {
      seedQuote("q-live", 30);

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({ scanned: 1, redisKeysPurged: 0 });
      expect(fakeStore.size).toBe(1);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "ACTIVE",
            expiresAt: { lt: expect.any(Date) },
          }),
        }),
      );
    });

    it("ignores keys that were already evicted", async () => {
      fakeStore.set(storeModule.sep38QuoteKey("q-missing"), -2);

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({ scanned: 1, redisKeysPurged: 0 });
    });

    it("purges keys that carry no expiry", async () => {
      const key = seedQuote("q-no-ttl", -1);

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({ scanned: 1, redisKeysPurged: 1 });
      expect(fakeStore.has(key)).toBe(false);
    });

    it("ignores keys outside the quote namespace", async () => {
      fakeStore.set("sep38:quote:lock:abc", 0);
      fakeStore.set("stellarflow:sessions:7:abc", 0);

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({ scanned: 0, redisKeysPurged: 0 });
      expect(fakeStore.size).toBe(2);
    });

    it("scans the namespace with the SCAN cursor in batches", async () => {
      for (let index = 0; index < 5; index += 1) {
        seedQuote(`q-batch-${index}`, 0);
      }

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
        batchSize: 2,
      });
      const summary = await worker.runSweepCycle();

      expect(fakeRedis.scanIterator).toHaveBeenCalledWith({
        MATCH: `${storeModule.SEP38_QUOTE_KEY_PREFIX}*`,
        COUNT: 2,
      });
      expect(scanBatchSizes).toEqual([2, 2, 1]);
      expect(summary).toMatchObject({ scanned: 5, redisKeysPurged: 5 });
      expect(fakeStore.size).toBe(0);
    });

    it("still reconciles Postgres when Redis is unavailable", async () => {
      seedQuote("q-expired", 0);
      fakeRedis.isOpen = false;
      mockUpdateMany.mockResolvedValueOnce({ count: 3 });

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({
        scanned: 0,
        redisKeysPurged: 0,
        quotesExpired: 3,
      });
      expect(fakeStore.size).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Redis not available"),
      );
    });

    it("returns null and logs when the cycle fails", async () => {
      seedQuote("q-expired", 0);
      fakeRedis.ttl.mockRejectedValueOnce(new Error("redis down"));

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toBeNull();
      expect(worker.isSweepCycleRunning()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Sweep cycle failed"),
        expect.any(Error),
      );
    });

    it("does not fail the cycle when the Postgres reconciliation errors", async () => {
      seedQuote("q-expired", 0);
      mockUpdateMany.mockRejectedValueOnce(new Error("db down"));

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      const summary = await worker.runSweepCycle();

      expect(summary).toMatchObject({ scanned: 1, redisKeysPurged: 1 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to expire quotes in Postgres"),
      );
    });
  });

  describe("1s schedule", () => {
    it("runs a sweep cycle on the default interval", async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(
        workerModule.Sep38QuoteExpiryWorker.prototype,
        "runSweepCycle",
      );

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: false,
      });
      worker.start();
      expect(worker.isActive()).toBe(true);

      await jest.advanceTimersByTimeAsync(1000);

      expect(spy).toHaveBeenCalledTimes(1);

      worker.stop();
      expect(worker.isActive()).toBe(false);
      spy.mockRestore();
    });

    it("runs an initial cycle on start when configured", async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(
        workerModule.Sep38QuoteExpiryWorker.prototype,
        "runSweepCycle",
      );

      const worker = new workerModule.Sep38QuoteExpiryWorker({
        runOnStart: true,
      });
      worker.start();

      await jest.advanceTimersByTimeAsync(0);

      expect(spy).toHaveBeenCalledTimes(1);

      worker.stop();
      spy.mockRestore();
    });
  });

  describe("singleton", () => {
    it("returns the same instance from getSep38QuoteExpiryWorker", () => {
      expect(workerModule.getSep38QuoteExpiryWorker()).toBe(
        workerModule.getSep38QuoteExpiryWorker(),
      );
    });

    it("resets the singleton with resetSep38QuoteExpiryWorker", () => {
      const first = workerModule.getSep38QuoteExpiryWorker();
      workerModule.resetSep38QuoteExpiryWorker();
      const second = workerModule.getSep38QuoteExpiryWorker();

      expect(second).not.toBe(first);
    });
  });
});
