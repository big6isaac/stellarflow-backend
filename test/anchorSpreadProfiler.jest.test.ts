import { Keypair } from "@stellar/stellar-sdk";

// Initialize test signing keypair before module loads
const testKp = Keypair.random();
process.env.STELLAR_SECRET = testKp.secret();
process.env.STELLAR_PUBLIC_KEY = testKp.publicKey();
process.env.SIGNER_BACKEND = "local";

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  AnchorSpreadProfiler,
  AnchorPartner,
} from "../src/services/remittance/anchorSpreadProfiler";
import { AlertType } from "../src/services/notificationService";

describe("AnchorSpreadProfiler (Issue #1238)", () => {
  let profiler: AnchorSpreadProfiler;
  let mockAlertSpy: any;

  const mockPartner: AnchorPartner = {
    id: "test-anchor-cowrie",
    name: "Cowrie Test Exchange",
    sep38Url: "https://mock.cowrie.test/sep38",
    enabled: true,
    spreadAnomalyThresholdPercent: 3.5,
    supportedCorridors: [
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" },
      { sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buyAsset: "iso4217:NGN" },
    ],
  };

  const defaultMockFetcher = async () => ({
    buy_assets: [
      { asset: "iso4217:NGN", price: String(1 / 1500) },
      { asset: "iso4217:KES", price: String(1 / 130) },
      { asset: "iso4217:EUR", price: "0.92" },
      { asset: "iso4217:GHS", price: String(1 / 15.5) },
    ],
  });

  const defaultMockBenchmark = async () => 1500.0;

  beforeEach(() => {
    mockAlertSpy = jest.fn(async (_alert: any) => {});
  });

  afterEach(() => {
    if (profiler) {
      profiler.stop();
    }
    jest.clearAllMocks();
  });

  describe("Partner Registry", () => {
    it("should initialize with default anchor partners and allow custom registrations", () => {
      profiler = new AnchorSpreadProfiler({
        httpFetcher: defaultMockFetcher,
        benchmarkProvider: defaultMockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });
      const partners = profiler.getPartners();
      expect(partners.length).toBeGreaterThan(0);

      profiler.registerPartner(mockPartner);
      expect(profiler.getPartner(mockPartner.id)).toBeDefined();
      expect(profiler.getPartner(mockPartner.id)?.name).toBe("Cowrie Test Exchange");

      const unregistered = profiler.unregisterPartner(mockPartner.id);
      expect(unregistered).toBe(true);
      expect(profiler.getPartner(mockPartner.id)).toBeUndefined();
    });
  });

  describe("SEP-38 Rate Extraction", () => {
    beforeEach(() => {
      profiler = new AnchorSpreadProfiler({
        httpFetcher: defaultMockFetcher,
        benchmarkProvider: defaultMockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });
    });

    it("should decode rates from standard SEP-38 /prices buy_assets array", () => {
      const sampleResponse = {
        buy_assets: [
          { asset: "iso4217:NGN", price: "0.00066667", decimals: 2 },
          { asset: "iso4217:KES", price: "0.00769230", decimals: 2 },
        ],
      };

      const result = profiler.extractSep38Rate(sampleResponse, "iso4217:USD", "iso4217:NGN");
      expect(result.anchorPrice).toBe(0.00066667);
      expect(Math.round(result.anchorRate)).toBe(1500);
    });

    it("should decode rates from direct /price single quote format", () => {
      const sampleResponse = {
        price: "0.00067114",
      };

      const result = profiler.extractSep38Rate(sampleResponse, "iso4217:USD", "iso4217:NGN");
      expect(result.anchorPrice).toBe(0.00067114);
      expect(Math.round(result.anchorRate)).toBe(1490);
    });

    it("should decode rates from buy_amount and sell_amount payload", () => {
      const sampleResponse = {
        sell_amount: "100.00",
        buy_amount: "148500.00",
      };

      const result = profiler.extractSep38Rate(sampleResponse, "iso4217:USD", "iso4217:NGN");
      expect(result.anchorRate).toBe(1485);
    });

    it("should throw when corridor is not present in response", () => {
      const sampleResponse = {
        buy_assets: [{ asset: "iso4217:EUR", price: "0.92" }],
      };

      expect(() => {
        profiler.extractSep38Rate(sampleResponse, "iso4217:USD", "iso4217:NGN");
      }).toThrow(/not found in SEP-38/);
    });
  });

  describe("Spread Calculation & Anomaly Detection", () => {
    it("should calculate correct spread percentage against mid-market benchmark", async () => {
      const mockFetcher = async () => ({
        buy_assets: [{ asset: "iso4217:NGN", price: String(1 / 1450) }],
      });

      const mockBenchmark = async () => 1500.0;

      profiler = new AnchorSpreadProfiler({
        httpFetcher: mockFetcher,
        benchmarkProvider: mockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });

      for (const p of profiler.getPartners()) {
        profiler.unregisterPartner(p.id);
      }
      profiler.registerPartner({
        ...mockPartner,
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" }],
      });

      const metrics = await profiler.profileAllAnchors();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.anchorRate).toBe(1450);
      expect(metrics[0]?.benchmarkRate).toBe(1500);
      expect(metrics[0]?.spreadPercentage).toBeCloseTo(3.3333, 2);
      expect(metrics[0]?.isAnomaly).toBe(false);
    });

    it("should flag anomaly and generate summary alert when spread exceeds threshold", async () => {
      const mockFetcher = async () => ({
        buy_assets: [{ asset: "iso4217:NGN", price: String(1 / 1400) }],
      });

      const mockBenchmark = async () => 1500.0;

      profiler = new AnchorSpreadProfiler({
        httpFetcher: mockFetcher,
        benchmarkProvider: mockBenchmark,
        notificationHandler: mockAlertSpy,
        alertThrottleMs: 0,
        autoStartImmediateTick: false,
      });

      for (const p of profiler.getPartners()) {
        profiler.unregisterPartner(p.id);
      }
      profiler.registerPartner({
        ...mockPartner,
        spreadAnomalyThresholdPercent: 3.5,
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" }],
      });

      const metrics = await profiler.profileAllAnchors();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.isAnomaly).toBe(true);
      expect(metrics[0]?.anomalyReason).toContain("exceeds partner threshold");

      // Verify summary alert was dispatched
      expect(mockAlertSpy).toHaveBeenCalledTimes(1);
      const alertCall = mockAlertSpy.mock.calls[0]![0];
      expect(alertCall.type).toBe(AlertType.PRICE_ANOMALY);
      expect(alertCall.message).toContain("Cowrie Test Exchange");
      expect(alertCall.message).toContain("6.67%");
    });

    it("should flag anomaly on inverted or non-positive rates", () => {
      profiler = new AnchorSpreadProfiler({
        httpFetcher: defaultMockFetcher,
        benchmarkProvider: defaultMockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });
      const anomalyCheck = profiler.detectAnomaly(-50, 1500, -103, 3.5);
      expect(anomalyCheck.isAnomaly).toBe(true);
      expect(anomalyCheck.reason).toContain("Inverted or non-positive");
    });

    it("should isolate failing anchors so queries for other anchors are not dropped", async () => {
      const mockFetcher = async (url: string) => {
        if (url.includes("cowrie")) {
          throw new Error("HTTP 503 Service Unavailable");
        }
        return {
          buy_assets: [{ asset: "iso4217:KES", price: String(1 / 130) }],
        };
      };

      profiler = new AnchorSpreadProfiler({
        httpFetcher: mockFetcher,
        benchmarkProvider: async () => 130.0,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });

      for (const p of profiler.getPartners()) {
        profiler.unregisterPartner(p.id);
      }

      // Partner 1 fails
      profiler.registerPartner({
        ...mockPartner,
        id: "failing-anchor",
        sep38Url: "https://cowrie.failing.test/sep38",
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" }],
      });

      // Partner 2 succeeds
      profiler.registerPartner({
        id: "healthy-anchor",
        name: "Healthy Exchange",
        sep38Url: "https://healthy.test/sep38",
        enabled: true,
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:KES" }],
      });

      const results = await profiler.profileAllAnchors();
      expect(results).toHaveLength(2);

      const failingResult = results.find((r) => r.anchorId === "failing-anchor");
      const healthyResult = results.find((r) => r.anchorId === "healthy-anchor");

      expect(failingResult?.status).toBe("ERROR");
      expect(failingResult?.isAnomaly).toBe(true);

      expect(healthyResult?.status).toBe("SUCCESS");
      expect(healthyResult?.anchorRate).toBe(130);
      expect(healthyResult?.isAnomaly).toBe(false);
    });
  });

  describe("Partner Evaluation & Competitiveness Ranking", () => {
    it("should compute partner evaluations and rank by average spread percentage", async () => {
      profiler = new AnchorSpreadProfiler({
        httpFetcher: defaultMockFetcher,
        benchmarkProvider: defaultMockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });
      for (const p of profiler.getPartners()) {
        profiler.unregisterPartner(p.id);
      }

      profiler.registerPartner({
        id: "partner-a",
        name: "Competitive Partner A",
        sep38Url: "https://a.test",
        enabled: true,
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" }],
      });

      profiler.registerPartner({
        id: "partner-b",
        name: "Expensive Partner B",
        sep38Url: "https://b.test",
        enabled: true,
        supportedCorridors: [{ sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" }],
      });

      // Inject sample history
      (profiler as any).memoryHistory = [
        {
          id: "m1",
          timestamp: new Date(),
          anchorId: "partner-a",
          anchorName: "Competitive Partner A",
          sellAsset: "iso4217:USD",
          buyAsset: "iso4217:NGN",
          anchorPrice: 1 / 1485,
          anchorRate: 1485,
          benchmarkRate: 1500,
          spreadPercentage: 1.0,
          isAnomaly: false,
          latencyMs: 120,
          status: "SUCCESS",
        },
        {
          id: "m2",
          timestamp: new Date(),
          anchorId: "partner-b",
          anchorName: "Expensive Partner B",
          sellAsset: "iso4217:USD",
          buyAsset: "iso4217:NGN",
          anchorPrice: 1 / 1440,
          anchorRate: 1440,
          benchmarkRate: 1500,
          spreadPercentage: 4.0,
          isAnomaly: true,
          latencyMs: 350,
          status: "SUCCESS",
        },
      ];

      const evaluations = await profiler.evaluatePartners();
      expect(evaluations).toHaveLength(2);

      // Partner A should rank #1 with 1.0% spread
      expect(evaluations[0]?.anchorId).toBe("partner-a");
      expect(evaluations[0]?.competitivenessRank).toBe(1);
      expect(evaluations[0]?.averageSpreadPercentage).toBe(1.0);
      expect(evaluations[0]?.uptimePercent).toBe(100);

      // Partner B should rank #2 with 4.0% spread
      expect(evaluations[1]?.anchorId).toBe("partner-b");
      expect(evaluations[1]?.competitivenessRank).toBe(2);
      expect(evaluations[1]?.averageSpreadPercentage).toBe(4.0);
      expect(evaluations[1]?.anomalyCount).toBe(1);
    });
  });

  describe("Lifecycle & 60-Second Scheduling", () => {
    it("should start and stop profiling worker gracefully without dropping scheduled queries", () => {
      profiler = new AnchorSpreadProfiler({
        httpFetcher: defaultMockFetcher,
        benchmarkProvider: defaultMockBenchmark,
        notificationHandler: mockAlertSpy,
        autoStartImmediateTick: false,
      });
      profiler.start();
      expect((profiler as any).scheduledTask).toBeDefined();

      profiler.stop();
      expect((profiler as any).scheduledTask).toBeNull();
    });
  });
});
