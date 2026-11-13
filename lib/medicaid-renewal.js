// Medicaid Renewal tab — per-patient read lane for the athena-embed prototype
// (handoff "sidecar-medicaid-renewal-tab-handoff.md", Craig 2026-10-21).
//
// WHAT THIS IS: one server-side read that assembles the Medicaid Renewal
// modal's data from the platform's EXISTING, already allow-listed Hasura
// documents, field by field, with an honest null + reason wherever the
// platform has no source. Nothing here is computed that the platform does not
// compute itself, and nothing is invented to fill a gap — the gaps are the
// contract (athena-embed/docs/CONTRACT-medicaid-renewal-sidecar-2026-10-21.md).
//
// Sources (frhc-platform `development` 6ccbdb3b, 2026-10-21; each text below
// MUST match applications/hasura/metadata/query_collections.yaml exactly —
// allow-list matching is on query TEXT, the same rule the Orion lanes follow):
//   - MedicaidPatientRenewal  — medicaid_worklist row (renewal list membership,
//                               renewal date, derived_state, member id)
//   - MedicaidPatientWorkfile — app_medicaid.workfile (the case: stage,
//                               application status)
//   - MedicaidCaseOutcomes    — current program selections (staff-recorded
//                               disposition_category → board column; program)
//   - MedicaidOutreachAttempts — the case's sent-message log
//
// IDENTITY (same posture as the Orion demographics/coverage lanes): there is
// NO athena → FrontRunner patient mapping, so the FrontRunner client id and
// canonical patient id are PINNED server-side (env) to a staging test patient.
// The client's :patientId is an athena id and is never forwarded through this
// server's staff token (IDOR guard). The envelope says so (`identity`).
//
// PLACEMENT mirrors the board's `bucketForRow`
// (website/client/src/features/medicaid-redetermination/lib/board-grouping.ts):
// no case → Unknown / Needs Screening; a case whose current selection carries
// a mapped disposition_category → that column (staff confirmed); anything
// else → Unknown / Needs Screening. The board's `fplBandForRow` ALWAYS
// returns "unknown" (no FPL/income prediction exists on the platform), so a
// live patient is never "Predicted" here either.
//
// CASE PROGRESS is read from the product, never computed here (Craig,
// 2026-10-21; tracker addendum 2026-10-26): `case.caseProgress` is an
// OPTIONAL typed field (steps with status, done count, total steps, current
// position, optional percent, closed/denied — see normalizeCaseProgress). It
// is ABSENT for every live patient: the platform serves no step data. The
// Replit platform repo derives it in the browser (website/client/src/features/
// medicaid-renewal/lib/pane/step-progress.ts, components/pane/
// CaseProgressTracker.tsx at 78a15a5ed — do NOT port them), and this
// platform's stage_machine.py stores 8 stage statuses in 4 nodes with no
// 7-step or per-activity data — never map the 8 stages onto the 7 steps.
// Contract gap #11.

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Allow-listed documents (Hasura-export form, verbatim)
// ---------------------------------------------------------------------------

export const MEDICAID_PATIENT_RENEWAL_QUERY = `query MedicaidPatientRenewal ($clientId: Int!, $patientId: bigint!) {
  medicaid_worklist(where: {client_id:{_eq:$clientId},patient_id:{_eq:$patientId}}, limit: 1) {
    workfile_id
    redetermination_date
    redetermination_source
    derived_state
    live_bucket
    payer_name
    plan_name
    medicaid_member_id
  }
}
`;

export const MEDICAID_PATIENT_WORKFILE_QUERY = `query MedicaidPatientWorkfile ($clientId: Int!, $patientId: bigint!) {
  app_medicaid_workfile(where: {client_id:{_eq:$clientId},patient_id:{_eq:$patientId}}, limit: 1) {
    id
    client_id
    source_system
    source_patient_id
    patient_id
    workflow_stage
    application_status
    state_case_number
    submission_note
    process_activities
  }
}
`;

export const MEDICAID_CASE_OUTCOMES_QUERY = `query MedicaidCaseOutcomes ($clientId: Int!) {
  app_medicaid_workfile(where: {client_id:{_eq:$clientId}}, order_by: {id:asc}, limit: 50000) {
    id
    source_system
    source_patient_id
    application_status
  }
  app_medicaid_program_selection(where: {client_id:{_eq:$clientId},is_current:{_eq:true}}, order_by: {id:asc}, limit: 50000) {
    case_id
    program_code
    disposition_category
  }
}
`;

