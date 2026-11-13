// Normalizers that map athenahealth API payloads into the compact shapes the
// embed Claim Verification UI consumes.
//
// athenahealth's classic claim object varies by claim type and API version, so
// every field is read defensively from its common aliases and left null/empty
// when truly absent. Nothing is invented — a field the payload does not carry
// surfaces honestly in the UI ("—" / "Rate not available" / "unavailable").

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v != null && v !== '') return v;
  }
  return null;
}

function toMoneyString(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// athenahealth claim statuses that mean the claim has already left the practice
// (or is otherwise not in a state a user can submit). Used only to derive a
// best-effort UI hint; the authoritative gate is the server-side eligibility +
// submission call, which surfaces athena's own rejection reason.
const NON_SUBMITTABLE_STATUS_RE =
  /(submit|billed|drop|closed|denied|paid|transferred|void|delete)/i;

// Build a best-effort submittability hint from the claim status. This is only a
// UI affordance — the real decision is made by athenahealth when the user hits
// Submit (see POST /api/claims/:id/submit), which returns athena's own reason.
function deriveSubmittability(status) {
  const s = status == null ? '' : String(status).trim();
  if (!s) return { eligibleForSubmission: true, ineligibleReason: '' };
  if (NON_SUBMITTABLE_STATUS_RE.test(s)) {
    return {
      eligibleForSubmission: false,
      ineligibleReason:
        'athenahealth reports this claim as "' +
        s +
        '". Submission is only available while the claim is open in athenahealth.',
    };
  }
  return { eligibleForSubmission: true, ineligibleReason: '' };
}

// Normalize a single athenahealth claim into:
//   { id, dos, cpt[], total, status, diagnosis[], billingProvider,
//     eligibleForSubmission, ineligibleReason }
export function normalizeAthenaClaim(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const procedures = asArray(raw.procedures);

  const cpt = procedures
    .map((pr) => firstDefined(pr.procedurecode, pr.proccode, pr.cpt, pr.code))
    .filter(Boolean)
    .map(String);

  // Diagnoses can live at the claim level or per-procedure, as objects or bare
  // code strings — collect uniquely from every shape we have seen.
  const diagnoses = [];
  const seenDiag = new Set();
  function addDiag(value) {
    const code = typeof value === 'object' && value != null
      ? firstDefined(value.diagnosiscode, value.icd10code, value.icdcode, value.code)
      : value;
    if (code && typeof code === 'string' && !seenDiag.has(code)) {
      seenDiag.add(code);
      diagnoses.push(code);
    }
  }
  asArray(raw.diagnoses).forEach(addDiag);
  procedures.forEach((pr) => {
    asArray(pr.diagnoses).forEach(addDiag);
    asArray(pr.diagnosiscodes).forEach(addDiag);
  });

  // Total charge: prefer a claim-level total, else sum per-procedure charges.
  let total = firstDefined(raw.totalcharge, raw.billedamount, raw.totalbilled);
  if (total == null && procedures.length) {
    const sum = procedures.reduce(
      (acc, pr) => acc + (Number(firstDefined(pr.chargeamount, pr.charge, pr.billedamount)) || 0),
      0,
    );
    if (sum > 0) total = sum;
  }
  const totalStr = total == null ? null : toMoneyString(total) || String(total);

  const dos = firstDefined(
    raw.servicedate,
    raw.serviceenddate,
    raw.claimservicedate,
    procedures[0] && firstDefined(procedures[0].servicedate, procedures[0].serviceenddate),
  );

  const status = firstDefined(raw.claimstatus, raw.status, raw.claimstatustext) || 'Unknown';
  const billingProvider = firstDefined(
    raw.billingprovidername,
    raw.renderingprovidername,
    raw.billingprovider,
    raw.renderingprovider,
  );

  const submit = deriveSubmittability(status);

  return {
    id: String(firstDefined(raw.claimid, raw.id, raw.claimnumber) || ''),
    dos: dos ? String(dos) : null,
    cpt,
    total: totalStr,
    status: String(status),
    diagnosis: diagnoses,
    billingProvider: billingProvider ? String(billingProvider) : null,
    eligibleForSubmission: submit.eligibleForSubmission,
    ineligibleReason: submit.ineligibleReason,
  };
}

// athenahealth /claims returns either a bare array or a paged envelope
// ({ claims: [...] } / { totalcount, claims }). Accept both, normalize each.
export function normalizeAthenaClaims(payload) {
  const list = Array.isArray(payload)
    ? payload
    : asArray(payload && (payload.claims || payload.data || payload.results));
  return list.map(normalizeAthenaClaim).filter((c) => c && c.id);
}

// Coerce an athenahealth copay value (string like "$30.00", "3000" cents, or a
// number of dollars) into dollars. Returns null when it cannot be determined.
function parseCopayDollars(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim();
  const cleaned = str.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // athenahealth frequently reports copays in cents on some endpoints; only
  // treat a value as cents when it is an integer with no decimal point AND is
  // large enough that dollars would be implausible for an office-visit copay.
  if (!str.includes('.') && Number.isInteger(n) && n >= 1000) return n / 100;
  return n;
}

// --- Patient profile normalizers ---------------------------------------------
// Map athenahealth's classic patient + insurances payloads into the nested
// shape the embed profile UI consumes. Like the claim normalizers, every field
// is read defensively from its common aliases and left null / [] when truly
// absent — nothing is invented. The UI shows "—" / "None on file" for the
// honest gaps rather than mock placeholders.

// athenahealth returns a single-element array for GET /patients/{id}; accept an
// array, a paged envelope, or a bare object.
function pickPatientRecord(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.patients)) return payload.patients[0] || null;
    return payload;
  }
  return null;
}

