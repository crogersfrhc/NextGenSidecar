// athenaOne embedded web app — prototype server.
//
// A self-contained Express app designed to be embedded as an iFrame inside
// athenahealth's athenaOne EHR. It is intentionally isolated from the main
// PATIENTREMEDI React app and API server so its global Content-Security-Policy
// and iframe-oriented pages do not interfere with the rest of the codebase.
//
// Hard athenahealth requirements implemented here:
//   1. Every response carries `Content-Security-Policy: default-src 'self' *.athenahealth.com`.
//   2. A `/launch` route as a placeholder for the SMART on FHIR SSO launch flow.
//   3. `/public/js/athenaMessaging.js` handles inbound/outbound athenaOne postMessages.
//
// The app is built by the `createAthenaEmbedApp` factory so its routes can be
// exercised in isolation with injected test doubles (see tests/server/). The
// process only binds a port when this file is run directly as the entrypoint.

import express from 'express';
import crypto from 'node:crypto';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_PATIENT_ID, DEMO_ENCOUNTER_ID } from './lib/mock-patient.js';
import {
  normalizeAthenaClaims,
  normalizeBenefits,
  normalizeAthenaPatient,
} from './lib/athena-claims.js';
import {
  fetchOrionPatientDemographics as defaultFetchOrionPatientDemographics,
  fetchOrionPatientDemographicsUpdate as defaultFetchOrionPatientDemographicsUpdate,
  mapOrionDemographics,
} from './lib/orion-demographics.js';
import {
  fetchOrionPatientCoverage as defaultFetchOrionPatientCoverage,
  fetchOrionPatientCoverageUpdate as defaultFetchOrionPatientCoverageUpdate,
  mapOrionCoverage,
} from './lib/orion-coverage.js';
import { createHasuraTokenProvider } from './lib/hasura-token.js';
import { resolveMedicaidRenewal, SAMPLE_PATIENTS as MEDICAID_SAMPLE_PATIENTS } from './lib/medicaid-renewal.js';
import { runLiveAction, validateAction } from './lib/medicaid-renewal-actions.js';
import { resolveFinancialClearance, runFinancialClearance } from './lib/financial-clearance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.ATHENA_EMBED_PORT) || 8000;

// SMART on FHIR / athenahealth Preview (sandbox) configuration.
// The Client ID is a public identifier and is safe to keep in source.
// The Client Secret MUST come from an environment variable (OAuth 2.0 Secret
// method) and must never be committed to source.
const ATHENA_SMART_CONFIG = {
  clientId: process.env.ATHENA_CLIENT_ID || '0oa12vloi9hhrzaaT298',
  environment: 'preview',
  authMethod: 'oauth2_secret',
  fhirBaseUrl: 'https://api.preview.platform.athenahealth.com/fhir/r4',
  authorizeUrl: 'https://api.preview.platform.athenahealth.com/oauth2/v1/authorize',
  tokenUrl: 'https://api.preview.platform.athenahealth.com/oauth2/v1/token',
  // Whether the Client Secret is actually configured in this environment.
  secretConfigured: Boolean(process.env.ATHENA_CLIENT_SECRET),
};

// The token endpoint used for the authorization-code exchange. Read from
// ATHENA_TOKEN_URL when provided (per requirements); fall back to the known
// Preview token endpoint (a public, non-secret URL) so the prototype still runs.
const ATHENA_TOKEN_URL = process.env.ATHENA_TOKEN_URL || ATHENA_SMART_CONFIG.tokenUrl;

// The athenaOne PAGE origin for this environment — the targetOrigin the
// embedded app must use for outbound postMessages (per the Embedded App
// Messaging guide: "Set appropriately for the environment you are in").
// Env-overridable for the production migration; the client-side bridge
// re-validates it against the *.athenahealth.com allowlist before use.
const ATHENA_ONE_ORIGIN = (process.env.ATHENA_ONE_ORIGIN || 'https://preview.athenahealth.com').trim();

// 30D — ID-token verification constants. PINNED at build time (env-overridable
// for fast correction without a code change) — NEVER derived at runtime from
// `iss`, token contents, or any request data (same injection class as the
// authorize-URL rule).
//
// Discovery source (2026-07-17, build-time, one-time):
//   - https://api.preview.platform.athenahealth.com/fhir/r4/.well-known/smart-configuration
//     -> issuer: https://athena.okta.com/oauth2/aus2hfei6ookPyyCA297
//     -> jwks_uri: https://api.preview.platform.athenahealth.com/oauth2/v1/keys
//   - Cross-checked against the issuer's own OIDC document
//     (https://athena.okta.com/oauth2/aus2hfei6ookPyyCA297/.well-known/openid-configuration):
//     issuer matches; its jwks_uri (athena.okta.com/.../v1/keys) serves the
//     IDENTICAL key set (same kids) as the athena-proxied URL. We pin the
//     athena-proxied JWKS URL to stay on the same origin family as
//     ATHENA_TOKEN_URL. ID tokens are RS256.
export const ATHENA_ID_TOKEN_ISSUER =
  process.env.ATHENA_ID_TOKEN_ISSUER || 'https://athena.okta.com/oauth2/aus2hfei6ookPyyCA297';
export const ATHENA_JWKS_URL =
  process.env.ATHENA_JWKS_URL || 'https://api.preview.platform.athenahealth.com/oauth2/v1/keys';
// Small clock tolerance for `exp`/`nbf` (seconds) — covers drift between our
// clock and the issuer's without meaningfully extending token life.
const ID_TOKEN_CLOCK_TOLERANCE_SEC = 60;
// The audience the verifier asserts (exported for tests that sign local
// tokens; a public identifier, not a secret).
export const ATHENA_ID_TOKEN_AUDIENCE = ATHENA_SMART_CONFIG.clientId;

// The athenahealth API base used to build per-practice endpoints. Public URL;
// env-overridable. The practice id is NOT hardcoded — it is parsed from the
// patient launch context and appended at request time (see buildPingUrl).
const ATHENA_API_BASE = (
  process.env.ATHENA_API_BASE || 'https://api.preview.platform.athenahealth.com'
).replace(/\/+$/, '');

// Build the practice-scoped ping URL from the authoritative practiceId parsed
// out of the patient launch context.
function buildPingUrl(practiceId) {
  return `${ATHENA_API_BASE}/v1/${encodeURIComponent(practiceId)}/ping`;
}

// Scopes requested during the SMART on FHIR authorize redirect.
//
// NARROWED 2026-09-23 (Craig) from 13 to these 5. Dropped: the bare `.r`
// variants (`.rs` subsumes `.r` under the SMART v2 c/r/u/d/s letters), and
// user/DocumentReference.*, user/Observation.* and user/Condition.* — no code
// path reads any of those three resources, so they were only ever requested
// speculatively.
//
// Why each entry is here:
//   openid          — an id_token is returned and verified (30D: pinned issuer,
//                     JWKS, audience). Without it there is nothing to verify.
//   offline_access  — yields the refresh token the 30E session refresher needs;
//                     drop it and every session dies at the ~1h token expiry.
//   launch          — the provider launch itself. Note the context claims the
//                     app reads (patient, encounter, practice) ride THIS, not
//                     user/Encounter.* : `encounterId` reaches the client from
//                     the /callback token RESPONSE, never from a FHIR read. So
//                     Encounter scope is held for FHIR Encounter reads the app
//                     may make, not for the launch context it already gets.
//   user/Patient.rs   — patient read + search.
//   user/Encounter.rs — encounter read + search.
//
// Read-only by design: no .c/.u/.d anywhere. The app's WRITES do not use this
// token at all — they go through Orion on the staff plane.
const ATHENA_SCOPES = [
  'openid',
  'offline_access',
  'launch',
  'user/Patient.rs',
  'user/Encounter.rs',
].join(' ');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// 30E: safety skew subtracted from the token's advertised lifetime — a token
// is treated as stale this long BEFORE athena would reject it, so a request
// never departs with a token that expires mid-flight. 60s comfortably covers
// clock drift + network latency without meaningfully shortening the ~1h token.
export const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

// 30E: parse `expires_in` (seconds; number or numeric string) from a token
// response into an absolute epoch-ms deadline minus the safety skew. Absent or
// unparseable -> null, which disables proactive refresh (the reactive
// once-only 401 retry still covers those sessions).
export function computeExpiresAt(tokenJson, now = Date.now()) {
  const raw = tokenJson ? tokenJson.expires_in : undefined;
  const secs =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return now + secs * 1000 - TOKEN_EXPIRY_SKEW_MS;
}

// 30B: idle TTL for a stored session. Hours, not minutes — a front-desk /
// provider session spans a working shift, and each authenticated use touches
// `lastSeenAt`, so 12 hours of true inactivity is the expiry, not 12 hours
// after launch. (The access token itself expires far sooner; 30E handles that
// separately — this TTL only bounds how long an idle token set stays in
// server memory.)
const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
// Light background prune interval (prune also runs on every session access).
const SESSION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

// Build the fresh, empty session-token state the app starts with. Both pending
// CSRF states and the most recent token set live only in process memory —
// nothing is persisted to disk or a DB. Exposed so tests can construct a
// known session (e.g. an authenticated one) without reaching into the module.
export function createSessionTokens() {
  return {
    accessToken: null,
    idToken: null,
    refreshToken: null,
    rawTokenResponse: null,
    expectedNonce: null,
    obtainedAt: null,
    // 30E: absolute epoch-ms deadline (expires_in minus safety skew) after
    // which the access token is treated as stale. null = unknown lifetime ->
    // proactive refresh skipped; the reactive 401 retry covers it.
    expiresAt: null,
    // 30E: single-flight guard — the ONE in-flight refresh promise for this
    // session (concurrent callers await it; cleared on settle). Never persisted.
    refreshPromise: null,
    // 30E: set when a refresh is rejected (or impossible) — the session is
    // dead and every subsequent resolve returns the honest relaunch error.
    evicted: false,
    // Parsed from the patient launch context (a-{practiceId}.E-{patientId}).
    // practiceId is the authoritative practice id for all subsequent API calls.
    patientContextRaw: null,
    practiceId: null,
    patientId: null,
    // Parsed from the encounter launch context (a-{practiceId}.encounter-{encounterId}).
    encounterContextRaw: null,
    encounterId: null,
    // 30B: session-store bookkeeping. `createdAt` is set once when the session
    // is minted at /callback; `lastSeenAt` is touched on every authenticated
    // use and drives the idle-TTL prune.
    createdAt: null,
    lastSeenAt: null,
  };
}

// 30B: the per-session token store. A plain Map<sessionId, tokenSet> — exposed
// so tests can construct a known store (e.g. two concurrent sessions) and
// inject it via `createAthenaEmbedApp({ sessionStore })`.
export function createSessionStore() {
  return new Map();
}

// Parse the athenaOne patient launch context. The patient id always follows the
// format `a-{practiceId}.E-{patientId}` (e.g. `a-1959370.E-27075`). Returns the
// numeric practiceId and patientId as strings, or nulls when the value does not
// match the expected shape.
function parsePatientContext(patientString) {
  if (typeof patientString !== 'string') return { practiceId: null, patientId: null };
  const match = patientString.trim().match(/^a-(\d+)\.E-(\d+)$/i);
  if (!match) return { practiceId: null, patientId: null };
  return { practiceId: match[1], patientId: match[2] };
}

// Parse the athenaOne encounter launch context. The encounter id follows the
// format `a-{practiceId}.encounter-{encounterId}` (e.g. `a-1959370.encounter-44614`).
// Returns the numeric practiceId and encounterId as strings, or nulls when the
// value does not match the expected shape.
function parseEncounterContext(encounterString) {
  if (typeof encounterString !== 'string') return { practiceId: null, encounterId: null };
  const match = encounterString.trim().match(/^a-(\d+)\.encounter-(\d+)$/i);
  if (!match) return { practiceId: null, encounterId: null };
  return { practiceId: match[1], encounterId: match[2] };
}

// Decode (without verifying) the payload of a JWT. 30D: DISPLAY-ONLY — the
// /debug page's escaped claim dump. Nothing consequential may read this;
// trusted claims come from createIdTokenVerifier's verified output.
function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string' || !jwt.includes('.')) return null;
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// 30D — map a jose verification error to a small failure class for the log
// line + error response. Never includes token material.
function classifyIdTokenError(err) {
  const code = err && err.code;
  if (code === 'ERR_JWT_EXPIRED') return 'exp';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (err.claim === 'iss') return 'iss';
    if (err.claim === 'aud') return 'aud';
    if (err.claim === 'exp' || err.claim === 'nbf' || err.claim === 'iat') return 'exp';
    return `claim:${err.claim || 'unknown'}`;
  }
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'signature';
  // Key-resolution failures (no matching kid, unreachable JWKS, malformed
  // token) are all signature-class: the signature could not be verified.
  return 'signature';
}

