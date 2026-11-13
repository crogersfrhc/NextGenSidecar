// Medicaid Renewal tab — the WRITE side (actionable addendum, Craig
// 2026-10-30): every action the tab can take, as one typed registry.
//
// Each action is either:
//   - LIVE: built from platform writes that exist and are on the Hasura
//     allow-list (verified at frhc-platform development 674568476,
//     2026-10-30). The texts below are copied VERBATIM from
//     applications/hasura/metadata/query_collections.yaml — allow-list
//     matching is on query text.
//   - a GAP: the platform has no usable write for it (missing, or partial:
//     the write exists but an input it needs is not readable here). A gap
//     never pretends to save: it fails with `not_available` and the tab shows
//     its error state. Each gap is a row in
//     docs/CONTRACT-medicaid-renewal-sidecar-2026-10-21.md.
//
// Sample patients (review data, labelled "Sample data") never reach the
// platform: their saves are SIMULATED and say so (`simulated: true`). A live
// patient's save is never faked.

import { hasuraQuery, MEDICAID_PATIENT_WORKFILE_QUERY } from './medicaid-renewal.js';

export const WRITE_TEXTS = {
  RenewalBoardCaseStatusSet: `mutation RenewalBoardCaseStatusSet ($input: MedicaidCaseStatusSetInput!) {
  medicaidCaseStatusSet(input: $input) {
    success
  }
}
`,
  RenewalPaneProcessActivitySet: `mutation RenewalPaneProcessActivitySet ($input: MedicaidProcessActivitySetInput!) {
  medicaidProcessActivitySet(input: $input) {
    success
    stage_advanced
    new_stage
    workfile {
      ... RenewalWorkfileFields
    }
    process_activity_state {
      workflow_stage
      target_stage
      steps {
        step
        ordinal
        is_current
        complete
        activities {
          activity_id
          required
          completed
          manual
          auto
          source
          completed_by
          completed_at
          actor_type
        }
      }
      auto_activities {
        key
        step
        activity_id
        source
      }
    }
  }
}
fragment RenewalWorkfileFields on MedicaidWorkfileData {
  id
  client_id
  source_system
  source_patient_id
  patient_id
  workflow_stage
  application_status
  case_status
  state_case_number
  submission_note
  submitted_at
  submission_method
  income_source
  case_start_reason
  case_start_reason_detail
  ineligibility_reason
  case_assignee_user_id
  case_closed_at
  case_closed_by
  case_close_reason
  case_last_activity_at
  process_activities
  field_verifications
  created_at
  updated_at
}
`,
  RenewalChecklistItemAdd: `mutation RenewalChecklistItemAdd ($input: MedicaidChecklistItemAddInput!) {
  medicaidChecklistItemAdd(input: $input) {
    success
    checklist_item {
      id
      label
      status
    }
  }
}
`,
  RenewalApplicationStatusSet: `mutation RenewalApplicationStatusSet ($input: MedicaidCaseApplicationStatusSetInput!) {
  medicaidCaseApplicationStatusSet(input: $input) {
    success
    workfile {
      ... RenewalWorkfileFields
    }
  }
}
fragment RenewalWorkfileFields on MedicaidWorkfileData {
  id
  client_id
  source_system
  source_patient_id
  patient_id
  workflow_stage
  application_status
  case_status
  state_case_number
  submission_note
  submitted_at
  submission_method
  income_source
  case_start_reason
  case_start_reason_detail
  ineligibility_reason
  case_assignee_user_id
  case_closed_at
  case_closed_by
  case_close_reason
  case_last_activity_at
  process_activities
  field_verifications
  created_at
  updated_at
}
`,
  RenewalPaneCaseNoteAdd: `mutation RenewalPaneCaseNoteAdd ($input: MedicaidCaseNoteAddInput!) {
  medicaidCaseNoteAdd(input: $input) {
    success
  }
}
`,
  RenewalOutreachSend: `mutation RenewalOutreachSend ($input: MedicaidOutreachSendInput!) {
  medicaidOutreachSend(input: $input) {
    success
    outreach_attempt {
      id
      channel
      status
      reason
    }
  }
}
`,};

// Case status options, as the platform's CASE_STATUSES (stage_machine.py)
// minus `closed` (the final close stays in FrontRunner).
export const CASE_STATUS_OPTIONS = ['new', 'in_progress', 'waiting', 'submitted'];

