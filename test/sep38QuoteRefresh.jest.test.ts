import {
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import express from "express";
import request from "supertest";

/**
 * In-memory Redis mirror keyed by the exact key the service writes.
 */
const fakeStore = new Map<string, string>();

const fakeRedis = {
  isOpen: true,
  get: jest.fn(async (key: string): Promise<string | null> => {
    return fakeStore.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string): Promise<"OK"> => {
    fakeStore.set(key, value);
    return "OK";
  }),
  del: jest.fn(async (key: string): Promise<number> => {
    return fakeStore.delete(key) ? 1 : 0;
  }),
};

const mockGetCorridorRate = jest.fn(async (): Promise<number> => 1500);

const mockCreate = jest.fn(async (): Promise<unknown> => ({}));
const mockFindUnique = jest.fn(async (): Promise<unknown> => null);
const mockUpdateMany = jest.fn(
  async (): Promise<{ count: number }> => ({ count: 1 }),
);

jest.unstable_mockModule("../src/lib/redis", () => ({
  getRedisClient: jest.fn(() => fakeRedis),
}));

jest.unstable_mockModule("../src/services/remittance/fxEngine", () => ({
  RemittanceFxEngine: jest.fn().mockImplementation(() => ({
    getCorridorRate: (...args: unknown[]) => mockGetCorridorRate(...args),
  })),
}));

jest.unstable_mockModule("../src/lib/prisma", () => ({
  prisma: {
    sep38Quote: {
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
  default: {
    sep38Quote: {
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
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

type ServiceModule = typeof import("../src/services/sep38Service");
type StoreModule =
  typeof import("../src/services/remittance/sep38QuoteStore");

let serviceModule: ServiceModule;
let storeModule: StoreModule;
let app: express.Express;

const CORRIDOR = {
  sell_asset: "iso4217:USD",
  buy_asset: "iso4217:NGN",
  sell_amount: "100",
};

beforeAll(async () => {
  serviceModule = await import("../src/services/sep38Service");
  storeModule = await import("../src/services/remittance/sep38QuoteStore");
  const sep38Router = (await import("../src/routes/sep38")).default;

  app = express();
  app.use(express.json());
  app.use("/api/v1/remittance/sep38", sep38Router);
});

function resetMocks(): void {
  fakeStore.clear();
  mockGetCorridorRate.mockReset();
  mockGetCorridorRate.mockResolvedValue(1500);
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({});
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue(null);
  mockUpdateMany.mockReset();
  mockUpdateMany.mockResolvedValue({ count: 1 });
  jest.clearAllMocks();
}

describe("Sep38Service quote lifecycle (#1276)", () => {
  beforeEach(resetMocks);

  it("persists an ACTIVE quote to Redis and Postgres", async () => {
    const service = new serviceModule.Sep38Service();
    const quote = await service.postQuote(CORRIDOR);

    expect(quote.status).toBe("ACTIVE");
    expect(quote.refreshed_from).toBeNull();
    expect(fakeStore.has(storeModule.sep38QuoteKey(quote.id))).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: quote.id,
          status: "ACTIVE",
          sellAsset: "iso4217:USD",
          buyAsset: "iso4217:NGN",
          expiresAt: expect.any(Date),
        }),
      }),
    );
  });

  it("serves a live quote straight from the Redis mirror", async () => {
    const service = new serviceModule.Sep38Service();
    const quote = await service.postQuote(CORRIDOR);

    const loaded = await service.getQuote(quote.id);

    expect(loaded?.id).toBe(quote.id);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the durable store once the Redis mirror is evicted", async () => {
    const service = new serviceModule.Sep38Service();
    const quote = await service.postQuote(CORRIDOR);
    fakeStore.clear();

    mockFindUnique.mockResolvedValueOnce({
      id: quote.id,
      sellAsset: "iso4217:USD",
      sellAmount: "100",
      buyAsset: "iso4217:NGN",
      buyAmount: "147750",
      price: "0.0006768",
      totalPrice: "0.0006768",
      fee: quote.fee,
      status: "EXPIRED",
      expiresAt: new Date(Date.now() - 1000),
      refreshedFromId: null,
    });

    const loaded = await service.getQuote(quote.id);

    expect(loaded?.status).toBe("EXPIRED");
    expect(loaded?.id).toBe(quote.id);
  });

  it("refreshes a quote at live rates and expires the original", async () => {
    const service = new serviceModule.Sep38Service();
    const original = await service.postQuote(CORRIDOR);

    const refreshed = await service.refreshQuote({ quoteId: original.id });

    expect(refreshed.id).not.toBe(original.id);
    expect(refreshed.refreshed_from).toBe(original.id);
    expect(refreshed.sell_asset).toBe(original.sell_asset);
    expect(refreshed.buy_asset).toBe(original.buy_asset);
    expect(refreshed.status).toBe("ACTIVE");
    expect(fakeStore.has(storeModule.sep38QuoteKey(refreshed.id))).toBe(true);
    expect(fakeStore.has(storeModule.sep38QuoteKey(original.id))).toBe(false);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: original.id, status: "ACTIVE" },
        data: { status: "EXPIRED" },
      }),
    );
  });

  it("issues a refreshed quote from an explicit corridor", async () => {
    const service = new serviceModule.Sep38Service();

    const refreshed = await service.refreshQuote({
      sellAsset: "iso4217:USD",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
    });

    expect(refreshed.status).toBe("ACTIVE");
    expect(refreshed.refreshed_from).toBeNull();
    expect(mockGetCorridorRate).toHaveBeenCalled();
  });

  it("throws when refreshing an unknown quote id", async () => {
    const service = new serviceModule.Sep38Service();

    await expect(
      service.refreshQuote({ quoteId: "sep38_q_does_not_exist" }),
    ).rejects.toBeInstanceOf(serviceModule.Sep38QuoteNotFoundError);
  });

  it("rejects a refresh without a corridor or amount", async () => {
    const service = new serviceModule.Sep38Service();

    await expect(service.refreshQuote({})).rejects.toThrow(
      "Missing required parameters",
    );
  });
});

describe("POST /api/v1/remittance/sep38/refresh-quote (#1276)", () => {
  beforeEach(resetMocks);

  it("issues a fresh quote for a client-supplied quote id", async () => {
    const service = new serviceModule.Sep38Service();
    const original = await service.postQuote(CORRIDOR);

    const res = await request(app)
      .post("/api/v1/remittance/sep38/refresh-quote")
      .send({ quote_id: original.id });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(original.id);
    expect(res.body.refreshed_from).toBe(original.id);
    expect(res.body.status).toBe("ACTIVE");
    expect(res.body.sell_asset).toBe("iso4217:USD");
    expect(res.body.buy_asset).toBe("iso4217:NGN");
  });

  it("refreshes from explicit corridor parameters", async () => {
    const res = await request(app)
      .post("/api/v1/remittance/sep38/refresh-quote")
      .send({ sell_asset: "iso4217:USD", buy_asset: "iso4217:NGN", sell_amount: "100" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ACTIVE");
  });

  it("returns 400 when neither a quote id nor a corridor is provided", async () => {
    const res = await request(app)
      .post("/api/v1/remittance/sep38/refresh-quote")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown quote id", async () => {
    const res = await request(app)
      .post("/api/v1/remittance/sep38/refresh-quote")
      .send({ quote_id: "sep38_q_missing" });

    expect(res.status).toBe(404);
  });
});
