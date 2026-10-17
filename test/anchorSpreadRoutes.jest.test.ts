import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import anchorSpreadRouter from "../src/routes/anchorSpread";
import { anchorSpreadProfiler } from "../src/services/remittance/anchorSpreadProfiler";

const app = express();
app.use(express.json());
app.use("/api/v1/anchor-spread", anchorSpreadRouter);

describe("Anchor Spread API Routes (Issue #1238)", () => {
  beforeEach(() => {
    // Inject mock memory history
    (anchorSpreadProfiler as any).memoryHistory = [
      {
        id: "test-m1",
        timestamp: new Date(),
        anchorId: "anchor-cowrie-ngn",
        anchorName: "Cowrie Exchange",
        sellAsset: "iso4217:USD",
        buyAsset: "iso4217:NGN",
        anchorPrice: 0.00067,
        anchorRate: 1492.53,
        benchmarkRate: 1500,
        spreadPercentage: 0.5,
        isAnomaly: false,
        latencyMs: 140,
        status: "SUCCESS",
      },
      {
        id: "test-m2",
        timestamp: new Date(),
        anchorId: "anchor-clickpesa-kes",
        anchorName: "ClickPesa Africa",
        sellAsset: "iso4217:USD",
        buyAsset: "iso4217:KES",
        anchorPrice: 0.008,
        anchorRate: 125,
        benchmarkRate: 130,
        spreadPercentage: 3.85,
        isAnomaly: true,
        anomalyReason: "Spread 3.85% exceeds partner threshold 3.50%",
        latencyMs: 220,
        status: "SUCCESS",
      },
    ];
  });

  it("GET /api/v1/anchor-spread/partners returns partner evaluations and rankings", async () => {
    const res = await request(app).get("/api/v1/anchor-spread/partners");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.evaluations)).toBe(true);
    expect(res.body.evaluations.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/anchor-spread/metrics returns metrics filtered by anchor or anomaly", async () => {
    const res = await request(app).get("/api/v1/anchor-spread/metrics?isAnomaly=true");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metrics.every((m: any) => m.isAnomaly === true)).toBe(true);
  });

  it("GET /api/v1/anchor-spread/anomalies returns recent anomaly records", async () => {
    const res = await request(app).get("/api/v1/anchor-spread/anomalies");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(res.body.anomalies[0].isAnomaly).toBe(true);
  });

  it("POST /api/v1/anchor-spread/profile triggers manual profiling run", async () => {
    jest.spyOn(anchorSpreadProfiler, "profileAllAnchors").mockResolvedValueOnce([
      {
        id: "m-profiled",
        timestamp: new Date(),
        anchorId: "anchor-cowrie-ngn",
        anchorName: "Cowrie Exchange",
        sellAsset: "iso4217:USD",
        buyAsset: "iso4217:NGN",
        anchorPrice: 0.00067,
        anchorRate: 1492.53,
        benchmarkRate: 1500,
        spreadPercentage: 0.5,
        isAnomaly: false,
        latencyMs: 110,
        status: "SUCCESS",
      },
    ]);

    const res = await request(app).post("/api/v1/anchor-spread/profile");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profiledCount).toBe(1);
  });
});