// The platform catalog's activity ids (process_catalog.py PROCESS_STEPS) for
// the tick-only steps the sidecar saves.
export const STEP_ACTIVITIES = {
  1: { step_id: 'screening', activities: { demographics: 'approve_demographics', insurance: 'approve_insurance', financial: 'approve_financial' } },
  4: { step_id: 'work_requirements', activities: { reviewed: 'review_work_requirement_evidence', confirmed: 'confirm_work_requirement_compliance' } },
};
export const FOLLOW_UP_ACTIVITIES = {
  checkedStatus: { step_id: 'under_review', activity_id: 'monitor_case_status' },
  answeredRequests: { step_id: 'under_review', activity_id: 'respond_to_information_requests' },
  reviewedServices: { step_id: 'approved', activity_id: 'review_available_services' },
};

export const MEMBER_ID_PATTERN = /^A[0-9]{8}$/;

function op(operationName, input) {
  return { operationName, query: WRITE_TEXTS[operationName], variables: { input }, resultField: OP_RESULT[operationName] };
}
const OP_RESULT = {
  RenewalBoardCaseStatusSet: 'medicaidCaseStatusSet',
  RenewalPaneProcessActivitySet: 'medicaidProcessActivitySet',
  RenewalChecklistItemAdd: 'medicaidChecklistItemAdd',
  RenewalApplicationStatusSet: 'medicaidCaseApplicationStatusSet',
  RenewalPaneCaseNoteAdd: 'medicaidCaseNoteAdd',
  RenewalOutreachSend: 'medicaidOutreachSend',
};

const isStr = (v) => typeof v === 'string';
const bad = (message) => ({ error: { code: 'invalid_input', message } });

/**
 * The registry. `validate(payload)` returns null or an error; `live` builds
 * the ordered platform writes from the payload and the live case, or is
 * absent for a gap (`gap` names the contract row).
 */
export const ACTIONS = {
  caseStatus: {
    validate: (p) => (CASE_STATUS_OPTIONS.includes(p.status) ? null : bad('Unknown case status.')),
    live: (p, c) => [op('RenewalBoardCaseStatusSet', { client_id: c.clientId, case_id: c.caseId, status: p.status })],
  },
  assignee: { validate: () => null, gap: 'assign case (medicaidCaseAssigneeSet needs a staff id; no staff list read)' },
  startCase: { needsCase: false, validate: () => null, gap: 'start case (source_patient_id not readable)' },
  confirmPlacement: {
    validate: (p) => (['medicaid_eligible', 'aca_marketplace', 'no_longer_eligible', 'unknown_screening'].includes(p.column) ? null : bad('Unknown column.')),
    gap: 'confirm placement (program_code required)',
  },
  saveStep: {
    validate: (p) => ([1, 2, 3, 4].includes(p.step) ? null : bad('This step is not saved this way.')),
    // Steps 1 and 4 are tick-only: one activity write per tick. Steps 2 and
    // 3 need reads the sidecar does not have (program list, checklist ids).
    live: (p, c) => {
      const spec = STEP_ACTIVITIES[p.step];
      if (!spec) return null;
      const ticks = p.ticks || {};
      return Object.keys(spec.activities).map((k) => {
        if (ticks[k] !== true) throw Object.assign(new Error('Every item must be ticked.'), { code: 'invalid_input' });
        return op('RenewalPaneProcessActivitySet', { client_id: c.clientId, case_id: c.caseId, step_id: spec.step_id, activity_id: spec.activities[k], status: 'completed' });
      });
    },
    gapFor: (p) => (p.step === 2 ? 'save program selection (program list not readable)' : p.step === 3 ? 'mark documents received (checklist item ids not readable)' : null),
  },
  addDocument: {
    validate: (p) => (isStr(p.label) && p.label.trim() ? null : bad('Enter the document name.')),
    live: (p, c) => [op('RenewalChecklistItemAdd', { client_id: c.clientId, case_id: c.caseId, label: p.label.trim() })],
  },
  recordSubmission: {
    validate: () => null,
    live: (p, c) => [op('RenewalApplicationStatusSet', {
      client_id: c.clientId, case_id: c.caseId, application_status: 'submitted',
      ...(isStr(p.confirmation) && p.confirmation.trim() ? { state_case_number: p.confirmation.trim() } : {}),
      ...(isStr(p.note) && p.note.trim() ? { submission_note: p.note.trim() } : {}),
    })],
  },
  followUp: {
    validate: (p) => (p.decision == null || p.decision === 'approved' || p.decision === 'denied' ? null : bad('Unknown decision.')),
    live: (p, c) => {
      const out = [];
      for (const [k, a] of Object.entries(FOLLOW_UP_ACTIVITIES)) {
        if (p.checks && p.checks[k] === true) out.push(op('RenewalPaneProcessActivitySet', { client_id: c.clientId, case_id: c.caseId, ...a, status: 'completed' }));
      }
      if (p.decision) out.push(op('RenewalApplicationStatusSet', { client_id: c.clientId, case_id: c.caseId, application_status: p.decision }));
      if (isStr(p.note) && p.note.trim()) out.push(op('RenewalPaneCaseNoteAdd', { client_id: c.clientId, case_id: c.caseId, note: p.note.trim() }));
      return out;
    },
  },
  memberId: {
    validate: (p) => (isStr(p.value) && MEMBER_ID_PATTERN.test(p.value) ? null : bad('Enter the letter A followed by eight digits.')),
    gap: 'correct member ID (the flagged ID is the Medicaid record, not athena coverage)',
  },
  send: {
    validate: (p) => (['email', 'sms', 'portal'].includes(p.channel) && isStr(p.message) && p.message.trim() ? null : bad('Write a message.')),
    live: (p, c) => (p.channel === 'portal' ? null : [op('RenewalOutreachSend', {
      client_id: c.clientId, case_id: c.caseId, channel: p.channel,
      ...(p.channel === 'email' ? { subject: isStr(p.subject) ? p.subject : '', message: p.message } : { sms_message: p.message }),
    })]),
    gapFor: (p) => (p.channel === 'portal' ? 'send message, portal channel (send takes email / sms / letter)' : null),
  },
  checkDemographics: { needsCase: false, validate: () => null, gap: 'check demographics (person and address inputs not readable)' },
  checkEligibility: { needsCase: false, validate: () => null, gap: 'check eligibility (result fields not mapped)' },
  replaceInsurance: {
    needsCase: false,
    validate: (p) => (isStr(p.payer) && p.payer.trim() && isStr(p.effectiveDate) && /^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate) ? null : bad('Enter the payer and the effective date.')),
    gap: 'replace insurance (creating coverage needs athena package id)',
  },
};

