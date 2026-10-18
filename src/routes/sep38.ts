import { Router } from "express";
import { sendApiError } from "../lib/apiError";
import {
  Sep38Service,
  Sep38QuoteNotFoundError,
} from "../services/sep38Service";

const sep38Service = new Sep38Service();
const router = Router();

router.get("/info", async (req, res) => {
  try {
    const info = await sep38Service.getInfo();
    res.json(info);
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get info",
    );
  }
});

router.get("/prices", async (req, res) => {
  try {
    const { sell_asset, sell_amount, sell_delivery_method, buy_delivery_method, country_code } = req.query;

    if (!sell_asset || !sell_amount) {
      sendApiError(res, 400, "BAD_REQUEST", "sell_asset and sell_amount are required");
      return;
    }

    const prices = await sep38Service.getPrices(
      sell_asset as string,
      sell_amount as string,
      sell_delivery_method as string,
      buy_delivery_method as string,
      country_code as string
    );
    res.json(prices);
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get prices",
    );
  }
});

router.get("/price", async (req, res) => {
  try {
    const { sell_asset, buy_asset, sell_amount, buy_amount } = req.query;

    if (!sell_asset || !buy_asset) {
      sendApiError(res, 400, "BAD_REQUEST", "sell_asset and buy_asset are required");
      return;
    }
    if (!sell_amount && !buy_amount) {
      sendApiError(res, 400, "BAD_REQUEST", "sell_amount or buy_amount is required");
      return;
    }

    const price = await sep38Service.getPrice(
      sell_asset as string,
      buy_asset as string,
      sell_amount as string,
      buy_amount as string
    );
    res.json(price);
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get price",
    );
  }
});

router.post("/quote", async (req, res) => {
  try {
    const quote = await sep38Service.postQuote(req.body);
    res.status(201).json(quote);
  } catch (error) {
    sendApiError(
      res,
      400,
      "BAD_REQUEST",
      error instanceof Error ? error.message : "Failed to post quote",
    );
  }
});

router.post("/refresh-quote", async (req, res) => {
  try {
    const body: Record<string, unknown> = req.body ?? {};
    const quoteId = body.quote_id as string | undefined;
    const sellAsset = body.sell_asset as string | undefined;
    const buyAsset = body.buy_asset as string | undefined;
    const sellAmount = body.sell_amount as string | undefined;
    const buyAmount = body.buy_amount as string | undefined;

    if (!quoteId && (!sellAsset || !buyAsset || (!sellAmount && !buyAmount))) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "quote_id is required, or sell_asset and buy_asset with sell_amount or buy_amount",
      );
      return;
    }

    const quote = await sep38Service.refreshQuote({
      ...(quoteId ? { quoteId } : {}),
      ...(sellAsset ? { sellAsset } : {}),
      ...(buyAsset ? { buyAsset } : {}),
      ...(sellAmount ? { sellAmount } : {}),
      ...(buyAmount ? { buyAmount } : {}),
    });

    res.status(201).json(quote);
  } catch (error) {
    if (error instanceof Sep38QuoteNotFoundError) {
      sendApiError(res, 404, "NOT_FOUND", error.message);
      return;
    }
    sendApiError(
      res,
      400,
      "BAD_REQUEST",
      error instanceof Error ? error.message : "Failed to refresh quote",
    );
  }
});

router.get("/quote/:id", async (req, res) => {
  try {
    const quote = await sep38Service.getQuote(req.params.id);
    if (!quote) {
      sendApiError(res, 404, "NOT_FOUND", "Quote not found");
      return;
    }
    res.json(quote);
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to get quote",
    );
  }
});

export default router;