// Parse an athenahealth date (commonly MM/DD/YYYY, sometimes ISO) into a
// { iso, age } pair. Returns nulls when the value cannot be understood.
function parseDob(value) {
  if (value == null || value === '') return { iso: null, age: null };
  const str = String(value).trim();
  let year;
  let month;
  let day;
  let mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    month = Number(mdy[1]);
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  } else {
    const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    }
  }
  if (!year || !month || !day) return { iso: null, age: null };
  const isoStr =
    String(year).padStart(4, '0') +
    '-' +
    String(month).padStart(2, '0') +
    '-' +
    String(day).padStart(2, '0');
  const now = new Date();
  let age = now.getFullYear() - year;
  const beforeBirthday =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day);
  if (beforeBirthday) age -= 1;
  if (!Number.isFinite(age) || age < 0 || age > 150) age = null;
  return { iso: isoStr, age };
}

// Map athenahealth's single-letter sex code to a display label, passing through
// any value that is not a known code.
function normalizeSex(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  const upper = str.toUpperCase();
  if (upper === 'F') return 'Female';
  if (upper === 'M') return 'Male';
  return str;
}

// Build "OT"-style initials from first/last names. Returns null when neither is
// available so the UI does not render an empty avatar.
function buildInitials(first, last) {
  const a = first ? String(first).trim().charAt(0) : '';
  const b = last ? String(last).trim().charAt(0) : '';
  const initials = (a + b).toUpperCase();
  return initials || null;
}

// Extract the last four SSN digits from athenahealth's (often masked) ssn field.
function extractSsnLast4(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

// Normalize a single athenahealth insurance record into the compact shape the
// insurance card consumes. Unknown fields are left null.
function normalizeInsuranceRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const payer = firstDefined(
    raw.insurancecompanyname,
    raw.ircname,
    raw.insuranceplanname,
    raw.insurancename,
  );
  const planName = firstDefined(
    raw.insuranceplandisplayname,
    raw.insuranceplanname,
    raw.insurancepackagename,
  );
  const memberId = firstDefined(raw.insuranceidnumber, raw.policynumber, raw.memberid);
  const groupNumber = firstDefined(
    raw.insurancepolicyholdergroupnumber,
    raw.policygroupnumber,
    raw.insurancegroupnumber,
    raw.groupnumber,
  );
  const relationship = firstDefined(
    raw.relationshiptoinsuredcategory,
    raw.relationshiptoinsured,
    raw.insurancepolicyholderrelationship,
  );
  const effectiveDate = firstDefined(raw.eligibilityfromdate, raw.effectivedate, raw.issuedate);
  const status = firstDefined(raw.eligibilitystatus, raw.insurancestatus);
  // NOTE (2026-08-15, Craig): insurancepackageid / insuranceid are deliberately
  // NOT mapped. Both are athena→Orion concerns the app never uses — the write
  // lane targets a policy via Orion's coverage_id (athena's insuranceid,
  // resolved server-side from the Orion coverage read), and the package id is
  // only needed on a CREATE, which the app cannot express. A short-lived
  // mapping of both existed 2026-08-14/15 and was reverted.
  return {
    payer: payer ? String(payer) : null,
    planName: planName ? String(planName) : null,
    memberId: memberId ? String(memberId) : null,
    groupNumber: groupNumber ? String(groupNumber) : null,
    relationship: relationship ? String(relationship) : null,
    effectiveDate: effectiveDate ? String(effectiveDate) : null,
    status: status ? String(status) : null,
  };
}

