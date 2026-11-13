// Financial Clearance — per-patient read + run lane for the athena-embed
// prototype (handoff "sidecar-financial-clearance-claude-code-handoff.md",
// Craig 2026-10-30; spec "sidecar-financial-clearance-spec.md").
//
// WHAT THIS IS: the sidecar's Pre Check-In "Financial Clearance" card and
// modal read the platform's canonical clearance record and run the SAME
// action the platform's Patient Hub > Financial Clearance "Run Financial
// Clearance" button runs. Nothing here computes clearance, FPL or tier; the
// platform does, and this lane passes its stored values through.
//
// RUN BEHAVIOR (confirmed from platform code, frhc-platform `development`
// 5dc23238, identical on `staging`; summary sent to Craig 2026-10-30):
//   - The platform button (website FinancialClearanceTab.tsx:314 →
//     patientManagementApi.runFinancialClearance) calls the Hasura Action
//     `financialClearanceRefresh` with { patient_id, origin: "manual" } and
//     NO household/income fields — omitted fields keep the stored values
//     (applications/services/action-handler/app/actions/checks/
//     financial_clearance.py:422-644). This lane sends exactly that, plus the
//     pinned client_id (a tenant pin: a wrong pin fails, it never writes
//     somewhere else).
//   - The action UPSERTS one app_patient.financial_clearance row per patient
//     (overwrites the previous result) and writes one PHI-free audit row. It
//     sends no messages. There is no separate Clearance History table: the
//     platform's history line is derived from this same row (needs_action
//     renders as "Partial").
//   - It returns the clearance record WITHOUT household/income/FPL; the
//     platform re-reads those with the allow-listed `FinancialClearanceRows`
//     query, and so does this lane after a run.
//
// SOURCES (Craig, 2026-10-30): household size, annual income, FPL % and tier
// come from the clearance record only. Approver/date and screening date have
// NO source on that record — they live on a Medicaid case's screening
// document, a separate store with its own household/income — so they are
// honest nulls ("Not recorded") here, never borrowed from that store. Long
// term these values are to be populated automatically by a credit check
// and/or a clearance run; that design is open (contract doc gap list).
//
// HIDDEN BY DECISION: coverage status, recommended path/action, reasons,
// estimate, outstanding balance and lifetime payments are read (the
// allow-listed query text carries them) but never leave this module.
//
// IDENTITY (same posture as the Orion and Medicaid Renewal lanes): there is
// NO athena → FrontRunner patient mapping, so the FrontRunner client id and
// canonical patient id are PINNED server-side (env). The client's :patientId
// is an athena id and is never forwarded through this server's staff token
// (IDOR guard). A run WRITES to the pinned patient: pin only the test
// patients Bob or Carol (handoff), and tell Craig before pinning anyone else.

import { hasuraQuery } from './medicaid-renewal.js';
import { callOrionAction } from './orion-demographics.js';

// ---------------------------------------------------------------------------
// Allow-listed documents (Hasura-export form, verbatim — allow-list matching
// is on query TEXT; source applications/hasura/metadata/query_collections.yaml
// entries `FinancialClearanceRows` and `FinancialClearanceRefresh`)
// ---------------------------------------------------------------------------

export const FINANCIAL_CLEARANCE_ROWS_QUERY = `query FinancialClearanceRows ($patientId: bigint!) {
  app_patient_financial_clearance(where: {patient_id:{_eq:$patientId}}, order_by: {last_refreshed_at:desc}) {
    id
    patient_id
    encounter_id
    client_id
    household_size
    annual_income
    fpl_percentage
    charity_tier
    status
    coverage_status
    recommended_path
    recommended_action
    reasons
    estimated_responsibility
    outstanding_balance
    lifetime_payments
    assistance
    origin
    last_refreshed_at
    created_at
    updated_at
  }
}
`;

export const FINANCIAL_CLEARANCE_REFRESH_MUTATION = `mutation FinancialClearanceRefresh ($input: FinancialClearanceRefreshInput!) {
  financialClearanceRefresh(input: $input) {
    success
    data
    error
  }
}
`;

// The platform's run origin for the manual button (CLEARANCE_ORIGINS).
export const RUN_ORIGIN = 'manual';

// Fields the clearance record has no source for today (Craig, 2026-10-30).
export const PLATFORM_GAPS = Object.freeze([
  'householdSizeApproval',
  'annualIncomeApproval',
  'screeningDate',
]);

// Stored charity_tier values (action-handler CHARITY_TIER_DISCOUNTS) and the
// platform's default FPL bands for them (website shared/lib/charity-eligibility
// CHARITY_TIERS). A client with its own assistance policy can band
// differently; the stored tier is the five-value compatibility band of the
// effective discount, so the range shown is the platform default.
export const CHARITY_TIERS = Object.freeze({
  full: { discountPercentage: 100, fplRange: '0–100' },
  75: { discountPercentage: 75, fplRange: '101–200' },
  50: { discountPercentage: 50, fplRange: '201–300' },
  25: { discountPercentage: 25, fplRange: '301–400' },
  none: { discountPercentage: 0, fplRange: '401+' },
});

