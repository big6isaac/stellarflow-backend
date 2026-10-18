/**
 * Shared SEP-38 quote key & status conventions (Issue #1276).
 *
 * The remittance SEP-38 quote server mirrors every ACTIVE quote in Redis under
 * `quote:sep38:<id>` with a TTL equal to the quote lifetime, and durably in the
 * Postgres `Sep38Quote` table. Both the service and the expiry worker need to
 * agree on the namespace and lifecycle labels, so they live here together.
 */

/** Redis key prefix for mirrored SEP-38 quotes: `quote:sep38:<quoteId>`. */
export const SEP38_QUOTE_KEY_PREFIX = "quote:sep38:";

/** Lifecycle statuses persisted on `Sep38Quote.status`. */
export const SEP38_QUOTE_STATUS = {
  /** Quote is still valid for consumption. */
  ACTIVE: "ACTIVE",
  /** Quote lifetime elapsed (Redis TTL lapsed or `expiresAt` passed). */
  EXPIRED: "EXPIRED",
} as const;

export type Sep38QuoteStatus =
  (typeof SEP38_QUOTE_STATUS)[keyof typeof SEP38_QUOTE_STATUS];

/** Build the Redis key that mirrors an ACTIVE SEP-38 quote. */
export function sep38QuoteKey(quoteId: string): string {
  return `${SEP38_QUOTE_KEY_PREFIX}${quoteId}`;
}

/**
 * Extract the quote id from a mirrored Redis key, or `null` when the key does
 * not belong to the SEP-38 quote namespace.
 */
export function parseSep38QuoteKey(key: string): string | null {
  if (!key.startsWith(SEP38_QUOTE_KEY_PREFIX)) {
    return null;
  }
  const id = key.slice(SEP38_QUOTE_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}
