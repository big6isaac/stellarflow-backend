import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import { logger } from "../utils/logger";
import { RemittanceFxEngine } from "./remittance/fxEngine";
import {
  SEP38_QUOTE_STATUS,
  sep38QuoteKey,
  type Sep38QuoteStatus,
} from "./remittance/sep38QuoteStore";

export interface Sep38QuoteFee {
  total: string;
  asset: string;
  details: Array<{
    name: string;
    amount: string;
    description?: string;
  }>;
}

export interface Sep38Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  price: string;
  total_price: string;
  status: Sep38QuoteStatus;
  refreshed_from?: string | null;
  fee: Sep38QuoteFee;
}

export interface Sep38QuoteRequest {
  sell_asset?: string;
  buy_asset?: string;
  sell_amount?: string;
  buy_amount?: string;
}

export interface RefreshQuoteParams {
  /** Id of the (typically expired) quote the client wants refreshed. */
  quoteId?: string;
  /** Fallback corridor when the original quote id is unknown. */
  sellAsset?: string;
  buyAsset?: string;
  sellAmount?: string;
  buyAmount?: string;
}

/** Raised when a refresh targets a quote id that does not exist. */
export class Sep38QuoteNotFoundError extends Error {
  constructor(quoteId: string) {
    super(`Quote not found: ${quoteId}`);
    this.name = "Sep38QuoteNotFoundError";
  }
}

export class Sep38Service {
  private fxEngine: RemittanceFxEngine;
  private static readonly QUOTE_TTL_SECONDS = 60;
  private static readonly PROTOCOL_FEE_PERCENT = 0.5; // F
  private static readonly ANCHOR_SPREAD_PERCENT = 1.0; // S

  constructor(fxEngine?: RemittanceFxEngine) {
    this.fxEngine = fxEngine ?? new RemittanceFxEngine();
  }

