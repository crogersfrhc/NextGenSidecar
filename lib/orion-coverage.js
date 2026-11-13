// Orion patient-coverage lane for the athena-embed prototype (FR-152 read /
// FR-154 write).
//
// The WRITE is the first live insurance-change lane the embed has had:
// platform PR #3110 (merged 2026-08-14, frhc-platform 58286fdc) added the
// synchronous Hasura Action `orionPatientCoverageUpdate` proxying
// action-handler `/actions/orion/patient-coverage-update` → Orion
// `PUT /v1/internal/patients/{patient_id}/coverage` → the athena coverage
// writers. Contract facts that bind every caller (from the merged handler +
// Orion schemas, verified at 58286fdc):
//   - WHOLE-RECORD per COB level, not a partial update: the caller states the
//     coverage it wants at each level; Orion derives create / update /
//     delete+create. `priority` is a MATCHING key (1 = primary, 2 =
//     secondary), never an ordering verb — athena has no patient-level
//     reorder (that stays appointment-level, CORE-54/76).
//   - `athena_package_id` is REQUIRED on every item and is athena's plan
//     CATALOG id — NOT the X12 payer_id; the two are never interchangeable.
//     The coverage READ does not project it (known demand-spec gap), so it
//     must come from the athena side (the profile's insurancepackageid).
//   - `coverage_id` is athena's insuranceid for the policy being edited — the
//     same value the coverage READ returns as coverage_id. Omit to CREATE.
//   - An empty `coverages` list is rejected (422 no_coverages_supplied);
//     removing coverage is NOT expressible on this lane.
//   - `service_date` matters only when the patient carries a self-pay policy;
//     Orion rejects that combination without it rather than guessing.
//   - The returned data is Orion's post-write RE-READ plus a per-level
//     `operations` report ({cob_level, operation, outcome, coverage_id,
//     requires_retro_review}). An `uncertain` outcome is a non-idempotent
//     CREATE that may or may not have landed (ADR-ATH-010): reconcile, NEVER
//     blind-retry. Callers must branch on operations, not the status code.
//
// TRANSPORT NOTE (DR-1, 2026-07-29): like the demographics lane this rides
// the STAFF Cognito staging harness — transport-chain evidence for the write
// contract, not the embed's production auth plane (ST-A6 is the sunset).

import { callOrionAction } from './orion-demographics.js';

// MUST match the allow-listed text in frhc-platform
// applications/hasura/metadata/query_collections.yaml EXACTLY (merged
// 2026-08-13, PR #2964). Same Hasura-export form as every entry there: a
// space before `($patient_id`.
export const ORION_PATIENT_COVERAGE_MUTATION = `mutation OrionPatientCoverage ($patient_id: String!) {
  orionPatientCoverage(patient_id: $patient_id) {
    success
    data
    error
  }
}
`;

// ⚠ ALLOW-LIST GAP (verified at frhc-platform 58286fdc, 2026-08-14): PR #3110
// added this operation to scripts/allowlist_hand_registry.graphql but did NOT
// regenerate metadata/query_collections.yaml, and the CI sync check only
// flags SPA-sourced omissions — so the deployed allow-list does not yet carry
// this entry. Until the platform runs `make allowlist-refresh` and commits
// the collection, live calls will be rejected pre-auth as "query is not
// allowed" (indistinguishable from a missing entry). The text below is the
// Hasura-export form the regenerated collection will hold (space before
// `($input`, matching every existing entry incl. OrionPatientDemographicsUpdate
// — the hand-registry snippet has no space, exactly like Linnea's PR #2929
// chat snippet didn't; the export normalization adds it).
export const ORION_PATIENT_COVERAGE_UPDATE_MUTATION = `mutation OrionPatientCoverageUpdate ($input: OrionCoverageUpdateInput!) {
  orionPatientCoverageUpdate(input: $input) {
    success
    data
    error
  }
}
`;

