// In-memory rate limiter: 10 requests per IP per 60 seconds.
//
// ⚠ Vercel caveat: serverless functions may run on multiple instances so this
// store is NOT shared across them. For strict enforcement at scale, swap this
// out for Upstash Redis (one line change — same API surface).

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 10;

const store = new Map(); // ip -> { count, resetAt }

// Prune stale entries every 5 minutes to avoid unbounded memory growth.
let lastPrune = Date.now();
function maybePrune(now) {
  if (now - lastPrune < 5 * 60_000) return;
  lastPrune = now;
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}

/**
 * @param {string} ip
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  maybePrune(now);

  const entry = store.get(ip);

  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetAt: now + WINDOW_MS };
  }

  if (entry.count >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetAt: entry.resetAt };
}