// Split an athenahealth insurances payload into { primary, secondary } using
// insurancetype / sequencenumber, falling back to list order. Either side may be
// null when the patient has no matching coverage on file.
export function normalizeInsurances(payload) {
  const list = Array.isArray(payload)
    ? payload
    : asArray(payload && (payload.insurances || payload.data));
  const active = list.filter((r) => r && typeof r === 'object');
  if (!active.length) return { primary: null, secondary: null };

  const bySeq = (n) =>
    active.find(
      (r) =>
        String(r.sequencenumber) === String(n) ||
        new RegExp(n === 1 ? 'primary' : 'secondary', 'i').test(String(r.insurancetype || '')),
    );
  const primaryRaw = bySeq(1) || active[0];
  const secondaryRaw = bySeq(2) || active.find((r) => r !== primaryRaw) || null;

  return {
    primary: normalizeInsuranceRecord(primaryRaw),
    secondary: secondaryRaw ? normalizeInsuranceRecord(secondaryRaw) : null,
  };
}

// Normalize athenahealth patient + insurances payloads into the full nested
// profile shape the embed UI renders. The skeleton is always complete (name /
// contact / address / insurance objects always present) so the renderer never
// dereferences undefined; clinical sections athenahealth does not expose here
// (allergies, medications, problems, vitals, care team, alerts, balance,
// encounter) are returned empty/null and surface honestly as "None on file".
export function normalizeAthenaPatient(patientPayload, insurancesPayload, ctx = {}) {
  const raw = pickPatientRecord(patientPayload) || {};
  const first = firstDefined(raw.firstname, raw.preferredname);
  const middle = firstDefined(raw.middlename, raw.middleinitial);
  const last = firstDefined(raw.lastname);
  const fullParts = [first, last].filter(Boolean).map(String);
  const full = fullParts.join(' ') || null;
  const { iso: dateOfBirth, age } = parseDob(firstDefined(raw.dob, raw.dateofbirth));

  const status = firstDefined(raw.status, raw.patientstatus);

  const emergencyName = firstDefined(raw.contactname, raw.emergencycontactname);
  const emergencyRelationship = firstDefined(
    raw.contactrelationship,
    raw.emergencycontactrelationship,
  );
  const emergencyPhone = firstDefined(
    raw.contactmobilephone,
    raw.contacthomephone,
    raw.emergencycontactmobilephone,
    raw.emergencycontacthomephone,
  );
  const emergencyContact =
    emergencyName || emergencyPhone
      ? {
          name: emergencyName ? String(emergencyName) : null,
          relationship: emergencyRelationship ? String(emergencyRelationship) : null,
          phone: emergencyPhone ? String(emergencyPhone) : null,
        }
      : null;

  const insurance = normalizeInsurances(insurancesPayload);

  return {
    id: String(firstDefined(raw.patientid, ctx.patientId) || ''),
    mrn: firstDefined(raw.patientid, ctx.patientId) ? String(firstDefined(raw.patientid, ctx.patientId)) : null,
    status: status ? String(status) : null,
    name: {
      first: first ? String(first) : null,
      middle: middle ? String(middle) : null,
      last: last ? String(last) : null,
      full,
      preferred: firstDefined(raw.preferredname) ? String(raw.preferredname) : null,
    },
    initials: buildInitials(first, last),
    dateOfBirth,
    age,
    sex: normalizeSex(firstDefined(raw.sex, raw.gender)),
    genderIdentity: firstDefined(raw.genderidentity, raw.assignedsexatbirth)
      ? String(firstDefined(raw.genderidentity, raw.assignedsexatbirth))
      : null,
    pronouns: firstDefined(raw.pronouns) ? String(raw.pronouns) : null,
    maritalStatus: firstDefined(raw.maritalstatus) ? String(raw.maritalstatus) : null,
    preferredLanguage: firstDefined(raw.language, raw.languagename, raw.language6392code)
      ? String(firstDefined(raw.language, raw.languagename, raw.language6392code))
      : null,
    race: firstDefined(raw.racename, Array.isArray(raw.race) ? raw.race[0] : raw.race)
      ? String(firstDefined(raw.racename, Array.isArray(raw.race) ? raw.race[0] : raw.race))
      : null,
    ethnicity: firstDefined(raw.ethnicityname, raw.ethnicity, raw.ethnicitycode)
      ? String(firstDefined(raw.ethnicityname, raw.ethnicity, raw.ethnicitycode))
      : null,
    ssnLast4: extractSsnLast4(raw.ssn),
    // Employer ADDED 2026-08-19 (Craig's field-set review): athena's patient
    // GET carries employername when the practice has it on file; honest null
    // otherwise. Display + discovery input only — no write lane.
    employer: firstDefined(raw.employername) ? { name: String(raw.employername) } : null,
    contact: {
      mobilePhone: firstDefined(raw.mobilephone) ? String(raw.mobilephone) : null,
      homePhone: firstDefined(raw.homephone) ? String(raw.homephone) : null,
      email: firstDefined(raw.email) ? String(raw.email) : null,
      preferredMethod: firstDefined(raw.contactpreference, raw.contactpreference_announcement_phone)
        ? String(firstDefined(raw.contactpreference, raw.contactpreference_announcement_phone))
        : null,
      preferredContactTime: null,
    },
    address: {
      line1: firstDefined(raw.address1) ? String(raw.address1) : null,
      line2: firstDefined(raw.address2) ? String(raw.address2) : null,
      city: firstDefined(raw.city) ? String(raw.city) : null,
      state: firstDefined(raw.state) ? String(raw.state) : null,
      postalCode: firstDefined(raw.zip, raw.zipcode) ? String(firstDefined(raw.zip, raw.zipcode)) : null,
      country: firstDefined(raw.countrycode, raw.country) ? String(firstDefined(raw.countrycode, raw.country)) : null,
    },
    emergencyContact,
    primaryCareProvider: firstDefined(raw.primaryprovidername) ? String(raw.primaryprovidername) : null,
    careTeam: [],
    encounter: null,
    insurance,
    balance: null,
    allergies: [],
    medications: [],
    problems: [],
    vitals: null,
    alerts: [],
    lastVisit: null,
    nextAppointment: null,
  };
}

