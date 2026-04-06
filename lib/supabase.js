import { createClient } from '@supabase/supabase-js';

// Singleton client — safe to reuse across serverless invocations on the same
// instance. Uses the service-role key so it can bypass RLS for server-side ops.
let _client = null;
function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.'
      );
    }
    _client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns the cached row for a VAT number, or null if not found.
 * Does NOT filter by freshness — caller decides what to do with a stale row.
 * @returns {object|null}
 */
export async function getCached(countryCode, vatNumber) {
  const { data, error } = await getClient()
    .from('vat_cache')
    .select('valid, company_name, address, cached_at')
    .eq('country_code', countryCode)
    .eq('vat_number', vatNumber)
    .maybeSingle();

  if (error) {
    console.error('[cache] getCached error:', error.message);
    return null;
  }
  return data ?? null;
}

/**
 * Returns true if a cache row is within the 24-hour TTL.
 */
export function isFresh(row) {
  return Date.now() - new Date(row.cached_at).getTime() < CACHE_TTL_MS;
}

/**
 * Upserts a VIES result into the cache. Fire-and-forget safe.
 */
export async function setCached(countryCode, vatNumber, result) {
  const { error } = await getClient()
    .from('vat_cache')
    .upsert(
      {
        country_code: countryCode,
        vat_number: vatNumber,
        valid: result.valid,
        company_name: result.companyName ?? null,
        address: result.address ?? null,
        cached_at: new Date().toISOString(),
      },
      { onConflict: 'country_code,vat_number' }
    );

  if (error) {
    console.error('[cache] setCached error:', error.message);
  }
}

/**
 * Appends a row to vat_cache_log so the stats endpoint can compute hit rates.
 * Always fire-and-forget — never await in the response path.
 */
export function logRequest(countryCode, cacheHit) {
  getClient()
    .from('vat_cache_log')
    .insert({ country_code: countryCode, cache_hit: cacheHit })
    .then(({ error }) => {
      if (error) console.error('[cache] logRequest error:', error.message);
    });
}