/**
 * Run one action for a LIVE patient. Returns `{ ok: true, writes }` or
 * `{ ok: false, error: { code, message } }`. Writes run in order and stop at
 * the first failure; `writes` / `error.completedWrites` say how many landed,
 * so the tab can be honest about a partial save.
 */
export async function runLiveAction({ action, payload, env, tokenProvider, query = hasuraQuery }) {
  const def = ACTIONS[action];
  if (!def) return { ok: false, error: { code: 'unknown_action', message: 'Unknown action.' } };
  const invalid = def.validate(payload || {});
  if (invalid) return { ok: false, ...invalid };
  const gap = def.gap || (def.gapFor && def.gapFor(payload || {}));
  if (gap || !def.live) return { ok: false, error: { code: 'not_available', message: 'No platform write for this action yet.', gap: gap || action } };

  if (!/^[0-9]+$/.test(String(env.clientId || '')) || !/^[0-9]+$/.test(String(env.patientId || '')) || !tokenProvider.enabled()) {
    return { ok: false, error: { code: 'not_configured', message: 'Live Medicaid data is not connected.' } };
  }
  const token = await tokenProvider.getIdToken();
  if (!token.ok) return { ok: false, error: { code: token.error.code, message: token.error.message } };
  const common = { hasuraOrigin: env.hasuraOrigin, idToken: token.idToken };
  const clientId = Number(env.clientId);

  let caseId = null;
  if (def.needsCase !== false) {
    const wf = await query({ ...common, operationName: 'MedicaidPatientWorkfile', query: MEDICAID_PATIENT_WORKFILE_QUERY, variables: { clientId, patientId: env.patientId } });
    if (!wf.ok) return { ok: false, error: { code: wf.error.code, message: wf.error.message } };
    const row = (wf.data.app_medicaid_workfile || [])[0];
    if (!row) return { ok: false, error: { code: 'no_case', message: 'This patient has no case.' } };
    caseId = String(row.id);
  }

  let writes;
  try {
    writes = def.live(payload || {}, { clientId, caseId }) || [];
  } catch (err) {
    return { ok: false, error: { code: err.code || 'invalid_input', message: err.message } };
  }
  if (!writes.length) return { ok: false, error: { code: 'invalid_input', message: 'Nothing to save.' } };

  let done = 0;
  for (const w of writes) {
    const res = await query({ ...common, operationName: w.operationName, query: w.query, variables: w.variables });
    const result = res.ok ? res.data[w.resultField] : null;
    if (!res.ok || !result || result.success !== true) {
      const e = res.ok ? { code: 'action_failed', message: `${w.resultField} reported failure.` } : res.error;
      return { ok: false, error: { code: e.code, message: e.message, completedWrites: done, totalWrites: writes.length } };
    }
    done += 1;
  }
  return { ok: true, writes: done };
}

/** Validate only (sample patients): same rules, nothing sent anywhere. */
export function validateAction(action, payload) {
  const def = ACTIONS[action];
  if (!def) return { code: 'unknown_action', message: 'Unknown action.' };
  const invalid = def.validate(payload || {});
  return invalid ? invalid.error : null;
}