  public async getInfo() {
    // Return mock supported assets for SEP-38
    return {
      assets: [
        { asset: "iso4217:USD" },
        { asset: "iso4217:NGN" },
        { asset: "iso4217:KES" },
        { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
        { asset: "stellar:XLM" },
      ],
    };
  }

  public async getPrices(sellAsset: string, sellAmount: string, sellDeliveryMethod?: string, buyDeliveryMethod?: string, countryCode?: string) {
    // Simplified prices endpoint
    const buyAssets = ["iso4217:NGN", "iso4217:KES", "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "stellar:XLM"].filter(a => a !== sellAsset);

    const amount = Number(sellAmount) || 1.0;
    const prices = [];

    for (const buyAsset of buyAssets) {
      const srcCurrency = this.extractCurrency(sellAsset);
      const tgtCurrency = this.extractCurrency(buyAsset);
      try {
        const rate = await this.fxEngine.getCorridorRate(srcCurrency, tgtCurrency);
        prices.push({
          asset: buyAsset,
          price: (1 / rate).toFixed(7),
          decimals: 7,
        });
      } catch (e) {
        // skip if no rate
      }
    }
    return { buy_assets: prices };
  }

  public async getPrice(sellAsset: string, buyAsset: string, sellAmount?: string, buyAmount?: string) {
    const srcCurrency = this.extractCurrency(sellAsset);
    const tgtCurrency = this.extractCurrency(buyAsset);

    const rate = await this.fxEngine.getCorridorRate(srcCurrency, tgtCurrency);

    // S and F
    const spread = Sep38Service.ANCHOR_SPREAD_PERCENT / 100;
    const protocolFee = Sep38Service.PROTOCOL_FEE_PERCENT / 100;
    const totalFeePercent = spread + protocolFee;

    const exchangeRate = rate * (1 - totalFeePercent);
    const price = (1 / exchangeRate).toFixed(7);
    const totalPrice = price; // simple representation

    let sellAmt = Number(sellAmount);
    let buyAmt = Number(buyAmount);

    if (sellAmt) {
      buyAmt = sellAmt * exchangeRate;
    } else if (buyAmt) {
      sellAmt = buyAmt / exchangeRate;
    } else {
      sellAmt = 1.0;
      buyAmt = exchangeRate;
    }

    const feeAmount = (sellAmt * totalFeePercent).toFixed(4);

    return {
      price,
      total_price: totalPrice,
      sell_amount: sellAmt.toFixed(4),
      buy_amount: buyAmt.toFixed(4),
      fee: {
        total: feeAmount,
        asset: sellAsset,
        details: [
          {
            name: "Anchor Spread",
            amount: (sellAmt * spread).toFixed(4),
            description: "Anchor spread S",
          },
          {
            name: "Protocol Fee",
            amount: (sellAmt * protocolFee).toFixed(4),
            description: "Protocol fee F",
          }
        ],
      },
    };
  }

  public async postQuote(payload: Sep38QuoteRequest): Promise<Sep38Quote> {
    const { sell_asset, buy_asset, sell_amount, buy_amount } = payload ?? {};

    if (!sell_asset || !buy_asset || (!sell_amount && !buy_amount)) {
      throw new Error("Missing required parameters");
    }

    return this.issueQuote(sell_asset, buy_asset, sell_amount, buy_amount);
  }

  /**
   * Issue a fresh quote at live anchor rates, optionally recording the quote it
   * supersedes. Used both by `postQuote` (no lineage) and the refresh engine.
   */
  private async issueQuote(
    sellAsset: string,
    buyAsset: string,
    sellAmount?: string,
    buyAmount?: string,
    refreshedFromId?: string,
  ): Promise<Sep38Quote> {
    const priceDetails = await this.getPrice(sellAsset, buyAsset, sellAmount, buyAmount);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + Sep38Service.QUOTE_TTL_SECONDS * 1000);
    const quoteId = `sep38_q_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;

    const quote: Sep38Quote = {
      id: quoteId,
      expires_at: expiresAt.toISOString(),
      sell_asset: sellAsset,
      sell_amount: priceDetails.sell_amount,
      buy_asset: buyAsset,
      buy_amount: priceDetails.buy_amount,
      price: priceDetails.price,
      total_price: priceDetails.total_price,
      status: SEP38_QUOTE_STATUS.ACTIVE,
      refreshed_from: refreshedFromId ?? null,
      fee: priceDetails.fee,
    };

    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      await redis.set(sep38QuoteKey(quoteId), JSON.stringify(quote), {
        EX: Sep38Service.QUOTE_TTL_SECONDS,
      });
    }

    await this.persistQuote(quote, expiresAt);

    return quote;
  }

  public async getQuote(id: string): Promise<Sep38Quote | null> {
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const data = await redis.get(sep38QuoteKey(id));
      if (data) {
        return JSON.parse(data) as Sep38Quote;
      }
    }

    // Fall back to the durable store: the Redis mirror is evicted on TTL lapse
    // but the lifecycle record survives as EXPIRED.
    return this.loadPersistedQuote(id);
  }

  /**
   * Client auto-refresh: reprice a quote at the current live anchor rates.
   *
   * Resolves the corridor from the original quote id when supplied (so a client
   * only has to send the id of the quote it holds) and otherwise from the
   * explicit corridor/amount parameters. The superseded quote is transitioned to
   * EXPIRED so it can never be consumed twice.
   */
  public async refreshQuote(params: RefreshQuoteParams): Promise<Sep38Quote> {
    let sellAsset = params.sellAsset;
    let buyAsset = params.buyAsset;
    let sellAmount = params.sellAmount;
    let buyAmount = params.buyAmount;
    let refreshedFromId: string | undefined;

    if (params.quoteId) {
      const original = await this.getQuote(params.quoteId);
      if (!original) {
        throw new Sep38QuoteNotFoundError(params.quoteId);
      }

      refreshedFromId = original.id;
      sellAsset = sellAsset ?? original.sell_asset;
      buyAsset = buyAsset ?? original.buy_asset;
      sellAmount = sellAmount ?? original.sell_amount;
      buyAmount = buyAmount ?? undefined;
    }

    if (!sellAsset || !buyAsset || (!sellAmount && !buyAmount)) {
      throw new Error("Missing required parameters");
    }

    const refreshed = await this.issueQuote(
      sellAsset,
      buyAsset,
      sellAmount,
      buyAmount,
      refreshedFromId,
    );

    if (refreshedFromId) {
      await this.markExpired(refreshedFromId);
    }

    return refreshed;
  }

  /**
   * Transition a quote to EXPIRED in both the Redis mirror and the durable
   * store. Safe to call repeatedly; only ACTIVE rows are moved.
   */
  public async markExpired(id: string): Promise<void> {
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      await redis.del(sep38QuoteKey(id));
    }

    try {
      await prisma.sep38Quote.updateMany({
        where: { id, status: SEP38_QUOTE_STATUS.ACTIVE },
        data: { status: SEP38_QUOTE_STATUS.EXPIRED },
      });
    } catch (error) {
      logger.warn(
        `[Sep38Service] Failed to mark quote ${id} EXPIRED in Postgres: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Sweep ACTIVE quotes whose `expires_at` has already passed. Returns the
   * number of rows transitioned to EXPIRED.
   */
  public async expireStaleQuotes(now: Date = new Date()): Promise<number> {
    const result = await prisma.sep38Quote.updateMany({
      where: { status: SEP38_QUOTE_STATUS.ACTIVE, expiresAt: { lt: now } },
      data: { status: SEP38_QUOTE_STATUS.EXPIRED },
    });

    return result.count;
  }

  private async persistQuote(quote: Sep38Quote, expiresAt: Date): Promise<void> {
    try {
      await prisma.sep38Quote.create({
        data: {
          id: quote.id,
          sellAsset: quote.sell_asset,
          sellAmount: quote.sell_amount,
          buyAsset: quote.buy_asset,
          buyAmount: quote.buy_amount,
          price: quote.price,
          totalPrice: quote.total_price,
          fee: quote.fee,
          status: quote.status,
          expiresAt,
          refreshedFromId: quote.refreshed_from ?? null,
        },
      });
    } catch (error) {
      // The Redis mirror still serves the quote; only lifecycle tracking is lost.
      logger.warn(
        `[Sep38Service] Failed to persist SEP-38 quote ${quote.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadPersistedQuote(id: string): Promise<Sep38Quote | null> {
    try {
      const record = await prisma.sep38Quote.findUnique({ where: { id } });
      if (!record) return null;

      return {
        id: record.id,
        expires_at: record.expiresAt.toISOString(),
        sell_asset: record.sellAsset,
        sell_amount: record.sellAmount.toString(),
        buy_asset: record.buyAsset,
        buy_amount: record.buyAmount.toString(),
        price: record.price.toString(),
        total_price: record.totalPrice.toString(),
        status: record.status as Sep38QuoteStatus,
        refreshed_from: record.refreshedFromId,
        fee: (record.fee as Sep38QuoteFee | null) ?? {
          total: "0",
          asset: record.sellAsset,
          details: [],
        },
      };
    } catch (error) {
      logger.warn(
        `[Sep38Service] Failed to load persisted quote ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private extractCurrency(asset: string): string {
    if (asset.startsWith("iso4217:")) {
      return asset.split(":")[1];
    }
    if (asset.startsWith("stellar:")) {
      const parts = asset.split(":");
      return parts.length >= 2 ? parts[1] : "XLM";
    }
    return asset;
  }
}
