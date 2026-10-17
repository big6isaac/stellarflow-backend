import axios, { AxiosInstance } from "axios";
import cron, { ScheduledTask } from "node-cron";
import prisma from "../../lib/prisma";
import { logger } from "../../utils/logger";
import {
  notificationService,
  AlertType,
  AlertSeverity,
} from "../notificationService";

export interface AnchorCorridor {
  sellAsset: string; // e.g. "iso4217:USD" or "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  buyAsset: string;  // e.g. "iso4217:NGN", "iso4217:KES", "iso4217:GHS"
}

export interface AnchorPartner {
  id: string;
  name: string;
  sep38Url: string;
  apiKey?: string;
  supportedCorridors: AnchorCorridor[];
  enabled: boolean;
  spreadAnomalyThresholdPercent?: number; // e.g. 3.5%
}

export interface ProfiledSpreadMetric {
  id: string;
  timestamp: Date;
  anchorId: string;
  anchorName: string;
  sellAsset: string;
  buyAsset: string;
  anchorPrice: number;
  anchorRate: number;
  benchmarkRate: number;
  spreadPercentage: number;
  isAnomaly: boolean;
  anomalyReason?: string;
  latencyMs: number;
  status: "SUCCESS" | "TIMEOUT" | "ERROR";
}

export interface PartnerEvaluation {
  anchorId: string;
  anchorName: string;
  sampleCount: number;
  averageSpreadPercentage: number;
  minSpreadPercentage: number;
  maxSpreadPercentage: number;
  anomalyCount: number;
  anomalyRatePercent: number;
  uptimePercent: number;
  competitivenessRank?: number;
}

export interface AnchorSpreadProfilerConfig {
  cronExpression?: string; // default "*/1 * * * *" (every 60 seconds)
  queryIntervalMs?: number; // fallback timer interval (60,000ms)
  defaultAnomalyThresholdPercent?: number; // default 3.5%
  httpTimeoutMs?: number; // default 5,000ms
  alertThrottleMs?: number; // default 5 minutes
  autoStartImmediateTick?: boolean; // default true
  benchmarkProvider?: (sellAsset: string, buyAsset: string) => Promise<number>;
  httpFetcher?: (url: string, params: Record<string, string>, headers?: Record<string, string>) => Promise<any>;
  notificationHandler?: (alert: any) => Promise<void>;
}

export const DEFAULT_ANCHOR_PARTNERS: AnchorPartner[] = [
  {
    id: "anchor-cowrie-ngn",
    name: "Cowrie Exchange",
    sep38Url: "https://api.cowrie.exchange/sep38",
    enabled: true,
    spreadAnomalyThresholdPercent: 3.5,
    supportedCorridors: [
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:NGN" },
      { sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buyAsset: "iso4217:NGN" },
    ],
  },
  {
    id: "anchor-clickpesa-kes",
    name: "ClickPesa Africa",
    sep38Url: "https://api.clickpesa.com/sep38",
    enabled: true,
    spreadAnomalyThresholdPercent: 3.5,
    supportedCorridors: [
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:KES" },
      { sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buyAsset: "iso4217:KES" },
    ],
  },
  {
    id: "anchor-tempo-eur",
    name: "Tempo Payments",
    sep38Url: "https://api.tempo.eu.com/sep38",
    enabled: true,
    spreadAnomalyThresholdPercent: 3.0,
    supportedCorridors: [
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:EUR" },
    ],
  },
  {
    id: "anchor-yellowcard-ghs",
    name: "Yellow Card",
    sep38Url: "https://api.yellowcard.io/sep38",
    enabled: true,
    spreadAnomalyThresholdPercent: 4.0,
    supportedCorridors: [
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:GHS" },
      { sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buyAsset: "iso4217:GHS" },
    ],
  },
];

export class AnchorSpreadProfiler {
  private partners: Map<string, AnchorPartner> = new Map();
  private scheduledTask: ScheduledTask | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isProfiling = false;
  private lastAlertTimestamps: Map<string, number> = new Map();
  private memoryHistory: ProfiledSpreadMetric[] = [];
  private readonly config: Required<AnchorSpreadProfilerConfig>;

