// Orion patient-demographics lane for the athena-embed prototype.
//
// Replaces the demographic slice of the mock patient profile with live data
// from the platform's `orionPatientDemographics` Hasura Action (frhc-platform
// PR #2855, staging-proven 2026-08-04 — probes 5/6 of
// scripts/spike-hasura-connectivity.mjs). Everything the Action does not
// serve (encounter, insurance, meds, problems, vitals, care team, alerts)
// stays mock and stays labeled mock by the caller.
//
// TRANSPORT NOTE (DR-1, 2026-07-29): this rides the STAFF Cognito plane — a
// staff id_token supplied via env, exactly like the connectivity spike. The
// embed's production data path is M2M (Ingress-2 HMAC envelope + signed
// launch-context assertion); this wiring is transport-chain evidence for the
// read contract, not the embed auth plane.

import { randomUUID } from 'node:crypto';

// MUST match the allow-listed text in frhc-platform
// applications/hasura/metadata/query_collections.yaml EXACTLY (merged
// 2026-08-04, 633515f0e / PR #2855). Hasura's allow-list matches on query
// TEXT before auth, so any drift is rejected as "query is not allowed" —
// indistinguishable from a missing entry. Variable is $patient_id.
export const ORION_PATIENT_DEMOGRAPHICS_MUTATION = `mutation OrionPatientDemographics ($patient_id: String!) {
  orionPatientDemographics(patient_id: $patient_id) {
    success
    data
    error
  }
}
`;

// MUST match the allow-listed text in frhc-platform
// applications/hasura/metadata/query_collections.yaml EXACTLY (merged
// 2026-08-05, 6273eef09 / PR #2929). NOTE the space before `($input` — the
// merged entry has it, Linnea's chat snippet did not, and allow-list matching
// is on query TEXT, so the snippet's shape would be rejected.
export const ORION_PATIENT_DEMOGRAPHICS_UPDATE_MUTATION = `mutation OrionPatientDemographicsUpdate ($input: OrionDemographicsUpdateInput!) {
  orionPatientDemographicsUpdate(input: $input) {
    success
    data
    error
  }
}
`;

// Shared Hasura Action caller. Normalizes BOTH failure shapes the platform
// produces (decision 12, API contract 2026-07-31):
//   - top-level errors[] with extensions.code (action-handler raised an HTTP
//     error; e.g. orion_patient_not_found, orion_unavailable)
//   - in-payload { success: false, error } (reserved by the Action type)
// Returns { ok: true, data } or { ok: false, error: { code, message } } —
// never throws for upstream conditions; only programmer errors escape.
// Every shape also carries `requestId`: the x-request-id that went over the
// wire (caller-supplied or generated here). Hasura masks any 5xx from the
// action-handler as an opaque "internal error" (message, code and the
// handler's own correlation id are all discarded), so this id is the ONLY
// handle a caller can give the platform team to find the failing call in
// Hasura/action-handler CloudWatch logs. Callers surface it; never drop it.
// Exported for the sibling Orion lanes (lib/orion-coverage.js) — ONE caller,
// never a second copy of the failure-shape normalization.
export async function callOrionAction({
  hasuraOrigin,
  idToken,
  operationName,
  query,
  variables,
  resultField,
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
        // Hasura adopts x-request-id as its CloudWatch request_id
        // (hasura-correlation-contract.md) — keeps every call traceable.
        'x-request-id': requestId,
      },
      body: JSON.stringify({ operationName, variables, query }),
    });
  } catch (err) {
    return {
      ok: false,
      requestId,
      error: {
        code: 'transport_error',
        message: `Could not reach Hasura at ${endpoint}: ${err && err.message ? err.message : err}`,
      },
    };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      requestId,
      error: { code: 'invalid_response', message: `Hasura returned non-JSON (HTTP ${res.status}).` },
    };
  }

  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    return {
      ok: false,
      requestId,
      error: {
        code: first?.extensions?.code || 'unexpected',
        message: first?.message || 'Hasura returned an error.',
      },
    };
  }

  const result = body?.data?.[resultField];
  if (!result) {
    return {
      ok: false,
      requestId,
      error: { code: 'invalid_response', message: `Hasura response carried no ${resultField} result (HTTP ${res.status}).` },
    };
  }
  if (result.success !== true || !result.data) {
    return {
      ok: false,
      requestId,
      error: {
        code: 'action_failed',
        message: typeof result.error === 'string' && result.error ? result.error : `${resultField} reported failure.`,
      },
    };
  }
  return { ok: true, requestId, data: result.data };
}