export const MEDICAID_OUTREACH_ATTEMPTS_QUERY = `query MedicaidOutreachAttempts ($caseId: bigint!, $clientId: Int!) {
  app_medicaid_outreach_attempt(where: {case_id:{_eq:$caseId},client_id:{_eq:$clientId}}, order_by: {attempted_at:desc_nulls_last}) {
    id
    channel
    status
    reason
    subject
    recipient
    letter_archived
    letter_archive_reason
    attempted_at
    created_at
  }
}
`;

// ---------------------------------------------------------------------------
// Product vocabulary, verbatim from the platform board (no new wording)
// ---------------------------------------------------------------------------

// lib/board-grouping.ts BUCKET_LABELS
export const COLUMN_LABELS = {
  medicaid_eligible: 'Medicaid Eligible',
  aca_marketplace: 'ACA / Marketplace Eligible',
  no_longer_eligible: 'No Longer Eligible',
  unknown_screening: 'Unknown / Needs Screening',
};

// lib/board-dnd.ts BUCKET_TO_OUTCOME, reversed (the board derives it the
// same way; `pending_review` maps to no column).
const OUTCOME_TO_COLUMN = {
  still_eligible: 'medicaid_eligible',
  plan_change_needed: 'aca_marketplace',
  transitioned_out: 'no_longer_eligible',
};

// lib/board-dnd.ts OUTCOME_CATEGORIES
const OUTCOME_CATEGORIES = ['pending_review', 'still_eligible', 'plan_change_needed', 'transitioned_out'];

// lib/board-grouping.ts FPL_BAND_LABELS
export const INCOME_BAND_LABELS = {
  under_100: 'Under 100% FPL',
  fpl_100_138: '100–138% FPL',
  fpl_138_250: '138–250% FPL',
  fpl_250_400: '250–400% FPL',
  above_400: 'Above 400% FPL',
  unknown: 'Income unknown',
};

// components/PlacementReasonChip.tsx labels for the reasons the modal's
// "Result" row can carry.
export const RESULT_LABELS = {
  staff_confirmed: 'Staff-recorded outcome',
  meets_income: 'Meets income requirement',
  over_medicaid_income: 'Over Medicaid income limit',
  over_subsidy_limit: 'Over ACA subsidy limit',
  income_unknown: 'Income unknown',
};

// contracts/process_step_activities.json steps[].label (WORKFLOW_STAGES)
export const STAGE_LABELS = {
  not_started: 'Not Started',
  screening: 'Eligibility Screening',
  document_collection: 'Document Collection',
  application_prep: 'Application Prep',
  application_submitted: 'Application Submitted',
  under_review: 'Under Review',
  approved: 'Approved',
  denied: 'Denied',
};

// components/AhcccsStateChip.tsx: `renewal_passed` (destructive) and
// `urgent` ("Renewal is due within 30 days", warning) are the product's own
// overdue / due-soon states — taken from derived_state, never recomputed from
// the date.
const RENEWAL_FLAG_BY_STATE = { renewal_passed: 'overdue', urgent: 'due_soon' };

// The board's card reads `patientDisplayName` etc.; the sidecar has no
// first-name source on these documents (see contract), so names come from
// the sidecar's own profile client-side.

// ---------------------------------------------------------------------------
// Hasura transport
// ---------------------------------------------------------------------------

export async function hasuraQuery({
  hasuraOrigin,
  idToken,
  operationName,
  query,
  variables,
  fetchImpl = fetch,
  requestId = randomUUID(),
}) {
  const endpoint = `${String(hasuraOrigin || '').replace(/\/+$/, '')}/v1/graphql`;
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        'x-request-id': requestId,
      },
      body: JSON.stringify({ operationName, variables, query }),
    });
  } catch (err) {
    return { ok: false, requestId, error: { code: 'transport_error', message: `Could not reach Hasura: ${err && err.message ? err.message : err}` } };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, requestId, error: { code: 'invalid_response', message: `Hasura returned non-JSON (HTTP ${res.status}).` } };
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    return {
      ok: false,
      requestId,
      error: { code: first?.extensions?.code || 'unexpected', message: first?.message || 'Hasura returned an error.' },
    };
  }
  if (!body || typeof body.data !== 'object' || body.data === null) {
    return { ok: false, requestId, error: { code: 'invalid_response', message: `Hasura response carried no data (HTTP ${res.status}).` } };
  }
  return { ok: true, requestId, data: body.data };
}