export async function fetchOrionPatientCoverage({ hasuraOrigin, idToken, patientId, fetchImpl, requestId }) {
  return callOrionAction({
    hasuraOrigin,
    idToken,
    operationName: 'OrionPatientCoverage',
    query: ORION_PATIENT_COVERAGE_MUTATION,
    variables: { patient_id: String(patientId) },
    resultField: 'orionPatientCoverage',
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function covStr(v) {
  return typeof v === 'string' && v !== '' ? v : v != null && v !== '' ? String(v) : null;
}

// Map Orion's FR-152 coverage read onto the per-rank shape the insurance
// comparison tabs consume — the coverage twin of mapOrionDemographics.
// Honest nulls throughout: a field the projection doesn't carry (relationship,
// policyholder anything) simply isn't here, and an absent COB level maps to
// null so the client renders '—' rather than inventing a policy. First
// coverage per priority wins, matching the write route's coverage_id
// resolution — the two must never disagree about which policy a level means.
export function mapOrionCoverage(data) {
  const list = Array.isArray(data?.coverages) ? data.coverages : [];
  const byPriority = new Map();
  for (const cov of list) {
    if (!cov || typeof cov !== 'object') continue;
    const p = Number(cov.priority);
    if (!byPriority.has(p)) byPriority.set(p, cov);
  }
  const rank = (p) => {
    const cov = byPriority.get(p);
    if (!cov) return null;
    return {
      coverageId: covStr(cov.coverage_id),
      planName: covStr(cov.plan?.plan_name),
      payerName: covStr(cov.plan?.payer_name),
      payerId: covStr(cov.plan?.payer_id),
      insuranceType: covStr(cov.plan?.insurance_type),
      groupNumber: covStr(cov.plan?.group_number),
      memberId: covStr(cov.subscriber?.subscriber_id),
      // Policyholder block (Craig, 2026-08-19: needed whenever the holder is
      // not Self). Orion's canonical SubscriberInfo carries all of these, but
      // the FR-152 projection currently exposes only subscriber_id — so these
      // map to honest nulls until the subscriber-block exposure ask lands.
      // NO ssn mapping, deliberately: Orion's SubscriberInfo marks ssn
      // "write-only on the internal lane. Never projected back on a read"
      // (domain/models/insurance.py), so a live SSN value cannot exist here —
      // the app's SSN row shows FrontRunner's masked last-4 only.
      relationship: covStr(cov.subscriber?.relationship_to_patient),
      policyholderFirstName: covStr(cov.subscriber?.first_name),
      policyholderLastName: covStr(cov.subscriber?.last_name),
      policyholderDob: covStr(cov.subscriber?.date_of_birth),
      policyholderGender: covStr(cov.subscriber?.gender),
      policyholderAddressLine1: covStr(cov.subscriber?.address_line_1),
      policyholderAddressLine2: covStr(cov.subscriber?.address_line_2),
      policyholderCity: covStr(cov.subscriber?.city),
      policyholderState: covStr(cov.subscriber?.state),
      policyholderZip: covStr(cov.subscriber?.zip_code),
      effectiveDate: covStr(cov.dates?.effective_date),
      terminationDate: covStr(cov.dates?.termination_date),
      // In-force vs eligibility-VERIFIED are different questions (FR-152):
      // `active` is always true here (Orion filters the rest out), so the
      // informative status is eligibility_status — "Unverified" is still a
      // real policy, never an error.
      eligibilityStatus: covStr(cov.eligibility_status),
      // Verification metadata the projection gained in platform PR #3149
      // (2026-08-19): the SOURCE of the current status ("Athena" = their
      // eligibility engine) and the date eligibility was last checked. Both
      // null on payloads captured before the deploy — honest nulls, as ever.
      eligibilityReason: covStr(cov.eligibility_reason),
      lastVerifiedDate: covStr(cov.dates?.last_verified_date),
      copay: cov.financial && cov.financial.copay_amount != null ? String(cov.financial.copay_amount) : null,
    };
  };
  return { primary: rank(1), secondary: rank(2) };
}

// WHOLE-RECORD-per-COB-level semantics (see the module comment): `input` is
// forwarded verbatim; the server route owns item validation, the coverage_id
// resolution against the read, and the writable-field whitelist.
export async function fetchOrionPatientCoverageUpdate({ hasuraOrigin, idToken, input, fetchImpl, requestId }) {
  return callOrionAction({
    hasuraOrigin,
    idToken,
    operationName: 'OrionPatientCoverageUpdate',
    query: ORION_PATIENT_COVERAGE_UPDATE_MUTATION,
    variables: { input },
    resultField: 'orionPatientCoverageUpdate',
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(requestId ? { requestId } : {}),
  });
}