const CLEARANCE_STATUSES = new Set(['clear', 'needs_action', 'blocked']);

function isDigits(v) {
  return typeof v === 'string' && /^\d+$/.test(v);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isConfigured(env, tokenProvider) {
  return isDigits(env.clientId) && isDigits(env.patientId) && tokenProvider.enabled();
}

// Shape the newest clearance row into the display block. Pure. Only the
// fields the sidecar shows leave this function.
export function buildClearanceFromRows(rows) {
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const tierKey = typeof row.charity_tier === 'string' ? row.charity_tier : null;
  const tier = tierKey && CHARITY_TIERS[tierKey] ? { key: tierKey, ...CHARITY_TIERS[tierKey] } : null;
  const householdSize = Number.isInteger(row.household_size) ? row.household_size : null;
  return {
    status: CLEARANCE_STATUSES.has(row.status) ? row.status : null,
    lastRefreshedAt: typeof row.last_refreshed_at === 'string' ? row.last_refreshed_at : null,
    tier,
    householdSize,
    annualIncome: numOrNull(row.annual_income),
    fplPercentage: numOrNull(row.fpl_percentage),
    householdSizeApproval: null,
    annualIncomeApproval: null,
    screeningDate: null,
  };
}

async function readClearance({ env, idToken, query }) {
  return query({
    hasuraOrigin: env.hasuraOrigin,
    idToken,
    operationName: 'FinancialClearanceRows',
    query: FINANCIAL_CLEARANCE_ROWS_QUERY,
    variables: { patientId: env.patientId },
  });
}

/**
 * Read the pinned patient's clearance record.
 *
 * Envelope `status`: 'ok' (record on file) | 'not_run' (no record) | 'error'
 * (the read failed). `source`: 'live' | 'not_configured'. Technical detail
 * rides `error` for logs; the UI shows plain copy only. Never sample data.
 */
export async function resolveFinancialClearance({
  requestedPatientId,
  env,
  tokenProvider,
  query = hasuraQuery,
  now = () => new Date(),
}) {
  const base = { requestedPatientId, fetchedAt: now().toISOString(), gaps: PLATFORM_GAPS };
  if (!isConfigured(env, tokenProvider)) {
    return { ...base, source: 'not_configured', status: 'not_run', identity: { kind: 'none' }, error: null, clearance: null };
  }
  const identity = { kind: 'pinned', clientId: env.clientId, patientId: env.patientId };
  const token = await tokenProvider.getIdToken();
  if (!token.ok) {
    return { ...base, source: 'live', status: 'error', identity, error: { code: token.error.code, message: token.error.message }, clearance: null };
  }
  const read = await readClearance({ env, idToken: token.idToken, query });
  if (!read.ok) {
    return { ...base, source: 'live', status: 'error', identity, error: { code: read.error.code, message: read.error.message, requestId: read.requestId }, clearance: null };
  }
  const clearance = buildClearanceFromRows(read.data.app_patient_financial_clearance);
  return { ...base, source: 'live', status: clearance ? 'ok' : 'not_run', identity, error: null, clearance };
}

/**
 * Run Financial Clearance for the pinned patient (the platform button's
 * action), then re-read the record.
 *
 * Returns { run: { ok, requestId, error? }, envelope? }:
 *   - run.ok false → the action did not run (or failed); nothing to show.
 *   - run.ok true  → envelope is the re-read; it can still be status 'error'
 *     when the run succeeded but the re-read failed (said honestly in the UI).
 */
export async function runFinancialClearance({
  requestedPatientId,
  env,
  tokenProvider,
  callAction = callOrionAction,
  query = hasuraQuery,
  now = () => new Date(),
}) {
  if (!isConfigured(env, tokenProvider)) {
    return { run: { ok: false, requestId: null, error: { code: 'live_lane_not_configured', message: 'Financial clearance is not connected for this sidecar.' } } };
  }
  const token = await tokenProvider.getIdToken();
  if (!token.ok) {
    return { run: { ok: false, requestId: null, error: { code: token.error.code, message: token.error.message } } };
  }
  const result = await callAction({
    hasuraOrigin: env.hasuraOrigin,
    idToken: token.idToken,
    operationName: 'FinancialClearanceRefresh',
    query: FINANCIAL_CLEARANCE_REFRESH_MUTATION,
    variables: {
      input: {
        patient_id: Number(env.patientId),
        client_id: Number(env.clientId),
        origin: RUN_ORIGIN,
      },
    },
    resultField: 'financialClearanceRefresh',
  });
  if (!result.ok) {
    return { run: { ok: false, requestId: result.requestId, error: result.error } };
  }
  const envelope = await resolveFinancialClearance({ requestedPatientId, env, tokenProvider, query, now });
  return { run: { ok: true, requestId: result.requestId }, envelope };
}