// ---------------------------------------------------------------------------
// Envelope assembly (pure — unit-tested without a network)
// ---------------------------------------------------------------------------

// Fields the platform has NO source for today. Each is an honest null in the
// envelope and a named row in the contract doc.
export const PLATFORM_GAPS = [
  'placement.predicted',
  'fpl',
  'incomeBand',
  'nextAppointment',
  'discount',
  'memberIdFlag',
  'case.caseProgress',
  'case.assignee',
  'screening',
];

/**
 * The board's bucketForRow, applied to one patient: `caseId` is the
 * workfile id (null = no case started); `selections` are the client's current
 * program selections in id order (later rows win, as in
 * useMedicaidCaseOutcomes).
 */
export function columnForCase(caseId, selections) {
  if (caseId == null) return { column: 'unknown_screening', outcome: null, programCode: null };
  let outcome = null;
  let programCode = null;
  for (const s of selections || []) {
    if (String(s.case_id) !== String(caseId)) continue;
    if (OUTCOME_CATEGORIES.includes(s.disposition_category)) outcome = s.disposition_category;
    if (s.program_code) programCode = s.program_code;
  }
  const column = (outcome && OUTCOME_TO_COLUMN[outcome]) || 'unknown_screening';
  return { column, outcome, programCode };
}

/**
 * Build the modal's data from the four reads. `reads` holds each read's
 * `{ ok, data | error }` result (outreach may be absent when there is no
 * case). Returns the `renewal` block, or null when the patient is not on the
 * renewal list.
 */
export function buildRenewalFromReads(reads) {
  const worklist = reads.renewal.data.medicaid_worklist || [];
  const row = worklist[0];
  if (!row) return null;

  // The caller guarantees the workfile and outcomes reads succeeded (a failed
  // one would misplace the patient, so it is an envelope error instead).
  const workfile = (reads.workfile.data.app_medicaid_workfile || [])[0] || null;
  const caseId = workfile ? String(workfile.id) : null;
  const selections = reads.outcomes.data.app_medicaid_program_selection || [];
  const { column, outcome, programCode } = columnForCase(caseId, selections);
  const staffConfirmed = OUTCOME_TO_COLUMN[outcome] !== undefined;

  let outreach;
  if (!caseId) {
    outreach = { status: 'no_case', attempts: [] };
  } else if (reads.outreach && reads.outreach.ok) {
    outreach = {
      status: 'ok',
      attempts: (reads.outreach.data.app_medicaid_outreach_attempt || []).map((a) => ({
        id: String(a.id),
        channel: a.channel || null,
        status: a.status || null,
        subject: a.subject || null,
        attemptedAt: a.attempted_at || a.created_at || null,
      })),
    };
  } else {
    outreach = { status: 'error', attempts: [] };
  }

  const stage = workfile ? workfile.workflow_stage || null : null;
  return {
    column,
    columnLabel: COLUMN_LABELS[column],
    // 'staff_confirmed' | 'predicted' | null — never guessed: the platform has
    // no prediction source, so a live envelope is never 'predicted'.
    placement: staffConfirmed ? 'staff_confirmed' : null,
    result: staffConfirmed
      ? { key: 'staff_confirmed', label: RESULT_LABELS.staff_confirmed }
      : { key: 'income_unknown', label: RESULT_LABELS.income_unknown },
    incomeBand: { key: 'unknown', label: INCOME_BAND_LABELS.unknown },
    fplPercent: null,
    renewalDate: row.redetermination_date ? String(row.redetermination_date).slice(0, 10) : null,
    renewalFlag: RENEWAL_FLAG_BY_STATE[row.derived_state] || null,
    nextAppointment: { available: false, at: null },
    program: programCode ? { code: programCode } : null,
    discount: null,
    memberId: {
      value: row.medicaid_member_id || null,
      // No server-side member-ID flag or message exists (the board's
      // "member ids to fix" list is a client-side AHCCCS shape check, which
      // this lane deliberately does not copy). Shape held for the contract.
      flagged: false,
      message: null,
    },
    case: caseId
      ? {
          id: caseId,
          stage,
          statusLabel: STAGE_LABELS[stage] || null,
          // `caseProgress` is deliberately ABSENT: no platform source (gap #11).
          assignee: null,
        }
      : null,
    screening: { status: 'none', ranAt: null, results: [] },
    outreach,
  };
}

