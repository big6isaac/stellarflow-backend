-- Issue #1238 — Remittance Anchor Exchange Rate Spread Profiler: TimescaleDB hypertable setup
--
-- Sets up the `AnchorSpreadMetric` table as a TimescaleDB hypertable partitioned by `timestamp`
-- and creates continuous aggregate view `anchor_spread_hourly_summary` for partner evaluation.
--
-- Apply AFTER the Prisma table "AnchorSpreadMetric" exists:
--     prisma db execute --file prisma/anchor_spread_hypertable.sql
--
-- The script is idempotent and safe to re-run.

DO $anchor_spread_setup$
DECLARE
  has_timescale boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb')
    INTO has_timescale;

  IF NOT has_timescale THEN
    -- Fallback for plain PostgreSQL (CI / dev environments)
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'anchor_spread_hourly_summary') THEN
      EXECUTE 'DROP VIEW anchor_spread_hourly_summary';
    END IF;

    EXECUTE $fallback_view$
      CREATE VIEW anchor_spread_hourly_summary AS
      SELECT
        date_trunc('hour', "timestamp") AT TIME ZONE 'UTC' AS bucket,
        "anchorId"                                          AS anchor_id,
        "anchorName"                                        AS anchor_name,
        "sellAsset"                                         AS sell_asset,
        "buyAsset"                                          AS buy_asset,
        COUNT(*)                                            AS sample_count,
        AVG("spreadPercentage")                             AS avg_spread_percentage,
        MIN("spreadPercentage")                             AS min_spread_percentage,
        MAX("spreadPercentage")                             AS max_spread_percentage,
        AVG("anchorRate")                                   AS avg_anchor_rate,
        AVG("benchmarkRate")                                AS avg_benchmark_rate,
        COUNT(CASE WHEN "isAnomaly" = TRUE THEN 1 END)      AS anomaly_count,
        AVG("latencyMs")                                    AS avg_latency_ms
      FROM "AnchorSpreadMetric"
      GROUP BY 1, 2, 3, 4, 5
    $fallback_view$;

    RAISE NOTICE 'timescaledb not available: created plain view anchor_spread_hourly_summary';
    RETURN;
  END IF;

  -- TimescaleDB is available
  CREATE EXTENSION IF NOT EXISTS timescaledb;

  -- Ensure table is registered as a hypertable
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AnchorSpreadMetric') THEN
    BEGIN
      PERFORM create_hypertable('"AnchorSpreadMetric"', 'timestamp', if_not_exists => TRUE);
      RAISE NOTICE 'Hypertable AnchorSpreadMetric created or already exists';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Notice: hypertable creation skipped: %', SQLERRM;
    END;
  END IF;

  -- Create continuous aggregate materialized view
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.continuous_aggregates
    WHERE view_name = 'anchor_spread_hourly_summary'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'anchor_spread_hourly_summary') THEN
      EXECUTE 'DROP VIEW anchor_spread_hourly_summary';
    END IF;

    EXECUTE $cagg$
      CREATE MATERIALIZED VIEW anchor_spread_hourly_summary
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 hour', "timestamp")             AS bucket,
        "anchorId"                                     AS anchor_id,
        "anchorName"                                   AS anchor_name,
        "sellAsset"                                    AS sell_asset,
        "buyAsset"                                     AS buy_asset,
        COUNT(*)                                       AS sample_count,
        AVG("spreadPercentage")                        AS avg_spread_percentage,
        MIN("spreadPercentage")                        AS min_spread_percentage,
        MAX("spreadPercentage")                        AS max_spread_percentage,
        AVG("anchorRate")                              AS avg_anchor_rate,
        AVG("benchmarkRate")                           AS avg_benchmark_rate,
        COUNT(CASE WHEN "isAnomaly" = TRUE THEN 1 END) AS anomaly_count,
        AVG("latencyMs")                               AS avg_latency_ms
      FROM "AnchorSpreadMetric"
      GROUP BY 1, 2, 3, 4, 5
      WITH NO DATA;
    $cagg$;

    BEGIN
      PERFORM add_continuous_aggregate_policy('anchor_spread_hourly_summary',
        start_offset => INTERVAL '3 days',
        end_offset   => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Continuous aggregate policy notice: %', SQLERRM;
    END;
  END IF;

  RAISE NOTICE 'anchor_spread TimescaleDB setup completed successfully';
END $anchor_spread_setup$;
