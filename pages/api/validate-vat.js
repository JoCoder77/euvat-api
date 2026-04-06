import { checkVatWithRetry, isValidCountryCode, ViesError } from '../../lib/vies';
import { checkRateLimit } from '../../lib/rateLimiter';
import { getCached, setCached, isFresh, logRequest } from '../../lib/supabase';

export default async function handler(req, res) {
  const startTime = Date.now();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const { allowed, remaining, resetAt } = checkRateLimit(ip);

  res.setHeader('X-RateLimit-Limit', '10');
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

  if (!allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Maximum 10 requests per minute.',
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
      response_time_ms: Date.now() - startTime,
    });
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { countryCode, vatNumber } = req.body ?? {};

  if (!countryCode || typeof countryCode !== 'string') {
    return res.status(400).json({
      error: '`countryCode` is required (e.g. "DE").',
      response_time_ms: Date.now() - startTime,
    });
  }
  if (!vatNumber || typeof vatNumber !== 'string') {
    return res.status(400).json({
      error: '`vatNumber` is required.',
      response_time_ms: Date.now() - startTime,
    });
  }

  const normalizedCountry = countryCode.trim().toUpperCase();
  const normalizedVat = vatNumber.trim().replace(/\s/g, '');

  if (!isValidCountryCode(normalizedCountry)) {
    return res.status(422).json({
      error: `"${normalizedCountry}" is not a recognised EU country code. Use the 2-letter ISO code (e.g. "DE", "FR", "EL" for Greece).`,
      response_time_ms: Date.now() - startTime,
    });
  }

  if (normalizedVat.length === 0) {
    return res.status(400).json({
      error: '`vatNumber` must not be empty.',
      response_time_ms: Date.now() - startTime,
    });
  }

  // ── Cache lookup ───────────────────────────────────────────────────────────
  let cachedRow = null;
  try {
    cachedRow = await getCached(normalizedCountry, normalizedVat);
  } catch (err) {
    // Cache unavailable — proceed to live VIES call, don't fail the request.
    console.error('[validate-vat] cache lookup failed:', err.message);
  }

  if (cachedRow && isFresh(cachedRow)) {
    // Fresh cache hit — return immediately.
    logRequest(normalizedCountry, true); // fire-and-forget
    return res.status(200).json({
      valid: cachedRow.valid,
      companyName: cachedRow.company_name,
      address: cachedRow.address,
      countryCode: normalizedCountry,
      vatNumber: normalizedVat,
      cached: true,
      stale: false,
      response_time_ms: Date.now() - startTime,
    });
  }

  // ── Live VIES call (with retry) ────────────────────────────────────────────
  try {
    const result = await checkVatWithRetry(normalizedCountry, normalizedVat);

    // Write to cache (await so the row is available for the next request,
    // but don't let a cache write failure block the response).
    setCached(normalizedCountry, normalizedVat, result).catch(err =>
      console.error('[validate-vat] cache write failed:', err.message)
    );

    logRequest(normalizedCountry, false); // fire-and-forget

    return res.status(200).json({
      valid: result.valid,
      companyName: result.companyName,
      address: result.address,
      countryCode: normalizedCountry,
      vatNumber: normalizedVat,
      cached: false,
      stale: false,
      response_time_ms: Date.now() - startTime,
    });
  } catch (err) {
    if (!(err instanceof ViesError)) {
      console.error('[validate-vat] unexpected error:', err);
      return res.status(500).json({
        error: 'An unexpected error occurred.',
        response_time_ms: Date.now() - startTime,
      });
    }

    // Country-level unavailability: clean error, no stale fallback useful here.
    if (err.code === 'COUNTRY_UNAVAILABLE') {
      return res.status(503).json({
        error: 'country_unavailable',
        message: err.message,
        response_time_ms: Date.now() - startTime,
      });
    }

    // All other VIES failures: attempt stale cache fallback before giving up.
    if (cachedRow) {
      logRequest(normalizedCountry, true); // stale hit counts as a cache hit
      return res.status(200).json({
        valid: cachedRow.valid,
        companyName: cachedRow.company_name,
        address: cachedRow.address,
        countryCode: normalizedCountry,
        vatNumber: normalizedVat,
        cached: true,
        stale: true,
        response_time_ms: Date.now() - startTime,
      });
    }

    // No cache at all and VIES is down — hard error.
    return res.status(err.statusCode).json({
      error: err.message,
      response_time_ms: Date.now() - startTime,
    });
  }
}