  constructor(config?: AnchorSpreadProfilerConfig) {
    this.config = {
      cronExpression: config?.cronExpression ?? "*/1 * * * *",
      queryIntervalMs: config?.queryIntervalMs ?? 60_000,
      defaultAnomalyThresholdPercent: config?.defaultAnomalyThresholdPercent ?? 3.5,
      httpTimeoutMs: config?.httpTimeoutMs ?? 5_000,
      alertThrottleMs: config?.alertThrottleMs ?? 5 * 60 * 1000,
      autoStartImmediateTick: config?.autoStartImmediateTick ?? true,
      benchmarkProvider: config?.benchmarkProvider ?? this.getDefaultBenchmarkRate.bind(this),
      httpFetcher: config?.httpFetcher ?? this.defaultHttpFetcher.bind(this),
      notificationHandler: config?.notificationHandler ?? ((alert: any) => notificationService.sendAlert(alert)),
    };

    // Load default partners
    for (const p of DEFAULT_ANCHOR_PARTNERS) {
      this.partners.set(p.id, { ...p });
    }
  }

  // ---------------------------------------------------------------------------
  // Partner Management
  // ---------------------------------------------------------------------------

  public registerPartner(partner: AnchorPartner): void {
    this.partners.set(partner.id, { ...partner });
    logger.info(`[AnchorSpreadProfiler] Registered anchor partner: ${partner.name} (${partner.id})`);
  }

  public unregisterPartner(partnerId: string): boolean {
    const deleted = this.partners.delete(partnerId);
    if (deleted) {
      logger.info(`[AnchorSpreadProfiler] Unregistered anchor partner: ${partnerId}`);
    }
    return deleted;
  }

  public getPartners(): AnchorPartner[] {
    return Array.from(this.partners.values());
  }

  public getPartner(partnerId: string): AnchorPartner | undefined {
    return this.partners.get(partnerId);
  }

  // ---------------------------------------------------------------------------
  // Benchmark Rate Resolution
  // ---------------------------------------------------------------------------

  private extractCurrencyCode(asset: string): string {
    if (asset.startsWith("iso4217:")) {
      return asset.split(":")[1]!.toUpperCase();
    }
    if (asset.startsWith("stellar:")) {
      const parts = asset.split(":");
      return parts.length >= 2 ? parts[1]!.toUpperCase() : "XLM";
    }
    return asset.toUpperCase();
  }

  private async getDefaultBenchmarkRate(sellAsset: string, buyAsset: string): Promise<number> {
    const src = this.extractCurrencyCode(sellAsset);
    const tgt = this.extractCurrencyCode(buyAsset);

    // Fallback baseline mid-market FX rates when fxEngine or external markets are offline
    const fallbackRates: Record<string, number> = {
      "USD/NGN": 1500.0,
      "USDC/NGN": 1500.0,
      "USD/KES": 130.0,
      "USDC/KES": 130.0,
      "USD/GHS": 15.5,
      "USDC/GHS": 15.5,
      "USD/EUR": 0.92,
      "EUR/USD": 1.087,
    };

    try {
      const { RemittanceFxEngine } = await import("./fxEngine.js");
      const engine = new RemittanceFxEngine();
      const rate = await engine.getCorridorRate(src, tgt);
      if (rate && rate > 0) return rate;
    } catch (e) {
      // Fall through to fallback mid-market FX table
    }

    const key = `${src}/${tgt}`;
    if (fallbackRates[key]) {
      return fallbackRates[key]!;
    }
    const invKey = `${tgt}/${src}`;
    if (fallbackRates[invKey]) {
      return 1 / fallbackRates[invKey]!;
    }

    return 1.0;
  }

  // ---------------------------------------------------------------------------
  // Default HTTP Fetcher with timeout
  // ---------------------------------------------------------------------------

