-- Migration: add_sep38_quote
-- Issue #1276: SEP-38 Exchange Rate Quote Expiration & Refresh Engine
-- Creates the Sep38Quote table that durably records every SEP-38 quote so the
-- lifecycle (ACTIVE -> EXPIRED) survives Redis eviction. The Redis key
-- `quote:sep38:<id>` mirrors an ACTIVE row and carries the quote TTL.

CREATE TABLE "Sep38Quote" (
    "id"              TEXT NOT NULL,
    "sellAsset"       VARCHAR(128) NOT NULL,
    "sellAmount"      DECIMAL(30,12) NOT NULL,
    "buyAsset"        VARCHAR(128) NOT NULL,
    "buyAmount"       DECIMAL(30,12) NOT NULL,
    "price"           DECIMAL(30,12) NOT NULL,
    "totalPrice"      DECIMAL(30,12) NOT NULL,
    "fee"             JSONB,
    "status"          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "refreshedFromId" TEXT,
    "refreshedAt"     TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sep38Quote_pkey" PRIMARY KEY ("id")
);

-- Primary sweep query: find ACTIVE quotes past their expiry.
CREATE INDEX "Sep38Quote_status_expiresAt_idx"
    ON "Sep38Quote" ("status", "expiresAt");

-- Status-only scans (admin dashboards, lifecycle reporting).
CREATE INDEX "Sep38Quote_status_idx"
    ON "Sep38Quote" ("status");

-- Trace refresh lineage from a superseded quote to its replacement.
CREATE INDEX "Sep38Quote_refreshedFromId_idx"
    ON "Sep38Quote" ("refreshedFromId");