export async function fetchOrionPatientDemographics({ hasuraOrigin, idToken, patientId, fetchImpl, requestId }) {
  return callOrionAction({
    hasuraOrigin,
    idToken,
    operationName: 'OrionPatientDemographics',
    query: ORION_PATIENT_DEMOGRAPHICS_MUTATION,
    variables: { patient_id: String(patientId) },
    resultField: 'orionPatientDemographics',
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

// PARTIAL-update semantics (PR #2929, load-bearing): athena's PUT is a partial
// update — an ABSENT field is left alone, an explicit null means "clear" and
// Orion currently REJECTS clears with 422. Callers must therefore send ONLY
// the fields being changed, never a full record and never nulls. `input` is
// forwarded verbatim; the server route owns field whitelisting.
export async function fetchOrionPatientDemographicsUpdate({ hasuraOrigin, idToken, input, fetchImpl, requestId }) {
  return callOrionAction({
    hasuraOrigin,
    idToken,
    operationName: 'OrionPatientDemographicsUpdate',
    query: ORION_PATIENT_DEMOGRAPHICS_UPDATE_MUTATION,
    variables: { input },
    resultField: 'orionPatientDemographicsUpdate',
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function composeName(parts) {
  if (!parts) return null;
  const first = str(parts.first_name);
  const last = str(parts.last_name);
  const full = [first, str(parts.middle_name), last].filter(Boolean).join(' ');
  return full || null;
}

function ageFromDob(dob, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

// Maps the Orion demographics projection onto the demographic slice of the
// profile shape renderProfile() consumes. Honest nulls throughout: a field
// the projection doesn't carry (or carries empty) maps to null — the client
// renders '—'. Nothing is invented: no pronouns, no preferred contact time,
// no MRN (the projection has none), no phone pretty-printing.
export function mapOrionDemographics(data, { now } = {}) {
  const name = data?.name || {};
  const first = str(name.first_name);
  const last = str(name.last_name);
  const dob = str(data?.date_of_birth);
  const address = data?.address || null;
  const contact = data?.contact || null;
  const ec = data?.emergency_contact || null;
  return {
    id: str(data?.patient_id),
    mrn: null,
    status: null,
    name: {
      first,
      middle: str(name.middle_name),
      last,
      full: composeName(name),
      preferred: str(data?.preferred_name?.first_name),
    },
    initials: [first, last].filter(Boolean).map((s) => s[0].toUpperCase()).join('') || null,
    dateOfBirth: dob,
    age: ageFromDob(dob, now),
    sex: str(data?.gender),
    genderIdentity: str(data?.gender_identity),
    pronouns: null,
    maritalStatus: str(data?.marital_status),
    preferredLanguage: str(data?.language),
    race: str(data?.race),
    ethnicity: str(data?.ethnicity),
    ssnLast4: str(data?.ssn_last4),
    // Honest null: the FR-150 projection carries no employment block. The
    // Orion demand spec's 2026-08-19 addendum asks for it (athena mapper
    // ingest + projection); when it lands, map it here and the EXISTING
    // column lights up with no display change.
    employer: null,
    contact: {
      mobilePhone: str(contact?.cell_phone),
      homePhone: str(contact?.phone_number),
      email: str(contact?.email),
      preferredMethod: str(data?.preferred_contact_method),
      preferredContactTime: null,
    },
    address: address
      ? {
          line1: str(address.address_line_1),
          line2: str(address.address_line_2),
          city: str(address.city),
          state: str(address.state),
          postalCode: str(address.zip_code),
          country: null,
        }
      : null,
    emergencyContact: ec
      ? {
          name: composeName(ec.name),
          relationship: str(ec.relationship),
          phone: str(ec.phone_number) || str(ec.cell_phone),
        }
      : null,
  };
}

// NOTE: mergeOrionDemographicsIntoPatient was REMOVED 2026-08-05. It merged
// the live athena read OVER the mock profile — which put athena's values in
// the Post Data FRONTRUNNERHC column. Column semantics of record (Craig,
// 2026-08-05): the profile/FRONTRUNNERHC column carries FrontRunner's values;
// the live athena read feeds the EXISTING column via the profile envelope's
// separate `athenaDemographics` block. Don't reintroduce the merge.
