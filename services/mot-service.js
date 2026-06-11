// ============================================================
// mot-service.js — DVSA MOT History API v1 Service
// ============================================================
// Authentication flow (OAuth 2.0 Client Credentials + API Key):
//
//   Step 1 — POST to Microsoft Entra ID to get a Bearer token
//            using client_id, client_secret and scope.
//
//   Step 2 — GET the MOT API endpoint with two headers:
//              Authorization: Bearer <token>
//              X-API-Key:     <api-key>
//
// Required environment variables (set in Railway → Variables):
//   MOT_CLIENT_ID       – Azure AD app / client ID
//   MOT_CLIENT_SECRET   – Azure AD client secret
//   MOT_API_KEY         – DVSA-issued API key
//   MOT_TENANT_ID       – Azure AD tenant ID (from the Token URL)
//
// Optional overrides:
//   MOT_SCOPE           – defaults to https://tapi.dvsa.gov.uk/.default
//   MOT_TOKEN_URL       – defaults to built from MOT_TENANT_ID
//   MOT_API_BASE_URL    – defaults to https://history.mot.api.gov.uk
// ============================================================

const MOT_CLIENT_ID     = process.env.MOT_CLIENT_ID;
const MOT_CLIENT_SECRET = process.env.MOT_CLIENT_SECRET;
const MOT_API_KEY       = process.env.MOT_API_KEY;
const MOT_TENANT_ID     = process.env.MOT_TENANT_ID;

const MOT_SCOPE = process.env.MOT_SCOPE || 'https://tapi.dvsa.gov.uk/.default';

const MOT_TOKEN_URL =
  process.env.MOT_TOKEN_URL ||
  `https://login.microsoftonline.com/${MOT_TENANT_ID}/oauth2/v2.0/token`;

const MOT_API_BASE_URL =
  process.env.MOT_API_BASE_URL || 'https://history.mot.api.gov.uk';

// ── Token cache ────────────────────────────────────────────
let cachedToken  = null;
let tokenExpiry  = 0;                        // epoch-ms
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;      // refresh 5 min before expiry

// ── Helper: obtain / refresh access token ──────────────────
async function getAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }

  // Validate required env vars
  if (!MOT_CLIENT_ID || !MOT_CLIENT_SECRET || !MOT_TENANT_ID) {
    throw new Error(
      'MOT API credentials missing. Ensure MOT_CLIENT_ID, MOT_CLIENT_SECRET ' +
      'and MOT_TENANT_ID are set in your environment variables.'
    );
  }

  console.log('[MOT] Requesting new access token from Microsoft Entra ID …');
  console.log('[MOT]   Token URL :', MOT_TOKEN_URL);
  console.log('[MOT]   Client ID :', MOT_CLIENT_ID.substring(0, 8) + '…');
  console.log('[MOT]   Scope     :', MOT_SCOPE);

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     MOT_CLIENT_ID,
    client_secret: MOT_CLIENT_SECRET,
    scope:         MOT_SCOPE,
  });

  const response = await fetch(MOT_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[MOT] Token request FAILED:', response.status, errorText);
    throw new Error(
      `MOT token request failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;

  console.log(
    `[MOT] Access token obtained — expires in ${data.expires_in}s ` +
    `(~${Math.round(data.expires_in / 60)} min)`
  );

  return cachedToken;
}

// ── Main: get MOT history by registration ──────────────────
async function getMotHistory(registration) {
  if (!registration || typeof registration !== 'string') {
    throw new Error('A valid vehicle registration is required.');
  }

  // Normalise: uppercase, strip spaces
  const reg = registration.replace(/\s+/g, '').toUpperCase();

  const token = await getAccessToken();

  if (!MOT_API_KEY) {
    throw new Error(
      'MOT_API_KEY is not set. Add it to your environment variables.'
    );
  }

  const url = `${MOT_API_BASE_URL}/v1/trade/vehicles/registration/${encodeURIComponent(reg)}`;

  console.log(`[MOT] GET ${url}`);

  const response = await fetch(url, {
    method:  'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-API-Key':     MOT_API_KEY,
    },
  });

  // ------ Handle errors ------
  if (!response.ok) {
    let errorBody = {};
    try { errorBody = await response.json(); } catch (_) { /* ignore */ }

    const code    = errorBody.errorCode    || `HTTP_${response.status}`;
    const message = errorBody.errorMessage || response.statusText;

    console.error(`[MOT] API error for "${reg}":`, code, message);

    // Map DVSA error codes to user-friendly messages
    const friendlyErrors = {
      'MOTH-NF-01': `Vehicle "${reg}" not found in MOT records.`,
      'MOTH-IV-03': `Registration "${reg}" is invalid.`,
      'MOTH-UA-01': 'MOT API authorisation failed — check credentials.',
      'MOTH-FB-02': 'MOT access token has expired (should auto-refresh).',
      'MOTH-FB-03': 'MOT API key is not recognised — check MOT_API_KEY.',
      'MOTH-FB-04': 'MOT access token is missing from the request.',
      'MOTH-RL-01': 'Daily MOT API usage limit reached.',
      'MOTH-RL-02': 'Too many requests — slow down and retry.',
    };

    const err = new Error(friendlyErrors[code] || `MOT API error: ${code} — ${message}`);
    err.statusCode = response.status;
    err.motErrorCode = code;
    throw err;
  }

  const motData = await response.json();
  console.log(`[MOT] Success for "${reg}" — ` +
    `${motData.motTests ? motData.motTests.length : 0} test(s) returned.`);

  return motData;
}

// ── Health check: verify connectivity + credentials ────────
async function testMotConnection() {
  const checks = { token: false, api: false, details: {} };

  // 1. Can we get a token?
  try {
    await getAccessToken();
    checks.token = true;
    checks.details.token = 'Access token obtained successfully.';
  } catch (err) {
    checks.details.token = err.message;
    return checks;
  }

  // 2. Can we reach the API? (Use a dummy reg — 200 or 404 both mean auth worked)
  try {
    const url = `${MOT_API_BASE_URL}/v1/trade/vehicles/registration/AA19AAA`;
    const response = await fetch(url, {
      method:  'GET',
      headers: {
        'Authorization': `Bearer ${cachedToken}`,
        'X-API-Key':     MOT_API_KEY,
      },
    });

    if (response.ok || response.status === 404) {
      checks.api = true;
      checks.details.api = `API reachable (HTTP ${response.status}).`;
    } else {
      const body = await response.json().catch(() => ({}));
      checks.details.api =
        `API returned ${response.status}: ${body.errorCode || ''} ${body.errorMessage || ''}`;
    }
  } catch (err) {
    checks.details.api = err.message;
  }

  return checks;
}

// ── Exports ────────────────────────────────────────────────
module.exports = { getMotHistory, testMotConnection };