// ---------------------------------------------------------------------------
// Case progress — the optional typed field (tracker addendum 2026-10-26)
// ---------------------------------------------------------------------------
//
//   caseProgress?: {
//     steps: { position: number; title: string; description?: string;
//              status: "done" | "in_progress" | "not_started" }[];
//     doneCount: number;        // steps done
//     totalSteps: number;       // e.g. 7
//     currentPosition: number | null;
//     percentComplete?: number; // the product's percent, optional
//     closed?: "closed" | "denied" | null;
//   }
//
// Whatever supplies it (only the review samples today), the value passes
// through this shape check and nothing is derived: a malformed value is
// dropped (the card then renders nothing), never repaired or recomputed.

export const CASE_PROGRESS_STATUSES = ['done', 'in_progress', 'not_started'];

const isInt = (n) => Number.isInteger(n) && n >= 0;

export function normalizeCaseProgress(cp) {
  if (!cp || typeof cp !== 'object' || !Array.isArray(cp.steps) || cp.steps.length === 0) return null;
  if (!isInt(cp.doneCount) || !isInt(cp.totalSteps) || cp.totalSteps !== cp.steps.length) return null;
  if (cp.doneCount > cp.totalSteps) return null;
  if (cp.currentPosition != null && !(isInt(cp.currentPosition) && cp.currentPosition >= 1 && cp.currentPosition <= cp.totalSteps)) return null;
  const steps = [];
  for (const st of cp.steps) {
    if (!st || !isInt(st.position) || typeof st.title !== 'string' || !st.title) return null;
    if (!CASE_PROGRESS_STATUSES.includes(st.status)) return null;
    steps.push({
      position: st.position,
      title: st.title,
      ...(typeof st.description === 'string' && st.description ? { description: st.description } : {}),
      status: st.status,
    });
  }
  const out = {
    steps,
    doneCount: cp.doneCount,
    totalSteps: cp.totalSteps,
    currentPosition: cp.currentPosition == null ? null : cp.currentPosition,
    closed: cp.closed === 'closed' || cp.closed === 'denied' ? cp.closed : null,
  };
  if (typeof cp.percentComplete === 'number' && cp.percentComplete >= 0 && cp.percentComplete <= 100) {
    out.percentComplete = cp.percentComplete;
  }
  return out;
}

// Step titles and descriptions as given in the tracker addendum ("as in the
// product"). Used ONLY by the review samples; a live value carries its own.
const SAMPLE_STEP_CATALOG = [
  ['Verify the patient\'s information', 'Confirm the facts the renewal is based on.'],
  ['Select the renewal programs', 'Choose the programs this renewal targets — the document checklist is built from them.'],
  ['Gather the required documents', 'Collect the proof each selected program needs and request anything outstanding from the patient.'],
  ['Work requirements', 'Review evidence and confirm the patient meets the work requirement or is exempt.'],
  ['Prepare the application', 'Fill out the state application forms — electronically, through the patient portal, or on paper.'],
  ['Submit & record the case', 'Submit the application to the state and record the submission on the case.'],
  ['Follow up & record the decision', 'Keep the case moving while the state reviews it, then record the decision.'],
];

/** A sample `caseProgress` value, written out as the product would supply it. */
function sampleCaseProgress({ statuses, doneCount, currentPosition, percentComplete, closed = null }) {
  return normalizeCaseProgress({
    steps: SAMPLE_STEP_CATALOG.map(([title, description], i) => ({ position: i + 1, title, description, status: statuses[i] })),
    doneCount,
    totalSteps: SAMPLE_STEP_CATALOG.length,
    currentPosition,
    percentComplete,
    closed,
  });
}

// ---------------------------------------------------------------------------
// Sample data — review only, labelled "Sample data" in the UI. OFF unless
// MEDICAID_RENEWAL_SAMPLE_DATA=1 (server.js; Craig, 2026-10-30, ending the
// temporary 2026-10-28 default). With it on, "olivia" is the default for the
// Olivia Torres mock profile. Must not be on in any shipped environment. Names are the prototype's test patients; the
// member-ID warnings follow the UX spec (Bob and Gita a product message, Carol
// the generic one, Alice none). The messages are the spec's examples.
// ---------------------------------------------------------------------------