  private async defaultHttpFetcher(
    url: string,
    params: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<any> {
    const res = await axios.get(url, {
      params,
      headers,
      timeout: this.config.httpTimeoutMs,
    });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Core Profiling Cycle
  // ---------------------------------------------------------------------------

  /**
   * Profiles all registered anchor partners across their configured currency corridors.
   * Runs queries concurrently without allowing one failing anchor to block or drop others.
   */
  public async profileAllAnchors(): Promise<ProfiledSpreadMetric[]> {
    if (this.isProfiling) {
      logger.warn("[AnchorSpreadProfiler] Profiling cycle already in progress; skipping concurrent trigger");
      return [];
    }

    this.isProfiling = true;
    const now = new Date();
    const results: ProfiledSpreadMetric[] = [];

    try {
      const tasks: Promise<ProfiledSpreadMetric[]>[] = [];

      for (const partner of this.partners.values()) {
        if (!partner.enabled) continue;
        tasks.push(this.profilePartner(partner, now));
      }

      const settled = await Promise.allSettled(tasks);
      for (const item of settled) {
        if (item.status === "fulfilled") {
          results.push(...item.value);
        } else {
          logger.error("[AnchorSpreadProfiler] Error profiling partner:", {
            error: item.reason instanceof Error ? item.reason.message : String(item.reason),
          });
        }
      }

      // Persist metrics to TimescaleDB / memory
      await this.persistMetrics(results);

      // Check anomalies and issue alerts
      await this.processAnomaliesAndAlerts(results);

      return results;
    } finally {
      this.isProfiling = false;
    }
  }

  /**
   * Profiles a single anchor partner across its configured corridors.
   */
  public async profilePartner(partner: AnchorPartner, timestamp: Date): Promise<ProfiledSpreadMetric[]> {
    const metrics: ProfiledSpreadMetric[] = [];

    for (const corridor of partner.supportedCorridors) {
      const startTime = Date.now();
      const { sellAsset, buyAsset } = corridor;

      try {
        // 1. Fetch benchmark rate
        const benchmarkRate = await this.config.benchmarkProvider(sellAsset, buyAsset);

        // 2. Query SEP-38 /prices endpoint
        const queryUrl = `${partner.sep38Url.replace(/\/+$/, "")}/prices`;
        const headers: Record<string, string> = {};
        if (partner.apiKey) {
          headers["Authorization"] = `Bearer ${partner.apiKey}`;
        }

        const responseData = await this.config.httpFetcher(
          queryUrl,
          { sell_asset: sellAsset, sell_amount: "100" },
          headers,
        );

        const latencyMs = Date.now() - startTime;

        // 3. Extract rate from SEP-38 response
        const { anchorPrice, anchorRate } = this.extractSep38Rate(responseData, sellAsset, buyAsset);

        // 4. Calculate spread percentage
        // In FX remittance, spread % = ((benchmarkRate - anchorRate) / benchmarkRate) * 100
        const spreadPercentage = benchmarkRate > 0
          ? Number((((benchmarkRate - anchorRate) / benchmarkRate) * 100).toFixed(4))
          : 0;

        // 5. Check for anomaly
        const threshold = partner.spreadAnomalyThresholdPercent ?? this.config.defaultAnomalyThresholdPercent;
        const { isAnomaly, reason } = this.detectAnomaly(anchorRate, benchmarkRate, spreadPercentage, threshold);

        metrics.push({
          id: `sp_${partner.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp,
          anchorId: partner.id,
          anchorName: partner.name,
          sellAsset,
          buyAsset,
          anchorPrice,
          anchorRate,
          benchmarkRate,
          spreadPercentage,
          isAnomaly,
          anomalyReason: reason,
          latencyMs,
          status: "SUCCESS",
        });
      } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        const isTimeout = error.code === "ECONNABORTED" || error.message?.includes("timeout");
        const status = isTimeout ? "TIMEOUT" : "ERROR";
        const reason = `Query failed: ${error.message ?? "network error"}`;

        metrics.push({
          id: `sp_${partner.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp,
          anchorId: partner.id,
          anchorName: partner.name,
          sellAsset,
          buyAsset,
          anchorPrice: 0,
          anchorRate: 0,
          benchmarkRate: 0,
          spreadPercentage: 0,
          isAnomaly: true,
          anomalyReason: reason,
          latencyMs,
          status,
        });
      }
    }

    return metrics;
  }

  /**
   * Decodes exchange rate from standard SEP-38 /prices or /price payload.
   */
  public extractSep38Rate(
    data: any,
    sellAsset: string,
    buyAsset: string,
  ): { anchorPrice: number; anchorRate: number } {
    if (!data) {
      throw new Error("Empty SEP-38 response");
    }

    // Format 1: SEP-38 /prices with buy_assets list
    if (Array.isArray(data.buy_assets)) {
      const match = data.buy_assets.find(
        (b: any) => b.asset === buyAsset || this.extractCurrencyCode(b.asset) === this.extractCurrencyCode(buyAsset),
      );
      if (match && match.price) {
        const price = Number(match.price);
        if (price <= 0 || isNaN(price)) {
          throw new Error(`Invalid price in SEP-38 response: ${match.price}`);
        }
        // In SEP-38, price is amount of sell_asset to buy 1 unit of buy_asset (price = sell_amount / buy_amount)
        // Rate (units of buy_asset per unit of sell_asset) is 1 / price
        const rate = 1 / price;
        return { anchorPrice: price, anchorRate: Number(rate.toFixed(8)) };
      }
    }

    // Format 2: Direct /price response with price or buy_amount
    if (data.price) {
      const price = Number(data.price);
      if (price > 0 && !isNaN(price)) {
        const rate = 1 / price;
        return { anchorPrice: price, anchorRate: Number(rate.toFixed(8)) };
      }
    }

    // Format 3: buy_amount and sell_amount
    if (data.buy_amount && data.sell_amount) {
      const sellAmt = Number(data.sell_amount);
      const buyAmt = Number(data.buy_amount);
      if (sellAmt > 0 && buyAmt > 0) {
        const rate = buyAmt / sellAmt;
        return { anchorPrice: 1 / rate, anchorRate: Number(rate.toFixed(8)) };
      }
    }

    throw new Error(`Corridor ${sellAsset} -> ${buyAsset} not found in SEP-38 prices response`);
  }

  /**
   * Identifies anomaly conditions in anchor exchange rate or spread.
   */
  public detectAnomaly(
    anchorRate: number,
    benchmarkRate: number,
    spreadPercentage: number,
    thresholdPercent: number,
  ): { isAnomaly: boolean; reason?: string } {
    if (anchorRate <= 0) {
      return { isAnomaly: true, reason: `Inverted or non-positive anchor rate: ${anchorRate}` };
    }

    // High spread spike beyond acceptable partner threshold
    if (Math.abs(spreadPercentage) > thresholdPercent) {
      return {
        isAnomaly: true,
        reason: `Spread ${spreadPercentage.toFixed(2)}% exceeds partner threshold ${thresholdPercent.toFixed(2)}%`,
      };
    }

    return { isAnomaly: false };
  }

  // ---------------------------------------------------------------------------
  // Alerting & TimescaleDB Persistence
  // ---------------------------------------------------------------------------

  private async processAnomaliesAndAlerts(metrics: ProfiledSpreadMetric[]): Promise<void> {
    const now = Date.now();

    for (const metric of metrics) {
      if (!metric.isAnomaly) continue;

      const alertKey = `${metric.anchorId}:${metric.sellAsset}:${metric.buyAsset}`;
      const lastAlert = this.lastAlertTimestamps.get(alertKey) ?? 0;

      // Throttle alerts per anchor corridor
      if (now - lastAlert < this.config.alertThrottleMs) {
        continue;
      }

      this.lastAlertTimestamps.set(alertKey, now);

      const alertMessage =
        `[Anchor Rate Anomaly] ${metric.anchorName} (${metric.anchorId}) corridor ` +
        `${this.extractCurrencyCode(metric.sellAsset)}/${this.extractCurrencyCode(metric.buyAsset)}: ` +
        `${metric.anomalyReason}. Anchor Rate: ${metric.anchorRate}, Benchmark: ${metric.benchmarkRate}, ` +
        `Spread: ${metric.spreadPercentage.toFixed(2)}%`;

      logger.warn(alertMessage);

      try {
        await this.config.notificationHandler({
          type: AlertType.PRICE_ANOMALY,
          severity: AlertSeverity.HIGH,
          title: `Anchor Rate Spread Anomaly: ${metric.anchorName}`,
          message: alertMessage,
          timestamp: metric.timestamp ?? new Date(),
          service: "AnchorSpreadProfiler",
          details: {
            anchorId: metric.anchorId,
            corridor: `${metric.sellAsset} -> ${metric.buyAsset}`,
            spreadPercentage: metric.spreadPercentage,
            anchorRate: metric.anchorRate,
            benchmarkRate: metric.benchmarkRate,
            reason: metric.anomalyReason,
            timestamp: metric.timestamp.toISOString(),
          },
        });
      } catch (alertError) {
        logger.error("[AnchorSpreadProfiler] Failed to send anomaly alert:", alertError);
      }
    }
  }

  private async persistMetrics(metrics: ProfiledSpreadMetric[]): Promise<void> {
    // Keep in-memory cache for fast queries and offline/test support
    this.memoryHistory.push(...metrics);
    if (this.memoryHistory.length > 5000) {
      this.memoryHistory.splice(0, this.memoryHistory.length - 5000);
    }

    // Persist to TimescaleDB / Prisma table
    try {
      if (prisma && (prisma as any).anchorSpreadMetric) {
        for (const m of metrics) {
          await (prisma as any).anchorSpreadMetric.create({
            data: {
              timestamp: m.timestamp,
              anchorId: m.anchorId,
              anchorName: m.anchorName,
              sellAsset: m.sellAsset,
              buyAsset: m.buyAsset,
              anchorPrice: m.anchorPrice,
              anchorRate: m.anchorRate,
              benchmarkRate: m.benchmarkRate,
              spreadPercentage: m.spreadPercentage,
              isAnomaly: m.isAnomaly,
              anomalyReason: m.anomalyReason ?? null,
              latencyMs: m.latencyMs,
              status: m.status,
            },
          });
        }
      }
    } catch (dbError) {
      logger.warn("[AnchorSpreadProfiler] TimescaleDB insert skipped or table unavailable; cached in memory", {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Partner Evaluation & Query APIs
  // ---------------------------------------------------------------------------

  /**
   * Evaluates historical performance of all anchor partners.
   */
  public async evaluatePartners(since?: Date): Promise<PartnerEvaluation[]> {
    const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // default last 24h
    let samples: ProfiledSpreadMetric[] = [];

    try {
      if (prisma && (prisma as any).anchorSpreadMetric) {
        const rows = await (prisma as any).anchorSpreadMetric.findMany({
          where: { timestamp: { gte: cutoff } },
          orderBy: { timestamp: "desc" },
        });
        if (rows && rows.length > 0) {
          samples = rows.map((r: any) => ({
            ...r,
            anchorPrice: Number(r.anchorPrice),
            anchorRate: Number(r.anchorRate),
            benchmarkRate: Number(r.benchmarkRate),
            spreadPercentage: Number(r.spreadPercentage),
          }));
        }
      }
    } catch (e) {
      // Fall through to memory history
    }

    if (samples.length === 0) {
      samples = this.memoryHistory.filter((m) => m.timestamp >= cutoff);
    }

    const evaluations: PartnerEvaluation[] = [];

    for (const partner of this.partners.values()) {
      const partnerSamples = samples.filter((s) => s.anchorId === partner.id);
      if (partnerSamples.length === 0) {
        evaluations.push({
          anchorId: partner.id,
          anchorName: partner.name,
          sampleCount: 0,
          averageSpreadPercentage: 0,
          minSpreadPercentage: 0,
          maxSpreadPercentage: 0,
          anomalyCount: 0,
          anomalyRatePercent: 0,
          uptimePercent: 100,
        });
        continue;
      }

      const successful = partnerSamples.filter((s) => s.status === "SUCCESS");
      const anomalies = partnerSamples.filter((s) => s.isAnomaly);
      const spreads = successful.map((s) => s.spreadPercentage);

      const avgSpread = spreads.length > 0
        ? Number((spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(4))
        : 0;
      const minSpread = spreads.length > 0 ? Math.min(...spreads) : 0;
      const maxSpread = spreads.length > 0 ? Math.max(...spreads) : 0;
      const uptime = Number(((successful.length / partnerSamples.length) * 100).toFixed(2));
      const anomalyRate = Number(((anomalies.length / partnerSamples.length) * 100).toFixed(2));

      evaluations.push({
        anchorId: partner.id,
        anchorName: partner.name,
        sampleCount: partnerSamples.length,
        averageSpreadPercentage: avgSpread,
        minSpreadPercentage: minSpread,
        maxSpreadPercentage: maxSpread,
        anomalyCount: anomalies.length,
        anomalyRatePercent: anomalyRate,
        uptimePercent: uptime,
      });
    }

    // Rank partners by competitiveness (lowest average spread % among available partners)
    evaluations.sort((a, b) => a.averageSpreadPercentage - b.averageSpreadPercentage);
    evaluations.forEach((evalObj, idx) => {
      evalObj.competitivenessRank = idx + 1;
    });

    return evaluations;
  }

  public getMemoryHistory(limit = 100): ProfiledSpreadMetric[] {
    return this.memoryHistory.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Management
  // ---------------------------------------------------------------------------

  public start(): void {
    if (this.scheduledTask || this.intervalTimer) {
      logger.warn("[AnchorSpreadProfiler] Profiler worker already running");
      return;
    }

    logger.info(`[AnchorSpreadProfiler] Starting worker with schedule: ${this.config.cronExpression}`);

    // Schedule 60-second cron
    this.scheduledTask = cron.schedule(this.config.cronExpression, () => {
      void this.profileAllAnchors();
    });

    // Also trigger initial tick if configured
    if (this.config.autoStartImmediateTick) {
      void this.profileAllAnchors();
    }
  }

  public stop(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    logger.info("[AnchorSpreadProfiler] Worker stopped");
  }
}

export const anchorSpreadProfiler = new AnchorSpreadProfiler();