// 30D — build the ID-token verifier. The default resolves keys from the
// PINNED ATHENA_JWKS_URL (lazily, so processes that never see an ID token
// never touch the network); tests inject `keySource` (a jose local JWK set)
// via the factory's `overrides.idTokenVerifier`. Asserts signature, issuer,
// audience (the app's client id from the shared SMART config — the
// 30E-unified source) and expiry with a small clock tolerance. Returns
// { ok:true, claims } or { ok:false, failureClass } — never throws, never
// exposes token values.
export function createIdTokenVerifier({ keySource } = {}) {
  let keys = keySource || null;
  return async function verifyIdToken(idToken) {
    if (!keys) keys = createRemoteJWKSet(new URL(ATHENA_JWKS_URL));
    try {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: ATHENA_ID_TOKEN_ISSUER,
        audience: ATHENA_SMART_CONFIG.clientId,
        clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SEC,
      });
      return { ok: true, claims: payload };
    } catch (err) {
      return { ok: false, failureClass: classifyIdTokenError(err) };
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The redirect_uri sent to athenahealth. Read from ATHENA_REDIRECT_URI when
// provided; otherwise derived from the forwarded host so the prototype runs
// behind the Replit proxy without configuration.
function resolveRedirectUri(req) {
  if (process.env.ATHENA_REDIRECT_URI) return process.env.ATHENA_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/callback`;
}

// Build an honest, user-facing message from an athenahealth error response,
// falling back to a generic message when athena supplies nothing useful.
function athenaErrorMessage(result, fallback) {
  const b = result && result.body;
  if (b && typeof b === 'object') {
    if (typeof b.detailedmessage === 'string' && b.detailedmessage) return b.detailedmessage;
    if (typeof b.message === 'string' && b.message) return b.message;
    if (typeof b.error === 'string' && b.error && b.error !== 'athena_unreachable') return b.error;
  }
  return fallback;
}

// Pick the patient's primary insurance package from an athenahealth insurances
// payload (array or { insurances: [...] }). Returns { insuranceid, raw } or null.
function pickPrimaryInsurance(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.insurances)
      ? payload.insurances
      : [];
  if (!list.length) return null;
  const primary =
    list.find(
      (i) =>
        i &&
        (/primary/i.test(String(i.insurancetype || '')) ||
          i.sequencenumber === 1 ||
          String(i.sequencenumber) === '1'),
    ) || list[0];
  return {
    insuranceid: primary.insuranceid || primary.insurancepackageid || primary.insuranceidnumber || null,
    raw: primary,
  };
}

// Interpret an athenahealth eligibility response as active/eligible or not.
// 32-a: DENY-FIRST predicate. The previous substring regex /active|eligible/
// matched "Inactive" and "Ineligible" — an inactive patient passed the claim
// submission gate (the .agents memo flagged this). Order matters:
//   1. any negative indicator DENIES first (covers athena's real vocabulary —
//      "Inactive", "Not Eligible"/"Ineligible", "Terminated", "Not Found",
//      "Expired", plus unverified/pending-style statuses via default-deny);
//   2. then ALLOW only word-bounded "active"/"eligible" (covers athena's
//      "Active", "Active Coverage", "Eligible");
//   3. anything else (empty, unknown, "Eligibility Unverified", …) DENIES.
export function isEligibilityActive(body) {
  if (!body || typeof body !== 'object') return false;
  const record = Array.isArray(body) ? body[0] || {} : body;
  const status = String(
    record.eligibilitystatus ||
      record.status ||
      (record.lasteligibilitycheck && record.lasteligibilitycheck.eligibilitystatus) ||
      '',
  ).toLowerCase();
  if (/\binactive\b|\bineligible\b|not\s+eligible|\bterminated\b|not\s+found|\bexpired\b/.test(status)) {
    return false;
  }
  return /\bactive\b|\beligible\b/.test(status);
}

// UI claim-data field key -> athenahealth claim form field. Only these fields
// are forwarded to athenahealth on an update; anything else is ignored.
const CLAIM_UPDATE_FIELD_MAP = {
  diagnosis: 'icd10codes',
  totalCharge: 'chargeamount',
};
function buildClaimUpdateForm(updates) {
  const form = {};
  if (!updates || typeof updates !== 'object') return form;
  for (const [key, athenaField] of Object.entries(CLAIM_UPDATE_FIELD_MAP)) {
    const value = updates[key];
    if (value != null && String(value).trim() !== '') form[athenaField] = String(value).trim();
  }
  return form;
}

// --- 30E: token refresh -------------------------------------------------------
// The normalized failure every refresh dead-end returns. It reuses the exact
// 30B guard shape/code (`session_unknown`) so the client renders the honest
// "Session expired — relaunch the app from athenaOne" state with ZERO client
// changes — never a generic athena failure.
function sessionExpiredResult() {
  return {
    ok: false,
    status: 401,
    body: {
      error: 'session_unknown',
      message: 'Session expired or unknown — relaunch the app from athenaOne.',
    },
  };
}

// 30E: recognize the session-expired result at every point that would
// otherwise wrap an athena failure into a stage-specific error code. The
// `session_unknown` code must survive to the client untouched — it is what
// triggers the honest relaunch state — so multi-stage routes pass it through
// instead of relabeling it (e.g. as claim_verification_failed).
function isSessionExpiredResult(result) {
  return Boolean(
    result &&
      result.status === 401 &&
      result.body &&
      result.body.error === 'session_unknown',
  );
}

// Build the refresh machinery around an injectable token-endpoint fetch (tests
// inject a fake; production uses global fetch). The refresh POST always goes
// to the HARDCODED ATHENA_TOKEN_URL constant — never derived from anything
// runtime — with the same Basic client auth as the code exchange.
//
// Returns { ensureFreshSession, refreshSession }:
//   - ensureFreshSession(session): proactive gate called before token use.
//     Fresh (now < expiresAt, or expiresAt null) -> no-op { ok: true }.
//     Stale -> single-flight refresh, or the session-expired failure.
//   - refreshSession(session): FORCED refresh (reactive 401 path) — still
//     single-flight with any in-flight proactive refresh.
export function createSessionRefresher({ tokenFetch = fetch } = {}) {
  async function doRefresh(session) {
    if (session.evicted) return sessionExpiredResult();
    if (!session.refreshToken) {
      // No credential to refresh with — the session is dead the moment its
      // access token stops working. Mark it so every later resolve is honest.
      session.evicted = true;
      return sessionExpiredResult();
    }
    // Same client identity as the /callback code exchange — the shared config
    // (env override + known preview default), NOT a bare env read that could
    // silently diverge and send an empty client id.
    const clientId = ATHENA_SMART_CONFIG.clientId;
    const clientSecret = process.env.ATHENA_CLIENT_SECRET || '';
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });

    let resp;
    let rawText;
    try {
      resp = await tokenFetch(ATHENA_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      rawText = await resp.text();
    } catch (err) {
      // Transport failure — athena was unreachable, which says nothing about
      // whether the refresh token is still good. Do NOT evict; surface the
      // honest upstream error so a transient outage doesn't kill the session.
      return {
        ok: false,
        status: 502,
        body: {
          error: 'athena_unreachable',
          message: 'Could not reach the athenahealth token endpoint to refresh the session.',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    let tokenJson;
    try {
      tokenJson = JSON.parse(rawText);
    } catch {
      tokenJson = null;
    }

    if (!resp.ok || !tokenJson || !tokenJson.access_token) {
      // Refresh REJECTED (revoked/expired/malformed) — the session is dead.
      // One log line per attempt: outcome only, values never.
      session.evicted = true;
      console.log(
        `[athena-embed] token refresh: rejected (status ${resp.status}) — session evicted`,
      );
      return sessionExpiredResult();
    }

    // Success: adopt the new access token + lifetime. athena MAY rotate the
    // refresh token — if the response carries a new one, store it; never
    // assume either behavior.
    const rotated = Boolean(tokenJson.refresh_token);
    session.accessToken = tokenJson.access_token;
    if (rotated) session.refreshToken = tokenJson.refresh_token;
    session.expiresAt = computeExpiresAt(tokenJson);
    session.obtainedAt = Date.now();
    session.rawTokenResponse = tokenJson;
    console.log(
      `[athena-embed] token refresh: ok, refresh token ${rotated ? 'rotated' : 'retained'}`,
    );
    return { ok: true, refreshed: true };
  }

  // SINGLE-FLIGHT: concurrent callers on the same session share the ONE
  // in-flight refresh promise (stored on the session entry, cleared on settle).
  function refreshSession(session) {
    if (session.refreshPromise) return session.refreshPromise;
    const p = doRefresh(session).finally(() => {
      if (session.refreshPromise === p) session.refreshPromise = null;
    });
    session.refreshPromise = p;
    return p;
  }

  async function ensureFreshSession(session) {
    if (session.evicted) return sessionExpiredResult();
    // Fresh token, or unknown lifetime (expiresAt null): no proactive refresh.
    if (!session.expiresAt || Date.now() < session.expiresAt) return { ok: true };
    return refreshSession(session);
  }

  return { ensureFreshSession, refreshSession };
}

// --- athenahealth classic API helper -----------------------------------------
// Builds a practice-scoped athenahealth API request function bound to a given
// session-token holder. Returns a normalized { ok, status, body } and never
// throws on HTTP/transport errors — callers surface upstream failures honestly
// rather than masking them. No patient identifiers are logged.
export function createAthenaRequest(sessionTokens, { refresher } = {}) {
  // 30E: default refresher uses the real token endpoint; tests inject one
  // built over a fake tokenFetch. `null` disables refresh entirely (not used
  // in production wiring, but keeps the helper honest when called bare).
  const sessionRefresher = refresher === undefined ? createSessionRefresher() : refresher;

  return async function athenaRequest(method, apiPath, { query, form } = {}) {
    if (!sessionTokens.accessToken) {
      return {
        ok: false,
        status: 401,
        body: { error: 'not_authenticated', message: 'No active athenahealth session; complete the launch flow first.' },
      };
    }
    if (!sessionTokens.practiceId) {
      return {
        ok: false,
        status: 409,
        body: { error: 'missing_practice_id', message: 'No practiceId was parsed from the launch context.' },
      };
    }

    // 30E: proactive refresh gate — a stale token is refreshed (single-flight)
    // before the request departs; a dead session fails with the honest
    // relaunch error instead of a generic upstream 401.
    if (sessionRefresher) {
      const fresh = await sessionRefresher.ensureFreshSession(sessionTokens);
      if (!fresh.ok) return fresh;
    }

    const url = new URL(`${ATHENA_API_BASE}/v1/${encodeURIComponent(sessionTokens.practiceId)}${apiPath}`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value != null && value !== '') url.searchParams.set(key, String(value));
      }
    }

    let bodyInit;
    let contentType = null;
    if (form && typeof form === 'object') {
      contentType = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (value != null) params.set(key, String(value));
      }
      bodyInit = params.toString();
    }

    // One attempt with the CURRENT access token (re-read per attempt so a
    // refresh between attempts is picked up).
    async function attempt() {
      const headers = {
        Authorization: `Bearer ${sessionTokens.accessToken}`,
        Accept: 'application/json',
      };
      if (contentType) headers['Content-Type'] = contentType;
      let resp;
      let rawText;
      try {
        resp = await fetch(url.toString(), { method, headers, body: bodyInit });
        rawText = await resp.text();
      } catch (err) {
        return {
          ok: false,
          status: 502,
          body: { error: 'athena_unreachable', message: 'Could not reach athenahealth.', detail: err instanceof Error ? err.message : String(err) },
        };
      }
      let body;
      try {
        body = rawText ? JSON.parse(rawText) : {};
      } catch {
        body = { raw: rawText };
      }
      return { ok: resp.ok, status: resp.status, body };
    }

    let result = await attempt();

    // 30E: reactive once-only retry — a 401 despite a "fresh" token (clock
    // skew, early revocation) gets ONE forced refresh and ONE retry. A second
    // 401 means the credential set is dead: evict and fail honestly. Never loop.
    if (result.status === 401 && sessionRefresher) {
      const refreshed = await sessionRefresher.refreshSession(sessionTokens);
      if (!refreshed.ok) return refreshed;
      result = await attempt();
      if (result.status === 401) {
        sessionTokens.evicted = true;
        return sessionExpiredResult();
      }
    }

    return result;
  };
}

// --- Claim Verification mock data ---------------------------------------------
// Prototype mock data for the Claim Verification card + modal. These three
// endpoints (/api/claims, /api/benefits, /api/mrf-rates) serve this canned data
// so the demo works without a live athenahealth session. Shapes match exactly
// what public/js/app.js consumes (claims: array of normalized claim objects;
// benefits: { copay, coinsuranceRate, planType }; rates: keyed by code with a
// `negotiatedRate`). A CPT code missing from MOCK_MRF_RATES is surfaced honestly
// as "Rate not available" — never back-filled with a guess.
const MOCK_CLAIMS = [
  {
    id: 'CLM-2026-0142',
    dos: '2026-06-03',
    cpt: ['99213', '85025'],
    total: '$285.00',
    status: 'Pending',
    diagnosis: ['E11.9', 'I10'],
    billingProvider: 'Dr. Rachel Nguyen, MD',
    eligibleForSubmission: false,
    ineligibleReason:
      'This claim is still Pending review. Submission to athena is available once the claim is marked Ready.',
  },
  {
    id: 'CLM-2026-0089',
    dos: '2026-03-01',
    cpt: ['99214'],
    total: '$195.00',
    status: 'Ready',
    diagnosis: ['E78.5'],
    billingProvider: 'Dr. Rachel Nguyen, MD',
    eligibleForSubmission: true,
    ineligibleReason: '',
  },
];

// Mock negotiated rates by CPT/billing code (dollars).
const MOCK_MRF_RATES = {
  '99213': 118.0,
  '99214': 155.0,
  '85025': 22.0,
};

// Mock benefit design: a flat copay on E&M office visits (992xx) and coinsurance
// on everything else. planType narrows real MRF lookups; harmless for mock rates.
const MOCK_BENEFITS = { copay: 30.0, coinsuranceRate: 0.2, planType: 'PPO' };

// Full prototype patient profile (Olivia Torres) for GET /api/patient/:patientId.
// Shape matches exactly what public/js/app.js renderProfile() consumes, so the
// demo profile renders fully without a live athenahealth session.
const MOCK_PATIENT = {
  _mock: true,
  id: 'P-100242',
  mrn: 'MRN-100242',
  nextgen: { enterprise: '00123', practice: '001', encounterId: 'E-558843' },
  status: 'Active',
  name: { first: 'Olivia', middle: 'Marie', last: 'Torres', full: 'Olivia Torres', preferred: 'Liv' },
  initials: 'OT',
  dateOfBirth: '1987-03-14',
  age: 39,
  sex: 'Female',
  genderIdentity: 'Female',
  pronouns: 'she/her',
  maritalStatus: 'Married',
  preferredLanguage: 'English',
  race: 'White',
  ethnicity: 'Hispanic or Latino',
  ssnLast4: '4821',
  // Employer ADDED 2026-08-19 (Craig's demographics field-set review):
  // discovery-service consumes employer name+address for employment-based
  // coverage matching. Display-only — athena's patient PUT takes employer by
  // employerid, so there is deliberately no write lane for it.
  employer: { name: 'Bluebonnet Federal Credit Union' },
  contact: {
    mobilePhone: '(512) 555-0142',
    homePhone: '(512) 555-0199',
    email: 'olivia.torres@example.com',
    preferredMethod: 'Mobile phone',
    preferredContactTime: 'Afternoons',
  },
  address: {
    line1: '4820 Bluebonnet Lane',
    line2: 'Apt 3B',
    city: 'Austin',
    state: 'TX',
    postalCode: '78745',
    country: 'USA',
  },
  emergencyContact: { name: 'Daniel Torres', relationship: 'Spouse', phone: '(512) 555-0177' },
  primaryCareProvider: 'Dr. Rachel Nguyen, MD',
  careTeam: [
    { name: 'Dr. Rachel Nguyen, MD', role: 'Primary Care Physician' },
    { name: 'Dr. Marcus Bell, MD', role: 'Endocrinology' },
    { name: 'Priya Shah, RN', role: 'Care Coordinator' },
  ],
  encounter: {
    id: 'E-558843',
    type: 'Office Visit',
    date: '2026-06-03',
    time: '10:30 AM',
    status: 'Checked In',
    provider: 'Dr. Rachel Nguyen, MD',
    department: 'Internal Medicine',
    location: 'Austin Central Clinic — Suite 210',
    reasonForVisit: 'Follow-up: Type 2 diabetes management & medication review',
  },
  insurance: {
    primary: {
      payer: 'Blue Cross Blue Shield of Texas',
      planName: 'BlueChoice PPO',
      insuranceType: 'PPO',
      memberId: 'XJT884512903',
      groupNumber: 'GRP-44821',
      relationship: 'Self',
      effectiveDate: '2026-01-01',
      copay: '$30 specialist / $20 primary',
      status: 'Active — eligibility verified',
      // Relationship is Self — the policyholder IS the patient (Craig,
      // 2026-08-19: policyholder info is needed whenever it is not Self, so
      // the rows display on every policy and Self simply mirrors the patient).
      policyholder: {
        firstName: 'Olivia',
        lastName: 'Torres',
        dateOfBirth: '1987-03-14',
        sex: 'Female',
        address: { line1: '4820 Bluebonnet Lane', line2: 'Apt 3B', city: 'Austin', state: 'TX', postalCode: '78745' },
        ssnLast4: '4821',
      },
    },
    secondary: {
      payer: 'Aetna',
      planName: 'Aetna Choice POS II',
      insuranceType: 'POS',
      memberId: 'W2049913',
      groupNumber: 'GRP-10092',
      relationship: 'Spouse',
      effectiveDate: '2026-01-01',
      status: 'Active',
      // Relationship is Spouse — the policyholder is Daniel Torres (the
      // emergency-contact spouse), which is exactly the non-Self case the
      // policyholder rows exist for.
      policyholder: {
        firstName: 'Daniel',
        lastName: 'Torres',
        dateOfBirth: '1985-09-02',
        sex: 'Male',
        address: { line1: '4820 Bluebonnet Lane', line2: 'Apt 3B', city: 'Austin', state: 'TX', postalCode: '78745' },
        ssnLast4: '7734',
      },
    },
    // NextGen: N-level coverage (ranked by defaultCob). Third plan shown as Tertiary.
    tertiary: {
      payer: 'Texas Medicaid',
      planName: 'STAR Medicaid',
      insuranceType: 'Medicaid',
      memberId: '512903377',
      groupNumber: '',
      relationship: 'Self',
      effectiveDate: '2026-03-01',
      status: 'Active',
      policyholder: {
        firstName: 'Olivia',
        lastName: 'Torres',
        dateOfBirth: '1987-03-14',
        sex: 'Female',
        address: { line1: '4820 Bluebonnet Lane', line2: 'Apt 3B', city: 'Austin', state: 'TX', postalCode: '78745' },
        ssnLast4: '4821',
      },
    },
  },
  // MRF-SIDECAR (D-113): a prior plan that has EXPIRED. The MRF Rate Search
  // filter (app.js mrfFilterToPatientPlans) must never count it, even though
  // the mock has rates for it. Kept OUTSIDE `insurance` on purpose: the Member
  // Eligibility card derives its package options from every key of
  // `insurance`, so a third key there would add a package. Only MRF reads this.
  insuranceHistory: [
    {
      payer: 'UnitedHealthcare',
      planName: 'Choice Plus PPO',
      insuranceType: 'PPO',
      memberId: 'UHC-3381920',
      effectiveDate: '2024-01-01',
      terminationDate: '2025-12-31',
      status: 'Expired',
    },
  ],
  balance: {
    patientResponsibility: '$145.00',
    lastPaymentAmount: '$50.00',
    lastPaymentDate: '2026-05-12',
  },
  allergies: [
    { substance: 'Penicillin', reaction: 'Hives', severity: 'Moderate' },
    { substance: 'Sulfa drugs', reaction: 'Rash', severity: 'Mild' },
    { substance: 'Shellfish', reaction: 'Anaphylaxis', severity: 'Severe' },
  ],
  medications: [
    { name: 'Metformin', dose: '1000 mg', frequency: 'Twice daily', status: 'Active' },
    { name: 'Lisinopril', dose: '10 mg', frequency: 'Once daily', status: 'Active' },
    { name: 'Atorvastatin', dose: '20 mg', frequency: 'Once daily at bedtime', status: 'Active' },
    { name: 'Levothyroxine', dose: '75 mcg', frequency: 'Once daily', status: 'Active' },
  ],
  problems: [
    { description: 'Type 2 diabetes mellitus', code: 'E11.9', since: '2019', status: 'Active' },
    { description: 'Essential hypertension', code: 'I10', since: '2021', status: 'Active' },
    { description: 'Hyperlipidemia', code: 'E78.5', since: '2022', status: 'Active' },
    { description: 'Hypothyroidism', code: 'E03.9', since: '2018', status: 'Active' },
  ],
  vitals: {
    recordedOn: '2026-06-03',
    heightInches: 65,
    weightLbs: 168,
    bmi: 27.9,
    bloodPressure: '128/82 mmHg',
    heartRate: '74 bpm',
    temperatureF: 98.4,
    respiratoryRate: '16 /min',
    oxygenSaturation: '98%',
  },
  alerts: [
    { type: 'Care gap', message: 'HbA1c due — last result 7.4% on 2025-12-01' },
    { type: 'Preventive', message: 'Annual eye exam recommended for diabetic retinopathy screening' },
  ],
  lastVisit: '2026-03-01',
  nextAppointment: '2026-09-02',
};

// MRF-SIDECAR (D-101): a synthetic SELF-PAY patient — no active primary or
// secondary plan — so the Rate Search's "no active plan" state can be demoed
// (launch with ?patientId=P-100318). Derived from MOCK_PATIENT so every other
// card still has the fields it reads; only identity and insurance differ.
const MOCK_SELF_PAY_PATIENT_ID = 'P-100318';
const MOCK_SELF_PAY_PATIENT = {
  ...MOCK_PATIENT,
  id: MOCK_SELF_PAY_PATIENT_ID,
  mrn: 'MRN-100318',
  name: { first: 'Jordan', middle: 'Lee', last: 'Avery', full: 'Jordan Avery', preferred: 'Jordan' },
  initials: 'JA',
  dateOfBirth: '1991-07-22',
  age: 35,
  sex: 'Male',
  genderIdentity: 'Male',
  pronouns: 'he/him',
  ssnLast4: '6604',
  employer: { name: 'Riverside Coffee Roasters' },
  contact: {
    ...MOCK_PATIENT.contact,
    mobilePhone: '(512) 555-0318',
    homePhone: '(512) 555-0319',
    email: 'jordan.avery@example.com',
  },
  emergencyContact: { name: 'Casey Avery', relationship: 'Sibling', phone: '(512) 555-0320' },
  insurance: {},
  insuranceHistory: [],
};

// Mock profiles by requested athena patient id; anything else gets Olivia
// Torres, exactly as before.
function mockPatientFor(patientId) {
  return patientId === MOCK_SELF_PAY_PATIENT_ID ? MOCK_SELF_PAY_PATIENT : MOCK_PATIENT;
}

// --- Application factory ------------------------------------------------------
// Builds the Express app with injectable dependencies so its routes can be
// tested in isolation. Overrides (30B store-level shape):
//   - sessionStore:      Map<sessionId, tokenSet> (default: fresh empty Map).
//                        Tests pre-populate it with known sessions.
//   - athenaRequestFor:  (tokenSet) => athenaRequest fn (default: the real
//                        createAthenaRequest) — inject to drive the
//                        eligibility-gated submit/update routes
//                        deterministically per session
//   - lookupMrfRates:    the negotiated-rate lookup fn (default: the real one)
export function createAthenaEmbedApp(overrides = {}) {
  const sessionStore = overrides.sessionStore || createSessionStore();
  // 30E: the refresh machinery is app-level so /ping and every athenaRequest
  // share the same single-flight guard per session. Tests inject `tokenFetch`
  // (a fake token endpoint) or a whole `refresher`.
  const refresher =
    overrides.refresher || createSessionRefresher({ tokenFetch: overrides.tokenFetch || fetch });
  const athenaRequestFor =
    overrides.athenaRequestFor || ((tokens) => createAthenaRequest(tokens, { refresher }));
  // 30D: the ID-token verifier is factory-injectable so tests supply a local
  // key set (no live tokens, no network). Default verifies against the PINNED
  // issuer + JWKS constants.
  const idTokenVerifier = overrides.idTokenVerifier || createIdTokenVerifier();
  const lookupMrfRates = overrides.lookupMrfRates || (async () => ({ ok: false, error: { code: 'not_in_scope', message: 'Rate Search is not in the NextGen v1 prototype.' } }));

  // Orion demographics lane (2026-08-04): live mode is on when EITHER a
  // static HASURA_ID_TOKEN or the self-refresh credential set is configured
  // (HASURA_REFRESH_TOKEN + HASURA_COGNITO_BASIC or COGNITO_CLIENT_ID/
  // COGNITO_CLIENT_SECRET; COGNITO_TOKEN_URL defaults to staging). Without
  // any credential the patient route serves the mock profile exactly as
  // before. The Orion patient id is PINNED server-side (env, default = the
  // staging demo patient 27075/Olivia Torres): the client's :patientId is an
  // ATHENA id with no athena→Orion identity mapping (Epic I is
  // attribution-only per DR-1), and forwarding a client-supplied id through
  // this server's staff token would be an IDOR. Tests inject all three deps.
  const fetchOrionDemographics =
    overrides.fetchOrionDemographics || defaultFetchOrionPatientDemographics;
  const fetchOrionDemographicsUpdate =
    overrides.fetchOrionDemographicsUpdate || defaultFetchOrionPatientDemographicsUpdate;
  // Orion coverage lane (2026-08-14, platform PR #3110): same live-mode gate,
  // same server-side patient pin, same test injection points.
  const fetchOrionCoverage =
    overrides.fetchOrionCoverage || defaultFetchOrionPatientCoverage;
  const fetchOrionCoverageUpdate =
    overrides.fetchOrionCoverageUpdate || defaultFetchOrionPatientCoverageUpdate;
  const orionDemographicsEnv = overrides.orionDemographicsEnv || {
    hasuraOrigin: process.env.HASURA_ORIGIN || 'https://test.frontrunnerhc.ai',
    patientId: process.env.ORION_PATIENT_ID || '27075',
  };
  const hasuraTokenProvider =
    overrides.hasuraTokenProvider ||
    createHasuraTokenProvider({
      tokenUrl:
        process.env.COGNITO_TOKEN_URL ||
        'https://frontrunner-stg.auth.us-east-1.amazoncognito.com/oauth2/token',
      clientId: process.env.COGNITO_CLIENT_ID || '',
      clientSecret: process.env.COGNITO_CLIENT_SECRET || '',
      basicAuth: process.env.HASURA_COGNITO_BASIC || '',
      refreshToken: process.env.HASURA_REFRESH_TOKEN || '',
      staticIdToken: process.env.HASURA_ID_TOKEN || '',
    });

  // Medicaid Renewal tab (2026-10-21): same live-mode gate and token as the
  // Orion lanes, and the same IDOR posture — the FrontRunner client id and
  // canonical patient id are PINNED here (no athena → FrontRunner mapping
  // exists). Both unset = the tab honestly reports "not connected".
  // Review samples are OFF unless MEDICAID_RENEWAL_SAMPLE_DATA=1 (Craig,
  // 2026-10-30: "never ship sample data on"; this ends the temporary
  // 2026-10-28 default). With the setting on, ?medicaidSample=<name> picks
  // any sample, and a patient shown with the Olivia Torres mock profile
  // (everyone except the self-pay demo patient) opens on the "olivia"
  // sample, labelled "Sample data — not a real patient." With it off the tab
  // shows the pinned live patient or its honest empty state, and
  // ?medicaidSample is ignored.
  const medicaidRenewalSamplesOn = process.env.MEDICAID_RENEWAL_SAMPLE_DATA === '1';
  const medicaidRenewalEnv = overrides.medicaidRenewalEnv || {
    hasuraOrigin: process.env.HASURA_ORIGIN || 'https://test.frontrunnerhc.ai',
    clientId: process.env.MEDICAID_RENEWAL_CLIENT_ID || '',
    patientId: process.env.MEDICAID_RENEWAL_PATIENT_ID || '',
    sampleDataEnabled: medicaidRenewalSamplesOn,
    defaultSample: medicaidRenewalSamplesOn ? 'olivia' : '',
    // "Open in FrontRunner" (actionable addendum): the product's case page is
    // <app>/medicaid-renewal?wf=<workfile id> (as read from the Replit
    // preview, 2026-10-26). Unset = no link (the button says so).
    frontRunnerAppUrl: (process.env.FRONTRUNNER_APP_URL || '').replace(/\/+$/, ''),
  };
  const medicaidRenewalQuery = overrides.medicaidRenewalQuery;

  // Financial Clearance (2026-10-30): same token and the same IDOR posture as
  // the Medicaid Renewal lane — client id and canonical patient id PINNED
  // here. Unlike that lane this one WRITES (Run Financial Clearance upserts
  // the patient's clearance record), so it is off unless both pins are set,
  // and the pins must be a test patient (Bob or Carol). No sample data, ever.
  const financialClearanceEnv = overrides.financialClearanceEnv || {
    hasuraOrigin: process.env.HASURA_ORIGIN || 'https://test.frontrunnerhc.ai',
    clientId: process.env.FINANCIAL_CLEARANCE_CLIENT_ID || '',
    patientId: process.env.FINANCIAL_CLEARANCE_PATIENT_ID || '',
  };
  const financialClearanceQuery = overrides.financialClearanceQuery;
  const financialClearanceAction = overrides.financialClearanceAction;

  // `pendingStates` holds one-time CSRF `state` values minted at /launch and
  // validated at /callback. Per-app so isolated test apps never share state.
  const pendingStates = new Map(); // state -> { nonce, iss, createdAt }

  function pruneExpiredStates() {
    const now = Date.now();
    for (const [state, entry] of pendingStates) {
      if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
    }
  }

  // 30B: idle-TTL prune, mirroring pendingStates. Runs on every session access
  // and on a light background interval (unref'd so tests/short-lived processes
  // exit cleanly).
  function pruneExpiredSessions() {
    const now = Date.now();
    for (const [id, s] of sessionStore) {
      const seen = s.lastSeenAt || s.createdAt;
      // A stored session without timestamps (e.g. injected by a test) starts
      // its idle clock on first sight rather than being treated as epoch-old.
      if (!seen) {
        s.lastSeenAt = now;
        continue;
      }
      if (now - seen > SESSION_IDLE_TTL_MS) sessionStore.delete(id);
    }
  }
  const pruneTimer = setInterval(pruneExpiredSessions, SESSION_PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  // 30B: resolve THIS request's session from the explicit handle — the
  // `X-Session-Id` header (API calls) or the `session` query param (page
  // routes). There is NO fallback of any kind: a missing handle and an
  // unknown/expired handle each return a distinct honest error, never some
  // other session's tokens. Touches lastSeenAt on success.
  function resolveSession(req) {
    pruneExpiredSessions();
    const headerId = req.get('x-session-id');
    const queryId = typeof req.query.session === 'string' ? req.query.session : '';
    const sessionId = (typeof headerId === 'string' && headerId) || queryId || '';
    if (!sessionId) {
      return {
        error: 'session_required',
        status: 401,
        message: 'No session handle was provided. Relaunch the app from athenaOne.',
      };
    }
    const session = sessionStore.get(sessionId);
    // 30E: an evicted session (refresh rejected / no refresh credential) is
    // indistinguishable from an unknown one on purpose — the honest relaunch
    // error, never a generic athena failure. Drop the dead entry eagerly.
    if (session && session.evicted) sessionStore.delete(sessionId);
    if (!session || session.evicted) {
      return {
        error: 'session_unknown',
        status: 401,
        message: 'Session expired or unknown — relaunch the app from athenaOne.',
      };
    }
    session.lastSeenAt = Date.now();
    return { session, sessionId };
  }

  // 30B: shared JSON guard for API routes. Returns the resolved session or
  // null after writing the honest, distinct error response.
  function requireSession(req, res) {
    const resolved = resolveSession(req);
    if (resolved.error) {
      res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
      return null;
    }
    return resolved;
  }

  // The patient id parsed from the launch context is authoritative for every
  // patient-scoped call; the client never supplies it, so a user cannot pull
  // another patient's claims through this proxy.
  function requireSessionPatientId(session, res) {
    if (!session.patientId) {
      res.status(409).json({
        error: 'missing_patient_id',
        message: 'No patientId was parsed from the launch context; cannot resolve claims.',
      });
      return null;
    }
    return session.patientId;
  }

  // Confirm a client-supplied claimId actually belongs to the launched patient
  // before any mutating action (submit/update). athena scopes claims by token,
  // but the claimId arrives from the browser, so we re-derive the launched
  // patient's own claim list and require the id to be in it. This closes the
  // object-level-authorization (IDOR) gap: a caller cannot submit or edit another
  // patient's claim by guessing its id. Returns:
  //   { ok:true, found:boolean } on a successful lookup, or
  //   { ok:false, status, message } when athena could not be consulted.
  async function verifyClaimOwnership(athenaRequest, claimId, patientId) {
    const result = await athenaRequest('GET', '/claims', {
      query: { patientid: patientId, showentirefamily: 'false' },
    });
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        message: athenaErrorMessage(result, 'Could not verify the claim against the patient record.'),
        // 30E: keep the raw result so callers can pass a session-expired
        // failure through untouched instead of relabeling it.
        result,
      };
    }
    const claims = normalizeAthenaClaims(result.body);
    const found = claims.some((c) => c.id === String(claimId));
    return { ok: true, found };
  }

  const app = express();
  app.disable('x-powered-by');

  // --- Requirement #1: CSP header on EVERY response ---------------------------
  // Applied as the very first middleware so it covers static assets, rendered
  // pages, JSON responses, errors, and 404s alike.
  // 32-b: frame-ancestors — the app renders PHI-shaped data and must only be
  // frameable by athenaOne. Allowlist https://*.athenahealth.com (covers
  // preview.athenahealth.com and production athenaOne); env-overridable via
  // ATHENA_FRAME_ANCESTORS (space-separated origins) for the environment
  // migration — a different production framing origin is corrected without a
  // code change. frame-ancestors restricts FRAMING only; direct (top-level)
  // visits, e.g. demo mode, are unaffected.
  const frameAncestors = (process.env.ATHENA_FRAME_ANCESTORS || 'https://*.athenahealth.com').trim();
  const cspHeaderValue =
    "default-src 'self' *.athenahealth.com; frame-ancestors " + frameAncestors;
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', cspHeaderValue);
    next();
  });

  // Static assets (athenaMessaging.js, app.js, styles) served under /public so the
  // athenaOne messaging bridge is reachable at /public/js/athenaMessaging.js.
  app.use(
    '/public',
    express.static(path.join(__dirname, 'public'), {
      setHeaders(res) {
        // Avoid stale cached assets during prototype iteration.
        if (process.env.NODE_ENV !== 'production') {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    }),
  );

  // JSON body parsing for the Claim Verification backend endpoints (mrf-rates,
  // claim submit/update). Kept after the CSP + static middleware so those still
  // apply first.
  app.use(express.json({ limit: '256kb' }));

  // --- App shell --------------------------------------------------------------
  // Server-rendered shell. The "waiting for patient context" state is shown by
  // default; client-side JS reveals the profile once athenaOne (or demo mode)
  // supplies a patientID.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  });

  // --- Requirement #2: /launch SMART on FHIR SSO placeholder ------------------
  // athenaOne opens the app via a SMART on FHIR launch, passing `iss` (the FHIR
  // server base) and `launch` (an opaque launch context token). A full
  // implementation would discover the authorization endpoint, redirect the user
  // to authorize with the Client ID + requested scopes, then exchange the returned
  // code for an access token using the OAuth 2.0 Secret method. This route is a
  // documented placeholder for that flow.
  app.get('/launch', (req, res) => {
    const iss = typeof req.query.iss === 'string' ? req.query.iss : '';
    const launch = typeof req.query.launch === 'string' ? req.query.launch : '';

    // --- Scenario A: launched from athenaOne (iss + launch present) -----------
    // Mint one-time state + nonce, remember state server-side, and redirect the
    // browser to the HARDCODED Preview authorize endpoint. The authorize URL is
    // never derived from `iss` — `iss` is used only as the `aud` parameter.
    if (iss && launch) {
      // 28B observability: record that a SMART launch arrived. Only the iss
      // HOSTNAME is logged — never the launch token or full parameter values.
      let issHost = '(unparseable)';
      try { issHost = new URL(iss).host; } catch { /* keep placeholder */ }
      console.log(`[athena-embed] /launch: SMART launch received (iss host: ${issHost}, launch token present: yes)`);
      const state = crypto.randomBytes(32).toString('hex');
      const nonce = crypto.randomBytes(32).toString('hex');
      pruneExpiredStates();
      pendingStates.set(state, { nonce, iss, createdAt: Date.now() });

      // The authorize endpoint is always the hardcoded Preview authorize URL.
      // The `iss` value is used ONLY as the `aud` parameter, never to build the URL.
      const authorizeUrl = new URL(ATHENA_SMART_CONFIG.authorizeUrl);
      authorizeUrl.searchParams.set('client_id', ATHENA_SMART_CONFIG.clientId);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('redirect_uri', resolveRedirectUri(req));
      authorizeUrl.searchParams.set('scope', ATHENA_SCOPES);
      authorizeUrl.searchParams.set('aud', iss);
      authorizeUrl.searchParams.set('launch', launch);
      authorizeUrl.searchParams.set('nonce', nonce);
      authorizeUrl.searchParams.set('state', state);

      return res.redirect(302, authorizeUrl.toString());
    }

    // --- Scenario B: accessed directly in a browser (no iss/launch) -----------
    // Show the informational SMART on FHIR config placeholder for dev/testing.
    console.log('[athena-embed] /launch: no iss/launch \u2192 config page');
    const rows = [
      ['Client ID', ATHENA_SMART_CONFIG.clientId],
      ['Environment', 'athenahealth Preview (sandbox)'],
      ['Auth method', 'OAuth 2.0 Secret'],
      ['Client Secret configured', ATHENA_SMART_CONFIG.secretConfigured ? 'Yes' : 'No (set ATHENA_CLIENT_SECRET)'],
      ['Authorize URL', ATHENA_SMART_CONFIG.authorizeUrl],
      ['Token URL', ATHENA_SMART_CONFIG.tokenUrl],
      ['FHIR base (iss)', iss || ATHENA_SMART_CONFIG.fhirBaseUrl],
      ['Launch token', launch || '(none provided)'],
    ]
      .map(
        ([label, value]) =>
          `<div class="kv-row"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value">${escapeHtml(value)}</span></div>`,
      )
      .join('');

    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SMART on FHIR Launch — Placeholder</title>
  <link rel="stylesheet" href="/public/css/styles.css" />
</head>
<body class="launch-body">
  <main class="launch-card" role="main">
    <span class="badge badge-amber">Placeholder</span>
    <h1>SMART on FHIR SSO Launch</h1>
    <p class="muted">
      This is a stub for the athenaOne SMART on FHIR single sign-on launch flow.
      In production this endpoint discovers the authorization server, redirects to
      authorize with the Client ID and requested scopes, and exchanges the
      returned code for an access token using the OAuth&nbsp;2.0 Secret method.
    </p>
    <section class="kv" aria-label="Launch configuration">${rows}</section>
    <ol class="steps">
      <li>Receive <code>iss</code> + <code>launch</code> from athenaOne.</li>
      <li>Fetch <code>{iss}/.well-known/smart-configuration</code> to discover endpoints.</li>
      <li>Redirect to <code>authorize</code> with <code>client_id</code>, <code>scope</code>, <code>redirect_uri</code>, <code>state</code>, <code>aud=iss</code>, <code>launch</code>.</li>
      <li>Exchange the authorization code at the token endpoint using the Client Secret.</li>
      <li>Open the app shell with the established patient context.</li>
    </ol>
    <a class="btn btn-primary" href="/">Open app shell</a>
  </main>
</body>
</html>`);
  });

  // --- OAuth 2.0 redirect / token exchange ------------------------------------
  // athenahealth redirects the browser here after the user authorizes the app,
  // supplying `code` (the authorization code) and `state`. This route exchanges
  // the code for an access token at the Preview token endpoint using the OAuth 2.0
  // Secret method (HTTP Basic auth with the Client ID + Client Secret). The
  // redirect_uri sent here MUST exactly match the one used in the authorize
  // request and registered with athenahealth.
  //
  // NOTE: For this verification phase the full token response is returned as JSON
  // so the exchange can be confirmed end-to-end. The access token must NOT be
  // surfaced to the browser once the flow is real — store it server-side instead.
  app.get('/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    // athenahealth may redirect back with an OAuth error instead of a code.
    if (typeof req.query.error === 'string' && req.query.error) {
      return res.status(400).json({
        error: 'oauth_redirect_error',
        oauthError: req.query.error,
        oauthErrorDescription:
          typeof req.query.error_description === 'string' ? req.query.error_description : null,
        state,
      });
    }

    if (!code) {
      return res.status(400).json({
        error: 'missing_code',
        message: 'No authorization code was supplied on the OAuth redirect.',
        state,
      });
    }

    // Validate `state` against what was minted at /launch (CSRF protection).
    pruneExpiredStates();
    const storedState = state ? pendingStates.get(state) : null;
    if (!storedState) {
      return res.status(400).json({
        error: 'invalid_state',
        message: 'The returned state does not match a known launch request (expired or forged).',
      });
    }
    // One-time use: consume the state regardless of exchange outcome.
    pendingStates.delete(state);

    const clientId = ATHENA_SMART_CONFIG.clientId;
    const clientSecret = process.env.ATHENA_CLIENT_SECRET;
    if (!clientSecret) {
      return res.status(500).json({
        error: 'client_secret_not_configured',
        message: 'ATHENA_CLIENT_SECRET is not set in the environment; cannot exchange the code.',
      });
    }

    const redirectUri = resolveRedirectUri(req);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let tokenResponse;
    let rawText;
    try {
      tokenResponse = await fetch(ATHENA_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      rawText = await tokenResponse.text();
    } catch (err) {
      return res.status(502).json({
        error: 'token_request_failed',
        message: 'Could not reach the athenahealth token endpoint.',
        detail: err instanceof Error ? err.message : String(err),
        redirectUri,
      });
    }

    let tokenJson;
    try {
      tokenJson = JSON.parse(rawText);
    } catch {
      tokenJson = { raw: rawText };
    }

    // On failure, the browser gets a GENERIC, stable error (32-c) — the raw
    // token-endpoint body is never echoed back. The upstream status and OAuth
    // error CODES (never the description free-text, never token material) are
    // logged server-side only, 30C style.
    if (!tokenResponse.ok || !tokenJson || !tokenJson.access_token) {
      const upstreamError =
        tokenJson && typeof tokenJson.error === 'string' ? tokenJson.error.slice(0, 64) : 'none';
      console.log(
        `[athena-embed] /callback: token exchange FAILED (token endpoint status: ${tokenResponse.status}, error code: ${upstreamError})`,
      );
      return res.status(tokenResponse.status || 502).json({
        error: 'token_exchange_failed',
        message: 'The authorization code could not be exchanged. Relaunch from athenaOne to try again.',
      });
    }

    // 30D — VERIFY the ID token (signature, issuer, audience, expiry) BEFORE
    // the nonce check and BEFORE any claim is read. A verification failure
    // hard-fails the callback: no tokens stored, no session minted, no
    // context parsed. The log line names the failure class only — never the
    // token. `verifiedIdClaims` is the ONLY source of ID-token claims from
    // here on; the unverified decode is display-only (/debug).
    let verifiedIdClaims = null;
    if (tokenJson.id_token) {
      const verdict = await idTokenVerifier(tokenJson.id_token);
      if (!verdict.ok) {
        console.log(
          `[athena-embed] /callback: ID token verification FAILED (class: ${verdict.failureClass})`,
        );
        return res.status(401).json({
          error: 'id_token_verification_failed',
          failureClass: verdict.failureClass,
          message:
            'The ID token returned by athenahealth could not be verified, so the launch was rejected. Relaunch the app from athenaOne.',
        });
      }
      verifiedIdClaims = verdict.claims;

      // Nonce check (replay / token-substitution protection) on VERIFIED
      // claims. We always send a nonce at /launch, so a verified token
      // WITHOUT a nonce claim is a hard failure exactly like a mismatch
      // (30D closes the old skip-when-absent hole).
      if (!verifiedIdClaims.nonce || verifiedIdClaims.nonce !== storedState.nonce) {
        console.log(
          `[athena-embed] /callback: ID token verification FAILED (class: ${verifiedIdClaims.nonce ? 'nonce-mismatch' : 'nonce-missing'})`,
        );
        return res.status(400).json({
          error: 'invalid_nonce',
          message: verifiedIdClaims.nonce
            ? 'The ID token nonce does not match the value issued for this launch.'
            : 'The ID token is missing the nonce issued for this launch.',
        });
      }
    }

    // 30B — Success: build a FRESH token set for THIS launch and store it in
    // the per-session store under a newly minted session id. The one-time
    // `state` has just been validated + consumed above, so launch provenance
    // is proven at this exact point. Concurrent launches each get their own
    // entry — no launch ever overwrites another session's tokens.
    const sessionTokens = createSessionTokens();
    sessionTokens.accessToken = tokenJson.access_token;
    sessionTokens.idToken = tokenJson.id_token || null;
    sessionTokens.refreshToken = tokenJson.refresh_token || null;
    sessionTokens.rawTokenResponse = tokenJson;
    sessionTokens.expectedNonce = storedState.nonce;
    sessionTokens.obtainedAt = Date.now();
    // 30E: capture the token lifetime as an absolute deadline (minus safety
    // skew). Absent expires_in -> null -> proactive refresh skipped; the
    // reactive once-only 401 retry covers those sessions.
    sessionTokens.expiresAt = computeExpiresAt(tokenJson);

    // Parse the patient launch context into the authoritative practiceId +
    // patientId and store them alongside the tokens for all subsequent API calls.
    // 30D: the ID-token fallback reads VERIFIED claims only — an unverifiable
    // token never reaches this point, and an absent id_token contributes
    // nothing. The tokenJson.patient primary path is unchanged.
    const idClaimsForContext = verifiedIdClaims;
    const patientContextRaw =
      tokenJson.patient || (idClaimsForContext && idClaimsForContext.patient) || null;
    const { practiceId, patientId } = parsePatientContext(patientContextRaw);
    sessionTokens.patientContextRaw = patientContextRaw;
    sessionTokens.practiceId = practiceId;
    sessionTokens.patientId = patientId;

    // Parse the encounter launch context (a-{practiceId}.encounter-{encounterId})
    // and store the encounterId alongside the practice / patient identifiers.
    const encounterContextRaw =
      tokenJson.encounter || (idClaimsForContext && idClaimsForContext.encounter) || null;
    const { encounterId } = parseEncounterContext(encounterContextRaw);
    sessionTokens.encounterContextRaw = encounterContextRaw;
    sessionTokens.encounterId = encounterId;

    // 30B: mint the session id AFTER the state was validated + consumed and
    // the token set is complete. Crypto-random 32 bytes hex, collision-checked
    // against the store (astronomically unlikely, but a loop costs nothing).
    let sessionId;
    do {
      sessionId = crypto.randomBytes(32).toString('hex');
    } while (sessionStore.has(sessionId));
    sessionTokens.createdAt = Date.now();
    sessionTokens.lastSeenAt = sessionTokens.createdAt;
    sessionStore.set(sessionId, sessionTokens);

    // 28B observability: exchange outcome + what was parsed. IDs are fine to
    // log (practice/patient/encounter identifiers, not PHI beyond that);
    // tokens are NEVER logged. 30C: refresh-token PRESENCE (a boolean phrase,
    // never a value/prefix/length) is logged so one live relaunch answers the
    // 30E-prerequisite question from the log alone.
    console.log(
      `[athena-embed] /callback: token exchange OK (practiceId: ${practiceId || 'not parsed'}, patientId: ${patientId || 'not parsed'}, encounterId: ${encounterId || 'not parsed'}, refresh token: ${sessionTokens.refreshToken ? 'present' : 'not provided'})`,
    );

    return res.redirect(302, `/app?session=${sessionId}`);
  });

  // --- /app: authenticated embedded app shell --------------------------------
  // After a successful token exchange, redirect the provider into the FrontRunner
  // UI at the root route, passing the authoritative parsed practiceId/patientId as
  // URL parameters. The full debug authentication page lives at /debug.
  app.get('/app', (req, res) => {
    // 30B: /app is session-scoped — it resolves ITS OWN session from the
    // `session` query param minted at /callback. Missing or unknown handle
    // gets the honest relaunch page; never another session's context.
    const resolved = resolveSession(req);
    if (resolved.error) {
      return res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Session expired</title>
<link rel="stylesheet" href="/public/css/styles.css" /></head>
<body class="launch-body"><main class="launch-card" role="main">
  <span class="badge badge-amber">Session expired</span>
  <h1>Session expired or unknown</h1>
  <p class="muted">${escapeHtml(resolved.message)}</p>
  <a class="btn btn-primary" href="/launch">View launch configuration</a>
</main></body></html>`);
    }
    const { session, sessionId } = resolved;

    // 28B: hand the RESOLVED launch context to the client. The root route's
    // `?patientId=` boot path consumes these params by design (see app.js —
    // "Patient context can arrive via URL parameters when the SMART on FHIR
    // launch redirects the provider here"). `source=athena` tells the client
    // to render the identity header ID-first (real IDs, mock profile).
    // 30B: the session id rides the same channel; the client captures it into
    // module state and scrubs it from the URL.
    if (session.patientId) {
      const params = new URLSearchParams();
      if (session.practiceId) params.set('practiceId', session.practiceId);
      params.set('patientId', session.patientId);
      // Omit encounterId entirely when the launch carried no encounter (the
      // pre-check-in case) — the client treats a missing param as null.
      if (session.encounterId) params.set('encounterId', session.encounterId);
      params.set('source', 'athena');
      params.set('session', sessionId);
      // Outbound postMessage target: in the real embed document.referrer is
      // EMPTY (athena's Okta-backed authorize hop strips it), so the bridge
      // cannot infer the athenaOne origin and withholds outbound messages
      // (observed live 2026-07-28: 'no athenaOne target origin; outbound
      // "appResize" not sent'). The docs' own instruction is to target the
      // environment origin explicitly — thread it to the client here.
      params.set('athenaOrigin', ATHENA_ONE_ORIGIN);
      // 30C: the session id is logged here — the handle already transits this
      // very redirect URL (the accepted 30B residual), so a dev-phase log line
      // adds no new exposure class, and it makes /debug reachable in practice.
      console.log(
        `[athena-embed] /app: handing off context (practiceId: ${session.practiceId || 'none'}, patientId: ${session.patientId}, encounterId: ${session.encounterId || 'none'}, sessionId: ${sessionId})`,
      );
      return res.redirect(302, `/?${params.toString()}`);
    }

    // Fallback: authenticated but no patientId was parsed from the launch
    // context — keep the pre-28B demo redirect so the provider still sees a
    // working app, and record WHY the real context is absent. 30B: the demo
    // fallback carries NO session id — demo mode has no session-guarded needs.
    console.log('[athena-embed] /app: no parsed patientId in session context \u2192 demo fallback (/?embed=athena)');
    return res.redirect(302, `/?embed=athena&athenaOrigin=${encodeURIComponent(ATHENA_ONE_ORIGIN)}`);
  });

  // --- /debug: authenticated debug page --------------------------------------
  // Rendered after a successful token exchange. Confirms authentication and shows
  // the launch context parsed from the ID token (practice / provider / patient).
  // Kept available for manual testing so nothing is lost when /app redirects.
  app.get('/debug', (req, res) => {
    // 30B: /debug takes an explicit session handle — `?session={id}` (browser
    // page, so the query param is the primary channel; the X-Session-Id header
    // is also accepted). Missing/unknown handle gets the honest page below;
    // NEVER a fallback to any stored session.
    const resolved = resolveSession(req);
    if (resolved.error) {
      return res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>No session</title>
<link rel="stylesheet" href="/public/css/styles.css" /></head>
<body class="launch-body"><main class="launch-card" role="main">
  <span class="badge badge-amber">${resolved.error === 'session_required' ? 'No session specified' : 'Session expired'}</span>
  <h1>${resolved.error === 'session_required' ? 'No session specified' : 'Session expired or unknown'}</h1>
  <p class="muted">${escapeHtml(resolved.message)} Open this page as <code>/debug?session={id}</code> with the session handle from the launch handoff.</p>
  <a class="btn btn-primary" href="/launch">View launch configuration</a>
</main></body></html>`);
    }
    const sessionTokens = resolved.session;

    const claims = decodeJwtPayload(sessionTokens.idToken) || {};
    const raw = sessionTokens.rawTokenResponse || {};

    // SMART launch context is returned as top-level fields on the token response
    // (e.g. patient, encounter), with identity details inside the ID token claims.
    const practice =
      raw.ah_practice || raw.practice || claims.ah_practice || claims.practiceid || '(not provided)';
    const provider =
      claims.fhirUser || claims.profile || raw.ah_provider || claims.preferred_username || claims.sub || '(not provided)';
    const patient = raw.patient || claims.patient || '(not provided)';
    const encounter = raw.encounter || claims.encounter || '(not provided)';

    // Authoritative, parsed identifiers stored at /callback.
    const practiceId = sessionTokens.practiceId || '(not parsed)';
    const patientId = sessionTokens.patientId || '(not parsed)';
    const encounterId = sessionTokens.encounterId || '(not parsed)';

    const contextRows = [
      ['Parsed practice ID', practiceId],
      ['Parsed patient ID', patientId],
      ['Parsed encounter ID', encounterId],
      ['Practice', practice],
      ['Provider', provider],
      ['Patient (raw context)', patient],
      ['Encounter', encounter],
      ['Token type', raw.token_type || '(unknown)'],
      ['Scopes granted', raw.scope || '(none returned)'],
      ['Expires in (s)', raw.expires_in != null ? String(raw.expires_in) : '(unknown)'],
      ['Refresh token', sessionTokens.refreshToken ? 'Present' : 'Not provided'],
    ]
      .map(
        ([label, value]) =>
          `<div class="kv-row"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value">${escapeHtml(value)}</span></div>`,
      )
      .join('');

    // Show the decoded ID token claims for development visibility. Access and
    // refresh tokens are intentionally NEVER rendered.
    const claimsJson = escapeHtml(JSON.stringify(claims, null, 2));

    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Embedded App — Authenticated</title>
  <link rel="stylesheet" href="/public/css/styles.css" />
</head>
<body class="launch-body">
  <main class="launch-card" role="main">
    <span class="badge badge-green">Authenticated</span>
    <h1>Authentication succeeded</h1>
    <p class="muted">
      The SMART on FHIR authorization-code exchange completed and tokens are held
      in server memory for this session. Below is the launch context parsed from
      the ID token.
    </p>
    <section class="kv" aria-label="Launch context">${contextRows}</section>
    <h2>ID token claims</h2>
    <pre class="code-block">${claimsJson}</pre>
  </main>
</body>
</html>`);
  });

  // --- /ping: verify the stored access token ---------------------------------
  // Calls the athenahealth ping endpoint with the in-memory access token as a
  // Bearer credential and returns the upstream response.
  app.get('/ping', async (req, res) => {
    // 30B: explicit session handle required (X-Session-Id header or ?session=).
    // Missing/unknown -> distinct honest error; never another session's token.
    const resolvedPing = requireSession(req, res);
    if (!resolvedPing) return;
    const sessionTokens = resolvedPing.session;
    if (!sessionTokens.accessToken) {
      return res.status(401).json({
        error: 'not_authenticated',
        message: 'No access token in memory; complete the launch flow first.',
      });
    }

    // Use the authoritative practiceId parsed from the patient launch context.
    // No hardcoded practice id is used anywhere.
    if (!sessionTokens.practiceId) {
      return res.status(409).json({
        error: 'missing_practice_id',
        message:
          'No practiceId was parsed from the patient launch context; cannot build a practice-scoped request.',
      });
    }

    // 30E: same freshness semantics as every athenaRequest — proactive refresh
    // gate before the token is read, via the app-shared single-flight helper.
    const freshPing = await refresher.ensureFreshSession(sessionTokens);
    if (!freshPing.ok) return res.status(freshPing.status).json(freshPing.body);

    const pingUrl = buildPingUrl(sessionTokens.practiceId);

    // One ping attempt with the CURRENT access token (re-read per attempt so
    // a refresh between attempts is picked up).
    async function attemptPing() {
      return fetch(pingUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionTokens.accessToken}`,
          Accept: 'application/json',
        },
      });
    }

    let pingResponse;
    let rawText;
    try {
      pingResponse = await attemptPing();
      // 30E: reactive once-only retry — a 401 despite a "fresh" token gets ONE
      // forced refresh and ONE retry; a second 401 evicts and fails honestly.
      if (pingResponse.status === 401) {
        const refreshed = await refresher.refreshSession(sessionTokens);
        if (!refreshed.ok) return res.status(refreshed.status).json(refreshed.body);
        pingResponse = await attemptPing();
        if (pingResponse.status === 401) {
          sessionTokens.evicted = true;
          const expired = sessionExpiredResult();
          return res.status(expired.status).json(expired.body);
        }
      }
      rawText = await pingResponse.text();
    } catch (err) {
      return res.status(502).json({
        error: 'ping_request_failed',
        message: 'Could not reach the athenahealth ping endpoint.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }

    res.status(pingResponse.status).json({
      pingUrl,
      practiceId: sessionTokens.practiceId,
      status: pingResponse.status,
      body,
    });
  });

  // --- Claim Verification: claims list ---------------------------------------
  // Prototype endpoint — returns the canned MOCK_CLAIMS so the Claim Verification
  // card + modal works without a live athenahealth session.
  app.get('/api/claims', async (req, res) => {
    res.json({ dataSource: 'mock', count: MOCK_CLAIMS.length, claims: MOCK_CLAIMS });
  });

  // --- Claim Verification: patient benefit design ----------------------------
  // Prototype endpoint — returns the canned MOCK_BENEFITS cost-share design
  // ({ copay, coinsuranceRate, planType }) so the modal can estimate patient
  // responsibility without a live athenahealth session.
  app.get('/api/benefits', async (req, res) => {
    res.json({ dataSource: 'mock', benefits: MOCK_BENEFITS });
  });

  // --- Claim Verification: negotiated rates ----------------------------------
  // Prototype endpoint — resolves the requested CPT codes against MOCK_MRF_RATES.
  // Each known code returns { code, negotiatedRate, source, version }; a code with
  // no mock rate comes back null so the UI shows "Rate not available" — rates are
  // never guessed.
  app.post('/api/mrf-rates', async (req, res) => {
    const codes = Array.isArray(req.body && req.body.codes) ? req.body.codes : [];
    const planType =
      req.body && typeof req.body.planType === 'string' && req.body.planType.trim()
        ? req.body.planType.trim()
        : null;
    const rates = {};
    codes.forEach((rawCode) => {
      const code = String(rawCode);
      const rate = MOCK_MRF_RATES[code];
      rates[code] =
        rate == null
          ? null
          : { code, negotiatedRate: rate, source: 'mock', version: 'prototype' };
    });
    res.json({ dataSource: 'mock', planType, rates });
  });

  // --- Claim Verification: submit a claim to athenahealth --------------------
  // Runs a real eligibility check on the patient's primary insurance, then (only
  // when athena confirms active eligibility) submits the claim. Every failure
  // stage surfaces athena's own reason rather than a generic success.
  app.post('/api/claims/:claimId/submit', async (req, res) => {
    // 30B: resolve THIS caller's session from the explicit X-Session-Id
    // handle — never a shared/latest session.
    const resolvedSubmit = requireSession(req, res);
    if (!resolvedSubmit) return;
    const session = resolvedSubmit.session;
    const athenaRequest = athenaRequestFor(session);
    if (!session.accessToken) {
      return res.status(401).json({
        error: 'not_authenticated',
        message: 'Submitting a claim requires an active athenahealth session.',
      });
    }
    const patientId = requireSessionPatientId(session, res);
    if (!patientId) return;
    const claimId = req.params.claimId;

    // Step 0 — ownership. Reject any claimId that is not among the launched
    // patient's own claims before touching eligibility or submission.
    const ownership = await verifyClaimOwnership(athenaRequest, claimId, patientId);
    if (!ownership.ok) {
      // 30E: a dead session must surface as session_unknown (the relaunch
      // trigger), never relabeled as a stage error.
      if (isSessionExpiredResult(ownership.result)) {
        return res.status(401).json(ownership.result.body);
      }
      return res.status(ownership.status).json({
        error: 'claim_verification_failed',
        stage: 'ownership',
        message: ownership.message,
      });
    }
    if (!ownership.found) {
      return res.status(404).json({
        error: 'claim_not_found',
        stage: 'ownership',
        message: 'This claim was not found among the launched patient\u2019s claims, so it cannot be submitted.',
      });
    }

    // Step 1 — eligibility. athena requires active, verified eligibility before a
    // claim can be submitted.
    const insResult = await athenaRequest('GET', `/patients/${encodeURIComponent(patientId)}/insurances`, {
      query: { showcancelled: 'false' },
    });
    if (!insResult.ok) {
      if (isSessionExpiredResult(insResult)) return res.status(401).json(insResult.body);
      return res.status(insResult.status).json({
        error: 'eligibility_unavailable',
        stage: 'eligibility',
        message: athenaErrorMessage(insResult, 'Could not verify insurance eligibility with athenahealth.'),
      });
    }
    const primary = pickPrimaryInsurance(insResult.body);
    if (!primary || !primary.insuranceid) {
      return res.status(409).json({
        error: 'no_insurance_on_file',
        stage: 'eligibility',
        message: 'No active insurance is on file for this patient, so the claim cannot be submitted.',
      });
    }
    const eligResult = await athenaRequest(
      'POST',
      `/patients/${encodeURIComponent(patientId)}/insurances/${encodeURIComponent(primary.insuranceid)}/eligibility`,
      { form: {} },
    );
    if (!eligResult.ok || !isEligibilityActive(eligResult.body)) {
      if (isSessionExpiredResult(eligResult)) return res.status(401).json(eligResult.body);
      return res.status(eligResult.ok ? 409 : eligResult.status).json({
        error: 'not_eligible',
        stage: 'eligibility',
        message: athenaErrorMessage(
          eligResult,
          'athenahealth could not confirm active eligibility, so the claim was not submitted.',
        ),
      });
    }

    // Step 2 — submit the claim back to athenahealth.
    const submitResult = await athenaRequest('PUT', `/claims/${encodeURIComponent(claimId)}`, {
      form: { actionrequest: 'submit' },
    });
    if (!submitResult.ok) {
      if (isSessionExpiredResult(submitResult)) return res.status(401).json(submitResult.body);
      return res.status(submitResult.status).json({
        error: 'submission_failed',
        stage: 'submission',
        message: athenaErrorMessage(submitResult, 'athenahealth did not accept the claim submission.'),
        athenaStatus: submitResult.status,
      });
    }
    res.json({ dataSource: 'athenahealth', submitted: true, claimId, message: 'Claim submitted to athenahealth.' });
  });

  // --- Claim Verification: update claim data ---------------------------------
  // Forwards a safe subset of edited claim fields to athenahealth's claim update
  // API. Rejected updates surface athena's reason; nothing is silently dropped.
  app.put('/api/claims/:claimId', async (req, res) => {
    // 30B: resolve THIS caller's session from the explicit X-Session-Id
    // handle — never a shared/latest session.
    const resolvedUpdate = requireSession(req, res);
    if (!resolvedUpdate) return;
    const session = resolvedUpdate.session;
    const athenaRequest = athenaRequestFor(session);
    if (!session.accessToken) {
      return res.status(401).json({
        error: 'not_authenticated',
        message: 'Updating a claim requires an active athenahealth session.',
      });
    }
    const patientId = requireSessionPatientId(session, res);
    if (!patientId) return;
    const claimId = req.params.claimId;
    const form = buildClaimUpdateForm(req.body && req.body.updates);
    if (!Object.keys(form).length) {
      return res.status(400).json({
        error: 'no_updatable_fields',
        message: 'No editable claim fields were provided to update.',
      });
    }

    // Ownership — reject any claimId that is not among the launched patient's
    // own claims before forwarding the update to athenahealth.
    const ownership = await verifyClaimOwnership(athenaRequest, claimId, patientId);
    if (!ownership.ok) {
      if (isSessionExpiredResult(ownership.result)) {
        return res.status(401).json(ownership.result.body);
      }
      return res.status(ownership.status).json({
        error: 'claim_verification_failed',
        message: ownership.message,
      });
    }
    if (!ownership.found) {
      return res.status(404).json({
        error: 'claim_not_found',
        message: 'This claim was not found among the launched patient\u2019s claims, so it cannot be updated.',
      });
    }

    const result = await athenaRequest('PUT', `/claims/${encodeURIComponent(claimId)}`, { form });
    if (!result.ok) {
      if (isSessionExpiredResult(result)) return res.status(401).json(result.body);
      return res.status(result.status).json({
        error: 'claim_update_failed',
        message: athenaErrorMessage(result, 'athenahealth did not accept the claim update.'),
        athenaStatus: result.status,
      });
    }
    res.json({ dataSource: 'athenahealth', updated: true, claimId });
  });

  // --- Patient profile API ---------------------------------------------------
  // Column semantics of record (Craig, 2026-08-05): the patient PROFILE (and
  // therefore the Post Data FRONTRUNNERHC column, which reads from it) always
  // carries FRONTRUNNER's values — in this prototype, MOCK_PATIENT stands in
  // for the FRHC platform record. The live athena read via Orion
  // (orionPatientDemographics, frhc-platform PR #2855) feeds the EXISTING
  // column instead, via the separate `athenaDemographics` block below. This
  // SUPERSEDES the 08-04 wiring that merged the live read over the profile —
  // that put athena's data in the FRHC column, inverting the comparison.
  //
  // athenaDemographicsSource: 'orion' (live read succeeded) | 'unavailable'
  // (lane configured but the read failed — athenaDemographicsError carries the
  // upstream reason; the profile still renders, EXISTING shows honest
  // unavailability, never simulated stand-ins) | 'simulated' (lane not
  // configured — client keeps its legacy simulated EXISTING values).
  // Staff Cognito plane per DR-1 — transport evidence, not the embed auth plane.
  app.get('/api/patient/:patientId', async (req, res) => {
    const encounterId =
      typeof req.query.encounterId === 'string' && req.query.encounterId
        ? req.query.encounterId
        : MOCK_PATIENT.encounter.id;

    // 30C: echo what was actually ASKED FOR — the envelope must not relabel
    // the mock profile's id as the request. The mock `patient.*` payload is
    // deliberately unchanged (an athena patient id is not an MRN; the "Mock
    // profile" pill + ID-first header keep identity honest client-side).
    const baseEnvelope = {
      dataSource: 'mock',
      requestedPatientId: req.params.patientId,
      requestedEncounterId: encounterId || null,
      insuranceAvailable: true,
      patient: mockPatientFor(req.params.patientId),
    };
    res.setHeader('x-data-source', 'mock');

    if (!hasuraTokenProvider.enabled()) {
      return res.json({
        ...baseEnvelope,
        athenaDemographics: null,
        athenaDemographicsSource: 'simulated',
        athenaDemographicsError: null,
        athenaCoverage: null,
        athenaCoverageSource: 'simulated',
        athenaCoverageError: null,
      });
    }

    const token = await hasuraTokenProvider.getIdToken();
    if (!token.ok) {
      const tokenErr = { code: token.error.code, message: token.error.message };
      return res.json({
        ...baseEnvelope,
        athenaDemographics: null,
        athenaDemographicsSource: 'unavailable',
        athenaDemographicsError: tokenErr,
        athenaCoverage: null,
        athenaCoverageSource: 'unavailable',
        athenaCoverageError: tokenErr,
      });
    }

    // NOTE: the Orion patient id is the server-side pin, NOT req.params — see
    // the factory comment (no athena→Orion mapping exists; client-supplied ids
    // must not ride this server's staff token).
    //
    // Coverage read added 2026-08-15 (Craig: show Orion's insurance data live,
    // like the demographics). The two reads run in PARALLEL and degrade
    // INDEPENDENTLY: a coverage failure must not take the working demographics
    // block down with it (and vice versa) — each carries its own
    // source/error, the same honest triple the demographics lane defined.
    const [demoResult, covResult] = await Promise.all([
      fetchOrionDemographics({
        hasuraOrigin: orionDemographicsEnv.hasuraOrigin,
        idToken: token.idToken,
        patientId: orionDemographicsEnv.patientId,
      }),
      fetchOrionCoverage({
        hasuraOrigin: orionDemographicsEnv.hasuraOrigin,
        idToken: token.idToken,
        patientId: orionDemographicsEnv.patientId,
      }),
    ]);

    res.json({
      ...baseEnvelope,
      ...(demoResult.ok
        ? {
            athenaDemographics: mapOrionDemographics(demoResult.data),
            athenaDemographicsSource: 'orion',
            athenaDemographicsError: null,
          }
        : {
            athenaDemographics: null,
            athenaDemographicsSource: 'unavailable',
            athenaDemographicsError: { code: demoResult.error.code, message: demoResult.error.message },
          }),
      ...(covResult.ok
        ? {
            athenaCoverage: mapOrionCoverage(covResult.data),
            athenaCoverageSource: 'orion',
            athenaCoverageError: null,
          }
        : {
            athenaCoverage: null,
            athenaCoverageSource: 'unavailable',
            athenaCoverageError: { code: covResult.error.code, message: covResult.error.message },
          }),
      orionPatientId: orionDemographicsEnv.patientId,
    });
  });

  // Medicaid Renewal tab read. Display data only — nothing here writes. The
  // response is always 200 with an honest envelope (status ok | not_tracked |
  // error); the technical error detail is logged here and carried for the
  // console, and the UI shows plain copy.
  app.get('/api/medicaid-renewal/:patientId', async (req, res) => {
    // An explicit ?sample= wins; otherwise the (temporary) default sample,
    // for the Olivia Torres mock profile only.
    const isOliviaProfile = mockPatientFor(req.params.patientId) === MOCK_PATIENT;
    const sampleKey = typeof req.query.sample === 'string' && req.query.sample
      ? req.query.sample
      : (isOliviaProfile && medicaidRenewalEnv.defaultSample) || '';
    const envelope = await resolveMedicaidRenewal({
      requestedPatientId: req.params.patientId,
      sampleKey,
      env: medicaidRenewalEnv,
      tokenProvider: hasuraTokenProvider,
      ...(medicaidRenewalQuery ? { query: medicaidRenewalQuery } : {}),
    });
    if (envelope.status === 'error' && envelope.source === 'live') {
      console.warn(
        `[athena-embed] medicaid-renewal read failed (code: ${envelope.error.code}, requestId: ${envelope.error.requestId || 'none'})`,
      );
    }
    const caseId = envelope.renewal && envelope.renewal.case && envelope.renewal.case.id;
    const links = envelope.source === 'live' && medicaidRenewalEnv.frontRunnerAppUrl && /^[0-9]+$/.test(String(caseId || ''))
      ? { caseUrl: `${medicaidRenewalEnv.frontRunnerAppUrl}/medicaid-renewal?wf=${caseId}` }
      : { caseUrl: null };
    res.setHeader('x-data-source', envelope.source);
    res.json({ ...envelope, links });
  });

  // Financial Clearance read. Always 200 with an honest envelope (status ok |
  // not_run | error; source live | not_configured). Display data only.
  app.get('/api/financial-clearance/:patientId', async (req, res) => {
    const envelope = await resolveFinancialClearance({
      requestedPatientId: req.params.patientId,
      env: financialClearanceEnv,
      tokenProvider: hasuraTokenProvider,
      ...(financialClearanceQuery ? { query: financialClearanceQuery } : {}),
    });
    if (envelope.status === 'error') {
      // PHI-free: code and request id only, never a record value.
      console.warn(
        `[athena-embed] financial-clearance read failed (code: ${envelope.error.code}, requestId: ${envelope.error.requestId || 'none'})`,
      );
    }
    res.setHeader('x-data-source', envelope.source);
    res.json(envelope);
  });

  // Run Financial Clearance — the platform button's action
  // (financialClearanceRefresh, origin "manual", no income fields), then a
  // re-read. 409 when the lane is not configured; 502 when the run did not
  // happen; 200 with { ran: true, envelope } when it did (the envelope can
  // still be status 'error' if only the re-read failed).
  app.post('/api/financial-clearance/:patientId/run', async (req, res) => {
    const out = await runFinancialClearance({
      requestedPatientId: req.params.patientId,
      env: financialClearanceEnv,
      tokenProvider: hasuraTokenProvider,
      ...(financialClearanceAction ? { callAction: financialClearanceAction } : {}),
      ...(financialClearanceQuery ? { query: financialClearanceQuery } : {}),
    });
    if (!out.run.ok) {
      const code = out.run.error.code;
      const status = code === 'live_lane_not_configured' ? 409 : 502;
      console.warn(
        `[athena-embed] financial-clearance run failed status=${status} code=${code || 'unknown'} requestId=${out.run.requestId || 'none'}`,
      );
      return res.status(status).json({
        error: status === 409 ? 'live_lane_not_configured' : 'financial_clearance_run_failed',
        code,
        message: out.run.error.message,
        requestId: out.run.requestId,
      });
    }
    if (out.envelope.status === 'error') {
      console.warn(
        `[athena-embed] financial-clearance re-read after run failed (code: ${out.envelope.error.code}, requestId: ${out.envelope.error.requestId || 'none'})`,
      );
    }
    res.json({ ran: true, requestId: out.run.requestId, envelope: out.envelope });
  });

  // Medicaid Renewal tab WRITES (actionable addendum, 2026-10-30). One door
  // for every action: POST /api/medicaid-renewal/:patientId/actions/:action
  // with { sample?, payload, simulateFailure? }. Always 200 with
  // { ok, simulated?, error? }.
  //   - A sample patient (same resolution as the read: an explicit sample, or
  //     the temporary default) is SIMULATED: validated, never sent, and
  //     reported as `simulated: true`. `simulateFailure` (sample only) returns
  //     a failure so the error state can be reviewed.
  //   - A live patient runs the platform writes in lib/medicaid-renewal-
  //     actions.js, or fails `not_available` for a gap. Never faked.
  // Logs carry the action and outcome code only (no PHI).
  app.post('/api/medicaid-renewal/:patientId/actions/:action', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = req.params.action;
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const explicit = typeof body.sample === 'string' && body.sample ? body.sample : '';
    const isOliviaProfile = mockPatientFor(req.params.patientId) === MOCK_PATIENT;
    const sampleKey = explicit || (isOliviaProfile && medicaidRenewalEnv.defaultSample) || '';
    const isSample = medicaidRenewalEnv.sampleDataEnabled && sampleKey && MEDICAID_SAMPLE_PATIENTS[sampleKey];

    if (isSample) {
      const invalid = validateAction(action, payload);
      if (invalid) return res.json({ ok: false, simulated: true, error: invalid });
      if (body.simulateFailure === true) {
        return res.json({ ok: false, simulated: true, error: { code: 'simulated_failure', message: 'Simulated failure (sample data).' } });
      }
      return res.json({ ok: true, simulated: true });
    }

    const out = await runLiveAction({
      action,
      payload,
      env: medicaidRenewalEnv,
      tokenProvider: hasuraTokenProvider,
      ...(medicaidRenewalQuery ? { query: medicaidRenewalQuery } : {}),
    });
    if (!out.ok) console.warn(`[athena-embed] medicaid-renewal action ${action} failed (code: ${out.error.code})`);
    res.json(out);
  });

  // --- Orion write observability (2026-09-16) --------------------------------
  // Every Orion write goes out with a fresh x-request-id, which Hasura adopts
  // as its CloudWatch request_id. Hasura MASKS any 5xx from the action-handler
  // as an opaque "internal error" — message, code and the handler's own
  // correlation id are all discarded — so on a failed post this id is the only
  // handle the platform team can search Hasura/action-handler logs by. The
  // route therefore (a) mints the id itself so it survives whatever the lane
  // returns, (b) forwards it to the lane, (c) returns it in the response
  // envelope (Network tab), and (d) logs ONE line carrying it. That line is
  // PHI-FREE by construction: route, HTTP status, upstream code, request id and
  // field NAMES only — never a field VALUE (values are PHI: names, DOB, phones,
  // member ids). Keep it that way when extending.
  // A route that makes MORE than one Orion call (the insurance write's
  // pre-write coverage read) mints a DISTINCT id per call, so Hasura's
  // request_id stays unique per call and the log line's `stage` says which
  // call failed; the envelope carries the failing call's id as `requestId`.
  function newOrionRequestId() {
    return crypto.randomUUID();
  }
  function logOrionWriteFailure({ route, stage = 'write', status, code, requestId, fields }) {
    const names = Array.isArray(fields) && fields.length > 0 ? fields.join(',') : '-';
    console.warn(
      `[athena-embed] orion write failed route=${route} stage=${stage} status=${status} code=${code || 'unknown'} requestId=${requestId} fields=${names}`,
    );
  }

  // --- Patient demographics WRITE (app → Orion → athena, PR #2929) ----------
  // Fields the app will forward to orionPatientDemographicsUpdate. This is a
  // deliberate SUBSET of the Action's input type — exclusions are load-bearing:
  //   - language / race / ethnicity / marital_status: athena takes CODES
  //     (ISO 639-2 / CDC) on the write path while the read returns display
  //     labels, so round-tripping a label is silently dropped by the vendor.
  //     Wire these only with a label→code map.
  //   - ssn: the modal renders a MASK (•••-••-1234); posting it would write
  //     the mask. Needs a dedicated unmasked input first.
  //   - first/last/middle name, address_*, emergency_contact_*: the modal
  //     carries composite display strings; splitting them heuristically risks
  //     writing wrong parts. Wire these with per-part inputs.
  // PARTIAL-update semantics (PR #2929): absent = leave alone; null = clear,
  // which Orion 422s — so null/empty values are dropped, never forwarded.
  // 'gender_identity' REMOVED 2026-08-19 (Craig's demographics field-set
  // review): its display row was removed app-wide (no insurance-discovery or
  // eligibility role), so the field can no longer be supplied; a stray submit
  // now skips it as not_writable_via_app. Keep in lockstep with
  // DEMOGRAPHIC_POST_FIELD_KEYS in public/js/app.js.
  const ORION_WRITABLE_DEMOGRAPHIC_FIELDS = new Set([
    'preferred_name',
    'date_of_birth',
    'gender',
    'mobile_phone',
    'home_phone',
    'email',
    // 2026-08-20 (Craig, source-backed composed rows): name and address post
    // as granular parts from the chosen comparison source — the client's
    // composed 'Full name'/'Address' rows carry these wire keys in their
    // delta parts, never a split display string. Both hops already accept
    // them (OrionDemographicsUpdateInput + _UPDATE_FIELD_TO_ATHENA_KEY map
    // 1:1 to firstname/lastname/middlename/address1/address2/city/state/zip).
    'first_name',
    'last_name',
    'middle_name',
    'address_line_1',
    'address_line_2',
    'city',
    'state',
    'zip_code',
  ]);

  app.post('/api/patient/demographics', async (req, res) => {
    if (!hasuraTokenProvider.enabled()) {
      return res.status(409).json({
        error: 'live_lane_not_configured',
        message: 'Live posting requires the Orion lane credentials (see athena-embed/docs/RUNBOOK-hasura-refresh-token.md).',
      });
    }

    const supplied = req.body && typeof req.body.fields === 'object' && req.body.fields !== null ? req.body.fields : {};
    const input = {};
    const skipped = [];
    for (const [key, value] of Object.entries(supplied)) {
      if (!ORION_WRITABLE_DEMOGRAPHIC_FIELDS.has(key)) {
        skipped.push({ field: key, reason: 'not_writable_via_app' });
        continue;
      }
      if (value === null || value === undefined || String(value).trim() === '') {
        // Never forward a clear: Orion 422s explicit nulls, and an empty
        // string is a no-op at the athena mapper — both are honest skips.
        skipped.push({ field: key, reason: 'empty_value_not_posted' });
        continue;
      }
      input[key] = String(value);
    }

    if (Object.keys(input).length === 0) {
      return res.status(400).json({
        error: 'nothing_to_post',
        message: 'No writable demographic fields were supplied.',
        skippedFields: skipped,
      });
    }

    const token = await hasuraTokenProvider.getIdToken();
    if (!token.ok) {
      return res.status(502).json({
        error: 'orion_demographics_update_unavailable',
        code: token.error.code,
        message: `Live posting unavailable — ${token.error.message}`,
      });
    }

    // patient_id is the server-side pin — same IDOR guard as the read route:
    // the client never chooses which Orion patient this server's token writes.
    // requestId: minted here and forwarded as x-request-id — see "Orion write
    // observability" above for why the route owns it.
    const requestId = newOrionRequestId();
    const result = await fetchOrionDemographicsUpdate({
      hasuraOrigin: orionDemographicsEnv.hasuraOrigin,
      idToken: token.idToken,
      input: { patient_id: orionDemographicsEnv.patientId, ...input },
      requestId,
    });
    if (!result.ok) {
      logOrionWriteFailure({
        route: 'POST /api/patient/demographics',
        status: 502,
        code: result.error.code,
        requestId,
        fields: Object.keys(input),
      });
      return res.status(502).json({
        error: 'orion_demographics_update_failed',
        code: result.error.code,
        message: result.error.message,
        requestId,
        postedFields: [],
        skippedFields: skipped,
      });
    }

    // result.data is the CONFIRMED vendor state (Orion re-reads after the
    // PUT) — return it so the client can render what athena actually holds,
    // not an echo of the request.
    res.json({
      dataSource: 'orion',
      posted: true,
      requestId,
      postedFields: Object.keys(input),
      skippedFields: skipped,
      confirmed: result.data,
    });
  });

  // --- Patient insurance WRITE (app → Orion → athena, PR #3110, FR-154) -----
  // Fields the app will forward inside an OrionCoverageItemInput. A deliberate
  // SUBSET of the Action's input type — exclusions are load-bearing:
  //   - payer_id: the app holds a payer display NAME; the X12 payer_id is a
  //     different value it does not hold.
  //   - plan_name: **REMOVED 2026-08-19 (Craig's field-set review)** — athena's
  //     PUT has no plan-name field, and Orion's routing treats a changed plan
  //     name as a CARRIER change, i.e. the DELETE+POST package-change pattern
  //     FrontRunner does not drive (scope note of record, same day). The
  //     Action still accepts it; this whitelist is the app's own narrower
  //     contract, so a supplied plan_name is skipped as not_writable_via_app
  //     rather than forwarded to trigger a replacement.
  //   - athena_package_id: **REMOVED from the app 2026-08-15 (Craig)** — the
  //     package id is Orion's concern. Per athena's own contract (V1
  //     Update/CreatePatientInsuranceRequest) an UPDATE is identified by the
  //     insuranceid in the PUT path — Orion's coverage_id — and only a CREATE
  //     needs the package id, which the app never has for a new policy.
  //   - policyholder name/DOB/sex: **INCLUDED 2026-08-19 (Craig: "If policy
  //     holder is not self that info is needed")** — Orion's CoverageWriteItem
  //     and the action-handler mirror both accept the full policyholder block
  //     (verified at origin/development b39f40a1), and the delete/create
  //     predicate keys ONLY on package id + subscriber id, so a policyholder
  //     correction is a plain athena PUT, never a replacement.
  //   - policyholder address: **INCLUDED, GRANULAR (Craig, same day: "should
  //     be a value that can be updated in athena via the PUT and should
  //     definitely be used in the POST")** — one field per athena/Orion write
  //     field, because a composed display line could never map back onto them.
  //   - policyholder_ssn: still excluded — the app displays masked-last-4
  //     only and never holds a full SSN to post.
  //   - copay / status: read-only projections, not writable coverage fields.
  const ORION_WRITABLE_COVERAGE_FIELDS = new Set([
    'member_id',
    'group_number',
    'effective_date',
    'termination_date',
    'relationship_to_patient',
    'policyholder_first_name',
    'policyholder_last_name',
    'policyholder_date_of_birth',
    'policyholder_gender',
    'policyholder_address_line_1',
    'policyholder_address_line_2',
    'policyholder_city',
    'policyholder_state',
    'policyholder_zip',
  ]);

  app.post('/api/patient/insurance', async (req, res) => {
    if (!hasuraTokenProvider.enabled()) {
      return res.status(409).json({
        error: 'live_lane_not_configured',
        message: 'Live posting requires the Orion lane credentials (see athena-embed/docs/RUNBOOK-hasura-refresh-token.md).',
      });
    }

    const suppliedList = Array.isArray(req.body && req.body.coverages) ? req.body.coverages : [];
    const skipped = [];
    const items = [];
    for (const entry of suppliedList) {
      if (!entry || typeof entry !== 'object') continue;
      const priority = Number(entry.priority);
      if (priority !== 1 && priority !== 2) {
        skipped.push({ priority: entry.priority ?? null, field: null, reason: 'invalid_priority' });
        continue;
      }
      const suppliedFields =
        entry.fields && typeof entry.fields === 'object' && entry.fields !== null ? entry.fields : {};
      const fields = {};
      for (const [key, value] of Object.entries(suppliedFields)) {
        if (!ORION_WRITABLE_COVERAGE_FIELDS.has(key)) {
          skipped.push({ priority, field: key, reason: 'not_writable_via_app' });
          continue;
        }
        if (value === null || value === undefined || String(value).trim() === '') {
          // Whole-record semantics make an empty value ambiguous (clear vs
          // absent); the app never means "clear", so empties are not sent.
          skipped.push({ priority, field: key, reason: 'empty_value_not_posted' });
          continue;
        }
        let outValue = String(value);
        // athena's policyholder-sex vocabulary is M/F ONLY, and Orion DROPS
        // anything wider on write rather than sending it to be rejected
        // (SubscriberInfo.gender docstring) — so FrontRunner's 'Female' would
        // silently vanish. Normalize the two known synonyms; anything else
        // passes through and Orion's drop stays visible upstream.
        if (key === 'policyholder_gender') {
          const v = outValue.trim().toLowerCase();
          if (v === 'female' || v === 'f') outValue = 'F';
          else if (v === 'male' || v === 'm') outValue = 'M';
        }
        fields[key] = outValue;
      }
      if (Object.keys(fields).length === 0) {
        skipped.push({ priority, field: null, reason: 'no_writable_fields' });
        continue;
      }
      items.push({ priority, fields });
    }

    if (items.length === 0) {
      return res.status(400).json({
        error: 'nothing_to_post',
        message: 'No postable coverage changes were supplied.',
        skippedFields: skipped,
      });
    }

    // service_date — the DOS the change is attributed to (the client sends the
    // launched encounter's date; Craig, 2026-08-15). Orion parses it as a
    // `date`, and it is load-bearing for self-pay patients: a write that queues
    // a self-pay reactivation is REFUSED without one rather than guessing the
    // billing period. Validated HERE, alongside the other input checks and
    // BEFORE the token mint and the pre-write read — cheap input validation
    // must not cost two upstream round trips. A malformed date is a hard 400,
    // never a silent drop: dropping it would resurface as Orion's self-pay
    // refusal on exactly the patients where the value matters most.
    const serviceDate = typeof req.body.serviceDate === 'string' && req.body.serviceDate.trim() !== ''
      ? req.body.serviceDate.trim()
      : null;
    if (serviceDate && !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return res.status(400).json({
        error: 'invalid_service_date',
        message: `serviceDate must be an ISO-8601 date (YYYY-MM-DD); received "${serviceDate}".`,
      });
    }

    const token = await hasuraTokenProvider.getIdToken();
    if (!token.ok) {
      return res.status(502).json({
        error: 'orion_coverage_update_unavailable',
        code: token.error.code,
        message: `Live posting unavailable — ${token.error.message}`,
      });
    }

    // coverage_id resolution: the write targets an EXISTING policy via
    // athena's insuranceid, which the coverage READ returns as coverage_id.
    // Read fresh, match by COB priority. No coverage at that priority means
    // this item is a CREATE (coverage_id omitted). A failed read is a hard
    // stop: writing whole records blind against an unknown current state is
    // exactly the kind of guess this lane must never make.
    // patient_id is the server-side pin — same IDOR guard as the reads: the
    // client never chooses which Orion patient this server's token writes.
    // readRequestId: this read is its own Hasura call, so it gets its own
    // x-request-id (distinct from the write's) — see "Orion write
    // observability" above.
    const readRequestId = newOrionRequestId();
    const readResult = await fetchOrionCoverage({
      hasuraOrigin: orionDemographicsEnv.hasuraOrigin,
      idToken: token.idToken,
      patientId: orionDemographicsEnv.patientId,
      requestId: readRequestId,
    });
    if (!readResult.ok) {
      logOrionWriteFailure({
        route: 'POST /api/patient/insurance',
        stage: 'pre-write-read',
        status: 502,
        code: readResult.error.code,
        requestId: readRequestId,
        // The read carries no fields — only the pinned patient id (not PHI).
        fields: [],
      });
      return res.status(502).json({
        error: 'orion_coverage_read_failed',
        code: readResult.error.code,
        message: `Could not read current coverage before writing — ${readResult.error.message}`,
        requestId: readRequestId,
      });
    }
    const currentByPriority = new Map();
    const currentList = Array.isArray(readResult.data && readResult.data.coverages)
      ? readResult.data.coverages
      : [];
    for (const cov of currentList) {
      if (cov && typeof cov === 'object' && !currentByPriority.has(Number(cov.priority))) {
        currentByPriority.set(Number(cov.priority), cov);
      }
    }

    // Whole-record per COB level, minimally stated: priority (matching key) +
    // coverage_id (the policy identity) + ONLY the changed writable fields.
    // ⚠ **athena_package_id REMOVED 2026-08-15 (Craig)** — items previously
    // carried it; the ruling is that the package id is Orion's concern.
    // athena's own contract agrees (V1 Update/CreatePatientInsuranceRequest):
    // an UPDATE is a PUT to .../insurances/{insuranceid} — identified by the
    // insuranceid Orion already returns as coverage_id — and only a CREATE
    // needs insurancepackageid. Consequence: an item at a priority with NO
    // current coverage would be a CREATE, which cannot be expressed without a
    // package id, so it is skipped honestly here instead of sent to fail.
    const coverages = [];
    for (const item of items) {
      const current = currentByPriority.get(item.priority);
      const coverageId = current && typeof current.coverage_id === 'string' && current.coverage_id
        ? current.coverage_id
        : null;
      if (!coverageId) {
        skipped.push({ priority: item.priority, field: null, reason: 'create_requires_athena_package_id' });
        continue;
      }
      // ⚠ SUBSCRIBER CARRY-THROUGH — learned from the 2026-08-15 live incident:
      // Orion routes to DELETE+CREATE when the incoming subscriber id differs
      // from the on-file row (`_should_delete_create`,
      // posting/patient_insurance.py:189, V1's line-90 predicate), and an
      // OMITTED member id compares as empty — i.e. "subscriber changed to
      // nothing". The first live write sent a minimal item, Orion cancelled the
      // policy (delete_pass1 success) and the near-empty replacement CREATE
      // failed at athena, leaving the level bare. Until the platform treats a
      // coverage_id-targeted item as a plain UPDATE (finding filed with
      // Linnea), the on-file member id from the pre-write read is carried
      // through VERBATIM whenever the caller is not deliberately changing it —
      // pinning the subscriber half of the predicate so a field edit stays a
      // field edit. A caller-supplied member_id still passes through untouched:
      // that IS a subscriber change, and replacement is then the correct
      // vendor semantic.
      const onFileMemberId = current && current.subscriber && typeof current.subscriber.subscriber_id === 'string' && current.subscriber.subscriber_id
        ? current.subscriber.subscriber_id
        : null;
      const carryMember = !('member_id' in item.fields) && onFileMemberId
        ? { member_id: onFileMemberId }
        : {};
      // PACKAGE-ID CARRY (bridge, 2026-08-19): platform PR #3149 relaxed
      // Orion's DTO (athena_package_id optional with coverage_id) and made the
      // FR-152 read project the on-file value — but MISSED the action-handler's
      // mirror schema (`OrionCoverageItem`, patient.py:235), which still
      // REQUIRES the field on every item. So the app carries the READ's own
      // value through verbatim: key-matched by construction, which routes the
      // write to UPDATE (the athena PUT) under the fixed absent-means-keep
      // predicate. Craig's ruling stands — the app neither displays the value
      // nor lets anyone choose it; this is platform-data-in, platform-data-out.
      // REMOVE this carry when the handler mirrors the relaxation (follow-up
      // filed with Linnea); items then ride coverage_id alone. If the read
      // carries no package id (staging pre-#3149), the item goes without and
      // the handler's 422 surfaces honestly — never an invented value.
      const onFilePackageId = current && current.plan && typeof current.plan.athena_package_id === 'string' && current.plan.athena_package_id
        ? current.plan.athena_package_id
        : null;
      const carryPackage = onFilePackageId ? { athena_package_id: onFilePackageId } : {};
      coverages.push({ priority: item.priority, coverage_id: coverageId, ...carryPackage, ...carryMember, ...item.fields });
    }
    if (coverages.length === 0) {
      return res.status(400).json({
        error: 'nothing_to_post',
        message: 'No updatable coverage remained after matching against the current coverage read.',
        skippedFields: skipped,
      });
    }

    const input = { patient_id: orionDemographicsEnv.patientId, coverages };
    if (serviceDate) input.service_date = serviceDate;

    // requestId: minted here and forwarded as x-request-id — see "Orion write
    // observability" above for why the route owns it.
    const requestId = newOrionRequestId();
    const result = await fetchOrionCoverageUpdate({
      hasuraOrigin: orionDemographicsEnv.hasuraOrigin,
      idToken: token.idToken,
      input,
      requestId,
    });
    if (!result.ok) {
      logOrionWriteFailure({
        route: 'POST /api/patient/insurance',
        stage: 'write',
        status: 502,
        code: result.error.code,
        requestId,
        // Field NAMES across the posted items (deduped) — never values.
        fields: [...new Set(coverages.flatMap((c) => Object.keys(c).filter((k) => ORION_WRITABLE_COVERAGE_FIELDS.has(k))))],
      });
      return res.status(502).json({
        error: 'orion_coverage_update_failed',
        code: result.error.code,
        message: result.error.message,
        requestId,
        // The read that preceded this write succeeded under its own id; carried
        // so the platform team can see the state Orion reported just before.
        readRequestId,
        postedCoverages: [],
        skippedFields: skipped,
      });
    }

    // result.data is Orion's post-write RE-READ plus the per-level operations
    // report. Clients MUST branch on operations — an `uncertain` outcome is a
    // non-idempotent CREATE that may or may not have landed (ADR-ATH-010):
    // reconcile, never blind-retry.
    res.json({
      dataSource: 'orion',
      posted: true,
      requestId,
      readRequestId,
      postedCoverages: coverages.map((c) => ({
        priority: c.priority,
        coverageId: c.coverage_id,
        postedFields: Object.keys(c).filter((k) => ORION_WRITABLE_COVERAGE_FIELDS.has(k)),
      })),
      skippedFields: skipped,
      operations: Array.isArray(result.data && result.data.operations) ? result.data.operations : [],
      confirmed: result.data,
    });
  });

  // Lightweight config endpoint so the client can pick up demo identifiers without
  // hardcoding them in two places.
  app.get('/api/config', (req, res) => {
    res.json({
      demo: {
        patientId: DEMO_PATIENT_ID,
        encounterId: DEMO_ENCOUNTER_ID,
      },
      athena: {
        clientId: ATHENA_SMART_CONFIG.clientId,
        environment: ATHENA_SMART_CONFIG.environment,
        athenaOneOrigin: ATHENA_ONE_ORIGIN,
      },
    });
  });

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });

  // 404 — still carries the CSP header from the middleware above.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Route not found.' });
  });

  return app;
}

// Start the server only when this file is executed directly as the entrypoint.
// Importing it (e.g. from a test) builds the factory without binding a port.
const isMain =
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const app = createAthenaEmbedApp();
  app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[athena-embed] prototype listening on http://0.0.0.0:${PORT}`);
  });
}
