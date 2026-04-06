const VIES_URL =
  'http://ec.europa.eu/taxation_customs/vies/services/checkVatService';

// All EU member state codes + XI (Northern Ireland)
export const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES',
  'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
]);

export function isValidCountryCode(code) {
  return EU_COUNTRY_CODES.has(code.toUpperCase());
}

// Countries that confirm valid/invalid but do not share company name or address.
const NO_DATA_COUNTRIES = new Set(['DE', 'ES', 'IT', 'CZ', 'SK']);

/**
 * Returns a human-readable note if the country withholds company/address data,
 * otherwise null (omitted from the response).
 */
export function getDataNote(countryCode) {
  return NO_DATA_COUNTRIES.has(countryCode)
    ? `${countryCode} does not share company name or address data via VIES. Validity confirmed only.`
    : null;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * @typedef {'RETRYABLE'|'COUNTRY_UNAVAILABLE'|'INVALID_INPUT'|'TIMEOUT'|'SERVICE_DOWN'} ViesErrorCode
 */
export class ViesError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode HTTP status to surface to the caller
   * @param {ViesErrorCode} code Machine-readable error discriminator
   */
  constructor(message, statusCode = 500, code = 'SERVICE_DOWN') {
    super(message);
    this.name = 'ViesError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Core SOAP call (single attempt)
// ---------------------------------------------------------------------------

export async function checkVat(countryCode, vatNumber) {
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVat>
      <urn:countryCode>${escapeXml(countryCode)}</urn:countryCode>
      <urn:vatNumber>${escapeXml(vatNumber)}</urn:vatNumber>
    </urn:checkVat>
  </soapenv:Body>
</soapenv:Envelope>`;

  let response;
  try {
    response = await fetch(VIES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '' },
      body: soapEnvelope,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ViesError('VIES service timed out.', 504, 'TIMEOUT');
    }
    throw new ViesError('Could not reach the VIES service.', 503, 'SERVICE_DOWN');
  }

  const text = await response.text();

  // Order matters: check specific fault codes before generic ones.
  if (
    text.includes('MS_MAX_CONCURRENT_REQ') ||
    text.includes('GLOBAL_MAX_CONCURRENT_REQ')
  ) {
    throw new ViesError('VIES is handling too many requests right now.', 503, 'RETRYABLE');
  }
  if (text.includes('MS_UNAVAILABLE')) {
    throw new ViesError(
      'The VAT authority for this country is temporarily unavailable. Please try again later.',
      503,
      'COUNTRY_UNAVAILABLE'
    );
  }
  if (text.includes('SERVICE_UNAVAILABLE')) {
    throw new ViesError('The VIES service is temporarily unavailable.', 503, 'SERVICE_DOWN');
  }
  if (text.includes('INVALID_INPUT')) {
    throw new ViesError('Invalid VAT number format for the given country.', 422, 'INVALID_INPUT');
  }
  if (text.includes('faultstring')) {
    const fault = extractTag(text, 'faultstring');
    throw new ViesError(fault || 'VIES service returned an error.', 502, 'SERVICE_DOWN');
  }
  if (!response.ok) {
    throw new ViesError(`VIES service error (HTTP ${response.status}).`, 502, 'SERVICE_DOWN');
  }

  return parseViesResponse(text);
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 3;

/**
 * Calls checkVat with up to MAX_ATTEMPTS retries for RETRYABLE errors.
 * Non-retryable errors (INVALID_INPUT, COUNTRY_UNAVAILABLE, etc.) are thrown
 * immediately on first occurrence.
 */
export async function checkVatWithRetry(countryCode, vatNumber) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await checkVat(countryCode, vatNumber);
    } catch (err) {
      lastError = err;

      const isRetryable =
        err instanceof ViesError && err.code === 'RETRYABLE';

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        throw err;
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  // Unreachable, but satisfies linters.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseViesResponse(xml) {
  const valid = extractTag(xml, 'valid');
  const name = extractTag(xml, 'name');
  const address = extractTag(xml, 'address');

  if (valid === null) {
    throw new ViesError('Unexpected response from VIES service.', 502, 'SERVICE_DOWN');
  }

  return {
    valid: valid === 'true',
    companyName: name && name !== '---' ? name : null,
    address: address && address !== '---' ? address : null,
  };
}

function extractTag(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