function sampleRenewal(o) {
  return {
    column: o.column,
    columnLabel: COLUMN_LABELS[o.column],
    placement: o.placement || null,
    result: o.result,
    incomeBand: { key: o.band, label: INCOME_BAND_LABELS[o.band] },
    fplPercent: o.fplPercent == null ? null : o.fplPercent,
    renewalDate: o.renewalDate,
    renewalFlag: o.renewalFlag || null,
    nextAppointment: o.nextAppointment ? { available: true, at: o.nextAppointment } : { available: true, at: null },
    program: o.program ? { code: o.program } : null,
    discount: o.discount ? { label: o.discount } : null,
    memberId: o.memberId || { value: null, flagged: false, message: null },
    case: o.case || null,
    screening: o.screening || { status: 'none', ranAt: null, results: [] },
    outreach: o.outreach || { status: o.case ? 'ok' : 'no_case', attempts: [] },
  };
}

// Actionable addendum (2026-10-30): the prototype's assignee options are
// sample; the real staff list is a contract gap.
const SAMPLE_ASSIGNEE_OPTIONS = ['Dev Admin', 'Staff member (sample)'];

/**
 * Per-step detail for the step panel — SAMPLE ONLY. The platform's per-step
 * state read (medicaidProcessActivityStateRead) is not wired, so a live case
 * has no `stepDetail` and no step panel. Values are consistent with the
 * step's status (the addendum's open item: the product's own sample data is
 * not).
 */
function sampleStepDetail({ approvals, selected, received, workreq, pdfsGenerated, submit }) {
  return {
    verify: {
      facts: [
        { label: 'Member ID', value: 'From the insurance record' },
        { label: 'Plan', value: 'AHCCCS Complete Care (sample)' },
        { label: 'Last eligibility check', value: 'Oct 14, 2026 · Active' },
        { label: 'Household income', value: '$1,850 / month (sample)' },
        { label: 'Household size', value: '3' },
      ],
      approvals,
      checks: {
        demographics: { lastRun: '2026-10-14', result: [{ label: 'Address', value: 'Matches the vendor record' }, { label: 'Phone', value: 'Matches the vendor record' }] },
        eligibility: { plan: 'AHCCCS Complete Care (sample)', lastRun: '2026-10-14', result: [{ label: 'Coverage', value: 'Active' }, { label: 'Plan', value: 'AHCCCS Complete Care (sample)' }] },
      },
    },
    programs: {
      items: [
        { code: 'AHCCCS-CHIP-9222', name: 'KidsCare (CHIP)', group: 'qualifies' },
        { code: 'AHCCCS-ADULT', name: 'AHCCCS Adult (sample)', group: 'qualifies' },
        { code: 'MSP-QMB', name: 'Medicare Savings Program (sample)', group: 'needs_review' },
        { code: 'ALTCS', name: 'Long-term care (sample)', group: 'needs_review' },
      ],
      selected,
    },
    documents: {
      items: [
        { id: 'doc-income', label: 'Proof of income', received },
        { id: 'doc-address', label: 'Proof of address', received },
        { id: 'doc-id', label: 'Photo ID', received },
      ],
    },
    workreq: { determination: 'Exempt: caregiver of a child under 6 (sample)', ...workreq },
    prepare: {
      pdfs: [
        { name: 'State renewal application', status: pdfsGenerated ? 'generated' : 'not_generated' },
        { name: 'Income attestation', status: pdfsGenerated ? 'generated' : 'not_generated' },
      ],
    },
    submit,
    decision: { checks: { checkedStatus: false, answeredRequests: false, reviewedServices: false }, decision: null, note: '' },
  };
}

