import { createClient } from '@supabase/supabase-js';

function getClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const supabase = getClient();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  // Run all three queries in parallel.
  const [totalResult, todayLogsResult, topCountryResult] = await Promise.all([
    // 1. Total rows in the cache table.
    supabase.from('vat_cache').select('*', { count: 'exact', head: true }),

    // 2. Today's log rows for hit-rate calculation.
    supabase
      .from('vat_cache_log')
      .select('cache_hit')
      .gte('logged_at', todayIso),

    // 3. Most-validated country from the log (all time).
    supabase.rpc('top_validated_country'),
  ]);

  // ── Total cached entries ───────────────────────────────────────────────────
  if (totalResult.error) {
    console.error('[cache-stats] total count error:', totalResult.error.message);
    return res.status(502).json({ error: 'Failed to query cache table.' });
  }
  const totalCached = totalResult.count ?? 0;

  // ── Today's hit rate ───────────────────────────────────────────────────────
  let cacheHitRateToday = null;
  if (todayLogsResult.error) {
    console.error('[cache-stats] log query error:', todayLogsResult.error.message);
  } else {
    const logs = todayLogsResult.data ?? [];
    const totalToday = logs.length;
    const hitsToday = logs.filter(r => r.cache_hit).length;
    cacheHitRateToday =
      totalToday === 0
        ? null
        : Math.round((hitsToday / totalToday) * 10000) / 100; // e.g. 72.34
  }

  // ── Most validated country ─────────────────────────────────────────────────
  let mostValidatedCountry = null;
  if (topCountryResult.error) {
    // RPC not available — fall back to a plain query on the log table.
    const { data, error } = await supabase
      .from('vat_cache_log')
      .select('country_code');

    if (!error && data) {
      const counts = {};
      for (const { country_code } of data) {
        counts[country_code] = (counts[country_code] ?? 0) + 1;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      mostValidatedCountry = top ? { country_code: top[0], request_count: top[1] } : null;
    }
  } else {
    const row = topCountryResult.data?.[0];
    mostValidatedCountry = row
      ? { country_code: row.country_code, request_count: Number(row.request_count) }
      : null;
  }

  return res.status(200).json({
    total_cached_entries: totalCached,
    cache_hit_rate_today_pct: cacheHitRateToday,
    most_validated_country: mostValidatedCountry,
    stats_as_of: new Date().toISOString(),
  });
}
