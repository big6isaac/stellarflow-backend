import { Router, Request, Response } from "express";
import { anchorSpreadProfiler, ProfiledSpreadMetric } from "../services/remittance/anchorSpreadProfiler.js";
import prisma from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/v1/anchor-spread/partners
 * Returns partner evaluations and competitiveness rankings.
 */
router.get("/partners", async (req: Request, res: Response) => {
  try {
    const hours = Number(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const evaluations = await anchorSpreadProfiler.evaluatePartners(since);
    res.json({ success: true, count: evaluations.length, evaluations });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/anchor-spread/metrics
 * Returns recent historical metrics with optional corridor or anchor filtering.
 */
router.get("/metrics", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const anchorId = req.query.anchorId as string | undefined;
    const isAnomaly = req.query.isAnomaly !== undefined ? req.query.isAnomaly === "true" : undefined;

    let metrics: any[] = [];
    try {
      if (prisma && (prisma as any).anchorSpreadMetric) {
        const where: any = {};
        if (anchorId) where.anchorId = anchorId;
        if (isAnomaly !== undefined) where.isAnomaly = isAnomaly;

        metrics = await (prisma as any).anchorSpreadMetric.findMany({
          where,
          orderBy: { timestamp: "desc" },
          take: limit,
        });
      }
    } catch {
      // fallback to memory
    }

    if (metrics.length === 0) {
      metrics = anchorSpreadProfiler.getMemoryHistory(limit);
      if (anchorId) metrics = metrics.filter((m) => m.anchorId === anchorId);
      if (isAnomaly !== undefined) metrics = metrics.filter((m) => m.isAnomaly === isAnomaly);
    }

    res.json({ success: true, count: metrics.length, metrics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/anchor-spread/anomalies
 * Returns recent anchor rate anomalies and alerts.
 */
router.get("/anomalies", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const metrics = anchorSpreadProfiler
      .getMemoryHistory(500)
      .filter((m: ProfiledSpreadMetric) => m.isAnomaly)
      .slice(-limit);

    res.json({ success: true, count: metrics.length, anomalies: metrics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/anchor-spread/profile
 * Manually triggers an immediate anchor rate profiling cycle.
 */
router.post("/profile", async (_req: Request, res: Response) => {
  try {
    const results = await anchorSpreadProfiler.profileAllAnchors();
    res.json({
      success: true,
      message: "Anchor rate profiling completed",
      profiledCount: results.length,
      anomaliesDetected: results.filter((r: ProfiledSpreadMetric) => r.isAnomaly).length,
      results,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