export const SAMPLE_PATIENTS = {
  bob: {
    firstName: 'Bob',
    fullName: 'Bob Testpatient',
    renewal: sampleRenewal({
      column: 'medicaid_eligible',
      placement: 'staff_confirmed',
      result: { key: 'staff_confirmed', label: RESULT_LABELS.staff_confirmed },
      band: 'under_100',
      fplPercent: 92,
      renewalDate: '2026-10-12',
      renewalFlag: 'overdue',
      nextAppointment: '2026-11-03T09:30:00',
      program: 'AHCCCS-CHIP-9222',
      discount: '75% Discount',
      memberId: { value: '12345', flagged: true, message: 'Member ID must be the letter A followed by eight digits.' },
      case: {
        id: 'sample-bob',
        stage: 'application_submitted',
        statusLabel: STAGE_LABELS.application_submitted,
        // Craig's reference from the Replit board card (Bob Testpatient,
        // MRN-ALPHA-002): 5 of 7 steps done, step 6 in progress, 63% (10 of
        // 16 activities). The product's numbers, written in — not derived.
        caseProgress: sampleCaseProgress({
          statuses: ['done', 'done', 'done', 'done', 'done', 'in_progress', 'not_started'],
          doneCount: 5,
          currentPosition: 6,
          percentComplete: 63,
        }),
        assignee: { name: 'Jordan Lee' },
        caseStatus: 'submitted',
        assigneeOptions: SAMPLE_ASSIGNEE_OPTIONS,
        stepDetail: sampleStepDetail({
          approvals: { demographics: true, insurance: true, financial: true },
          selected: ['AHCCCS-CHIP-9222'],
          received: true,
          workreq: { reviewed: true, confirmed: true },
          pdfsGenerated: true,
          submit: { attestation: 'Signed', packet: 'Ready to download' },
        }),
      },
      screening: {
        status: 'available',
        ranAt: '2026-10-14',
        results: [
          { label: 'Insurance verification', value: 'Active Medicaid coverage found' },
          { label: 'Insurance discovery', value: 'Not run (coverage on file)' },
          { label: 'Credit check', value: 'Completed' },
          { label: 'FPL screening', value: 'Under 100% FPL' },
          { label: 'Qualifies for', value: 'AHCCCS-CHIP-9222' },
        ],
      },
      outreach: {
        status: 'ok',
        attempts: [{ id: 's1', channel: 'email', status: 'sent', subject: 'Medicaid renewal due', attemptedAt: '2026-10-02T15:04:00Z' }],
      },
    }),
  },
  carol: {
    firstName: 'Carol',
    fullName: 'Carol Testpatient',
    renewal: sampleRenewal({
      column: 'aca_marketplace',
      placement: 'predicted',
      result: { key: 'over_medicaid_income', label: RESULT_LABELS.over_medicaid_income },
      band: 'fpl_138_250',
      fplPercent: 180,
      renewalDate: '2026-11-04',
      renewalFlag: 'due_soon',
      memberId: { value: 'C-55102', flagged: true, message: null },
      // Actionable addendum: Carol is the case at step 1 with nothing ticked
      // (no product percent), so the whole step flow can be walked.
      case: {
        id: 'sample-carol',
        stage: 'screening',
        statusLabel: STAGE_LABELS.screening,
        assignee: null,
        caseStatus: 'new',
        assigneeOptions: SAMPLE_ASSIGNEE_OPTIONS,
        caseProgress: sampleCaseProgress({
          statuses: ['in_progress', 'not_started', 'not_started', 'not_started', 'not_started', 'not_started', 'not_started'],
          doneCount: 0,
          currentPosition: 1,
        }),
        stepDetail: sampleStepDetail({
          approvals: { demographics: false, insurance: false, financial: false },
          selected: [],
          received: false,
          workreq: { reviewed: false, confirmed: false },
          pdfsGenerated: false,
          submit: { attestation: 'Not signed yet', packet: 'Not ready' },
        }),
      },
      screening: { status: 'error', ranAt: null, results: [] },
    }),
  },
  alice: {
    firstName: 'Alice',
    fullName: 'Alice Testpatient',
    renewal: sampleRenewal({
      column: 'no_longer_eligible',
      placement: 'staff_confirmed',
      result: { key: 'staff_confirmed', label: RESULT_LABELS.staff_confirmed },
      band: 'above_400',
      fplPercent: 410,
      renewalDate: '2027-01-15',
      case: { id: 'sample-alice', stage: 'denied', statusLabel: STAGE_LABELS.denied, assignee: { name: 'Sam Ortiz' } },
    }),
  },
  gita: {
    firstName: 'Gita',
    fullName: 'Gita Testpatient',
    renewal: sampleRenewal({
      column: 'unknown_screening',
      placement: null,
      result: { key: 'income_unknown', label: RESULT_LABELS.income_unknown },
      band: 'unknown',
      renewalDate: '2026-12-01',
      memberId: { value: 'A0099812', flagged: true, message: 'Member ID not found at the payer.' },
    }),
  },
  untracked: { firstName: 'Una', fullName: 'Una Testpatient', renewal: null },
  // The sidecar's default mock profile, Olivia Torres, shown with Bob's
  // sample renewal when samples are on (Medicaid Eligible, staff
  // confirmed, 5 of 7 steps done, 63%) so the UI can be shown. Filled in below
  // from Bob's entry, so the two never drift apart.
  olivia: null,
  error: { firstName: 'Eve', fullName: 'Eve Testpatient', error: true },
};