// Coerce a coinsurance value into a 0..1 rate. Accepts "20", "20%", or 0.2.
function parseCoinsuranceRate(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[%\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n > 1) return n / 100;
  return n;
}

// Normalize an athenahealth benefit/insurance payload into the patient's
// office-visit cost-share design: { copay, coinsuranceRate, planType }. Any
// field that cannot be determined is left null so the UI can say so honestly.
export function normalizeBenefits(payload) {
  const out = { copay: null, coinsuranceRate: null, planType: null };
  if (!payload || typeof payload !== 'object') return out;

  // The insurances endpoint returns an array; eligibility may return one object.
  const records = Array.isArray(payload)
    ? payload
    : asArray(payload.insurances || payload.benefits || payload.data);
  const primary =
    records.find((r) => r && (r.insuranceidnumber || r.sequencenumber === 1 || /primary/i.test(String(r.insurancetype || '')))) ||
    records[0] ||
    payload;

  if (!primary || typeof primary !== 'object') return out;

  out.planType = firstDefined(
    primary.plantype,
    primary.insuranceplantype,
    primary.policytype,
    primary.producttype,
  );
  out.planType = out.planType ? String(out.planType) : null;

  out.copay = parseCopayDollars(
    firstDefined(primary.copay, primary.officevisitcopay, primary.specialistcopay, primary.copayamount),
  );
  out.coinsuranceRate = parseCoinsuranceRate(
    firstDefined(primary.coinsurance, primary.coinsurancepercent, primary.coinsurancerate),
  );

  return out;
}
