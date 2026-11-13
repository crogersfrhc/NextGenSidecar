// Self-refreshing Hasura (Cognito) id_token provider for the athena-embed
// prototype's staging test harness.
//
// Mirrors the platform SPA's own refresh flow byte-for-byte (frhc-platform
// website/client/src/shared/services/aws-cognito-auth.ts, verified 2026-08-04):
// form-POST to the Cognito hosted-UI token endpoint with
// `Authorization: Basic base64(client_id:client_secret)` and
// `grant_type=refresh_token`. Refresh tokens live ~30 days (the SPA stores one
// in the `refresh_token` cookie next to `id_token`), so this turns the
// paste-a-token-every-hour ritual into a roughly-monthly one.
//
// SCOPE WARNING (DR-1, 2026-07-29 — decision of record): this is STAGING TEST
// SCAFFOLDING for the staff Cognito browser plane. The embed's production
// data path is M2M (Ingress-2 HMAC envelope + signed launch-context
// assertion); the embed never holds a Cognito token in production. Delete this
// harness when the M2M lane lands — do not let it become the auth mechanism.

const REFRESH_BUFFER_MS = 120_000; // refresh when < 2 min of validity remains
const DEFAULT_TTL_S = 3600;

// Decode a JWT's exp claim (seconds) without verifying — good enough to know
// when to refresh a token we received over TLS from the issuer.
function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Provider contract: `enabled()` says whether ANY live credential is
// configured; `getIdToken()` resolves { ok: true, idToken } or
// { ok: false, error: { code, message } } — upstream failures never throw.
//
// Modes (in precedence order):
//   1. refresh mode  — tokenUrl + refreshToken + (basicAuth | clientId+clientSecret):
//        cached id_token, proactive single-flight refresh, in-memory rotation
//        when Cognito returns a new refresh_token.
//   2. static mode   — staticIdToken only: returned as-is (legacy behavior),
//        with an honest expired error instead of a doomed upstream call.
//   3. disabled      — nothing configured.
export function createHasuraTokenProvider({
  tokenUrl,
  clientId,
  clientSecret,
  basicAuth, // pre-encoded base64(client_id:client_secret) — wins over the pair
  refreshToken,
  staticIdToken,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const auth =
    (typeof basicAuth === 'string' && basicAuth.trim()) ||
    (clientId && clientSecret ? Buffer.from(`${clientId}:${clientSecret}`).toString('base64') : '');
  const canRefresh = Boolean(tokenUrl && auth && refreshToken);

  let currentRefreshToken = refreshToken || '';
  let cachedIdToken = '';
  let cachedExpiresAtMs = 0;
  let refreshInFlight = null;

  async function performRefresh() {
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
        }).toString(),
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'token_refresh_transport_error',
          message: `Could not reach the Cognito token endpoint: ${err && err.message ? err.message : err}`,
        },
      };
    }

    let body = null;
    let rawText = '';
    try {
      rawText = await res.text();
      body = JSON.parse(rawText);
    } catch {
      /* keep rawText for the error message */
    }

    if (!res.ok || !body || !body.id_token) {
      return {
        ok: false,
        error: {
          code: 'token_refresh_failed',
          // Cognito's own reason (e.g. invalid_grant when the refresh token is
          // revoked/expired) — surfaced verbatim, never guessed at.
          message: `Cognito token refresh failed (HTTP ${res.status}): ${rawText.slice(0, 300)}`,
        },
      };
    }

    cachedIdToken = body.id_token;
    const ttlMs = (typeof body.expires_in === 'number' ? body.expires_in : DEFAULT_TTL_S) * 1000;
    cachedExpiresAtMs = (jwtExpMs(body.id_token) ?? now() + ttlMs);
    // Cognito only returns refresh_token here when rotation is enabled — keep
    // ours otherwise.
    if (typeof body.refresh_token === 'string' && body.refresh_token) {
      currentRefreshToken = body.refresh_token;
    }
    return { ok: true, idToken: cachedIdToken };
  }

  return {
    enabled() {
      return canRefresh || Boolean(staticIdToken);
    },

    mode() {
      return canRefresh ? 'refresh' : staticIdToken ? 'static' : 'disabled';
    },

    async getIdToken() {
      if (canRefresh) {
        if (cachedIdToken && now() < cachedExpiresAtMs - REFRESH_BUFFER_MS) {
          return { ok: true, idToken: cachedIdToken };
        }
        // Single-flight: concurrent callers share one refresh — Cognito can
        // reject near-simultaneous reuse of the same refresh token (same
        // guard the SPA carries).
        if (!refreshInFlight) {
          refreshInFlight = performRefresh().finally(() => {
            refreshInFlight = null;
          });
        }
        return refreshInFlight;
      }

      if (staticIdToken) {
        const expMs = jwtExpMs(staticIdToken);
        if (expMs !== null && now() >= expMs) {
          return {
            ok: false,
            error: {
              code: 'static_token_expired',
              message:
                'The configured HASURA_ID_TOKEN has expired. Paste a fresh one — or configure HASURA_REFRESH_TOKEN + COGNITO_CLIENT_ID/COGNITO_CLIENT_SECRET (or HASURA_COGNITO_BASIC) so the server refreshes itself.',
            },
          };
        }
        return { ok: true, idToken: staticIdToken };
      }

      return {
        ok: false,
        error: { code: 'token_not_configured', message: 'No Hasura credential is configured.' },
      };
    },
  };
}