SAMPLE_PATIENTS.olivia = { firstName: 'Olivia', fullName: 'Olivia Torres', renewal: SAMPLE_PATIENTS.bob.renewal };

// ---------------------------------------------------------------------------
// The route body
// ---------------------------------------------------------------------------

function isDigits(v) {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

/**
 * Resolve the envelope for GET /api/medicaid-renewal/:patientId.
 * Envelope `status`: 'ok' (renewal block present) | 'not_tracked' (no renewal
 * list record) | 'error' (the primary read failed). `source`: 'live' |
 * 'sample' | 'not_configured'. Technical detail rides `error` for logs; the
 * UI shows plain copy only.
 */
export async function resolveMedicaidRenewal({
  requestedPatientId,
  sampleKey,
  env,
  tokenProvider,
  query = hasuraQuery,
  now = () => new Date(),
}) {
  const base = { requestedPatientId, fetchedAt: now().toISOString(), gaps: PLATFORM_GAPS };

  if (env.sampleDataEnabled && sampleKey) {
    const sample = SAMPLE_PATIENTS[sampleKey];
    if (sample) {
      if (sample.error) {
        return { ...base, source: 'sample', status: 'error', identity: { kind: 'sample' }, error: { code: 'sample_error', message: 'Sample error state.' }, renewal: null };
      }
      return {
        ...base,
        source: 'sample',
        status: sample.renewal ? 'ok' : 'not_tracked',
        identity: { kind: 'sample', firstName: sample.firstName, fullName: sample.fullName },
        error: null,
        renewal: sample.renewal,
      };
    }
  }

  if (!isDigits(env.clientId) || !isDigits(env.patientId) || !tokenProvider.enabled()) {
    return { ...base, source: 'not_configured', status: 'not_tracked', identity: { kind: 'none' }, error: null, renewal: null };
  }

  const token = await tokenProvider.getIdToken();
  if (!token.ok) {
    return { ...base, source: 'live', status: 'error', identity: { kind: 'pinned' }, error: { code: token.error.code, message: token.error.message }, renewal: null };
  }

  const common = { hasuraOrigin: env.hasuraOrigin, idToken: token.idToken };
  const clientId = Number(env.clientId);
  const patientId = env.patientId;
  const [renewal, workfile, outcomes] = await Promise.all([
    query({ ...common, operationName: 'MedicaidPatientRenewal', query: MEDICAID_PATIENT_RENEWAL_QUERY, variables: { clientId, patientId } }),
    query({ ...common, operationName: 'MedicaidPatientWorkfile', query: MEDICAID_PATIENT_WORKFILE_QUERY, variables: { clientId, patientId } }),
    query({ ...common, operationName: 'MedicaidCaseOutcomes', query: MEDICAID_CASE_OUTCOMES_QUERY, variables: { clientId } }),
  ]);
  const identity = { kind: 'pinned', clientId: env.clientId, patientId: env.patientId };

  // Any of the three primary reads failing is a load error: without the case
  // and its outcome the column cannot be placed the way the board places it.
  const failed = [renewal, workfile, outcomes].find((r) => !r.ok);
  if (failed) {
    return { ...base, source: 'live', status: 'error', identity, error: { code: failed.error.code, message: failed.error.message, requestId: failed.requestId }, renewal: null };
  }

  const wf = (workfile.data.app_medicaid_workfile || [])[0];
  let outreach = null;
  if (wf) {
    outreach = await query({
      ...common,
      operationName: 'MedicaidOutreachAttempts',
      query: MEDICAID_OUTREACH_ATTEMPTS_QUERY,
      variables: { caseId: String(wf.id), clientId },
    });
  }

  const block = buildRenewalFromReads({ renewal, workfile, outcomes, outreach });
  return {
    ...base,
    source: 'live',
    status: block ? 'ok' : 'not_tracked',
    identity,
    error: null,
    renewal: block,
  };
}
