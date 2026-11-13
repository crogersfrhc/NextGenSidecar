/*
 * app.js — embedded app UI controller.
 *
 * Wires the athenaMessaging bridge to the patient profile UI:
 *   - shows a "waiting for patient context" state until a patientID arrives
 *   - fetches the (mock) FrontRunner patient profile once context is received
 *   - renders the full profile
 *   - wires demo controls to the outbound athenaOne messaging methods
 *
 * No inline script/handlers (CSP: default-src 'self' *.athenahealth.com).
 */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function ready(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  var STATES = ['state-waiting', 'state-loading', 'state-error', 'state-profile'];

  // Most recently rendered patient (source for the Post Data modal).
  var currentPatient = null;
  // Live athena demographics via Orion — feeds the EXISTING column of the
  // Post Data comparisons (column semantics of record, Craig 2026-08-05:
  // FRONTRUNNERHC = FrontRunner's values from the profile payload; EXISTING =
  // what athena currently holds). Null when the live lane is off or the read
  // failed; meta.source distinguishes 'orion' / 'simulated' / 'unavailable'.
  var currentAthenaDemographics = null;
  var currentAthenaDemographicsMeta = { source: 'simulated', error: null };
  // Coverage twin (2026-08-15, Craig: show Orion's insurance read live, like
  // the demographics): { primary, secondary } per-rank objects from the FR-152
  // read, or null. Same source triple, degraded INDEPENDENTLY of demographics
  // — one lane's failure never poses as the other's data.
  var currentAthenaCoverage = null;
  var currentAthenaCoverageMeta = { source: 'simulated', error: null };
  // 36: the separate Fee Estimations card (and its openFeeEstimationModal
  // handle + expand-state flags) is fully retired — fee estimates are no
  // longer separate from GFEs (Prod parity, Craig 2026-08-17); the GFE card
  // is the one estimate surface.

  function showState(activeId) {
    STATES.forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = id !== activeId;
    });
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value == null || value === '' ? '—' : String(value);
  }

  // Strip a leading "MRN-"/"MRN "/"MRN" prefix from a stored MRN value so it
  // isn't doubled when rendered after a literal "MRN" label/prefix.
  function bareMrn(m) {
    return String(m || '').replace(/^MRN[-\s]*/i, '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function makeList(containerId, items, renderItem) {
    var container = $(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!items || items.length === 0) {
      container.appendChild(el('li', 'empty', 'None on file'));
      return;
    }
    items.forEach(function (item) {
      container.appendChild(renderItem(item));
    });
  }

  // Identity sub-line for modal headers: name plus MRN when one exists. A null
  // MRN (live Orion demographics carry none) renders as the name alone — never
  // a literal "null".
  function identitySubLine(p) {
    return [p.name.full, p.mrn].filter(Boolean).join(' · ');
  }

  function fmtAddress(addr) {
    if (!addr) return '—';
    var parts = [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.postalCode];
    return parts.filter(Boolean).join(' · ');
  }

  // ---- 30B: per-launch session handle ----------------------------------------
  // The server's /app handoff appends &session={id} to the redirect params.
  // Boot captures it here (module state only — never persisted), then scrubs
  // it from the URL so the handle can't leak via copy/paste, bookmarks, or
  // referers. Session-guarded calls attach it as the X-Session-Id header.
  // Demo boots (?embed=athena or direct visits) carry no session — that is
  // honest: demo mode has no session-guarded needs.
  var currentSessionId = null;

  // Headers for session-guarded requests. NO fallback: when no session is held
  // the header is simply absent and the server answers 401 session_required.
  function sessionHeaders(extra) {
    var headers = extra || {};
    if (currentSessionId) headers['X-Session-Id'] = currentSessionId;
    return headers;
  }

  // Shared fetch wrapper for session-guarded endpoints (none are called from
  // this file today — /api/patient/:id is deliberately unguarded mock data —
  // but any future claim submit/update/ping call MUST go through this).
  // A 401 session_required/session_unknown response surfaces the honest
  // relaunch instruction instead of a generic failure.
  function guardedFetch(url, options) {
    var opts = options || {};
    opts.headers = sessionHeaders(opts.headers);
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (body) {
            var code = body && body.error;
            if (code === 'session_required' || code === 'session_unknown') {
              throw new Error('Session expired \u2014 relaunch the app from NextGen.');
            }
            throw new Error(body && body.message ? body.message : 'Not authenticated (HTTP 401).');
          });
      }
      return res;
    });
  }

  function fetchPatient(patientId, encounterId) {
    var url = '/api/patient/' + encodeURIComponent(patientId);
    if (encounterId) {
      url += '?encounterId=' + encodeURIComponent(encounterId);
    }
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            var msg = body && body.message ? body.message : 'Unable to load patient profile (HTTP ' + res.status + ').';
            throw new Error(msg);
          });
      }
      return res.json();
    });
  }

  // ---- Step 13: FrontRunner data refresh -------------------------------------
  // The app pulls from TWO systems via SEPARATE paths:
  //   - athena       -> launch context (patientId/encounterId/practiceId) via the
  //                     AthenaMessaging bridge. NOT a fetch; never re-pulled here.
  //   - FrontRunner  -> the patient profile via fetchPatient() -> GET /api/patient/:id
  //                     (eligibility, verification, demographics-validation, coverage).
  // After any eligibility action, re-pull ONLY the FrontRunner call and re-render
  // through the existing renderProfile() path (RTV, Insurance, Demographics,
  // readiness panel all read from it). On today's mock data the re-pull returns
  // the same values, so nothing visibly changes — the value is the MECHANISM:
  // once live FrontRunner data is connected, these triggers surface genuinely
  // updated records with no further UI work.
  //
  // Loop safety: nothing auto-runs (ST-C4 §2 retired the launch auto-run), so a
  // re-render can never fire a check by itself; every trigger below runs AFTER a
  // human-initiated eligibility action (or is the Member Eligibility lookup,
  // which never invokes runEligibilityCheck), so a refresh cannot loop.
  // UI-state safety: wireCollapsibleCards() remembers per-card collapse state, and
  // the Member Eligibility card restores its package selection + lookup result
  // from module state on re-render, so both survive a refresh.

  // Last athena launch context, stored so a refresh can re-invoke the FrontRunner
  // fetch WITHOUT re-resolving the athena context.
  var currentAthenaContext = null;
  // 28C (architect finding): the LAST context that carried a patient, kept
  // separately from currentAthenaContext. A context-clear NULLS
  // currentAthenaContext (so every in-flight fetch fails the stale-response
  // reference guard and can never render a patient after athena said none is
  // loaded) while lastNonNullAthenaContext preserves the same-patient
  // semantics: a follow-up message with the SAME id resumes that patient's
  // working state (no re-seed, no notice); a DIFFERENT id takes the full
  // switch branch.
  var lastNonNullAthenaContext = null;
  // Coalesces overlapping refreshes so rapid repeated actions stay idempotent.
  var frontRunnerRefreshInFlight = false;

  function refreshFrontRunnerData() {
    if (!currentAthenaContext || !currentAthenaContext.patientId) return;
    if (frontRunnerRefreshInFlight) return;
    frontRunnerRefreshInFlight = true;
    fetchPatient(currentAthenaContext.patientId, currentAthenaContext.encounterId)
      .then(function (payload) {
        warnOnRequestedPatientIdMismatch(payload, currentAthenaContext);
        renderProfile(payload, currentAthenaContext);
        console.log('[frontrunner] data re-pulled + cards re-rendered after eligibility action');
      })
      .catch(function (err) {
        // A failed background refresh must NOT blank the visible profile — keep
        // the current render and report the failure explicitly.
        console.error('[frontrunner] refresh failed: ' + (err && err.message ? err.message : err));
      })
      .then(function () {
        frontRunnerRefreshInFlight = false;
      });
  }

  // 30C: id-threading tripwire — when the app booted with an athena-source
  // context and the server's envelope echoes a DIFFERENT requestedPatientId
  // than the context's patientId, something between client and server dropped
  // or rewrote the id. One console.warn naming both values; no UI change.
  // Demo boots (no athena source) never warn, and an absent envelope field
  // (older server) stays silent.
  function warnOnRequestedPatientIdMismatch(payload, context) {
    if (!isAthenaSourceContext(context)) return;
    if (!payload || !payload.requestedPatientId) return;
    if (String(payload.requestedPatientId) === String(context.patientId)) return;
    console.warn(
      '[frontrunner] requestedPatientId mismatch: context patientId=' +
        context.patientId +
        ' but server echoed requestedPatientId=' +
        payload.requestedPatientId,
    );
  }

  // 28C: ONE shared source check for "this context carries a REAL athena
  // patient id" — true for both delivery paths: 'athena' (28B url-launch,
  // threaded from the /app redirect params) and 'athena-message' (28C, the
  // documented patientContextChanged message normalized by the bridge).
  // Demo/standalone contexts have no source flag and stay false.
  function isAthenaSourceContext(context) {
    var src = context && context.raw && context.raw.source;
    return src === 'athena' || src === 'athena-message';
  }

  function renderProfile(payload, context) {
    var p = payload.patient;
    currentPatient = p;
    currentAthenaDemographics = payload.athenaDemographics || null;
    currentAthenaDemographicsMeta = {
      source: payload.athenaDemographicsSource || 'simulated',
      error: payload.athenaDemographicsError || null,
    };
    currentAthenaCoverage = payload.athenaCoverage || null;
    currentAthenaCoverageMeta = {
      source: payload.athenaCoverageSource || 'simulated',
      error: payload.athenaCoverageError || null,
    };

    // Identity header.
    // 28B: when the context came from the server's SMART-launch handoff
    // (context.raw.source === 'athena', threaded through the URL boot path),
    // the REAL athena patient id is the prominent identity — ID-only this
    // phase (no FHIR Patient read, no name). Since 2026-10-26 (Craig) the
    // header shows the patient id only: no "· Encounter #" suffix and no
    // data-source pill. Demo/standalone contexts (no source flag) render
    // exactly as before.
    // NextGen: header always shows the patient's name (NextGen launch gives
    // personId + encounterId; the name comes from the FrontRunner patient).
    setText('p-name', p.name.full);
    setText('p-enterprise', (p.nextgen && p.nextgen.enterprise) || '\u2014');
    setText('p-practice', (p.nextgen && p.nextgen.practice) || '\u2014');
    setText('p-encounter', (context && context.encounterId) || (p.nextgen && p.nextgen.encounterId) || '\u2014');
    setText('p-mrn', bareMrn(p.mrn));
    setText('p-status', p.status);
    // The header's profile-source pill ("Mock profile: …", later "Live
    // demographics (Orion): … · clinical cards mock") was REMOVED (Craig,
    // 2026-10-26 and 2026-10-28): the header carries no data-source label.

    // Demographics
    // Gender identity / Preferred language / Preferred contact method rows
    // REMOVED 2026-08-19 (Craig's demographics field-set review): no insurance-
    // discovery or eligibility role. Marital status / Race / Ethnicity ruled
    // KEEP for now, same review.
    setText('d-preferred', p.name.preferred);
    setText('d-marital', p.maritalStatus);
    setText('d-race', p.race);
    setText('d-ethnicity', p.ethnicity);
    setText('d-ssn', p.ssnLast4 ? '•••-••-' + p.ssnLast4 : '—');
    setText('d-employer', p.employer && p.employer.name);

    // Contact
    setText('c-mobile', p.contact.mobilePhone);
    setText('c-home', p.contact.homePhone);
    setText('c-email', p.contact.email);
    setText('c-address', fmtAddress(p.address));
    // Orion's projection can carry null relationship/phone — render only the
    // parts that exist rather than a literal "(null)".
    setText(
      'c-emergency',
      p.emergencyContact
        ? [
            p.emergencyContact.name,
            p.emergencyContact.relationship ? '(' + p.emergencyContact.relationship + ')' : null,
            p.emergencyContact.phone ? '· ' + p.emergencyContact.phone : null,
          ]
            .filter(Boolean)
            .join(' ')
        : '—',
    );

    // Insurance — Step 19: rendered as the richer Clearline layout from the
    // payload + INSURANCE_CARD_ENRICHMENT (replaces the old static kv fill).
    renderInsuranceCard(p);

    // Vitals
    var v = p.vitals || {};
    setText('v-bp', v.bloodPressure);
    setText('v-hr', v.heartRate);
    setText('v-temp', v.temperatureF != null ? v.temperatureF + ' °F' : '—');
    setText('v-resp', v.respiratoryRate);
    setText('v-spo2', v.oxygenSaturation);
    setText('v-bmi', v.bmi);
    setText('v-weight', v.weightLbs != null ? v.weightLbs + ' lbs' : '—');
    setText('v-recorded', v.recordedOn);

    // Allergies
    makeList('list-allergies', p.allergies, function (a) {
      var li = el('li', 'pill-row');
      li.appendChild(el('span', 'pill pill-danger', a.severity));
      li.appendChild(el('span', 'pill-main', a.substance));
      li.appendChild(el('span', 'pill-sub', a.reaction));
      return li;
    });

    // Medications
    makeList('list-medications', p.medications, function (m) {
      var li = el('li', 'pill-row');
      li.appendChild(el('span', 'pill-main', m.name + ' ' + m.dose));
      li.appendChild(el('span', 'pill-sub', m.frequency));
      return li;
    });

    // Problems
    makeList('list-problems', p.problems, function (pr) {
      var li = el('li', 'pill-row');
      li.appendChild(el('span', 'pill-main', pr.description));
      li.appendChild(el('span', 'pill-sub', pr.code + ' · since ' + pr.since));
      return li;
    });

    // Care team
    makeList('list-careteam', p.careTeam, function (ct) {
      var li = el('li', 'pill-row');
      li.appendChild(el('span', 'pill-main', ct.name));
      li.appendChild(el('span', 'pill-sub', ct.role));
      return li;
    });

    // Alerts
    makeList('list-alerts', p.alerts, function (al) {
      var li = el('li', 'alert-row');
      li.appendChild(el('span', 'pill pill-amber', al.type));
      li.appendChild(el('span', 'alert-msg', al.message));
      return li;
    });

    // Real-Time Verification (live checks launcher; sits after MRF Data
    // Explorer).
    renderRealTimeVerificationCard(p);

    // Financial Clearance (handoff 2026-10-30) — status card that expands to
    // Run Financial Clearance + read-only Income & Household. Fetches once per
    // patient; mounts before wireCollapsibleCards() so it collapses too.
    // NextGen: removed — renderFinancialClearanceCard(p, context);

    // Member Eligibility (Step 12A) — input-driven TPA member-benefits lookup on
    // the Pre Check-In tab; not patient-scoped. Mounts into the same grid before
    // wireCollapsibleCards() runs, so it collapses like the others.
    // NextGen: removed — renderMemberEligibilityCard();

    // Appointments (Step 25B) — the Appointment tab's primary surface (replaces
    // the encounter banner); mounts FIRST in that tab's grid, before the GFE card.
    // NextGen: removed — renderAppointmentsCard(p);

    // Good Faith Estimates (No Surprises Act; sits after Real-Time
    // Verification — the one estimate surface, see the Step-36 note above).
    renderGoodFaithEstimatesCard(p);

    // Rate Search (MRF-SIDECAR, D-105) — the MRF launcher card on the Clearline
    // tab. Mounts before wireCollapsibleCards() runs, so it collapses like the others.
    // NextGen: removed — renderMrfRateSearchCard(p);

    // Claim Validation (Step 24D1) — second Clearline card, after MRF.
    // NextGen: removed — renderClaimValidationCard(p);

    // Medicaid Renewal tab — one modal for the open patient. Fetches once per
    // patient (a same-patient re-render repaints from its own state).
    renderMedicaidRenewalTab(p, context);

    // Patient Readiness panel (Step 10B) — consumes buildReadiness() and replaces
    // the old attention chip strip. Sits above the cards on Pre Check-In.
    renderReadinessPanel(p);

    // ⚠ **LAUNCH AUTO-RUN RETIRED 2026-08-12** (ST-C4 §2, approved Craig
    // 2026-08-05; supersedes R-16/R-17 and the R-22 billed-usage posture).
    // This block previously read: "on launch, auto-run eligibility when the last
    // verification is stale (>30 ROLLING days) … R-22: this auto-check counts
    // toward billed usage by design (no suppression)", and fired
    // `runEligibilityCheck({ auto: true, services: ['eligibility'] })` behind a
    // `!rtvHasRun` guard.
    //
    // NOTHING AUTO-RUNS ANY MORE (A-C1, James + Craig 2026-08-04; trigger table
    // of record ST-D1 §6). Every run is a human gesture. At launch, staleness
    // now produces a RECOMMENDATION row in the readiness header — zero check
    // calls, zero usage events. `ELIGIBILITY_AUTO_RUN_DAYS` survives ONLY as the
    // recommendation threshold (see buildReadinessRecommendations).
    //
    // Do not reinstate an auto-fire here. The reason is billing, not taste: an
    // automatic metered check bills the client for a run no human asked for.
    //
    // 2026-08-14 (audit GAP-3 cleanup, approved Craig): the retirement's dead
    // remnants removed — `eligibilityAutoChecked` (write-only since 2026-08-12),
    // the `opts.auto` option (constant false at every call site), the History
    // rows' `auto` flag, and the " (auto)" suffix rendering (unreachable: no
    // seed row carries the flag and no runtime row could set it).

    // Step 8: collapse every card via the ONE shared, idempotent helper — runs
    // AFTER the JS cards (RTV/GFE) have mounted and after the static cards got
    // their status dots. Default state is collapsed; per-card state is remembered.
    wireCollapsibleCards();

    showState('state-profile');
  }

  // ---- Patient Readiness panel + shared card helpers -------------------------
  // Step 10B replaced the old "Attention Required" chip strip with the Patient
  // Readiness panel (renderReadinessPanel, below). Two helpers from the old strip
  // are intentionally RETAINED because they're shared:
  //   - attnAlertLabel : also used by buildReadiness() (10A) to title care-gap rows.
  //   - attnFlashCard  : kept for 10C, which will reuse it for issue actions that
  //                      point at a card (scroll-to + amber flash). Temporarily
  //                      unused after the strip's removal — do NOT delete (verify-
  //                      before-delete: it is referenced by the upcoming 10C wiring).
  // All dynamic styling stays CSP-safe (className against styles.css tokens / css()
  // CSSOM — inline <style>/style="" are blocked by the embed CSP).
  //
  // Derive a short label from a full alert message, e.g.
  // "HbA1c due — last result 7.4% on 2025-12-01" -> "HbA1c Due"
  // "Annual eye exam recommended for diabetic retinopathy screening"
  //   -> "Annual Eye Exam Recommended"
  // Title-cases only all-lowercase words so tokens like "HbA1c" are preserved.
  function attnAlertLabel(message) {
    var s = String(message || '').trim();
    if (!s) return '';
    var cut = s.split(' — ')[0];
    if (cut === s) {
      var fi = s.indexOf(' for ');
      if (fi > 0) cut = s.slice(0, fi);
    }
    return cut
      .trim()
      .split(/\s+/)
      .map(function (w) {
        return /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
      })
      .join(' ');
  }

  // Scroll a target card into view and briefly ring it in amber, then revert.
  function attnFlashCard(id) {
    var card = $(id);
    if (!card) return;
    // Step 8: if the target is a collapsed collapsible card, expand it first so
    // the flashed content is actually visible (not just a collapsed header).
    if (card.classList.contains('is-collapsible') && card.classList.contains('is-collapsed')) {
      setCardCollapsed(card, false);
    }
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      card.scrollIntoView();
    }
    css(card, {
      transition: 'box-shadow 0.25s ease, border-color 0.25s ease',
      boxShadow: '0 0 0 3px hsl(45 93% 58% / 0.85)',
      borderColor: 'hsl(26 90% 45%)',
    });
    window.setTimeout(function () {
      css(card, { boxShadow: '', borderColor: '' });
    }, 1500);
  }

  // R-18 resolve: demographics confirmed current. This is the SINGLE complete
  // resolution operation — called from BOTH the Demographics Review modal's
  // "Confirm Demographics Current" header action AND its footer Submit (the real
  // review flow), so completing demographics any way produces identical state.
  // It keeps the two demographics signals in sync (R-23 — no dual source of truth):
  // the verified DATE and the RTV per-service STATUS, so the readiness panel and
  // the RTV card never disagree.
  //   - Stamp RTV_LAST_RUN.demographics to today: clears the medium "re-verify"
  //     issue buildReadiness() derives from daysSince(RTV_LAST_RUN.demographics).
  //   - Flip RTV_CARD_SERVICE_STATUS.demographics to 'pass' so the RTV card's
  //     Demographics service turns green (was warn) and the pass count rises.
  //   - Record the re-verification in RTV history via the same mechanism as the
  //     eligibility/discovery runs. Per R-22 this counts toward billed usage.
  //   - Stamp + render through stampCheck (29C, approved change #1): the full
  //     fan-out now includes the open-modal header-note refresh, so a confirm
  //     made while the Demographics modal is open updates its stamp in place.
  // ASK-first by design — this runs ONLY on an explicit user action, never on launch.
  function markDemographicsReverified() {
    RTV_SEED_HISTORY.unshift({ date: rtvToday(), services: 'Demographics', status: 'Completed' });
    stampCheck(['demographics'], function (key, entry) {
      entry.result = 'pass';
    });
  }

  // ---------------------------------------------------------------------------
  // R-19 / R-20: Patient Readiness PANEL (Step 10B) — renders buildReadiness().
  // Replaces the old attention chip strip; mounts into #readiness-panel (the DOM
  // slot the strip occupied, above the cards on Pre Check-In). Consumes the 10A
  // rollup DIRECTLY (never recomputes). Action buttons are wired in 10C via
  // handleReadinessAction(actionKey). Styling is CSP-safe: structural
  // classes live in styles.css (semantic tokens), applied here via className.
  // ---------------------------------------------------------------------------
  var READINESS_SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  var READINESS_SEVERITY_BADGE = { high: 'badge-red', medium: 'badge-amber', low: 'badge-blue' };

  // ---------------------------------------------------------------------------
  // ST-C4 §1 — the problem vs. RECOMMENDATION axis (approved Craig 2026-08-05).
  //
  // Recommendations are suggestions, not defects: they render in their own
  // section below the problems, they render REGARDLESS of the high/medium
  // display filter (they are not severities), and they NEVER flip the verdict —
  // a `ready` patient with two recommendations still reads Ready.
  //
  // Deliberately RENDER-SIDE. `buildReadiness()` is a standing byte-fence
  // (harness29d) and its body is untouched: it still emits the demographics
  // 180-day row as a medium problem, and the renderer below reclassifies it.
  // That reclassification is why the displayed verdict is derived from the
  // PROBLEMS that survive the split rather than read from `r.verdict`.
  //
  // Catalog = the ST-D1 §6 trigger table of record, rendered:
  //   · eligibility last run ≥ ELIGIBILITY_AUTO_RUN_DAYS
  //   · insurance changed MANUALLY this session (the A-C2 add + modal edits)
  //   · demographics last verified > DEMOGRAPHICS_REVERIFY_DAYS (reclassified)
  // Subsume rule: coverage changed via DISCOVERY produces no eligibility
  // recommendation — the eligibility data came with the discovery result, which
  // is also why `insuranceChangedManually` is set only on manual write paths.
  // ---------------------------------------------------------------------------
  var READINESS_RECLASSIFIED_AS_RECOMMENDATION = { demographics: true };

  function buildReadinessRecommendations() {
    var recs = [];

    // Eligibility staleness. Threshold read through the named constant — the
    // harness29d fence forbids bare numeric threshold literals outside
    // buildReadiness().
    var eligDays = daysSince(CHECKS.eligibility.lastRunAt);
    if (eligDays > ELIGIBILITY_AUTO_RUN_DAYS) {
      recs.push({
        key: 'eligibility-stale',
        title: 'Eligibility last verified ' + eligDays + ' days ago — re-run recommended',
        detail: 'Last verified ' + checkStamp('eligibility'),
        actionLabel: 'Run eligibility',
        actionKey: 'eligibility',
      });
    }

    // Manual insurance change this session. Discovery-sourced changes never set
    // the flag (subsume rule), so this row cannot fire off a discovery run.
    if (insuranceChangedManually) {
      recs.push({
        key: 'insurance-changed',
        title: 'Insurance changed — run eligibility to verify the new coverage',
        detail: 'Coverage was edited in this session',
        actionLabel: 'Run eligibility',
        actionKey: 'eligibility',
      });
    }

    return recs;
  }

  // ST-D1 ruling ⑤ — the 30-day confirm is the BILLING protection now that
  // nothing auto-runs: re-running a metered check inside the window states when
  // it last ran before firing. Friction, never a block.
  //
  // Rendered as an INLINE prompt (the buildInsuranceRemoveBar pattern), not
  // window.confirm: the app runs under a strict CSP inside a third-party
  // athenaOne iframe where native dialogs are unreliable, and an inline prompt
  // is assertable by the JSDOM harnesses (jsdom's window.confirm is a
  // not-implemented stub that returns undefined — every run would silently
  // cancel).
  function meteredRerunPrompt(checkKey) {
    var days = daysSince(CHECKS[checkKey] && CHECKS[checkKey].lastRunAt);
    if (!(days >= 0) || days > ELIGIBILITY_AUTO_RUN_DAYS) return null;
    var svc = RTV_SERVICES.filter(function (s) { return s.key === checkKey; })[0];
    return ((svc && svc.short) || checkKey) + ' ran ' + days +
      (days === 1 ? ' day' : ' days') + ' ago. Run again?';
  }

  function renderReadinessPanel(p) {
    var panel = $('readiness-panel');
    if (!panel) return;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.className = '';
    panel.hidden = true;
    if (!p) return;

    // Consume the 10A data model (do NOT duplicate the rollup logic).
    var r = buildReadiness();

    // DISPLAY FILTER (10B-fix2): buildReadiness() still computes ALL issues (incl.
    // the lows + informational care gaps); the panel only DISPLAYS the actionable
    // high/medium ones to stay compact. The header badges, the open-issue count,
    // and the ready-state gate below all reflect what's SHOWN (not r.openIssueCount),
    // so the header always matches the visible rows (e.g. "2 open issues" + "1 High"
    // + "1 Medium", no "1 Low"). The lows are intentionally not rendered here.
    //
    // ST-C4 §1: rows reclassified as recommendations come OUT of that set — the
    // demographics 180-day row is emitted by the fenced buildReadiness() as a
    // medium problem and is a recommendation here ("re-verification recommended"
    // always was one).
    var displayed = r.issues.filter(function (it) {
      return (it.severity === 'high' || it.severity === 'medium') &&
        !READINESS_RECLASSIFIED_AS_RECOMMENDATION[it.id];
    });

    // Reclassified rows join the catalog-driven recommendations, carrying the
    // fence's own title/detail/action so the row reads identically — only its
    // KIND changed.
    var recommendations = r.issues
      .filter(function (it) { return READINESS_RECLASSIFIED_AS_RECOMMENDATION[it.id]; })
      .map(function (it) {
        return {
          key: it.id, title: it.title,
          // Carry the Part-5.3 display-only date formatting across with the row.
          // buildReadiness() supplies the RAW store value ('2025-09-02'); the
          // problem-row path below reformats it to MM/DD/YYYY, and a reclassified
          // row must not lose that just because it changed section.
          detail: it.id === 'demographics'
            ? 'Last verified ' + checkStamp('demographics')
            : it.detail,
          actionLabel: it.actionLabel, actionKey: it.actionKey,
        };
      })
      .concat(buildReadinessRecommendations());

    // ⚠ The verdict is derived from the surviving PROBLEMS, not read from
    // `r.verdict`. buildReadiness() counts the demographics medium toward
    // `needs-attention`, and ST-C4 §1 is explicit that recommendations never
    // flip the verdict. Reading r.verdict here would leave a patient whose only
    // finding is a recommendation showing "Needs attention" — the exact bug the
    // reclassification exists to remove. Verdict rule otherwise unchanged
    // (ST-C4 §3): needs-attention iff any high/medium PROBLEM.
    var attention = displayed.some(function (it) {
      return it.severity === 'high' || it.severity === 'medium';
    });
    panel.className = 'readiness-panel ' + (attention ? 'is-attention' : 'is-ready');

    // ---- Header: icon + title, status pill, severity summary, open-issue count ----
    var head = el('div', 'readiness-head');

    var title = el('h2', 'readiness-title');
    var titleIcon = el('span', 'readiness-title-icon', attention ? '\u26A0\uFE0F' : '\u2705');
    titleIcon.setAttribute('aria-hidden', 'true');
    title.appendChild(titleIcon);
    title.appendChild(el('span', null, 'Patient Readiness'));
    head.appendChild(title);

    var pill = el('span', 'badge ' + (attention ? 'badge-amber chip-icon-warn' : 'badge-green chip-icon-check'),
      attention ? 'Needs attention' : 'Ready');
    head.appendChild(pill);

    // Severity summary (e.g. "1 High") — counts only the DISPLAYED high/medium
    // issues so the badges match the visible rows (lows are filtered out above).
    var sevCounts = { high: 0, medium: 0, low: 0 };
    displayed.forEach(function (it) {
      sevCounts[it.severity] = (sevCounts[it.severity] || 0) + 1;
    });
    var sevWrap = el('span', 'readiness-severity-summary');
    ['high', 'medium', 'low'].forEach(function (sev) {
      if (sevCounts[sev] > 0) {
        sevWrap.appendChild(el('span', 'badge ' + READINESS_SEVERITY_BADGE[sev],
          sevCounts[sev] + ' ' + READINESS_SEVERITY_LABEL[sev]));
      }
    });
    if (sevWrap.childNodes.length) head.appendChild(sevWrap);

    // Open-issue count reflects the DISPLAYED issues (not r.openIssueCount), so the
    // header stays consistent with the rows shown below.
    var count = el('span', 'readiness-count',
      displayed.length + ' open issue' + (displayed.length === 1 ? '' : 's'));
    head.appendChild(count);

    panel.appendChild(head);

    // ---- Ready state: compact positive treatment, no issue list ----
    // Shown when there are no DISPLAYED (high/medium) issues. Any lower-severity
    // issues buildReadiness() found are intentionally not surfaced in this panel.
    if (displayed.length === 0) {
      var ready = el('div', 'readiness-ready');
      var readyIcon = el('span', null, '\u2705');
      readyIcon.setAttribute('aria-hidden', 'true');
      ready.appendChild(readyIcon);
      ready.appendChild(el('span', null, 'Patient ready \u2014 no open issues'));
      panel.appendChild(ready);
      // NOTE: no early return any more. Recommendations render below even when
      // there are zero problems \u2014 that is the whole point of the kind: a Ready
      // patient can still carry "eligibility last verified 47 days ago".
    }

    // ---- Issue list: only the DISPLAYED high/medium issues, already sorted
    // high -> medium by 10A's stable ordering (eligibility high first, then
    // demographics medium). Lows/informational care gaps are filtered out above. ----
    var list = el('ul', 'readiness-issues');
    displayed.forEach(function (it) {
      var row = el('li', 'readiness-issue sev-' + it.severity +
        (it.informational ? ' is-informational' : ''));

      var dot = el('span', 'readiness-issue-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);

      var body = el('div', 'readiness-issue-body');

      // Headline: title + inline severity tag on the left, compact action button
      // right-aligned on the SAME line (density fix — detail drops to a sub-line).
      var headline = el('div', 'readiness-issue-headline');
      var rowTitle = el('div', 'readiness-issue-title', it.title);
      var sevTag = el('span', 'readiness-issue-sev', READINESS_SEVERITY_LABEL[it.severity]);
      sevTag.setAttribute('aria-label', it.severity + ' severity');
      rowTitle.appendChild(sevTag);
      headline.appendChild(rowTitle);

      // Action button: wired in 10C via handleReadinessAction(actionKey). Only
      // actionable issues carry a label. (it/btn are unique per forEach iteration,
      // so the closure below captures the correct issue.)
      if (it.actionLabel) {
        var btn = el('button', 'readiness-issue-action', it.actionLabel);
        btn.type = 'button';
        btn.setAttribute('data-action-key', it.actionKey || '');
        btn.addEventListener('click', function () {
          handleReadinessAction(it.actionKey, btn);
        });
        headline.appendChild(btn);
      }
      body.appendChild(headline);

      // Part 5.3 (B1): display-only date formatting for the readiness panel (no
      // rollup/severity/issue-set change — buildReadiness() only supplies the raw
      // store values). Demographics shows its MM/DD/YYYY last-verified date;
      // eligibility appends its formatted last-verified date to its detail line.
      var detailText = it.detail;
      if (it.id === 'demographics') {
        detailText = 'Last verified ' + checkStamp('demographics');
      } else if (it.id === 'eligibility') {
        detailText = (it.detail ? it.detail + ' \u00B7 ' : '') +
          'Last verified ' + checkStamp('eligibility');
      }
      if (detailText) body.appendChild(el('div', 'readiness-issue-detail', detailText));
      row.appendChild(body);
      list.appendChild(row);
    });
    if (displayed.length) panel.appendChild(list);

    // ---- Recommendations (ST-C4 §1) — own section, below the problems. ----
    // Rendered regardless of the high/medium display filter above: they are not
    // severities, so that filter does not apply to them.
    if (recommendations.length) {
      var recWrap = el('div', 'readiness-recommendations');
      var recHead = el('div', 'readiness-recommendations-head', 'Recommended');
      recWrap.appendChild(recHead);
      var recList = el('ul', 'readiness-recommendation-list');
      recommendations.forEach(function (rec) {
        var row = el('li', 'readiness-recommendation');
        row.setAttribute('data-rec-key', rec.key);
        var body = el('div', 'readiness-issue-body');
        var headline = el('div', 'readiness-issue-headline');
        headline.appendChild(el('div', 'readiness-issue-title', rec.title));

        if (rec.actionLabel) {
          var btn = el('button', 'readiness-issue-action', rec.actionLabel);
          btn.type = 'button';
          btn.setAttribute('data-action-key', rec.actionKey || '');
          // ST-D1 ruling ⑤: inside the window, the affordance first states when
          // the check last ran. Friction, never a block — Run is always
          // available; only the extra gesture is added.
          btn.addEventListener('click', function () {
            var prompt = rec.actionKey === 'eligibility' ? meteredRerunPrompt('eligibility') : null;
            if (!prompt) { handleReadinessAction(rec.actionKey, btn); return; }
            if (row.querySelector('.readiness-rerun-confirm')) return;
            var box = el('div', 'readiness-rerun-confirm');
            box.appendChild(el('div', 'readiness-rerun-msg', prompt));
            var actions = el('div', 'readiness-rerun-actions');
            var go = el('button', 'readiness-rerun-go', 'Run again');
            go.type = 'button';
            go.addEventListener('click', function () {
              box.remove();
              handleReadinessAction(rec.actionKey, btn);
            });
            var no = el('button', 'readiness-rerun-cancel', 'Cancel');
            no.type = 'button';
            no.addEventListener('click', function () { box.remove(); });
            actions.appendChild(no);
            actions.appendChild(go);
            box.appendChild(actions);
            body.appendChild(box);
          });
          headline.appendChild(btn);
        }
        body.appendChild(headline);
        if (rec.detail) body.appendChild(el('div', 'readiness-issue-detail', rec.detail));
        row.appendChild(body);
        recList.appendChild(row);
      });
      recWrap.appendChild(recList);
      panel.appendChild(recWrap);
    }
    panel.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // R-19 / R-20: Patient Readiness ACTIONS (Step 10C) — wires each issue's
  // actionKey to a real workflow. We change the underlying SIGNALS that
  // buildReadiness() reads (eligibility status, last-verified date) and then
  // re-render the panel, so a resolved issue drops off on the next build. The
  // rollup logic itself is never touched.
  // ---------------------------------------------------------------------------
  function handleReadinessAction(actionKey, btn) {
    if (actionKey === 'eligibility') {
      // ST-C4 §1: the recommendation rows' run affordance. Routes through the
      // SAME shared runEligibilityCheck path as the modal's "Check Eligibility"
      // button — a recommendation run is an ordinary human-initiated run, not a
      // second mechanism (nothing auto-runs, ST-C4 §2).
      runHeaderActionCheck(btn, 'Checking…', function () {
        runEligibilityCheck({ label: 'Eligibility', services: ['eligibility'] });
      });
    } else if (actionKey === 'discovery') {
      runInsuranceDiscovery(btn);
    } else if (actionKey === 'demographics') {
      // Route to the EXISTING Demographics Review modal (same one the card's
      // "Review" button opens). Its "Confirm Demographics Current" action already
      // calls markDemographicsReverified(), which refreshes the readiness panel —
      // so the medium demographics issue drops off once the user confirms.
      CARD_WORKFLOWS.Demographics();
    }
  }

  // Action 1 (R-19): mock insurance discovery, SUCCESS path. MOCK ONLY — the
  // real discovery is a backend call FrontRunner will wire later; a discovery
  // run counts toward billed usage per R-22.
  //
  // ⚠ **SUPERSEDED IN PLACE 2026-08-14 (A-C1 executed; approved Craig).** This
  // block previously described the "Step 16 — causal two-step chain": phase 1
  // set insuranceDiscovered + discovery's own pass, then phase 2 AUTOMATICALLY
  // re-ran eligibility through the shared runEligibilityCheck path ("only this
  // auto re-run is chained"). That chained re-run was the last automatic check
  // run in the app, and it contradicted the A-C1 decision of record (James +
  // Craig, 2026-08-04): "coverage changed via discovery needs no eligibility
  // run — discovery includes eligibility data (Linnea)".
  //
  // Discovery's completion now applies its OWN included eligibility data
  // directly: eligibility passes and stamps from the discovery result — ONE
  // operation, ONE History row, no second (metered) run. The Step-14/16 guard
  // inside runEligibilityCheck is unchanged: a MANUAL eligibility run still
  // fails ("subscriber not found") until discovery has found the insurance,
  // and passes after — insuranceDiscovered remains that causal signal.
  function runInsuranceDiscovery(btn) {
    // Pending state: disable + relabel so it can't be double-clicked across the
    // ~1s mock phase. Guard against re-entry if the click somehow repeats.
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-pending');
      btn.textContent = 'Running discovery\u2026';
    }
    // Scope the completion to the patient it was started for: if the athena
    // context switches patients mid-pending, the timeout must abort — otherwise
    // it would mark the NEW patient's insurance as discovered and pass their
    // eligibility without a discovery ever running for them.
    var chainPatientId = currentAthenaContext && currentAthenaContext.patientId;
    function chainAborted() {
      return !!(currentAthenaContext && currentAthenaContext.patientId !== chainPatientId);
    }
    setTimeout(function () {
      if (chainAborted()) return;
      // Discovery FOUND the correct insurance. ONE run of ONE service through
      // the shared door — runEligibilityCheck owns the A-C1 rule, so a
      // discovery-inclusive run sets the causal flag, applies the INCLUDED
      // eligibility data (stamp + Step-20 verified flip), appends the single
      // History row with the "(incl. eligibility)" suffix, flips rtvHasRun,
      // renders the fan-out, and fires the Step-13 FrontRunner re-pull. No
      // second metered run — eligibility arrives as data, not as a run.
      // (Ruled Craig 2026-08-14: the RTV modal's scoped run applies the
      // included data too, which is why the rule lives in the door and not
      // here.)
      runEligibilityCheck({ label: 'Insurance Discovery', services: ['discovery'] });
    }, 1000);
  }

  // Shared collapsible-section wiring that mirrors the "Show / Hide contact info"
  // toggle: a subtle teal text link that smoothly expands/collapses a wrapper via
  // an animated max-height + opacity transition. `initialExpanded` seeds the state
  // (so it survives re-renders) and `onChange` reports the new state back so the
  // caller can persist it. All styling routed through css() (CSSOM) for the CSP.
  function makeCollapsibleSection(opts) {
    var toggle = opts.toggle;
    var collapse = opts.collapse;
    var showLabel = opts.showLabel;
    var hideLabel = opts.hideLabel;
    var onChange = opts.onChange || function () {};
    var expanded = !!opts.initialExpanded;

    css(toggle, {
      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 0',
      background: 'none', border: 'none', color: THEME.teal, fontFamily: 'inherit',
      fontSize: '12px', fontWeight: '600', cursor: 'pointer', lineHeight: '1.2',
    });
    toggle.addEventListener('mouseenter', function () { toggle.style.color = THEME.navy; });
    toggle.addEventListener('mouseleave', function () { toggle.style.color = THEME.teal; });

    css(collapse, { overflow: 'hidden' });

    // When an expand animation finishes, drop the max-height cap so the section
    // can reflow freely (e.g. if the table wraps) without clipping.
    collapse.addEventListener('transitionend', function (e) {
      if (e.propertyName === 'max-height' && expanded) {
        collapse.style.maxHeight = 'none';
      }
    });

    function apply(animate) {
      if (expanded) {
        toggle.textContent = hideLabel;
        toggle.setAttribute('aria-expanded', 'true');
        css(collapse, { opacity: '1' });
        css(collapse, { maxHeight: animate ? (collapse.scrollHeight + 'px') : 'none' });
      } else {
        toggle.textContent = showLabel;
        toggle.setAttribute('aria-expanded', 'false');
        if (animate) {
          // Give the transition a finite start height before collapsing to 0.
          css(collapse, { maxHeight: collapse.scrollHeight + 'px' });
          void collapse.offsetHeight;
        }
        css(collapse, { maxHeight: '0px', opacity: '0' });
      }
    }

    // Seed the initial state without animating (so re-renders restore instantly
    // and a collapsed card never flashes its content open on load).
    apply(false);
    css(collapse, { transition: 'max-height 0.3s ease, opacity 0.3s ease' });

    toggle.addEventListener('click', function () {
      expanded = !expanded;
      onChange(expanded);
      apply(true);
    });
  }

  // ---- Post Data modal -------------------------------------------------------
  // Styling is applied via per-property CSSOM setters (node.style.x = …) rather
  // than inline `style="…"` attributes or a stylesheet: the embed's CSP
  // (`default-src 'self' *.athenahealth.com`, no `style-src 'unsafe-inline'`)
  // blocks parsed inline styles, but does not intercept CSSOM property setters.
  // Existing styles.css classes (.btn, .badge) are reused where they fit.
  var THEME = {
    navy: '#284776',
    navyGradient: 'linear-gradient(100deg, #233f6a 0%, #284776 50%, #2d5a8a 100%)',
    teal: '#3a7ca5',
    border: '#e2e8f0',
    borderSoft: '#eef2f6',
    borderInput: '#cbd5e1',
    inset: '#f8fafc',
    // Platform filter / well area (brand-pack muted, style spec 2.3): white
    // controls sit on it. Muted text on it uses slate500Strong (6.57:1);
    // slate500 (43%) is 4.76:1 there.
    well: '#e8f0f5',
    wellBorder: '#d7e6ee',
    slate500Strong: 'hsl(215.3 19.3% 34.5%)',
    // Platform text colours (frhc-platform index.css --foreground and
    // --muted-foreground). The slate names are kept so callers do not change.
    slate900: 'hsl(220 14% 28%)',
    slate500: 'hsl(215.4 16.3% 43%)',
    amber: '#b45309',
    amberBg: 'rgba(245, 158, 11, 0.12)',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  };

  function css(node, styles) {
    for (var k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) {
        node.style[k] = styles[k];
      }
    }
    return node;
  }

  var postModal = null;
  var lastFocused = null;
  // R-25 (B1): live refresher for the currently-open post modal's last-verified
  // stamp line (opts.headerNote). Set by buildPostModalImpl when a headerNote is
  // present, cleared on close and whenever a modal without one is built. The
  // shared run path (runEligibilityCheck) calls it after a run so the stamp line
  // updates the instant a run completes — not only on the next modal open. Kept
  // as ONE hook so every stamping caller (Demographic Verification, Check
  // Eligibility, discovery) refreshes through the same single source of truth.
  var postModalHeaderNoteRefresh = null;

  // --- 26D: post-run module state -------------------------------------------
  // ATHENA_POSTED_OVERRIDES — the athena-side reflection. After a successful
  // post, the mock's "Existing" values must show what was posted (in
  // production FrontRunner would optimistically reflect — or re-query — what
  // it wrote to athena). The def builders derive their Existing values from
  // literals/transforms of the FRHC payload, so rather than hacking each
  // transform, posted values are overlaid at the ONE comparison chokepoint
  // (comparisonRows → effectiveExisting). Keyed 'tabKey|field label'; reset on
  // a DIFFERENT-patient context change (Step-16 branch).
  var ATHENA_POSTED_OVERRIDES = {};
  function effectiveExisting(tabKey, d) {
    var key = tabKey + '|' + d.label;
    return Object.prototype.hasOwnProperty.call(ATHENA_POSTED_OVERRIDES, key)
      ? ATHENA_POSTED_OVERRIDES[key]
      : d.existing;
  }
  // lastPostState — the posted-stamp: { date: 'YYYY-MM-DD', summary: '8
  // updates · 1 appointment' }. Recorded when a posting run settles; shown as
  // a muted line in the review phase on later opens; reset on patient switch.
  var lastPostState = null;
  // postRunActive — a posting sequence is in flight: closePostModal refuses
  // (Esc / X / overlay / Cancel all funnel there); the mid-run patient-switch
  // bail-out clears it before force-closing.
  var postRunActive = false;
  // postModalCloseNotify — set when a run settles; closePostModal fires it
  // once (the Step-13 notify moved from the old fire-and-close submitPost to
  // completion), then clears it.
  var postModalCloseNotify = null;

  // --- 27B: open-modal registry ---------------------------------------------
  // ONE shared mechanism for the Step-16 different-patient force-close: every
  // modal registers an idempotent closer on open and deregisters on normal
  // close; the different-patient branch calls closeAllOpenModals() FIRST
  // (before re-seeds/re-renders) so no modal ever renders against
  // half-switched state. A modal's subject is patient-specific — the new
  // patient has no equivalent of the old patient's claim or a half-filled
  // Post Data form — so close-and-notify beats a silent in-place reload.
  // Closers must leave no residue: pending timeouts cleared, run flags
  // cleared, completion callbacks nulled. Existing runPatientId bail-outs are
  // COMPLEMENTED by the registry, not replaced. Retires the 24D3 architect
  // note (stale claim-detail modal across a switch).
  var OPEN_MODAL_CLOSERS = [];
  function registerModalCloser(closeFn) {
    OPEN_MODAL_CLOSERS.push(closeFn);
    return function deregister() {
      var i = OPEN_MODAL_CLOSERS.indexOf(closeFn);
      if (i !== -1) OPEN_MODAL_CLOSERS.splice(i, 1);
    };
  }
  function closeAllOpenModals() {
    // Snapshot + clear first so each closer's own deregister() is a no-op and
    // a closer that (indirectly) opens/closes another modal can't mutate the
    // list mid-iteration.
    var closers = OPEN_MODAL_CLOSERS.slice();
    OPEN_MODAL_CLOSERS.length = 0;
    closers.forEach(function (fn) {
      try { fn(); } catch (err) {
        // One bad closer must not strand the remaining modals open.
        // eslint-disable-next-line no-console
        console.warn('[NextGen-embed] modal force-close failed', err);
      }
    });
  }

  // 27B: the post-overlay system's registry slot. showPostOverlay REPLACES an
  // existing modal without going through closePostModal, so the system holds
  // at most ONE slot (registered on first mount, released by closePostModal).
  var postModalDeregister = null;
  // 27B: the 26D bespoke force-close, migrated verbatim into a named closer —
  // the completion notify is dropped FIRST (no side effect of the old
  // patient's run may fire against the new context) and postRunActive is
  // cleared so closePostModal's mid-run refusal (which exists for
  // user-initiated closes, not context switches) doesn't block the close.
  function forceClosePostModal() {
    postRunActive = false;
    postModalCloseNotify = null;
    closePostModal();
  }

  // --- 27B: patient-context-change notice ------------------------------------
  // Brief, non-interactive banner directly under the identity header: the
  // whole workspace repaints on a switch, and the notice is what makes that
  // read as deliberate rather than a glitch (complements — does not replace —
  // the persistent identity header, R-6/R-8). One at a time: a rapid
  // double-switch REPLACES the notice (no stacking). Auto-dismisses after 5s.
  // CSP-safe: styled via css() (CSSOM) only. aria-live="polite" so screen
  // readers announce the new context without interrupting.
  var contextNoticeEl = null;
  var contextNoticeTimer = null;
  function showPatientContextNotice(name, mrn) {
    if (contextNoticeTimer) { clearTimeout(contextNoticeTimer); contextNoticeTimer = null; }
    if (contextNoticeEl && contextNoticeEl.parentNode) contextNoticeEl.parentNode.removeChild(contextNoticeEl);
    contextNoticeEl = null;
    // 28C: athena-source switches pass mrn = null — the notice must not claim
    // a name/MRN we don't have (the mock profile's MRN is not this patient's).
    var text = 'Patient context changed \u2014 now showing ' + name + (mrn ? ' \u00b7 MRN ' + mrn : '');
    var n = el('div', null, text);
    n.setAttribute('role', 'status');
    n.setAttribute('aria-live', 'polite');
    css(n, {
      margin: '10px 0 0', padding: '8px 12px', borderRadius: '8px',
      background: 'hsl(187 71% 93%)', border: '1px solid hsl(187 55% 72%)',
      color: THEME.navy, fontSize: '13px', fontWeight: '600', lineHeight: '1.4',
    });
    var identity = document.querySelector('.profile-identity');
    if (identity && identity.parentNode) {
      identity.parentNode.insertBefore(n, identity.nextSibling);
    } else {
      // Defensive fallback — the profile section should always exist by the
      // time a switch renders, but a notice at the top of body beats none.
      document.body.insertBefore(n, document.body.firstChild || null);
    }
    contextNoticeEl = n;
    contextNoticeTimer = setTimeout(function () {
      if (n.parentNode) n.parentNode.removeChild(n);
      if (contextNoticeEl === n) contextNoticeEl = null;
      contextNoticeTimer = null;
    }, 5000);
  }

  // --- 27C-DEBUG: message-capture panel ---------------------------------------
  // On-screen viewer for the bridge's raw message capture. The app runs in a
  // cross-origin iframe inside athenaOne, so its console is unreachable from
  // the host tab — the capture MUST be visible in the app UI to make the
  // athenaPreview navigation test conclusive (empty capture + positive
  // control present = athenaOne sent nothing; any capture IS the missing
  // shape, verbatim). Permanent tooling behind a gate, not throwaway.
  // Gate: hidden by default; opens via ?debugMessages=1 (demo/debug) OR a
  // rapid triple-click on the patient identity header (embedded use — the
  // URL is fixed by athena's app config). Same gesture toggles it closed.
  // Deliberately NOT registered in the 27B open-modal registry: the panel is
  // patient-agnostic tooling and must SURVIVE patient switches — observing
  // them is its purpose. It never takes focus.
  var msgPanel = null;
  var msgPanelUnsub = null;
  var MSG_VERDICT_COLORS = {
    'accepted': '#16a34a',
    'rejected-origin': '#dc2626',
    'unrecognized-shape': '#d97706',
    'app-state': '#2563eb',
  };

  function msgPanelTime(ts) {
    var d = new Date(ts);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function buildMsgCaptureRow(entry) {
    var row = el('div', 'msg-capture-row');
    css(row, {
      borderTop: '1px solid ' + THEME.borderSoft, padding: '6px 10px',
      display: 'flex', flexDirection: 'column', gap: '3px',
    });
    var top = el('div');
    css(top, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    var time = el('span', null, msgPanelTime(entry.ts));
    css(time, { fontSize: '12px', color: THEME.slate500, fontFamily: THEME.mono, flex: '0 0 auto' });
    var origin = el('span', null, entry.origin || '(no origin)');
    css(origin, {
      fontSize: '12px', color: THEME.slate900, fontWeight: '600', flex: '1 1 auto',
      minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    var verdict = el('span', null, entry.verdict);
    css(verdict, {
      fontSize: '12px', fontWeight: '700', textTransform: 'uppercase',
      letterSpacing: '0.03em', color: '#ffffff', borderRadius: '4px',
      padding: '1px 6px', flex: '0 0 auto',
      background: MSG_VERDICT_COLORS[entry.verdict] || THEME.slate500,
    });
    top.appendChild(time); top.appendChild(origin); top.appendChild(verdict);
    var data = el('div', null, entry.dataPreview);
    css(data, {
      fontFamily: THEME.mono, fontSize: '12px', color: THEME.slate900,
      background: 'hsl(210 20% 96%)', borderRadius: '4px', padding: '4px 6px',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '72px', overflow: 'auto',
    });
    row.appendChild(top);
    row.appendChild(data);
    return row;
  }

  function refreshMsgCapturePanel() {
    if (!msgPanel) return;
    var entries = window.AthenaMessaging.getCapturedMessages();
    msgPanel._countEl.textContent = entries.length + ' captured';
    msgPanel._listEl.innerHTML = '';
    // Newest first — the rerun reads "what just arrived" at the top.
    for (var i = entries.length - 1; i >= 0; i--) {
      msgPanel._listEl.appendChild(buildMsgCaptureRow(entries[i]));
    }
    if (!entries.length) {
      var empty = el('div', null, 'No messages captured yet.');
      css(empty, { padding: '10px', fontSize: '12px', color: THEME.slate500 });
      msgPanel._listEl.appendChild(empty);
    }
  }

  function closeMsgCapturePanel() {
    if (!msgPanel) return;
    if (msgPanelUnsub) { msgPanelUnsub(); msgPanelUnsub = null; }
    if (msgPanel.parentNode) msgPanel.parentNode.removeChild(msgPanel);
    msgPanel = null;
  }

  function openMsgCapturePanel() {
    if (msgPanel) return;
    var panel = el('div');
    panel.id = 'message-capture-panel';
    panel.setAttribute('aria-label', 'Message capture');
    css(panel, {
      position: 'fixed', bottom: '12px', right: '12px', zIndex: '1300',
      width: 'min(50%, 320px)', maxHeight: '48vh', display: 'flex',
      flexDirection: 'column', background: '#ffffff',
      border: '1px solid ' + THEME.border, borderRadius: '10px',
      boxShadow: '0 12px 30px rgba(0,0,0,0.22)', overflow: 'hidden',
      fontFamily: 'inherit',
    });
    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 10px', background: THEME.navy, color: '#ffffff',
    });
    var title = el('span', null, 'Message capture');
    css(title, { fontSize: '12px', fontWeight: '700', flex: '0 0 auto' });
    var count = el('span', null, '0 captured');
    css(count, { fontSize: '12px', opacity: '0.85', flex: '1 1 auto' });
    function headBtn(label) {
      var b = el('button', null, label);
      b.type = 'button';
      css(b, {
        background: 'rgba(255,255,255,0.14)', color: '#ffffff', border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: '5px', padding: '2px 8px', fontSize: '12px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit', flex: '0 0 auto',
      });
      return b;
    }
    var clearBtn = headBtn('Clear');
    clearBtn.addEventListener('click', function () {
      window.AthenaMessaging.clearCapturedMessages();
      refreshMsgCapturePanel();
    });
    var closeBtn = headBtn('Close');
    closeBtn.setAttribute('aria-label', 'Close message capture panel');
    closeBtn.addEventListener('click', closeMsgCapturePanel);
    head.appendChild(title); head.appendChild(count); head.appendChild(clearBtn); head.appendChild(closeBtn);
    var list = el('div');
    css(list, { flex: '1 1 auto', overflowY: 'auto', minHeight: '0' });
    panel.appendChild(head);
    panel.appendChild(list);
    panel._countEl = count;
    panel._listEl = list;
    document.body.appendChild(panel);
    msgPanel = panel;
    refreshMsgCapturePanel();
    // Live update — full refresh per capture (≤50 entries; simplest correct).
    msgPanelUnsub = window.AthenaMessaging.onMessageCaptured(function () {
      refreshMsgCapturePanel();
    });
  }

  function toggleMsgCapturePanel() {
    if (msgPanel) closeMsgCapturePanel();
    else openMsgCapturePanel();
  }

  var msgGateWired = false;
  ready(function () {
    // Guard: wire the gate exactly once even if DOMContentLoaded is delivered
    // more than once (test harnesses dispatch it manually) — duplicate
    // delegated listeners would each count 3 clicks and toggle the panel
    // open-then-closed in the same gesture.
    if (msgGateWired) return;
    msgGateWired = true;
    // Gate (a): URL param — demo/debug use.
    try {
      if (new URLSearchParams(window.location.search).get('debugMessages') === '1') {
        openMsgCapturePanel();
      }
    } catch (e) { /* URLSearchParams unavailable — gesture gate still works */ }
    // Gate (b): rapid triple-click on the identity header — embedded use.
    // Delegated on document so it survives every profile re-render.
    var clickTimes = [];
    document.addEventListener('click', function (e) {
      var t = e.target;
      var hit = false;
      while (t && t !== document) {
        if (t.classList && t.classList.contains('profile-identity')) { hit = true; break; }
        t = t.parentNode;
      }
      if (!hit) return;
      var now = Date.now();
      clickTimes.push(now);
      while (clickTimes.length && now - clickTimes[0] > 600) clickTimes.shift();
      if (clickTimes.length >= 3) {
        clickTimes.length = 0;
        toggleMsgCapturePanel();
      }
    });
  });

  // Comparison sameness (Craig, 2026-08-14): a letter-case difference is not a
  // data difference ("Married" vs "MARRIED"), and per-field synonyms are the
  // same value spelled differently ("F" vs "Female" for Sex). ONE equality
  // rule with three consumers inside comparisonRows — the diff-count bar, the
  // row mismatch state, and the chosen-value delta math — so the summary, the
  // highlight, and the Submit-label count can never disagree. Display is
  // untouched: each column still renders its source's own casing; only the
  // sameness VERDICT normalizes. Synonyms are keyed per field label on
  // purpose — a global "f" ≡ "female" would misread single-letter values on
  // fields where they mean something else.
  var COMPARISON_VALUE_SYNONYMS = {
    'Sex': { f: 'female', m: 'male' },
    // athena's policyholder sex vocabulary is M/F only (Orion drops anything
    // wider on write) — FrontRunner's 'Female' and athena's 'F' are the same
    // value spelled differently, exactly like the patient Sex row.
    'Policyholder sex': { f: 'female', m: 'male' },
  };
  // Phone fields compare by their DIGITS (Craig, 2026-08-14 follow-up): the
  // same number differently formatted — "(512) 555-0142" vs "512-555-0142" vs
  // "512.555.0142" — is not a data difference. NANP-normalized: an 11-digit
  // number with a leading 1 (a "+1" prefix) equals its 10-digit form. A value
  // with NO digits falls through to the text rule, so a non-numeric entry
  // still compares as text. Keyed per field label like the synonyms: the rule
  // applies only where the whole value IS a phone number, never to composites
  // that merely contain one (Emergency contact stays a text compare).
  var COMPARISON_PHONE_FIELDS = { 'Mobile phone': true, 'Home phone': true };
  function normalizedComparisonValue(fieldLabel, value) {
    var v = (value == null ? '' : String(value)).trim().toLowerCase();
    if (COMPARISON_PHONE_FIELDS[fieldLabel]) {
      var digits = v.replace(/\D/g, '');
      if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
      if (digits) return digits;
    }
    var syn = COMPARISON_VALUE_SYNONYMS[fieldLabel];
    if (syn && Object.prototype.hasOwnProperty.call(syn, v)) v = syn[v];
    return v;
  }
  function comparisonValuesEqual(fieldLabel, a, b) {
    return normalizedComparisonValue(fieldLabel, a) === normalizedComparisonValue(fieldLabel, b);
  }

  // Builds the comparison body for a tab: FrontRunner vs athena (simulated
  // athena mismatch) vs a Custom free-text entry, chosen via radio. 26C: the
  // Posted Value column is GONE (it overflowed and truncated at 600px — a
  // preview you can't read isn't a preview; the selected radio already states
  // the outcome). The freed width goes to the three sources. Each row carries
  // its selection state as data attributes (data-value / data-delta) so
  // the 26D run capture and the live Submit-label math read the DOM. A
  // diff-first bar (delta summary + "Show only differences" toggle) tops
  // every comparison tab (the 26A lesson).
  function comparisonRows(tabKey, defs, panel) {
    // Columns: label | FrontRunner | athena | Custom (radio + free text).
    // (Heading text only — the internal source keys stay 'frhc' / 'existing',
    // which is what data-source, selectSource and the harnesses match on.)
    var grid = '90px 1.1fr 1.1fr 1fr';

    // ---- Diff-first bar -----------------------------------------------------
    var diffCount = 0;
    defs.forEach(function (d) {
      // infoOnly rows are context, never differences (Craig, 2026-08-19 round
      // 4): FrontRunner's and athena's plan/type names come from DIFFERENT
      // NAMING SYSTEMS (athena's own docs: the package name "may not exactly
      // match the name of the insurance on the patient's ID card"), so a
      // disagreement there is near-permanent — an always-on alarm is not a
      // signal, and it trains staff to ignore amber on the rows where it IS
      // actionable. No highlight, no diff count; both values render plainly
      // and the human reads them.
      if (d.infoOnly) return;
      var f = d.frhc == null || d.frhc === '' ? '—' : String(d.frhc);
      // 26D: Existing is read through the posted-overrides overlay so a
      // successful post resolves these diffs on re-open (athena-side
      // reflection) — same read as the row loop below.
      var ex = effectiveExisting(tabKey, d);
      var e = ex == null || ex === '' ? '—' : String(ex);
      if (!comparisonValuesEqual(d.label, f, e)) diffCount += 1;
    });

    var rowEls = [];
    var onlyDiffs = diffCount > 0; // toggle DEFAULT ON when differences exist
    function applyFilter() {
      rowEls.forEach(function (r) {
        r.el.style.display = onlyDiffs && !r.mismatch ? 'none' : 'grid';
      });
    }

    var bar = document.createElement('div');
    bar.className = 'cmp-diff-bar';
    css(bar, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '10px', flexWrap: 'wrap', padding: '8px 10px', marginBottom: '12px',
      borderRadius: '8px',
      border: '1px solid ' + (diffCount ? 'rgba(180, 83, 9, 0.35)' : THEME.borderSoft),
      background: diffCount ? THEME.amberBg : THEME.inset,
    });
    if (diffCount) {
      var summary = el('span', 'cmp-diff-summary',
        diffCount + (diffCount === 1 ? ' field differs' : ' fields differ') + ' from NextGen');
      css(summary, { fontSize: '12px', fontWeight: '700', color: THEME.amber });
      bar.appendChild(summary);
      var toggleWrap = document.createElement('label');
      css(toggleWrap, {
        display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
        fontSize: '12px', fontWeight: '600', color: THEME.slate900,
      });
      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = onlyDiffs;
      toggle.className = 'cmp-diff-toggle';
      css(toggle, { accentColor: THEME.navy, margin: '0', flex: 'none' });
      toggle.addEventListener('change', function () {
        onlyDiffs = toggle.checked;
        applyFilter();
      });
      toggleWrap.appendChild(toggle);
      toggleWrap.appendChild(el('span', null, 'Show only differences'));
      bar.appendChild(toggleWrap);
    } else {
      // Zero-diff tab: all rows stay visible plus this muted line — never an
      // empty panel, and no pointless toggle.
      var noDiff = el('span', 'cmp-nodiff', 'No differences \u2014 NextGen matches FrontRunner');
      css(noDiff, { fontSize: '12px', fontStyle: 'italic', color: THEME.slate500 });
      bar.appendChild(noDiff);
    }
    panel.appendChild(bar);

    // EXISTING-column provenance (demographic tab only — insurance tabs are
    // still fully simulated): live athena via Orion, honest unavailability
    // with the upstream reason, or the legacy simulated stand-ins.
    // 2026-08-15 (Craig): the insurance tabs got their own live lane (the
    // FR-152 coverage read), so this gate widened from demographic-only to
    // every tab with a live EXISTING source — each tab annotated from ITS OWN
    // meta, because the two lanes degrade independently (demographics can be
    // live while coverage is unavailable, and vice versa).
    var srcMeta = tabKey === 'demographic'
      ? currentAthenaDemographicsMeta
      : (tabKey === 'primary' || tabKey === 'secondary') ? currentAthenaCoverageMeta : null;
    if (srcMeta) {
      var srcText;
      // Names the column it annotates, so it tracks the heading rename: with the
      // column now called "athena", "Existing = live athena values" would both
      // point at a heading that no longer exists and say athena twice.
      if (srcMeta.source === 'orion') {
        srcText = 'NextGen = live values (via Orion)';
      } else if (srcMeta.source === 'unavailable') {
        srcText = 'NextGen values unavailable — ' + (srcMeta.error && srcMeta.error.message ? srcMeta.error.message : 'live NextGen read failed');
      } else {
        srcText = 'NextGen = simulated values (live lane not configured)';
      }
      var srcNote = el('div', 'cmp-existing-source', srcText);
      css(srcNote, {
        fontSize: '12px', fontStyle: 'italic',
        color: srcMeta.source === 'unavailable' ? THEME.amber : THEME.slate500,
        margin: '-4px 0 10px',
      });
      panel.appendChild(srcNote);
    }

    var header = document.createElement('div');
    css(header, {
      display: 'grid', gridTemplateColumns: grid, gap: '8px', alignItems: 'start',
      padding: '4px 0 10px', borderBottom: '1px solid ' + THEME.border,
    });
    // Bulk source selection: a "Select all" under the FrontRunner and athena
    // headers points every row in this tab at that source at once. Deliberately
    // NOT offered under Custom — each Custom value is free text typed per field,
    // so there is nothing to select in bulk.
    //
    // Applies to EVERY row, not just the ones the "Show only differences" filter
    // is currently showing. That is safe rather than sloppy: a hidden row is a
    // non-mismatch row, where frhc === existing, so both sources resolve to the
    // same data-value and the same data-delta ("0"). Scoping to visible rows
    // would be identical in effect and would add a hidden-state rule to explain.
    function selectAll(src) {
      rowEls.forEach(function (r) { r.select(src); });
      // syncRowState() updates the row attributes but does NOT reach the Submit
      // label: buildPostModalImpl recomputes it from a delegated 'change'
      // listener on the modal body, and a programmatic radio.checked assignment
      // fires no event. One bubbling change covers every row just touched.
      header.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Column headings render AS WRITTEN — no textTransform. The casing is
    // deliberate and product-chosen (Craig, 2026-08-12): "FrontRunner", and
    // "athena" lower-case, which is how athenahealth styles its own product
    // name. An uppercase transform here would silently override it.
    ['', 'FrontRunner', 'NextGen', 'Custom'].forEach(function (t, i) {
      var c = document.createElement('div');
      css(c, { minWidth: '0' });
      var title = el('div', null, t);
      css(title, {
        fontSize: '12px', fontWeight: '700', letterSpacing: '0.5px',
        color: i === 1 ? THEME.navy : THEME.slate500, minWidth: '0', overflowWrap: 'break-word',
      });
      c.appendChild(title);
      if (i === 1 || i === 2) {
        var src = i === 1 ? 'frhc' : 'existing';
        var all = document.createElement('button');
        all.type = 'button';
        all.className = 'cmp-select-all';
        all.setAttribute('data-source', src);
        all.textContent = 'Select all';
        all.setAttribute('aria-label',
          'Select ' + t + ' for all ' + defs.length + (defs.length === 1 ? ' field' : ' fields'));
        css(all, {
          marginTop: '3px', padding: '0', border: 'none', background: 'none',
          font: 'inherit', fontSize: '12px', fontWeight: '600',
          color: i === 1 ? THEME.navy : THEME.slate500,
          textDecoration: 'underline', cursor: 'pointer',
        });
        all.addEventListener('click', function () { selectAll(src); });
        c.appendChild(all);
      }
      header.appendChild(c);
    });
    panel.appendChild(header);

    defs.forEach(function (d, idx) {
      var frhc = d.frhc == null || d.frhc === '' ? '—' : String(d.frhc);
      // 26D: posted-overrides overlay (see effectiveExisting) — after a post,
      // athena's Existing IS what was posted.
      var existingRaw = effectiveExisting(tabKey, d);
      var existing = existingRaw == null || existingRaw === '' ? '—' : String(existingRaw);
      var mismatch = !comparisonValuesEqual(d.label, frhc, existing);

      var row = document.createElement('div');
      // State carrier for the 26D run capture + the live Submit-label math (replaces the
      // dropped Posted Value inputs): data-value = the value the selected radio
      // will post; data-delta = "1" when that CHOSEN value differs from athena's
      // existing (Existing selected = never a delta; empty Custom = never a delta).
      row.className = 'comparison-field-row';
      row.setAttribute('data-tab', tabKey);
      row.setAttribute('data-field', d.label);
      row.setAttribute('data-mismatch', d.infoOnly ? '0' : (mismatch ? '1' : '0'));
      css(row, {
        display: 'grid', gridTemplateColumns: grid, gap: '8px', alignItems: 'center',
        padding: '9px 0', borderBottom: '1px solid ' + THEME.borderSoft,
      });

      var label = el('div', null, d.label);
      css(label, { fontSize: '12px', color: THEME.slate500, minWidth: '0', overflowWrap: 'break-word' });
      row.appendChild(label);

      // infoOnly rows (2026-08-19, unified insurance field set): display-only —
      // Plan name and Insurance type (a change there is a carrier change,
      // which is the Add New Insurance Replace flow, never a field edit) and
      // the verification metadata (Last verified). No radios, no Custom
      // input, never a delta — and NO mismatch highlight (round 4 ruling):
      // these values come from different naming systems and will near-always
      // differ, so a highlight would be an always-on alarm. Both values
      // render plainly; the human reads them.
      if (d.infoOnly) {
        row.setAttribute('data-mismatch', '0');
        var frhcText = el('div', null, frhc);
        css(frhcText, { fontSize: '12px', color: THEME.slate900, minWidth: '0', overflowWrap: 'break-word' });
        var existingText = el('div', null, existing);
        css(existingText, { fontSize: '12px', color: THEME.slate900, minWidth: '0', overflowWrap: 'break-word' });
        row.appendChild(frhcText);
        row.appendChild(existingText);
        row.appendChild(el('div'));
        row.setAttribute('data-value', existing);
        row.setAttribute('data-delta', '0');
        rowEls.push({ el: row, mismatch: false, select: function () {} });
        panel.appendChild(row);
        return;
      }

      var name = 'src-' + tabKey + '-' + idx;

      // Remembers the last FrontRunner/athena choice so clearing the Custom
      // field can revert to whichever source was selected before.
      var prevNonCustom = 'frhc';
      var customRadio;
      var customInput;   // scalar rows: the single free-text box
      var customInputs;  // composed rows: one small input PER PART

      function syncRowState() {
        var value, delta, parts = null;
        if (customRadio && customRadio.checked) {
          if (d.parts) {
            // Composed Custom: only the parts actually typed post (partial
            // update — absent = leave alone), so "fix just the city" is one
            // input, one wire field. The displayed value is the composition
            // of the typed parts; no string is ever split.
            var typed = {};
            customInputs.forEach(function (ci) {
              var v = ci.input.value.trim();
              if (v !== '' && v !== '—') typed[ci.key] = v;
            });
            value = d.composeParts(typed);
            delta = Object.keys(typed).length > 0 && !comparisonValuesEqual(d.label, value, existing);
            parts = typed;
          } else {
            value = customInput.value;
            // Custom with an empty input is not a valid delta; a Custom value
            // that is the SAME value differently spelled (case / synonym) is
            // not one either — and neither is the '—' placeholder.
            delta = value.trim() !== '' && value.trim() !== '—' && !comparisonValuesEqual(d.label, value, existing);
          }
        } else if (existingCell && existingCell.radio.checked) {
          value = existing;
          delta = false; // keeping athena's value = nothing to post
          if (d.parts) parts = d.existingParts;
        } else {
          value = frhc;
          // Same verdict as the row's mismatch state (one equality rule) — with
          // one guard: an EMPTY FrontRunner side ('—' placeholder) is never a
          // postable delta. Before 2026-08-19 a null-FRHC row with a live
          // athena value defaulted to "post '—'" — a literal em dash sent as
          // the field's new value. The mismatch highlight stays; posting the
          // placeholder does not.
          delta = mismatch && frhc !== '—';
          if (d.parts) parts = d.frhcParts;
        }
        row.setAttribute('data-value', value);
        row.setAttribute('data-delta', delta ? '1' : '0');
        // Composed rows carry the CHOSEN SOURCE's granular parts for the run
        // capture: the posting functions spread these wire keys into the
        // request instead of a label-mapped single field.
        if (d.parts) row.setAttribute('data-parts', JSON.stringify(parts || {}));
      }

      function sourceCell(value, srcVal, checked, isExisting) {
        var wrap = document.createElement('label');
        css(wrap, {
          display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: 'pointer',
          fontSize: '12px', color: THEME.slate900, minWidth: '0',
        });
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = srcVal;
        radio.checked = checked;
        css(radio, { accentColor: THEME.navy, marginTop: '2px', flex: 'none' });
        radio.addEventListener('change', function () {
          if (radio.checked) {
            prevNonCustom = srcVal;
            syncRowState();
          }
        });
        var span = el('span', null, value);
        css(span, { minWidth: '0', overflowWrap: 'break-word' });
        if (isExisting && mismatch) {
          css(span, { color: THEME.amber, background: THEME.amberBg, borderRadius: '4px', padding: '0 4px' });
        }
        wrap.appendChild(radio);
        wrap.appendChild(span);
        return { wrap: wrap, radio: radio };
      }

      var frhcCell = sourceCell(frhc, 'frhc', true, false);
      // Tagged so the workflow buttons (Demographic Verification, Check Eligibility,
      // etc.) can apply a placeholder loading state to the FrontRunner column.
      frhcCell.wrap.className = 'frhc-cell';
      var existingCell = sourceCell(existing, 'existing', false, true);

      // Driven by the header "Select all" controls. Mirrors what the per-radio
      // change handler does — move the radio, remember it as the non-custom
      // choice so clearing the Custom box reverts here, then re-derive the row's
      // post state. Radio-group semantics unselect any Custom choice for us
      // while LEAVING the typed text in place, so the entry stays recoverable.
      function selectSource(src) {
        var cell = src === 'existing' ? existingCell : frhcCell;
        cell.radio.checked = true;
        prevNonCustom = src === 'existing' ? 'existing' : 'frhc';
        syncRowState();
      }

      // Custom cell — radio inline with an always-visible free-text input (kept
      // visible so the affordance is obvious; sized to its column). Typing
      // auto-selects the Custom radio; clearing reverts to the prior source.
      // Composed rows render one small input PER PART instead of a single box —
      // free text is the one source with no granular backing, so the parts are
      // typed as parts rather than split from a string (the ST-E6 trap).
      var customWrap = document.createElement('div');
      css(customWrap, {
        display: 'flex', alignItems: d.parts ? 'flex-start' : 'center', gap: '6px',
        fontSize: '12px', color: THEME.slate900, minWidth: '0',
      });
      customRadio = document.createElement('input');
      customRadio.type = 'radio';
      customRadio.name = name;
      customRadio.value = 'custom';
      customRadio.checked = false;
      customRadio.setAttribute('aria-label', d.label + ' use custom value');
      css(customRadio, { accentColor: THEME.navy, flex: 'none', marginTop: d.parts ? '2px' : '0' });
      customRadio.addEventListener('change', function () {
        if (customRadio.checked) syncRowState();
      });
      var inputStyles = {
        width: '100%', minWidth: '0', padding: '5px 6px', border: '1px solid ' + THEME.borderInput,
        borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit', color: THEME.slate900,
        background: '#fff', boxSizing: 'border-box',
      };
      var customEntry;
      if (d.parts) {
        customInputs = [];
        customEntry = document.createElement('div');
        css(customEntry, { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%', minWidth: '0' });
        d.parts.forEach(function (pt) {
          var pi = document.createElement('input');
          pi.type = 'text';
          pi.placeholder = pt.short + '…';
          pi.setAttribute('aria-label', d.label + ' custom ' + pt.short.toLowerCase());
          css(pi, inputStyles);
          pi.addEventListener('input', function () {
            var any = customInputs.some(function (ci) { return ci.input.value !== ''; });
            if (any) {
              customRadio.checked = true;
            } else if (prevNonCustom === 'existing') {
              existingCell.radio.checked = true;
            } else {
              frhcCell.radio.checked = true;
            }
            syncRowState();
          });
          customInputs.push({ key: pt.key, input: pi });
          customEntry.appendChild(pi);
        });
      } else {
        customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = 'Custom…';
        customInput.setAttribute('aria-label', d.label + ' custom value');
        css(customInput, inputStyles);
        customInput.addEventListener('input', function () {
          if (customInput.value !== '') {
            customRadio.checked = true;
          } else if (prevNonCustom === 'existing') {
            existingCell.radio.checked = true;
          } else {
            frhcCell.radio.checked = true;
          }
          syncRowState();
        });
        customEntry = customInput;
      }
      customWrap.appendChild(customRadio);
      customWrap.appendChild(customEntry);

      row.appendChild(frhcCell.wrap);
      row.appendChild(existingCell.wrap);
      row.appendChild(customWrap);
      syncRowState(); // initial state: FrontRunner selected
      rowEls.push({ el: row, mismatch: mismatch, select: selectSource });
      panel.appendChild(row);
    });

    applyFilter();
  }

  // EXISTING-column resolver (column semantics of record, Craig 2026-08-05):
  // live athena value (via Orion) when the read succeeded; honest null (renders
  // '—') when the lane is configured but the read failed — NEVER a simulated
  // stand-in masquerading as athena; the legacy simulated value only when the
  // live lane isn't configured at all.
  function athenaExistingValue(simulated, liveGetter) {
    if (currentAthenaDemographicsMeta.source === 'orion' && currentAthenaDemographics) {
      return liveGetter(currentAthenaDemographics);
    }
    if (currentAthenaDemographicsMeta.source === 'unavailable') return null;
    return simulated;
  }

  // Coverage twin of athenaExistingValue — same resolution ladder, per COB
  // rank ('primary'/'secondary'). One extra honest case: the lane can be LIVE
  // while the patient has no coverage at that rank (or a field the FR-152
  // projection doesn't carry — relationship, copay in staging) — that is a
  // real null and renders '—', never the simulated stand-in.
  function athenaCoverageValue(rank, simulated, liveGetter) {
    if (currentAthenaCoverageMeta.source === 'orion' && currentAthenaCoverage) {
      var live = currentAthenaCoverage[rank];
      return live ? liveGetter(live) : null;
    }
    if (currentAthenaCoverageMeta.source === 'unavailable') return null;
    return simulated;
  }

  // Shared formatters so FRHC (profile p) and EXISTING (athena ath) render
  // through identical composition rules — a formatting difference must never
  // read as a data diff.
  function composeAddressLine(a) {
    a = a || {};
    return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.postalCode].filter(Boolean).join(' · ');
  }
  // Athena/Orion data can carry null relationship/phone — render only the
  // parts that exist, never a literal "(null)".
  function composeEmergencyLine(ec) {
    ec = ec || {};
    return ec.name
      ? [ec.name, ec.relationship ? '(' + ec.relationship + ')' : null, ec.phone ? '· ' + ec.phone : null]
          .filter(Boolean)
          .join(' ')
      : '—';
  }

  // --- Source-backed composed rows (Craig, 2026-08-20) ----------------------
  // A composed row displays ONE line per side (better UX than a stack of
  // granular rows — Craig's granularity ruling) while staying fully postable:
  // both columns are BACKED by the granular parts the app already holds (the
  // mock profile and the Orion mappers both keep parts alongside any composed
  // string), so choosing a source posts that source's PARTS — never a string
  // split. Free-text Custom is the one case with no parts to fall back on, so
  // a composed row renders one small input PER PART instead of a single box.
  // The wire never sees a composed string: `data-parts` carries {wireKey:
  // value} for the chosen source and the posting functions spread it into the
  // request, so the granular platform contract (action handler → Orion →
  // athena) is untouched — exactly what Linnea's side already accepts.
  //
  // Each part: { key: wire field name, short: per-part input placeholder,
  // frhc, existing } — existing resolved through the SAME per-tab resolver as
  // scalar rows, so live/simulated/unavailable behave identically. The row's
  // display strings are composed FROM the resolved parts, which is what
  // guarantees display and post can never disagree.
  function composedDef(label, parts, composeFn) {
    function sideMap(side) {
      var m = {};
      parts.forEach(function (pt) {
        var v = pt[side];
        if (v != null && v !== '') m[pt.key] = String(v);
      });
      return m;
    }
    var frhcParts = sideMap('frhc');
    var existingParts = sideMap('existing');
    var frhcLine = composeFn(frhcParts);
    var existingLine = composeFn(existingParts);
    return {
      label: label,
      parts: parts,
      composeParts: composeFn,
      frhcParts: frhcParts,
      existingParts: existingParts,
      frhc: frhcLine === '' ? null : frhcLine,
      existing: existingLine === '' ? null : existingLine,
    };
  }
  function composeNameLine(v) {
    return [v.first_name, v.middle_name, v.last_name].filter(Boolean).join(' ');
  }
  // 'Full name' — parts post as first_name/middle_name/last_name (the flat
  // per-part shape orionPatientDemographicsUpdate already defines). Sim
  // existing keeps the demo's deliberate middle-initial mismatch ('M').
  function composedNameDef(ex, p) {
    var n = (p && p.name) || {};
    return composedDef('Full name', [
      { key: 'first_name', short: 'First', frhc: n.first, existing: ex(n.first, function (ath) { return ath.name && ath.name.first; }) },
      { key: 'middle_name', short: 'Middle', frhc: n.middle, existing: ex('M', function (ath) { return ath.name && ath.name.middle; }) },
      { key: 'last_name', short: 'Last', frhc: n.last, existing: ex(n.last, function (ath) { return ath.name && ath.name.last; }) },
    ], composeNameLine);
  }
  // 'Address' — parts post as address_line_1/2, city, state, zip_code. Sim
  // existing keeps the demo's deliberate Lane→Ln mismatch on line 1.
  function composedAddressDef(ex, a) {
    a = a || {};
    return composedDef('Address', [
      { key: 'address_line_1', short: 'Address 1', frhc: a.line1, existing: ex((a.line1 || '').replace('Lane', 'Ln'), function (ath) { return ath.address && ath.address.line1; }) },
      { key: 'address_line_2', short: 'Address 2', frhc: a.line2, existing: ex(a.line2, function (ath) { return ath.address && ath.address.line2; }) },
      { key: 'city', short: 'City', frhc: a.city, existing: ex(a.city, function (ath) { return ath.address && ath.address.city; }) },
      { key: 'state', short: 'State', frhc: a.state, existing: ex(a.state, function (ath) { return ath.address && ath.address.state; }) },
      { key: 'zip_code', short: 'ZIP', frhc: a.postalCode, existing: ex(a.postalCode, function (ath) { return ath.address && ath.address.postalCode; }) },
    ], function (v) {
      return composeAddressLine({ line1: v.address_line_1, line2: v.address_line_2, city: v.city, state: v.state, postalCode: v.zip_code });
    });
  }

  function buildDemographicDefs(p) {
    var c = p.contact || {};
    var emergency = composeEmergencyLine(p.emergencyContact);
    function ex(sim, getter) { return athenaExistingValue(sim, getter); }
    return [
      // Full name / Address: source-backed composed rows (Craig, 2026-08-20) —
      // one displayed line per side, granular parts on the wire. This makes
      // both fields POSTABLE for the first time (ST-E6's per-part fidelity
      // requirement satisfied by parts, not by splitting the display string).
      composedNameDef(ex, p),
      { label: 'Preferred name', frhc: p.name.preferred, existing: ex(p.name.preferred, function (ath) { return ath.name && ath.name.preferred; }) },
      { label: 'Date of birth', frhc: p.dateOfBirth, existing: ex(p.dateOfBirth, function (ath) { return ath.dateOfBirth; }) },
      { label: 'Sex', frhc: p.sex, existing: ex(p.sex, function (ath) { return ath.sex; }) },
      // Gender identity / Pronouns / Preferred language rows REMOVED 2026-08-19
      // (Craig's demographics field-set review): no insurance-discovery or
      // eligibility role. Marital status / Race / Ethnicity ruled KEEP for now.
      { label: 'Marital status', frhc: p.maritalStatus, existing: ex(p.maritalStatus, function (ath) { return ath.maritalStatus; }) },
      { label: 'Race', frhc: p.race, existing: ex(p.race, function (ath) { return ath.race; }) },
      { label: 'Ethnicity', frhc: p.ethnicity, existing: ex('Hispanic', function (ath) { return ath.ethnicity; }) },
      { label: 'SSN', frhc: p.ssnLast4 ? '•••-••-' + p.ssnLast4 : null, existing: ex(p.ssnLast4 ? '•••-••-' + p.ssnLast4 : null, function (ath) { return ath.ssnLast4 ? '•••-••-' + ath.ssnLast4 : null; }) },
      // Employer ADDED 2026-08-19 (Craig's field-set review): a discovery
      // input (employment-based coverage matching). Live EXISTING renders '—'
      // until Orion ingests/projects employment (demand-spec addendum
      // 2026-08-19). Display-only: athena's PUT takes employer by employerid,
      // so the row is deliberately absent from DEMOGRAPHIC_POST_FIELD_KEYS.
      { label: 'Employer', frhc: p.employer && p.employer.name, existing: ex(p.employer && p.employer.name, function (ath) { return ath.employer && ath.employer.name; }) },
      { label: 'Mobile phone', frhc: c.mobilePhone, existing: ex((c.mobilePhone || '').replace(/[()]/g, '').replace(/\s+/g, '-'), function (ath) { return ath.contact && ath.contact.mobilePhone; }) },
      { label: 'Home phone', frhc: c.homePhone, existing: ex(c.homePhone, function (ath) { return ath.contact && ath.contact.homePhone; }) },
      { label: 'Email', frhc: c.email, existing: ex(c.email, function (ath) { return ath.contact && ath.contact.email; }) },
      composedAddressDef(ex, p.address),
      { label: 'Emergency contact', frhc: emergency, existing: ex(emergency, function (ath) { return composeEmergencyLine(ath.emergencyContact); }) },
    ];
  }

  // The EXISTING column is LIVE Orion coverage since 2026-08-15 (Craig: show
  // the FR-152 read like the demographics) — resolved per rank through
  // athenaCoverageValue: live value when the read succeeded, honest '—' when
  // the lane is up but the projection lacks the field (Relationship,
  // policyholder anything; Payer name is null in staging) or the rank has no
  // coverage in force, legacy simulated values only when the lane isn't
  // configured. Status maps to eligibility_status — the FR-152 rule:
  // "Unverified" is still a real policy, never an error.
  //
  // ⚠ **'Athena Package ID' REMOVED FROM THE APP ENTIRELY 2026-08-15 (Craig):
  // "Orion is handling the athena package ID already and it is of no concern
  // to the app."** The app neither displays nor sends it — an insurance
  // UPDATE is identified by the insuranceid in athena's PUT path, which the
  // server resolves as Orion's coverage_id; only a CREATE needs the package
  // id, which the app cannot express (Q5 open). Do not re-add it as a row or
  // a payload field.
  // ✅ UNIFIED FIELD SET (Craig, 2026-08-19): primary and secondary display the
  // SAME fields — one builder, rank-parameterized, so the tabs can never drift
  // apart again. The set is the athena-GET ↔ FrontRunner mapping's keepers:
  // every row has a live FR-152 source (or is Relationship, kept with an honest
  // null by explicit ruling) and a FrontRunner DB equivalent.
  //   - Copay DROPPED (same ruling): not writable via athena's PUT (their
  //     eligibility engine populates it), no live value in the projection, and
  //     it was the one asymmetric row. Do not re-add.
  //   - Payer and Status ROWS REMOVED (Craig's review, same day): neither can
  //     ever post (Payer is a display name — the X12 payer id is a different
  //     value; Status is engine-set), so as choosable rows they only produced
  //     "not wired" outcomes. Payer still lives on the tab PANEL (data-payer)
  //     for occupancy/re-point plumbing, and both still display on the
  //     Insurance card. A payer change is a carrier change — that is the Add
  //     New Insurance Replace flow, never a field edit.
  //   - Plan name DISPLAY-ONLY (same review): athena's PUT has no plan-name
  //     field, and Orion treats a changed plan name as a carrier change — the
  //     DELETE+POST package-change pattern FrontRunner does not drive (scope
  //     note of record). The row stays for side-by-side reading but nothing
  //     posts and nothing highlights (round 4: the two names come from
  //     different naming systems and near-always differ — an always-on
  //     highlight is noise, not signal). Insurance type joined it (round 3) —
  //     same class: package-derived, unwritable. Eligibility reason was
  //     dropped in the same round (see the row comment below).
  //   - Relationship KEPT with an honest '—' in live mode until Orion projects
  //     subscriber.relationship_to_patient (it is already in their canonical
  //     model — exposure ask, not new modeling). Still writable on post.
  //   - Eligibility reason / Last verified are infoOnly: verification metadata
  //     from athena's side — there is no FrontRunner-vs-athena choice to make,
  //     so they render without source radios and never count as deltas.
  function buildInsuranceDefs(p, rank) {
    var ins = (p.insurance && p.insurance[rank]) || {};
    var ph = ins.policyholder || {};
    var pha = ph.address || {};
    var isPrimary = rank === 'primary';
    function exc(sim, getter) { return athenaCoverageValue(rank, sim, getter); }
    // Simulated EXISTING stand-ins (mock mode only) keep the demo's deliberate
    // per-rank mismatches, exactly as the two pre-unification builders had them.
    var simPlan = isPrimary ? ins.planName : (ins.planName || '').replace('POS II', 'POS 2');
    var simGroup = isPrimary ? (ins.groupNumber || '').replace('GRP-', '') : ins.groupNumber;
    return [
      { label: 'Plan name', infoOnly: true, frhc: ins.planName, existing: exc(simPlan, function (cov) { return cov.planName; }) },
      // Display-only like Plan name (Craig, 2026-08-19 round 3): athena derives
      // the type from the package, the PUT cannot change it, and as a choosable
      // row its only possible outcome was "not wired" noise.
      { label: 'Insurance type', infoOnly: true, frhc: ins.insuranceType, existing: exc(ins.insuranceType, function (cov) { return cov.insuranceType; }) },
      { label: 'Member ID', frhc: ins.memberId, existing: exc(ins.memberId, function (cov) { return cov.memberId; }) },
      { label: 'Group number', frhc: ins.groupNumber, existing: exc(simGroup, function (cov) { return cov.groupNumber; }) },
      // The subscriber block below (Relationship + the policyholder rows) is
      // not yet in the FR-152 projection — live mode renders honest '—'s until
      // the exposure ask lands (the getters already read the mapped fields, so
      // the columns light up platform-side with no app change). Policyholder
      // rows included by ruling (Craig, 2026-08-19): "If policy holder is not
      // self that info is needed." They display on every policy — under Self
      // they simply mirror the patient — because conditional rows would break
      // the same-fields symmetry between the tabs.
      { label: 'Relationship', frhc: ins.relationship, existing: exc(ins.relationship, function (cov) { return cov.relationship; }) },
      // Policyholder name + address: source-backed COMPOSED rows (Craig,
      // 2026-08-20 — better UX than seven granular rows). This does NOT
      // reverse the 2026-08-19 round-6 postability ruling: the chosen side's
      // granular PARTS are what post (data-parts → the same
      // policyholder_* write fields), so the value is still "updated in
      // athena via the PUT" — one displayed line, never a string split.
      composedDef('Policyholder name', [
        { key: 'policyholder_first_name', short: 'First', frhc: ph.firstName, existing: exc(ph.firstName, function (cov) { return cov.policyholderFirstName; }) },
        { key: 'policyholder_last_name', short: 'Last', frhc: ph.lastName, existing: exc(ph.lastName, function (cov) { return cov.policyholderLastName; }) },
      ], function (v) { return [v.policyholder_first_name, v.policyholder_last_name].filter(Boolean).join(' '); }),
      { label: 'Policyholder DOB', frhc: ph.dateOfBirth, existing: exc(ph.dateOfBirth, function (cov) { return cov.policyholderDob; }) },
      { label: 'Policyholder sex', frhc: ph.sex, existing: exc(ph.sex, function (cov) { return cov.policyholderGender; }) },
      composedDef('Policyholder address', [
        { key: 'policyholder_address_line_1', short: 'Address 1', frhc: pha.line1, existing: exc(pha.line1, function (cov) { return cov.policyholderAddressLine1; }) },
        { key: 'policyholder_address_line_2', short: 'Address 2', frhc: pha.line2, existing: exc(pha.line2, function (cov) { return cov.policyholderAddressLine2; }) },
        { key: 'policyholder_city', short: 'City', frhc: pha.city, existing: exc(pha.city, function (cov) { return cov.policyholderCity; }) },
        { key: 'policyholder_state', short: 'State', frhc: pha.state, existing: exc(pha.state, function (cov) { return cov.policyholderState; }) },
        { key: 'policyholder_zip', short: 'ZIP', frhc: pha.postalCode, existing: exc(pha.postalCode, function (cov) { return cov.policyholderZip; }) },
      ], function (v) {
        return composeAddressLine({ line1: v.policyholder_address_line_1, line2: v.policyholder_address_line_2, city: v.policyholder_city, state: v.policyholder_state, postalCode: v.policyholder_zip });
      }),
      // SSN renders masked last-4 only and stays display-only — the app never
      // holds a full SSN, and Orion marks subscriber ssn write-only, never
      // projected, so its athena column is '—' by DESIGN, not by gap.
      { label: 'Policyholder SSN', infoOnly: true, frhc: ph.ssnLast4 ? '•••-••-' + ph.ssnLast4 : null, existing: exc(ph.ssnLast4 ? '•••-••-' + ph.ssnLast4 : null, function () { return null; }) },
      { label: 'Effective date', frhc: ins.effectiveDate, existing: exc(ins.effectiveDate, function (cov) { return cov.effectiveDate; }) },
      { label: 'Termination date', frhc: ins.terminationDate, existing: exc(ins.terminationDate, function (cov) { return cov.terminationDate; }) },
      // 'Eligibility reason' DROPPED (same round): it is the SOURCE of the
      // eligibility status, and the Status row it explained was removed in the
      // 2026-08-19 review — reason-without-status is trivia here; the
      // eligibility story lives on the Member Eligibility card and RTV.
      { label: 'Last verified', infoOnly: true, frhc: null, existing: exc(null, function (cov) { return cov.lastVerifiedDate; }) },
    ];
  }

  // Demographic-only fields (identity attributes). The merged Demographic Data
  // modal concatenates these with buildContactDefs to show contact rows below.
  function buildDemographicOnlyDefs(p) {
    function ex(sim, getter) { return athenaExistingValue(sim, getter); }
    return [
      // Composed, source-backed (Craig, 2026-08-20) — same row the full Post
      // Data modal renders, so the scoped Demographics modal posts name parts
      // identically.
      composedNameDef(ex, p),
      { label: 'Preferred name', frhc: p.name.preferred, existing: ex(p.name.preferred, function (ath) { return ath.name && ath.name.preferred; }) },
      { label: 'Date of birth', frhc: p.dateOfBirth, existing: ex(p.dateOfBirth, function (ath) { return ath.dateOfBirth; }) },
      { label: 'Sex', frhc: p.sex, existing: ex(p.sex, function (ath) { return ath.sex; }) },
      // Gender identity / Pronouns / Preferred language rows REMOVED 2026-08-19
      // (Craig's demographics field-set review): no insurance-discovery or
      // eligibility role. Marital status / Race / Ethnicity ruled KEEP for now.
      { label: 'Marital status', frhc: p.maritalStatus, existing: ex(p.maritalStatus, function (ath) { return ath.maritalStatus; }) },
      { label: 'Race', frhc: p.race, existing: ex(p.race, function (ath) { return ath.race; }) },
      { label: 'Ethnicity', frhc: p.ethnicity, existing: ex('Hispanic', function (ath) { return ath.ethnicity; }) },
      { label: 'SSN', frhc: p.ssnLast4 ? '•••-••-' + p.ssnLast4 : null, existing: ex(p.ssnLast4 ? '•••-••-' + p.ssnLast4 : null, function (ath) { return ath.ssnLast4 ? '•••-••-' + ath.ssnLast4 : null; }) },
      // Employer ADDED 2026-08-19 (Craig's field-set review) — see the note on
      // the buildDemographicDefs copy of this row.
      { label: 'Employer', frhc: p.employer && p.employer.name, existing: ex(p.employer && p.employer.name, function (ath) { return ath.employer && ath.employer.name; }) },
    ];
  }

  // Contact fields (phone, email, preferred method, address, emergency contact)
  // — appended below the demographic fields in the merged Demographic Data modal.
  function buildContactDefs(p) {
    var c = p.contact || {};
    var emergency = composeEmergencyLine(p.emergencyContact);
    function ex(sim, getter) { return athenaExistingValue(sim, getter); }
    return [
      { label: 'Mobile phone', frhc: c.mobilePhone, existing: ex((c.mobilePhone || '').replace(/[()]/g, '').replace(/\s+/g, '-'), function (ath) { return ath.contact && ath.contact.mobilePhone; }) },
      { label: 'Home phone', frhc: c.homePhone, existing: ex(c.homePhone, function (ath) { return ath.contact && ath.contact.homePhone; }) },
      { label: 'Email', frhc: c.email, existing: ex(c.email, function (ath) { return ath.contact && ath.contact.email; }) },
      // 'Preferred contact method' row REMOVED 2026-08-19 (Craig's demographics
      // field-set review): an MU checkbox athena's own docs call "not used by
      // any automated systems" — and athena has no single such field anyway
      // (nine contactpreference_<purpose>_<channel> booleans), so the EXISTING
      // column was null by construction.
      composedAddressDef(ex, p.address),
      { label: 'Emergency contact', frhc: emergency, existing: ex(emergency, function (ath) { return composeEmergencyLine(ath.emergencyContact); }) },
    ];
  }

  // 27A: buildBalanceDefs + the scoped "Balance Data" modal were REMOVED — the
  // Balance surface is a product no-go (card superseded by Good Faith Estimates;
  // the scoped modal had no live entry point since the card's removal). The
  // server payload's balance block is intentionally untouched (not in scope).

  // ===========================================================================
  // Step 25B: Appointments — data model + profile card (replaces the encounter
  // banner as the Appointment tab's primary surface).
  // ---------------------------------------------------------------------------
  // Two honest sources, one working copy:
  //   - APPOINTMENTS_DATAVIEW_SEED simulates athena's NIGHTLY DATAVIEW batch
  //     feed — possibly stale, stamped "as of {yesterday}".
  //   - "Refresh from athena" simulates the live
  //     GET /patients/{patientid}/appointments — a SUPERSET of the dataview
  //     (a same-day walk-in the overnight feed could not contain).
  // The working copy follows the claims/24D1 pattern: frozen seed -> mutable
  // copy, re-seeded (and the live flag reset) on a DIFFERENT-patient context
  // change. Member IDs reuse the patient's real mock ids where the payer
  // matches (BCBS of Texas, Aetna) and are mock values otherwise. Dates
  // reconcile with the existing mock record: APT-88843 is the current
  // encounter (E-558843, 2026-06-03), APT-71022 matches lastVisit
  // (2026-03-01), APT-90177 matches nextAppointment (2026-09-02).
  // ===========================================================================
  var APPT_BCBS = Object.freeze({ payer: 'Blue Cross Blue Shield of Texas', memberId: 'XJT884512903' });
  var APPT_AETNA = Object.freeze({ payer: 'Aetna', memberId: 'W2049913' });

  var APPOINTMENTS_DATAVIEW_SEED = Object.freeze([
    {
      id: 'APT-62910', encounterId: null, date: '2025-12-10', time: '2:15 PM',
      type: 'Follow Up', provider: 'Dr. Marcus Bell, MD', department: 'Endocrinology',
      location: 'Austin Central Clinic \u2014 Suite 340', status: 'Completed',
      primary: { payer: 'Humana', memberId: 'H558204417' }, secondary: null,
    },
    {
      id: 'APT-71022', encounterId: null, date: '2026-03-01', time: '9:00 AM',
      type: 'Office Visit', provider: 'Dr. Rachel Nguyen, MD', department: 'Internal Medicine',
      location: 'Austin Central Clinic \u2014 Suite 210', status: 'Completed',
      primary: APPT_BCBS, secondary: APPT_AETNA,
    },
    {
      id: 'APT-77450', encounterId: null, date: '2026-04-17', time: '3:30 PM',
      type: 'Telehealth Follow Up', provider: 'Dr. Marcus Bell, MD', department: 'Endocrinology',
      location: 'Telehealth', status: 'Cancelled',
      primary: APPT_BCBS, secondary: APPT_AETNA,
    },
    {
      // The CURRENT encounter's appointment — matched to the launch encounter
      // by encounterId (E-558843), which drives the card's "Current" highlight
      // and the Post Data tab's pre-check.
      id: 'APT-88843', encounterId: 'E-558843', date: '2026-06-03', time: '10:30 AM',
      type: 'Office Visit', provider: 'Dr. Rachel Nguyen, MD', department: 'Internal Medicine',
      location: 'Austin Central Clinic \u2014 Suite 210', status: 'Checked In',
      primary: APPT_BCBS, secondary: APPT_AETNA,
    },
    {
      id: 'APT-90177', encounterId: null, date: '2026-09-02', time: '11:00 AM',
      type: 'Office Visit', provider: 'Dr. Rachel Nguyen, MD', department: 'Internal Medicine',
      location: 'Austin Central Clinic \u2014 Suite 210', status: 'Scheduled',
      primary: APPT_BCBS, secondary: APPT_AETNA,
    },
  ]);

  function appointmentsFromSeed() {
    // Deep copy — 25C/25D will mutate working rows (statuses, applied insurance).
    return JSON.parse(JSON.stringify(APPOINTMENTS_DATAVIEW_SEED));
  }
  var APPOINTMENTS = appointmentsFromSeed();
  // True once "Refresh from athena" has replaced the dataview with the live
  // set for THIS patient; reset on patient switch (the dataview is what a
  // fresh launch would have on hand).
  var appointmentsRefreshedFromAthena = false;

  // Yesterday as YYYY-MM-DD — the honest "as of" stamp for a nightly batch
  // feed (it ran overnight, so its snapshot predates today).
  function apptDataviewAsOf() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // The live-only row: a same-day walk-in booked AFTER the overnight dataview
  // ran, so only the live athena call knows about it. Rebuilt per refresh so
  // its date is always "today".
  function apptLiveWalkIn() {
    return {
      id: 'APT-93110', encounterId: null, date: rtvToday(), time: '1:45 PM',
      type: 'Walk-In Visit', provider: 'Dr. Marcus Bell, MD', department: 'Internal Medicine',
      location: 'Austin Central Clinic \u2014 Suite 210', status: 'Scheduled',
      primary: APPT_BCBS, secondary: APPT_AETNA,
    };
  }

  // In production this is the live GET /patients/{patientid}/appointments; the
  // seeded list above is the nightly batch DATAVIEW feed. Idempotent: the live
  // set is always re-derived from the frozen seed + the live-only rows, so
  // refreshing again yields the same set (no duplicates, no drift).
  // Step 25D: applied insurance updates are CARRIED THROUGH the re-derivation —
  // refresh must not silently revert them. Honest framing: in production the
  // per-appointment PUTs landed in athena, so a live re-fetch would return the
  // UPDATED insurance anyway; reverting here would be the dishonest behavior.
  function applyLiveAppointments() {
    var applied = {};
    APPOINTMENTS.forEach(function (a) {
      if (a.insuranceUpdatedDate) {
        applied[a.id] = { primary: a.primary, secondary: a.secondary, insuranceUpdatedDate: a.insuranceUpdatedDate };
      }
    });
    APPOINTMENTS = appointmentsFromSeed().concat([apptLiveWalkIn()]);
    APPOINTMENTS.forEach(function (a) {
      var u = applied[a.id];
      if (u) {
        a.primary = u.primary;
        a.secondary = u.secondary;
        a.insuranceUpdatedDate = u.insuranceUpdatedDate;
      }
    });
    appointmentsRefreshedFromAthena = true;
  }

  // ---------------------------------------------------------------------------
  // Step 25D: the session's insurance changes — the gate + "what will be
  // applied" source. There are changes to apply when discovery found coverage
  // this session OR eligibility verified it (the 25A OR-recommendation,
  // adopted): both mean the session now holds insurance that the appointments'
  // on-file copies may predate. Returns null when neither has happened (gate
  // disabled). The payload is the patient's insurance AS IT NOW STANDS
  // (payer + member id — the fields appointment insurance carries) plus the
  // data-driven change-source label.
  // ---------------------------------------------------------------------------
  function sessionInsuranceCurrent() {
    if (!currentPatient) return null;
    if (!insuranceDiscovered && !insuranceAccumsVerified) return null;
    var ins = currentPatient.insurance || {};
    // 29D (fallback honesty): never fabricate a verification date. The label
    // says "Eligibility verified", so if the accumulator stamp is somehow null
    // (defensive-only today — insuranceAccumsVerified and insuranceVerifiedDate
    // are set together in runEligibilityCheck), fall back to the eligibility
    // CHECK's real stamp; if both are empty, omit the date clause entirely.
    // The old code minted TODAY here, presenting a run that never happened.
    var verifiedStamp = insuranceVerifiedDate || checkStamp('eligibility');
    var source = insuranceDiscovered
      ? 'Coverage discovered this session'
      : (verifiedStamp ? 'Eligibility verified ' + verifiedStamp : 'Eligibility verified');
    return {
      primary: ins.primary ? { payer: ins.primary.payer, memberId: ins.primary.memberId } : null,
      secondary: ins.secondary ? { payer: ins.secondary.payer, memberId: ins.secondary.memberId } : null,
      source: source,
    };
  }

  // Mock business rule (PENDING Craig's athena testing — may flip; one-line
  // change here if athena allows post-check-in updates): appointment insurance
  // canNOT be updated once checked in. Scheduled = updatable; Checked In /
  // Completed = not updatable; Cancelled = not applicable.
  function appointmentInsuranceUpdatability(a) {
    if (a.status === 'Scheduled') return { updatable: true, reason: null };
    if (a.status === 'Checked In') return { updatable: false, reason: 'Not updatable \u2014 checked in' };
    if (a.status === 'Completed') return { updatable: false, reason: 'Not updatable \u2014 completed' };
    return { updatable: false, reason: 'Not applicable \u2014 cancelled' };
  }

  // The per-appointment mutation — overwrites the working-copy row's insurance
  // with the session's current set and stamps it. In production this is where
  // the INDIVIDUAL PUT/POST /appointments/{appointmentid}/insurances call goes
  // (no batch endpoint exists — exactly why the modal shows sequential
  // per-appointment results).
  // 26D: parametrized — `values` is the insurance set to write ({ primary,
  // secondary } of { payer, memberId }). The 25D card flow keeps passing
  // sessionInsuranceCurrent() explicitly; the Post Data run passes ITS
  // resolved Payer/Member ID choices. Explicit default: a value-less call
  // falls back to the session-current set (never writes undefined).
  function applyInsuranceUpdateToAppointment(a, values) {
    var v = values || sessionInsuranceCurrent();
    if (!v) return;
    a.primary = v.primary ? { payer: v.primary.payer, memberId: v.primary.memberId } : a.primary;
    a.secondary = v.secondary ? { payer: v.secondary.payer, memberId: v.secondary.memberId } : null;
    a.insuranceUpdatedDate = rtvToday();
  }

  // 26D: ONE result-state styler for every sequential-run status element —
  // the 25D card flow's per-appointment rows AND the Post Data run's
  // per-section + per-appointment rows (R-25 pending/success/failed tones).
  function setRunResultState(node, kind, text) {
    node.textContent = text;
    if (kind === 'pending') css(node, { color: '#d97706', fontStyle: 'italic', fontWeight: '600' });
    else if (kind === 'failed') css(node, { color: '#dc2626', fontStyle: 'normal', fontWeight: '700' });
    // 'uncertain' — the ADR-ATH-010 insurance-write outcome: a non-idempotent
    // CREATE that may or may not have landed. Amber and settled (not the
    // italic in-flight pending style): it is a FINAL state requiring human
    // reconciliation, never a retry.
    else if (kind === 'uncertain') css(node, { color: '#d97706', fontStyle: 'normal', fontWeight: '700' });
    else css(node, { color: '#16a34a', fontStyle: 'normal', fontWeight: '700' });
  }

  // --- 26B: the ONE shared select-phase engine -------------------------------
  // Two surfaces render appointment selection — the 25D card flow
  // (openApplyInsuranceModal) and the Post Data modal's restored Appointments
  // tab. Both MUST render from this one implementation (rule + row builder);
  // never fork a second copy. appointmentInsuranceUpdatability() above is the
  // shared rule; these are the shared presentation pieces extracted from 25D.

  // One line summarizing a working-copy row's CURRENT insurance.
  function insuranceLineText(a) {
    var s = a.primary.payer + ' \u00B7 ' + a.primary.memberId;
    if (a.secondary) s += ' \u00B7 2nd: ' + a.secondary.payer;
    return s;
  }

  // Date-ascending copy of the shared working copy — both surfaces list rows
  // in the same order.
  function sortedAppointments() {
    return APPOINTMENTS.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  // Builds ONE select-phase checkbox row (25D presentation, verbatim):
  // APT id · date·time·type · status badge · current-insurance line;
  // Scheduled rows selectable + PRE-CHECKED, Checked In / Completed / Cancelled
  // visible but disabled with the rule's reason line. Returns the same row
  // state shape 25D's sequential phases consume ({ appt, cb, row, insLine,
  // result }). opts:
  //   onChange      — checkbox change listener (updatable rows only).
  //   markForSubmit — Post Data modal REVIEW tab only: tags the checkbox
  //                   (.post-appointment + data-appt-id) so the 26D run
  //                   capture (startPostRun) can collect checked ids.
  function buildAppointmentSelectRow(a, opts) {
    opts = opts || {};
    var upd = appointmentInsuranceUpdatability(a);
    var row = el('label');
    css(row, {
      display: 'flex', alignItems: 'flex-start', gap: '10px',
      border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
      padding: '10px 12px', background: '#fff',
      cursor: upd.updatable ? 'pointer' : 'default',
      opacity: upd.updatable ? '1' : '0.6',
    });
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = upd.updatable;   // updatable rows pre-checked
    cb.disabled = !upd.updatable;
    if (opts.markForSubmit) {
      cb.className = 'post-appointment';
      cb.setAttribute('data-appt-id', a.id);
    }
    css(cb, { marginTop: '3px', flex: '0 0 auto' });

    var main = el('div');
    css(main, { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1', minWidth: '0' });
    var top = el('div');
    css(top, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    var idEl = el('span', null, a.id);
    css(idEl, { fontFamily: THEME.mono, fontWeight: '700', fontSize: '12px', color: THEME.slate900 });
    var when = el('span', null, fmtRunDate(a.date) + ' \u00B7 ' + a.time + ' \u00B7 ' + a.type);
    css(when, { fontSize: '12px', color: THEME.slate900 });
    var badge = el('span', statusBadgeClass(a.status), a.status);
    top.appendChild(idEl); top.appendChild(when); top.appendChild(badge);
    main.appendChild(top);
    var insLine = el('div', null, insuranceLineText(a));
    css(insLine, { fontSize: '12px', color: THEME.slate500 });
    main.appendChild(insLine);
    if (!upd.updatable) {
      var reason = el('div', null, upd.reason);
      css(reason, { fontSize: '12px', color: THEME.slate500, fontStyle: 'italic' });
      main.appendChild(reason);
    }

    // Per-row result slot — 25D's pending/result states render here (phase
    // 2/3); the Post Data tab gains the same slot in 26D's async submit.
    var result = el('span');
    css(result, { flex: '0 0 auto', fontSize: '12px', alignSelf: 'center', whiteSpace: 'nowrap' });

    row.appendChild(cb); row.appendChild(main); row.appendChild(result);
    if (upd.updatable && typeof opts.onChange === 'function') cb.addEventListener('change', opts.onChange);
    return { appt: a, cb: cb, row: row, insLine: insLine, result: result };
  }

  // Freshness stamp — data-driven, shared by the card face and the status-dot
  // tip so they can never disagree.
  function appointmentsSourceStamp() {
    return appointmentsRefreshedFromAthena
      ? 'Live from NextGen \u00B7 retrieved ' + fmtRunDate(rtvToday())
      : 'Nightly dataview \u00B7 as of ' + fmtRunDate(apptDataviewAsOf());
  }

  // Single source for the collapsed key-status (and anything else that needs
  // the one-liner): count + the most useful date signal.
  function appointmentsSummaryLine() {
    var total = APPOINTMENTS.length;
    if (!total) return 'No appointments on file';
    var today = rtvToday();
    var todayCount = 0;
    var nextDate = null;
    APPOINTMENTS.forEach(function (a) {
      if (a.status === 'Cancelled') return;
      if (a.date === today) todayCount += 1;
      else if (a.date > today && a.status === 'Scheduled' && (!nextDate || a.date < nextDate)) nextDate = a.date;
    });
    var label = total + (total === 1 ? ' appointment' : ' appointments');
    if (todayCount) return label + ' \u00B7 ' + todayCount + ' today';
    if (nextDate) return label + ' \u00B7 next ' + fmtRunDate(nextDate);
    return label;
  }

  // Status-dot entry — computed at wire time. Amber while on the stale-possible
  // dataview, green once refreshed live; the tip is the freshness stamp itself.
  function appointmentsDotStatus(green, amber) {
    return {
      color: appointmentsRefreshedFromAthena ? green : amber,
      tip: appointmentsSourceStamp(),
    };
  }

  // Builds (idempotently) the Appointments profile card as the FIRST card on
  // the Appointment tab (it replaces the encounter banner as the tab's primary
  // surface; the GFE card follows it).
  function renderAppointmentsCard(p) {
    var grid = document.querySelector('#tab-appointment .card-grid');
    if (!grid) return;
    var existing = $('appointments-card');
    // Step 13: position-stable re-render; first mount goes to the TOP of the grid.
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : grid.firstChild;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'appointments-card';
    card.setAttribute('aria-label', 'Appointments');
    css(card, { position: 'relative' });

    card.appendChild(el('h2', null, 'Appointments'));
    card.appendChild(el('p', 'card-sub',
      'Patient schedule from NextGen \u2014 nightly dataview feed with on-demand live refresh'));

    // Freshness stamp + the Refresh action.
    var srcRow = el('div');
    css(srcRow, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '10px', flexWrap: 'wrap', marginTop: '12px',
    });
    var stamp = el('span', null, appointmentsSourceStamp());
    css(stamp, { fontSize: '12px', color: THEME.slate500 });
    var refreshBtn = el('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh from NextGen';
    css(refreshBtn, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 12px', fontSize: '12px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    refreshBtn.addEventListener('click', function () {
      if (refreshBtn.disabled) return;
      // Established async pattern (~1s pending, disabled) with the Step-16
      // runPatientId bail-out.
      var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing\u2026';
      css(refreshBtn, { opacity: '0.7', cursor: 'default' });
      setTimeout(function () {
        // Patient switched mid-run: the context-change reseed already reset the
        // working copy — do NOT apply the previous patient's live results (the
        // switch also re-rendered this card, so the pending button is gone).
        if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) return;
        applyLiveAppointments();
        renderAppointmentsCard(currentPatient); // stamp/rows/dot recompute
        wireCollapsibleCards();                 // collapsed key-status refresh
      }, 1000);
    });
    var btnWrap = el('div');
    css(btnWrap, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    btnWrap.appendChild(refreshBtn);

    // Step 25D: the apply-insurance launcher. Gated on the session actually
    // holding insurance changes (discovery OR verified eligibility — the 25A
    // OR-recommendation); otherwise honestly disabled with the reason below.
    var sessionIns = sessionInsuranceCurrent();
    var applyBtn = el('button');
    applyBtn.type = 'button';
    applyBtn.id = 'appointments-apply-insurance';
    applyBtn.textContent = 'Apply insurance updates';
    css(applyBtn, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 12px', fontSize: '12px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    if (!sessionIns) {
      applyBtn.disabled = true;
      css(applyBtn, { opacity: '0.5', cursor: 'default', borderColor: THEME.borderInput, color: THEME.slate500 });
    } else {
      applyBtn.addEventListener('click', function () { openApplyInsuranceModal(); });
    }
    btnWrap.appendChild(applyBtn);

    srcRow.appendChild(stamp);
    srcRow.appendChild(btnWrap);
    card.appendChild(srcRow);

    // Honest gate note — shown only while there is nothing to apply.
    if (!sessionIns) {
      var gateNote = el('div', null,
        'No insurance changes this session \u2014 run discovery or verify eligibility first.');
      css(gateNote, { marginTop: '6px', fontSize: '12px', color: THEME.slate500, fontStyle: 'italic' });
      card.appendChild(gateNote);
    }

    // Appointment rows — 23B compact style, chronological. 25C: rows are now
    // navigable — the 24D2 claim-row affordance (button, hover border/shadow,
    // trailing chevron) opening the read-only appointment-detail modal.
    var list = el('div');
    css(list, { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' });
    var rows = APPOINTMENTS.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    if (!rows.length) {
      var empty = el('div', null, 'No appointments on file for this patient.');
      css(empty, { fontSize: '13px', color: THEME.slate500 });
      list.appendChild(empty);
    }
    var curEncId = p && p.encounter && p.encounter.id;
    rows.forEach(function (a) {
      var isCurrent = !!(curEncId && a.encounterId === curEncId);
      // The current row keeps its navy accent border; hover restores to it.
      var baseBorder = isCurrent ? THEME.navy : THEME.borderSoft;
      var row = el('button');
      row.type = 'button';
      row.setAttribute('data-appointment-id', a.id);
      row.setAttribute('aria-label', 'Open appointment ' + a.id);
      css(row, {
        display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
        textAlign: 'left', border: '1px solid ' + baseBorder, borderRadius: '8px',
        padding: '10px 12px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      });
      row.addEventListener('mouseenter', function () {
        row.style.borderColor = THEME.teal; row.style.boxShadow = '0 1px 6px rgba(15,23,42,0.08)';
      });
      row.addEventListener('mouseleave', function () {
        row.style.borderColor = baseBorder; row.style.boxShadow = 'none';
      });
      row.addEventListener('click', function () { openAppointmentDetailModal(a); });

      // Info column (flex 1) — the 25B content lines live here; chevron trails.
      var info = el('div');
      css(info, { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1', minWidth: '0' });

      var top = el('div');
      css(top, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
      var when = el('span', null, fmtRunDate(a.date) + ' \u00B7 ' + a.time + ' \u00B7 ' + a.type);
      css(when, { fontWeight: '700', fontSize: '13px', color: THEME.slate900 });
      top.appendChild(when);
      if (isCurrent) top.appendChild(el('span', 'badge badge-blue', 'Current'));
      var badge = el('span', statusBadgeClass(a.status), a.status);
      css(badge, { marginLeft: 'auto' });
      top.appendChild(badge);
      info.appendChild(top);

      var sub = el('div', null, a.provider + ' \u00B7 ' + a.department + ' \u00B7 ' + a.location);
      css(sub, { fontSize: '12px', color: THEME.slate500 });
      info.appendChild(sub);

      // Trailing chevron — the GFE/claim-list navigation affordance.
      var chev = el('span', null, '\u203A');
      css(chev, { fontSize: '20px', color: THEME.slate500, lineHeight: '1', flex: '0 0 auto', alignSelf: 'center' });

      row.appendChild(info); row.appendChild(chev);
      list.appendChild(row);
    });
    card.appendChild(list);

    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot

    // Same 24C timing rule: dot wiring must run BEFORE wireCollapsibleCards
    // mutates the h2 (title lookup keys on its textContent). Idempotent.
    wireCardStatusDots();
  }

  // Step 25C: read-only appointment detail modal — shared 600px shell (see
  // openClaimDetailModal). Simulates the LIVE per-selection round trip (R-5:
  // the LIST may come from the stale nightly dataview, but a selected
  // appointment's detail is fetched live): the modal opens IMMEDIATELY with a
  // compact "Retrieving…" state, then renders the detail after a short beat.
  // Strict Step-16 scoping: if the athena context switches patients mid-fetch,
  // the modal closes without rendering (never show one patient's appointment
  // under another patient's session). No mutations — 25D adds the
  // apply-insurance action.
  function openAppointmentDetailModal(appt) {
    if (!currentPatient) return;
    var p = currentPatient;
    var prevFocus = document.activeElement;
    // 25D hardening: the simulated-fetch timer is tracked so closeModal can
    // clear it if the modal is dismissed during the loading phase.
    var pendingFetchTimer = null;

    var overlay = el('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', zIndex: '1000', overflowY: 'auto',
    });
    var dialog = el('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Appointment ' + appt.id);
    css(dialog, {
      background: '#ffffff', borderRadius: '12px', width: '100%', maxWidth: '600px',
      maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      boxShadow: '0 20px 45px rgba(0,0,0,0.28)', color: THEME.slate900, fontFamily: 'inherit',
    });

    function closeModal() {
      deregisterCloser(); // 27B: idempotent — no-op when the registry already cleared it
      // 25D hardening: dismissing during the loading phase cancels the
      // simulated fetch — no render fires against a detached body.
      if (pendingFetchTimer) { clearTimeout(pendingFetchTimer); pendingFetchTimer = null; }
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape' && document.body.lastElementChild === overlay) closeModal();
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKey);
    // 27B: a patient switch force-closes this modal through the shared
    // registry; closeModal already clears the pending simulated-fetch timer.
    var deregisterCloser = registerModalCloser(closeModal);

    // --- header (shared shell: navy gradient, title + patient name·MRN) ---
    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '16px 20px', color: '#ffffff',
      borderTopLeftRadius: '12px', borderTopRightRadius: '12px',
      backgroundImage: THEME.navyGradient,
    });
    var headText = el('div');
    var hTitle = el('div', null, 'Appointment ' + appt.id);
    css(hTitle, { fontSize: '16px', fontWeight: '700' });
    var hSub = el('div', null, identitySubLine(p));
    css(hSub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    headText.appendChild(hTitle); headText.appendChild(hSub);
    head.appendChild(headText);

    // --- body: opens in the retrieving state, then renders the detail ---
    var body = el('div');
    css(body, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '20px', background: '#ffffff' });

    var loading = el('div', null, 'Retrieving appointment from NextGen\u2026');
    css(loading, { fontSize: '13px', color: THEME.slate500, fontStyle: 'italic', padding: '10px 0' });
    body.appendChild(loading);

    function sectionHeading(text) {
      var h = el('div', null, text);
      css(h, {
        fontSize: '12px', fontWeight: '700', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px',
      });
      return h;
    }

    // Everything renders from the working-copy row — read-only (25D mutates).
    function renderDetail() {
      while (body.firstChild) body.removeChild(body.firstChild);
      var isCurrent = !!(p.encounter && appt.encounterId && appt.encounterId === p.encounter.id);

      // --- 1. Top line: date · time · type + Current chip + status badge ---
      var topLine = el('div');
      css(topLine, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
      var when = el('span', null, fmtRunDate(appt.date) + ' \u00B7 ' + appt.time + ' \u00B7 ' + appt.type);
      css(when, { fontWeight: '700', fontSize: '15px', color: THEME.slate900 });
      topLine.appendChild(when);
      if (isCurrent) topLine.appendChild(el('span', 'badge badge-blue', 'Current'));
      var badge = el('span', statusBadgeClass(appt.status), appt.status);
      css(badge, { marginLeft: 'auto' });
      topLine.appendChild(badge);
      body.appendChild(topLine);

      // --- 2. Appointment kv-grid — only fields the row actually carries ---
      var kv = el('div');
      css(kv, {
        display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 14px',
        marginTop: '12px', fontSize: '13px',
      });
      function kvText(label, text) {
        var l = el('div', null, label);
        css(l, { color: THEME.slate500, fontWeight: '600', fontSize: '12px' });
        var v = el('div', null, text);
        css(v, { color: THEME.slate900 });
        kv.appendChild(l); kv.appendChild(v);
      }
      kvText('Provider', appt.provider);
      kvText('Department', appt.department);
      kvText('Location', appt.location);
      // Only the launch encounter's appointment carries an encounter link.
      if (appt.encounterId) kvText('Encounter', appt.encounterId);
      body.appendChild(kv);

      // --- 3. Insurance on file for this appointment ---
      var insWrap = el('div');
      css(insWrap, { marginTop: '20px' });
      insWrap.appendChild(sectionHeading('Insurance on file for this appointment'));
      var insList = el('div');
      css(insList, { display: 'flex', flexDirection: 'column', gap: '6px' });
      function insRow(rank, cov) {
        var box = el('div');
        css(box, {
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
          padding: '8px 12px', background: '#fff',
        });
        var tag = el('span', null, rank);
        css(tag, {
          fontSize: '12px', fontWeight: '700', color: THEME.slate500,
          textTransform: 'uppercase', letterSpacing: '0.05em', flex: '0 0 auto',
        });
        var payer = el('span', null, cov.payer);
        css(payer, { fontSize: '13px', fontWeight: '600', color: THEME.slate900 });
        var member = el('span', null, 'Member ID ' + cov.memberId);
        css(member, { fontFamily: THEME.mono, fontSize: '12px', color: THEME.slate500, marginLeft: 'auto' });
        box.appendChild(tag); box.appendChild(payer); box.appendChild(member);
        return box;
      }
      insList.appendChild(insRow('Primary', appt.primary));
      if (appt.secondary) {
        insList.appendChild(insRow('Secondary', appt.secondary));
      } else {
        var noSec = el('div', null, 'No secondary coverage on file for this appointment.');
        css(noSec, { fontSize: '12px', color: THEME.slate500 });
        insList.appendChild(noSec);
      }
      insWrap.appendChild(insList);
      // Step 25D: when THIS appointment's insurance was updated this session,
      // show the honest updated-stamp (set by applyInsuranceUpdateToAppointment).
      if (appt.insuranceUpdatedDate) {
        var updStamp = el('div', null, 'Insurance updated ' + fmtRunDate(appt.insuranceUpdatedDate));
        css(updStamp, { marginTop: '8px', fontSize: '12px', fontWeight: '600', color: '#16a34a' });
        insWrap.appendChild(updStamp);
      }
      // 25D re-point (was a "next step" placeholder): the action now exists on
      // the Appointments card.
      var insNote = el('div', null,
        'Session insurance changes can be applied from the Appointments card (\u201CApply insurance updates\u201D).');
      css(insNote, { marginTop: appt.insuranceUpdatedDate ? '4px' : '8px', fontSize: '12px', color: THEME.slate500, fontStyle: 'italic' });
      insWrap.appendChild(insNote);
      body.appendChild(insWrap);

      // --- 4. The modal's OWN freshness line — the detail was fetched live ---
      var fresh = el('div', null, 'Retrieved live from NextGen \u00B7 ' + fmtRunDate(rtvToday()));
      css(fresh, { marginTop: '20px', fontSize: '12px', color: THEME.slate500 });
      body.appendChild(fresh);
    }

    // Production: this is where the live GET /appointments/{appointmentid}
    // call goes — the detail is fetched per selection even though the list may
    // come from the nightly dataview. Simulated here as a short round trip
    // against the working-copy row (established async pattern).
    // 25D hardening: the pending timer is cleared on early close (Esc/overlay/
    // Cancel during the loading phase) so no detached-node render fires.
    var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
    pendingFetchTimer = setTimeout(function () {
      pendingFetchTimer = null;
      // Mid-fetch patient switch: ABORT without rendering — close outright.
      if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) {
        closeModal();
        return;
      }
      renderDetail();
    }, 700);

    // --- footer (Cancel only — read-only view) ---
    var footer = el('div');
    css(footer, {
      flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '10px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: '#ffffff',
      borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
    });
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    css(cancel, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    cancel.addEventListener('click', closeModal);
    footer.appendChild(cancel);

    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    cancel.focus();
  }

  // ===========================================================================
  // Step 25D: Apply insurance updates — Post-Data-style multi-select modal,
  // three phases (RTV-modal precedent extended with the NEW sequential
  // per-appointment mechanic):
  //   1. Select  — "what will be applied" summary + checkbox rows for ALL
  //      working-copy appointments (updatable pre-checked; not-updatable rows
  //      SHOWN disabled with the reason — showing beats hiding, the user
  //      learns WHY; deliberately differs from the old Post-Data tab's hiding).
  //   2. Apply   — selected rows process ONE AT A TIME (pending → result,
  //      ~600ms apart). Production reality drives this UI: the real call is an
  //      INDIVIDUAL PUT/POST /appointments/{appointmentid}/insurances per id —
  //      there is NO batch endpoint — so per-appointment sequential results
  //      are the honest rendering. Footer disabled during the run (no
  //      mid-sequence cancel complexity). runPatientId bail-out stops the
  //      sequence immediately on a mid-run patient switch (already-applied
  //      rows stay applied; the switch re-seed wipes them anyway).
  //   3. Summary — settled "N updated · N failed" line + rows in final states;
  //      footer becomes Done. Close re-renders the card so updated insurance
  //      is visible everywhere (card/detail/Post Data — one working copy).
  // Deterministic mock: no random failures, but 'failed' is a real code path
  // (R-25 pending/success/failed vocabulary), not a redesign.
  // ===========================================================================
  function openApplyInsuranceModal() {
    var current = sessionInsuranceCurrent();
    if (!currentPatient || !current) return;
    var p = currentPatient;
    var prevFocus = document.activeElement;
    var running = false;       // phase 2 in flight — closes are refused
    var appliedAny = false;    // at least one row mutated — close re-renders the card
    var seqTimer = null;
    // Gap closed 2026-08-13 (Craig): this modal writes the SAME per-appointment
    // athena insurance data as the Insurance modal's Appointments tab, which
    // notifies athenaOne on close — this one never did (the single notify call
    // site lived in the post-modal family only). Same pattern as
    // postModalCloseNotify: armed at settle, fired ONCE on any close path,
    // context-guarded so a patient switch between settle and close sends
    // nothing. A mid-run switch never arms it (finish() is never reached).
    var closeNotify = null;
    var runPatientId = null;
    var appliedIds = [];

    var overlay = el('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', zIndex: '1000', overflowY: 'auto',
    });
    var dialog = el('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Apply insurance updates');
    css(dialog, {
      background: '#ffffff', borderRadius: '12px', width: '100%', maxWidth: '600px',
      maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      boxShadow: '0 20px 45px rgba(0,0,0,0.28)', color: THEME.slate900, fontFamily: 'inherit',
    });

    // forceClose bypasses the running guard (mid-sequence patient switch);
    // closeModal is the user-facing close (refused during the run — the
    // footer is disabled, and Esc/overlay honor the same rule).
    function forceClose() {
      deregisterCloser(); // 27B: idempotent — no-op when the registry already cleared it
      if (seqTimer) { clearTimeout(seqTimer); seqTimer = null; }
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      // The card re-renders so applied insurance is visible immediately (the
      // detail modals + Post Data tab read the same working copy).
      if (appliedAny && currentPatient) {
        renderAppointmentsCard(currentPatient);
        wireCollapsibleCards();
      }
      // Fired once, whatever the close path (Done/X-less Esc/overlay/registry
      // force-close) — the guard inside skips it when the patient switched.
      if (typeof closeNotify === 'function') {
        var fn = closeNotify;
        closeNotify = null;
        fn();
      }
    }
    function closeModal() {
      if (running) return;
      forceClose();
    }
    function onKey(e) {
      if (e.key === 'Escape' && document.body.lastElementChild === overlay) closeModal();
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKey);
    // 27B: register the RUN-GUARD-BYPASSING closer — a patient switch must
    // close even mid-run. The 25D runPatientId bail-outs still stop the
    // sequential engine; the registry complements them, it does not replace
    // them (forceClose also clears seqTimer).
    var deregisterCloser = registerModalCloser(forceClose);

    // --- header (shared shell) ---
    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '16px 20px', color: '#ffffff',
      borderTopLeftRadius: '12px', borderTopRightRadius: '12px',
      backgroundImage: THEME.navyGradient,
    });
    var headText = el('div');
    var hTitle = el('div', null, 'Apply insurance updates');
    css(hTitle, { fontSize: '16px', fontWeight: '700' });
    var hSub = el('div', null, identitySubLine(p));
    css(hSub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    headText.appendChild(hTitle); headText.appendChild(hSub);
    head.appendChild(headText);

    // --- body ---
    var body = el('div');
    css(body, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '20px', background: '#ffffff' });

    function sectionHeading(text) {
      var h = el('div', null, text);
      css(h, {
        fontSize: '12px', fontWeight: '700', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px',
      });
      return h;
    }

    // --- 1. What will be applied — the session's insurance as it now stands ---
    body.appendChild(sectionHeading('What will be applied'));
    var sumBox = el('div');
    css(sumBox, {
      border: '1px solid ' + THEME.border, borderRadius: '8px', padding: '12px 14px',
      background: THEME.inset, display: 'flex', flexDirection: 'column', gap: '6px',
    });
    function sumLine(rank, cov) {
      var line = el('div');
      css(line, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '13px' });
      var tag = el('span', null, rank);
      css(tag, {
        fontSize: '12px', fontWeight: '700', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.05em', flex: '0 0 auto',
      });
      var payer = el('span', null, cov.payer);
      css(payer, { fontWeight: '600', color: THEME.slate900 });
      var member = el('span', null, 'Member ID ' + cov.memberId);
      css(member, { fontFamily: THEME.mono, fontSize: '12px', color: THEME.slate500, marginLeft: 'auto' });
      line.appendChild(tag); line.appendChild(payer); line.appendChild(member);
      return line;
    }
    if (current.primary) sumBox.appendChild(sumLine('Primary', current.primary));
    if (current.secondary) sumBox.appendChild(sumLine('Secondary', current.secondary));
    var srcLine = el('div', null, current.source);
    css(srcLine, { fontSize: '12px', color: THEME.slate500, fontStyle: 'italic' });
    sumBox.appendChild(srcLine);
    body.appendChild(sumBox);

    // --- 2. Appointment checkbox rows (23B/Post-Data row style) ---
    var apptHead = sectionHeading('Appointments');
    css(apptHead, { marginTop: '20px' });
    body.appendChild(apptHead);
    // Phase-3 summary slot — empty until the sequence settles.
    var summaryStatus = el('div');
    summaryStatus.setAttribute('role', 'status');
    summaryStatus.setAttribute('aria-live', 'polite');
    css(summaryStatus, { display: 'none', marginBottom: '10px' });
    body.appendChild(summaryStatus);

    var rowsWrap = el('div');
    css(rowsWrap, { display: 'flex', flexDirection: 'column', gap: '8px' });
    // 26B: rows come from the SHARED select-phase engine (rule + row builder
    // extracted to module level) — the Post Data modal's Appointments tab
    // renders from the exact same functions. updateApplyLabel is a hoisted
    // function declaration below, so it is safe to reference here.
    var rowStates = [];
    sortedAppointments().forEach(function (a) {
      var st = buildAppointmentSelectRow(a, { onChange: updateApplyLabel });
      rowsWrap.appendChild(st.row);
      rowStates.push(st);
    });
    body.appendChild(rowsWrap);

    // --- footer: Cancel + Apply to N selected ---
    var footer = el('div');
    css(footer, {
      flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '10px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: '#ffffff',
      borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
    });
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    css(cancel, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    cancel.addEventListener('click', closeModal);
    var applyBtn = el('button'); applyBtn.type = 'button';
    css(applyBtn, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    function selectedStates() {
      return rowStates.filter(function (st) { return st.cb.checked && !st.cb.disabled; });
    }
    function updateApplyLabel() {
      var n = selectedStates().length;
      applyBtn.textContent = 'Apply to ' + n + ' selected';
      applyBtn.disabled = n === 0;
      css(applyBtn, { opacity: n === 0 ? '0.5' : '1', cursor: n === 0 ? 'default' : 'pointer' });
    }
    updateApplyLabel();
    footer.appendChild(cancel);
    footer.appendChild(applyBtn);

    // 26D: delegates to the SHARED run-result styler (also used by the Post
    // Data modal's posting phase) — labels stay 25D's Updating…/Updated/Failed.
    function setResult(st, kind) {
      setRunResultState(st.result, kind,
        kind === 'pending' ? 'Updating\u2026' : kind === 'updated' ? 'Updated' : 'Failed');
    }

    // --- Phase 2: the sequential per-appointment apply ---
    applyBtn.addEventListener('click', function () {
      if (running || applyBtn.disabled) return;
      var sel = selectedStates();
      if (!sel.length) return;
      running = true;
      // Disable the footer for the run — the simplest honest behavior (no
      // mid-sequence cancel); every checkbox locks too.
      cancel.disabled = true; applyBtn.disabled = true;
      css(cancel, { opacity: '0.5', cursor: 'default' });
      css(applyBtn, { opacity: '0.5', cursor: 'default' });
      rowStates.forEach(function (st) { st.cb.disabled = true; });

      runPatientId = currentAthenaContext && currentAthenaContext.patientId;
      appliedIds = [];
      var results = [];
      var idx = 0;
      function step() {
        if (idx >= sel.length) { finish(results); return; }
        var st = sel[idx];
        setResult(st, 'pending'); // this row's INDIVIDUAL call is in flight
        seqTimer = setTimeout(function () {
          seqTimer = null;
          // Mid-sequence patient switch: stop IMMEDIATELY — no further
          // mutations. Already-applied rows stay applied (the switch re-seed
          // wiped the working copy anyway); close outright, 25C-style.
          if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) {
            running = false;
            appliedAny = false; // reseed already replaced the working copy
            forceClose();
            return;
          }
          // Deterministic mock: every call succeeds. 'failed' stays a REAL
          // code path (R-25 pending/success/failed) so a live failure is a
          // data change here, not a redesign.
          var outcome = 'updated';
          if (outcome === 'updated') {
            applyInsuranceUpdateToAppointment(st.appt, current);
            appliedAny = true;
            appliedIds.push(st.appt.id);
            st.insLine.textContent = insuranceLineText(st.appt);
          }
          setResult(st, outcome);
          results.push(outcome);
          idx += 1;
          step();
        }, 600);
      }
      step();
    });

    // --- Phase 3: settled summary + Done footer ---
    function finish(results) {
      running = false;
      // Arm the close-time notify — athena data changed, so athenaOne gets the
      // documented reload command once the user has dismissed the results.
      closeNotify = function () {
        if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) return;
        try {
          window.AthenaMessaging.notifyPatientDataChange({
            // ATHENA context id, not the FRHC profile id (see the post-modal
            // family's note — same 2026-08-13 fix).
            athenaPatientId: runPatientId,
            postedAppointments: appliedIds.slice(),
          });
        } catch (e) { /* no-op outside athenaOne */ }
      };
      var updated = results.filter(function (r) { return r === 'updated'; }).length;
      var failed = results.filter(function (r) { return r === 'failed'; }).length;
      summaryStatus.textContent = updated + ' updated \u00B7 ' + failed + ' failed';
      css(summaryStatus, {
        display: 'block', fontSize: '12px', fontWeight: '700',
        color: failed ? '#dc2626' : '#16a34a',
        background: failed ? 'rgba(220,38,38,0.08)' : 'rgba(22,163,74,0.08)',
        border: '1px solid ' + (failed ? 'rgba(220,38,38,0.35)' : 'rgba(22,163,74,0.35)'),
        borderRadius: '6px', padding: '7px 10px',
      });
      while (footer.firstChild) footer.removeChild(footer.firstChild);
      var done = el('button', null, 'Done'); done.type = 'button';
      css(done, {
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      done.addEventListener('click', closeModal);
      footer.appendChild(done);
      done.focus();
    }

    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    cancel.focus();
  }

  // 26B (course correction of 26A): the Post Data modal's Appointments tab is
  // BACK — the modal is intentionally a one-stop posting surface (demographics
  // + insurance + applying those insurance updates to appointments), mirroring
  // what the cards offer individually. Rebuilt to 25D's standards via the
  // shared select-phase engine above (NOT a resurrection of the old tab, which
  // pre-checked a Checked-In row and carried a duplicate in-body Submit).
  // Semantics: the tab applies the insurance values chosen in THIS modal's
  // insurance tabs; in production that is the same per-appointment
  // PUT/POST /appointments/{appointmentid}/insurances calls as the card flow.
  // Selection only this step — sequential per-appointment results for BOTH
  // surfaces arrive in 26D. Returned as a custom-render tab def consumed by
  // buildPostModalImpl's existing t.render path (no appointmentsTab flag —
  // the two entry points that want the tab simply append this def).
  // ---- Coverage-order rulings of record (Craig, 2026-08-13) -------------------
  // The per-appointment call `PUT /appointments/{appointmentid}/insurances` is
  // needed for exactly ONE case, because appointment insurance are POINTERS
  // (`{primaryinsuranceid, secondaryinsuranceid}`) and not data:
  //   • FIELD EDIT on an existing policy → the appointment already points at
  //     that policy id, so the edit propagates implicitly. NO appointment call.
  //     (This SUPERSEDES the 2026-07-29 ruling's UPDATE half, which had the
  //     prototype firing a PUT per appointment on every insurance edit.)
  //   • CREATE → `POST /patients/{id}/insurances` carries
  //     `updateappointments: true`, so athena applies the new policy to every
  //     future appointment itself. NO per-appointment call.
  //   • RE-POINT (which EXISTING policy occupies which rank) → the pointers live
  //     on the appointment, so this is the only change that cannot be expressed
  //     any other way. THE appointment call exists for this.
  // Patient-level reorder is NOT done at all: athena has no reorder verb (a
  // sequence number cannot be assigned while another ACTIVE insurance holds it),
  // so it would require delete-then-create — deliberately out of scope (`FR-33`).
  // Appointment-level swap is `FR-60` / ST-E8 (CORE-337), recreated from V1
  // `UpdateProcessor.cs:280/:332`.
  //
  // plannedRepoint is the run-scoped record of a re-point: null when this modal
  // is only editing fields or creating policies (the common case, which posts no
  // appointment calls at all), or { movedPayer, from, to } when an existing
  // policy changes rank. Reset with the rest of the per-modal state.
  var plannedRepoint = null;

  function buildAppointmentsPostTabDef() {
    return {
      key: 'appointments',
      label: 'Appointments',
      render: function (panel) {
        // No re-point in this run → nothing to apply per appointment, and saying
        // so is the honest render. Previously this tab always offered the whole
        // appointment list and the run posted a PUT per checked row on ANY
        // insurance delta; that behavior was confirmed unnecessary (see the
        // ruling block above) and would bill athena writes nobody asked for.
        if (!plannedRepoint) {
          var none = el('div', null,
            'No coverage-order change in this run — nothing to apply per appointment.');
          css(none, { fontSize: '13px', fontWeight: '600', color: THEME.slate900, marginBottom: '6px' });
          panel.appendChild(none);
          var why = el('div', null,
            'Field edits to a policy already on file reach future appointments on their own, because an ' +
            'appointment stores a POINTER to the policy rather than a copy of it. A newly created policy is ' +
            'applied by NextGen itself (the create carries updateappointments). Only changing WHICH policy is ' +
            'primary vs secondary needs a per-appointment update — add or move a policy to see that here.');
          css(why, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.5' });
          panel.appendChild(why);
          return;
        }
        var header = el('div', null,
          'Coverage order is changing (' + plannedRepoint.movedPayer + ': ' + plannedRepoint.from +
          ' → ' + plannedRepoint.to + '). Select the future appointments to re-point:');
        css(header, { fontSize: '13px', color: THEME.slate900, marginBottom: '10px' });
        panel.appendChild(header);
        var rowsWrap = el('div');
        css(rowsWrap, { display: 'flex', flexDirection: 'column', gap: '8px' });
        // The SHARED working copy (25B) — after a card "Refresh from athena"
        // the walk-in appears here too. No in-body Submit: the footer Submit
        // covers the whole modal; markForSubmit lets the 26D run capture collect the
        // checked ids.
        sortedAppointments().forEach(function (a) {
          rowsWrap.appendChild(buildAppointmentSelectRow(a, { markForSubmit: true }).row);
        });
        panel.appendChild(rowsWrap);
      },
    };
  }

  // Maps an appointment status to one of the existing theme badge variants.
  // (25B: + Cancelled -> amber; Scheduled stays the neutral badge.)
  function statusBadgeClass(status) {
    if (status === 'Checked In') return 'badge badge-blue';
    if (status === 'Completed') return 'badge badge-green chip-icon-check';
    if (status === 'Cancelled') return 'badge badge-amber';
    return 'badge';
  }

  // STEP 31 (product decision of record, July 17): the COB swap — the
  // "Insurance Order (COB)" control that reordered a patient's primary/secondary
  // insurance — was REMOVED, not hidden. athena has a known inability to swap
  // insurance order via its API; FrontRunner will pursue an alternative with
  // athenahealth. Per the mock-honesty principle the app must not advertise a
  // capability the product cannot deliver. If an athena mechanism materializes,
  // the swap returns as a NEW step designed against it (see CHANGE-JOURNAL.md).

  function buildPostModalImpl(p, opts) {
    opts = opts || {};
    // R-25 (B1): clear any stamp-line refresher from a previously-built modal so a
    // modal WITHOUT a headerNote (e.g. the full Post Data modal) leaves no stale hook;
    // the headerNote block below re-assigns it when this modal has one.
    postModalHeaderNoteRefresh = null;
    // 26D: defensive — a freshly-built modal must never inherit a previous
    // modal's completion notify (showPostOverlay replaces without closing).
    postModalCloseNotify = null;
    // Same defensive reset for the re-point record: a planned coverage-order
    // change belongs to the modal that planned it. Inheriting it would offer
    // appointment re-pointing in a modal where nothing is moving rank.
    plannedRepoint = null;
    var overlay = document.createElement('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)', display: 'none',
      alignItems: 'center', justifyContent: 'center', padding: '24px', zIndex: '1000',
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePostModal();
    });

    var dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'post-modal-title');
    css(dialog, {
      // Step 11: cap at the athena embed iframe width (~600px) so the modal fits
      // within the embed rather than exceeding the app. width:100% + overlay
      // padding still shrinks it further inside a true 600px iframe.
      background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '600px', maxHeight: '90vh',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 45px rgba(0,0,0,0.28)',
    });

    // Header bar (navy gradient, matches the patient identity block).
    var head = document.createElement('div');
    css(head, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      padding: '16px 20px', backgroundImage: THEME.navyGradient, color: '#fff',
    });
    var titleWrap = document.createElement('div');
    var title = el('div', null, opts.title || 'Post Data');
    title.id = 'post-modal-title';
    css(title, { fontSize: '16px', fontWeight: '700' });
    var sub = el('div', null, opts.sub || (p.mrn ? p.name.full + ' · MRN ' + bareMrn(p.mrn) : p.name.full));
    css(sub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    var xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.textContent = '×';
    xBtn.setAttribute('aria-label', 'Close');
    css(xBtn, {
      background: 'transparent', border: 'none', color: '#fff', fontSize: '24px', lineHeight: '1',
      cursor: 'pointer', padding: '2px 8px', borderRadius: '8px',
    });
    xBtn.addEventListener('click', closePostModal);
    head.appendChild(titleWrap);
    head.appendChild(xBtn);

    // ---- Workflow action strip (FrontRunner refresh placeholder) --------------
    // Starts a placeholder "refresh" on the FrontRunner column: each tagged
    // cell gets a subtle pulse + spinner for a short window, simulating the real
    // FrontRunner API call that will replace this later. Re-clicking restarts the
    // window. Function declarations are hoisted, so the click handlers below can
    // call this even though it is defined here.
    var frhcRefreshTimer = null;
    // Tracks the cells currently animating so cleanup walks this list rather than
    // re-querying the live DOM — cells detached mid-refresh (modal close, tab
    // removal) are still cancelled deterministically instead of leaking infinite
    // animations.
    var loadingCells = [];
    function startCellLoading(cell) {
      if (cell._loading) return;
      cell._loading = true;
      loadingCells.push(cell);
      var spinner = document.createElement('span');
      spinner.setAttribute('aria-hidden', 'true');
      css(spinner, {
        display: 'inline-block', width: '11px', height: '11px', marginLeft: '6px',
        border: '2px solid ' + THEME.border, borderTopColor: THEME.navy, borderRadius: '50%',
        flex: 'none', boxSizing: 'border-box',
      });
      cell.appendChild(spinner);
      cell._spinner = spinner;
      // Web Animations API — scripted animation is not subject to the page CSP
      // (no inline <style>/keyframes needed). Guarded for older engines.
      if (typeof spinner.animate === 'function') {
        cell._spinAnim = spinner.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: 700, iterations: Infinity }
        );
      }
      if (typeof cell.animate === 'function') {
        cell._pulseAnim = cell.animate(
          [{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }],
          { duration: 1100, iterations: Infinity }
        );
      }
    }
    function stopCellLoading(cell) {
      if (!cell._loading) return;
      cell._loading = false;
      var i = loadingCells.indexOf(cell);
      if (i !== -1) loadingCells.splice(i, 1);
      if (cell._spinAnim) { cell._spinAnim.cancel(); cell._spinAnim = null; }
      if (cell._pulseAnim) { cell._pulseAnim.cancel(); cell._pulseAnim = null; }
      if (cell._spinner && cell._spinner.parentNode) cell._spinner.parentNode.removeChild(cell._spinner);
      cell._spinner = null;
      cell.style.opacity = '';
    }
    // Cancels the timer and every tracked animation (slice() so the list can be
    // mutated by stopCellLoading during iteration). Safe to call repeatedly.
    function stopFrhcRefresh() {
      if (frhcRefreshTimer) { clearTimeout(frhcRefreshTimer); frhcRefreshTimer = null; }
      loadingCells.slice().forEach(stopCellLoading);
    }
    function simulateFrhcRefresh() {
      stopFrhcRefresh();
      dialog.querySelectorAll('.frhc-cell').forEach(startCellLoading);
      frhcRefreshTimer = setTimeout(stopFrhcRefresh, 2600);
    }
    // 26D: the posting sequence's step timer — cleared on teardown alongside
    // the refresh animations (defensive: mid-run closes are refused and the
    // bail-out fires inside a settled timer, but a torn-down modal must never
    // leave a live timer behind).
    var seqTimer = null;
    // Exposed so closePostModal can deterministically tear down any in-flight
    // refresh when the modal is dismissed mid-animation.
    overlay._cleanupLoading = function () {
      stopFrhcRefresh();
      if (seqTimer) { clearTimeout(seqTimer); seqTimer = null; }
    };

    // Optional action strip rendered just below the header and above the tab bar.
    // Built when the caller supplies opts.headerActions = [{ label, message }, …]
    // (a single opts.headerAction object is still accepted for back-compat). Each
    // button matches the footer Submit button exactly (navy fill, white text, same
    // size/radius/weight); clicking one shows a dismissible confirmation message
    // below the buttons and kicks off the placeholder FrontRunner refresh. These
    // are intentional placeholders — the real FrontRunner API integration will
    // replace simulateFrhcRefresh() in a later phase.
    var headerActions = opts.headerActions || (opts.headerAction ? [opts.headerAction] : null);
    // A-C2: the Insurance modal's "Add New Insurance" control shares the header
    // strip with the verification runs but renders outlined (see `variant`
    // below). Appended to a COPY — the caller's array stays its own.
    if (opts.addableInsurance) {
      headerActions = (headerActions || []).slice();
      headerActions.push({
        label: 'Add New Insurance',
        variant: 'outline',
        // Deliberately no `message`: the form IS the feedback, and the default
        // placeholder branch must not fire simulateFrhcRefresh() — nothing has
        // been verified by opening a form.
        onClick: function () { openAddInsuranceForm(); },
      });
    }
    var actionBar = null;
    if (headerActions && headerActions.length) {
      actionBar = document.createElement('div');
      css(actionBar, {
        display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px',
        padding: '10px 20px', background: THEME.inset, borderBottom: '1px solid ' + THEME.border,
      });

      // Part 5.6 (B1): optional muted note line at the top of the action bar.
      // Used by the Demographics modal AND (R-25) the Insurance modal for their
      // last-verified stamps — the full Post Data modal passes no
      // headerNote, so it is unaffected. opts.headerNote may be a STRING or a
      // FUNCTION returning the current string; a function lets the live refresher
      // (postModalHeaderNoteRefresh) re-read the shared RTV_LAST_RUN store after a
      // run so the stamp updates in place without reopening the modal.
      if (opts.headerNote) {
        var evalHeaderNote = function () {
          return typeof opts.headerNote === 'function' ? opts.headerNote() : opts.headerNote;
        };
        var headerNoteEl = el('div', null, evalHeaderNote());
        css(headerNoteEl, { fontSize: '12px', color: THEME.slate500, fontWeight: '600' });
        actionBar.appendChild(headerNoteEl);
        postModalHeaderNoteRefresh = function () { headerNoteEl.textContent = evalHeaderNote(); };
      }

      var btnRow = document.createElement('div');
      css(btnRow, { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '10px' });

      // Dismissible confirmation message shown below the buttons after a click.
      var msgRow = document.createElement('div');
      css(msgRow, {
        display: 'none', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px',
        padding: '8px 12px', background: '#fff', border: '1px solid ' + THEME.border, borderRadius: '6px',
      });
      var actionMsg = el('div', null, '');
      actionMsg.setAttribute('role', 'status');
      actionMsg.setAttribute('aria-live', 'polite');
      css(actionMsg, { fontSize: '12px', fontWeight: '600', color: THEME.navy, lineHeight: '1.4' });
      var dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Dismiss message');
      css(dismiss, {
        background: 'transparent', border: 'none', color: THEME.slate500, fontSize: '16px',
        lineHeight: '1', cursor: 'pointer', padding: '0 2px', flex: 'none', fontFamily: 'inherit',
      });
      dismiss.addEventListener('click', function () { msgRow.style.display = 'none'; });
      msgRow.appendChild(actionMsg);
      msgRow.appendChild(dismiss);

      headerActions.forEach(function (action) {
        var actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.textContent = action.label || 'Run';
        css(actionBtn, {
          background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy, borderRadius: '8px',
          padding: '8px 18px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
        });
        // A-C2: `variant: 'outline'` for actions that change the modal's own
        // structure rather than calling a verification service. Same size and
        // position, inverted fill — a filled button in this strip means "a
        // service ran", and Add New Insurance runs nothing.
        if (action.variant === 'outline') {
          css(actionBtn, { background: '#fff', color: THEME.navy });
        }
        actionBtn.addEventListener('click', function () {
          // A custom onClick (e.g. the Claim Verification "Run Verification"
          // action, or the R-25 Demographics/Insurance real-run actions) drives
          // its own tab navigation / shared run; the default placeholder actions
          // instead kick off the FrontRunner refresh. The clicked button is passed
          // as the 2nd arg so real-run handlers can apply pending state to it
          // (relabel/disable) — discovery needs it for its pending phase.
          if (typeof action.onClick === 'function') {
            action.onClick(modalCtx, actionBtn);
          } else {
            simulateFrhcRefresh();
          }
          if (action.message) {
            actionMsg.textContent = action.message;
            msgRow.style.display = 'flex';
          }
        });
        btnRow.appendChild(actionBtn);
      });

      actionBar.appendChild(btnRow);
      actionBar.appendChild(msgRow);
    }

    // Tab bar.
    var tabBar = document.createElement('div');
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Post data sections');
    css(tabBar, {
      display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '0 12px',
      background: THEME.inset, borderBottom: '1px solid ' + THEME.border,
    });

    // Scrollable body.
    var body = document.createElement('div');
    css(body, { padding: '18px 20px', overflowY: 'auto', flex: '1', background: '#fff' });

    // 26D: posted-stamp — a muted review-phase line on opens AFTER a
    // successful post this session ("Last posted 07/10/2026 · 8 updates · 1
    // appointment"). Module state ({ date, summary }); reset on patient switch.
    if (lastPostState) {
      var postedStampLine = el('div', 'post-last-posted',
        'Last posted ' + fmtRunDate(lastPostState.date) + ' \u00B7 ' + lastPostState.summary);
      css(postedStampLine, { fontSize: '12px', color: THEME.slate500, fontStyle: 'italic', marginBottom: '12px' });
      body.appendChild(postedStampLine);
    }

    // Comparison tabs are supplied by the caller (full modal = demographic +
    // primary + secondary; scoped modals = a single section); every modal
    // shares the same chrome and footer.
    var comparisonTabs = opts.comparisonTabs || [];
    var tabs = comparisonTabs.map(function (t) { return { key: t.key, label: t.label, payer: t.payer || null }; });
    // (26B: the Appointments tab — removed in 26A, restored as a product
    // decision — arrives as a caller-supplied custom-render tab
    // (buildAppointmentsPostTabDef), sharing the 25D card flow's rule + row
    // builder. Nothing tab-specific lives in this builder.)

    var panels = {};
    var tabButtons = {};

    function activate(key) {
      tabs.forEach(function (t) {
        var active = t.key === key;
        panels[t.key].style.display = active ? 'block' : 'none';
        panels[t.key].setAttribute('aria-hidden', active ? 'false' : 'true');
        tabButtons[t.key].setAttribute('aria-selected', active ? 'true' : 'false');
        tabButtons[t.key].tabIndex = active ? 0 : -1;
        css(tabButtons[t.key], {
          color: active ? THEME.navy : THEME.slate500,
          borderBottom: active ? '2px solid ' + THEME.navy : '2px solid transparent',
        });
      });
    }

    var tabOrder = tabs.map(function (t) { return t.key; });
    function onTablistKeydown(e, key) {
      var idx = tabOrder.indexOf(key);
      var next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabOrder.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + tabOrder.length) % tabOrder.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabOrder.length - 1;
      if (next >= 0) {
        e.preventDefault();
        var k = tabOrder[next];
        activate(k);
        tabButtons[k].focus();
      }
    }

    tabs.forEach(function (t) {
      var tb = document.createElement('button');
      tb.type = 'button';
      tb.textContent = t.label;
      tb.setAttribute('role', 'tab');
      tb.id = 'post-tab-' + t.key;
      tb.setAttribute('aria-controls', 'post-panel-' + t.key);
      tb.setAttribute('aria-selected', 'false');
      tb.tabIndex = -1;
      css(tb, {
        background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
        padding: '12px 14px', fontSize: '13px', fontWeight: '600', color: THEME.slate500,
        cursor: 'pointer', fontFamily: 'inherit',
      });
      tb.addEventListener('click', function () {
        activate(t.key);
      });
      tb.addEventListener('keydown', function (e) {
        onTablistKeydown(e, t.key);
      });
      tabButtons[t.key] = tb;
      tabBar.appendChild(tb);

      var panel = document.createElement('div');
      panel.setAttribute('role', 'tabpanel');
      panel.id = 'post-panel-' + t.key;
      panel.setAttribute('aria-labelledby', 'post-tab-' + t.key);
      panel.tabIndex = 0;
      panel.style.display = 'none';
      // Insurance tabs carry their payer on the PANEL since the Payer row was
      // removed (2026-08-19 review): occupyingPayer / resolvedRank read this.
      if (t.payer) panel.setAttribute('data-payer', t.payer);
      panels[t.key] = panel;
      body.appendChild(panel);
    });

    // Context handed to custom tab renderers and header-action onClick callbacks
    // so they can navigate between tabs.
    var modalCtx = {
      panels: panels,
      tabButtons: tabButtons,
      activate: activate,
    };

    comparisonTabs.forEach(function (t) {
      if (typeof t.render === 'function') {
        // Custom (non-comparison) tab content, e.g. the Claim Verification modal's
        // Claims and Verification Results tabs.
        t.render(panels[t.key], modalCtx);
      } else {
        comparisonRows(t.key, t.defs, panels[t.key]);
      }
      // Per-tab posting (Craig, 2026-08-19): each tab carries its own scoped
      // Post button — no-op unless opts.perTabPosting (the Insurance modal).
      attachTabPostButton(t.key, panels[t.key]);
    });

    // The Appointments tab's content depends on plannedRepoint, which A-C2's
    // Demote sets AFTER the modal is built — so it needs a re-render hook. Only
    // that one tab is rebuilt; re-running every renderer would discard unrelated
    // in-modal state (selected radios, custom inputs, collapse state).
    function refreshAppointmentsPostTab() {
      var def = null;
      comparisonTabs.forEach(function (t) {
        if (t.key === 'appointments' && typeof t.render === 'function') def = t;
      });
      var panel = panels.appointments;
      if (!def || !panel) return;
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      def.render(panel, modalCtx);
      // The re-render destroyed any per-tab Re-point button — re-attach (the
      // attach helper skips it while no re-point is planned).
      attachTabPostButton('appointments', panel);
      refreshSubmitState();
    }

    // One-time success banner (pinned to the top of the body) confirming an
    // insurance removal request was sent.
    var removedBanner = null;
    function showInsuranceRemovedBanner() {
      if (removedBanner) return;
      removedBanner = el('div', null, 'Insurance removed. A request has been sent to update the appointment and patient record.');
      removedBanner.setAttribute('role', 'status');
      css(removedBanner, {
        padding: '10px 14px', marginBottom: '14px', borderRadius: '8px',
        border: '1px solid #10b981', background: '#ecfdf5', color: '#065f46',
        fontSize: '13px', fontWeight: '600',
      });
      body.insertBefore(removedBanner, body.firstChild);
    }

    // Structural tab teardown — DOM + tab bookkeeping ONLY, no user-facing
    // messaging. Shared by the per-tab Remove control (which adds the removal
    // banner) and by A-C2's Replace disposition, which tears the incumbent tab
    // down and immediately builds the replacement in its place — where a
    // "Insurance removed" banner would be a lie.
    function dropInsuranceTab(key) {
      if (tabButtons[key] && tabButtons[key].parentNode) tabButtons[key].parentNode.removeChild(tabButtons[key]);
      if (panels[key]) {
        panels[key].querySelectorAll('.frhc-cell').forEach(stopCellLoading);
        if (panels[key].parentNode) panels[key].parentNode.removeChild(panels[key]);
      }
      delete tabButtons[key];
      delete panels[key];
      tabs = tabs.filter(function (t) { return t.key !== key; });
      tabOrder = tabOrder.filter(function (k) { return k !== key; });
    }

    // Removes an insurance tab (button + panel) from the modal and activates the
    // first remaining tab. Used by the per-tab Remove control.
    function removeInsuranceTab(key) {
      dropInsuranceTab(key);
      if (tabOrder.length) activate(tabOrder[0]);
      showInsuranceRemovedBanner();
      // Removing a tab removes its rows (and their deltas) — recompute (26C).
      refreshSubmitState();
    }

    // Builds the top-right "Remove" control for an insurance tab: a red outlined
    // button that reveals an inline confirmation prompt (Confirm Remove / Cancel).
    function buildInsuranceRemoveBar(key) {
      var bar = document.createElement('div');
      bar.className = 'ins-remove-bar';
      css(bar, { marginBottom: '14px' });

      var topRow = document.createElement('div');
      css(topRow, { display: 'flex', justifyContent: 'flex-end' });
      var removeBtn = el('button', null, 'Remove');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove this insurance');
      css(removeBtn, {
        background: '#fff', color: '#dc2626', border: '1px solid #dc2626',
        borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      topRow.appendChild(removeBtn);

      var confirmBox = document.createElement('div');
      css(confirmBox, {
        display: 'none', marginTop: '10px', padding: '12px 14px', borderRadius: '8px',
        border: '1px solid #fecaca', background: '#fef2f2',
      });
      var confirmMsg = el('div', null, 'Are you sure you want to remove this insurance? This will trigger a removal from the appointment and patient record.');
      css(confirmMsg, { fontSize: '13px', color: '#7f1d1d', marginBottom: '10px' });
      var confirmBtns = document.createElement('div');
      css(confirmBtns, { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
      var cancelBtn = el('button', null, 'Cancel');
      cancelBtn.type = 'button';
      css(cancelBtn, {
        background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      var confirmBtn = el('button', null, 'Confirm Remove');
      confirmBtn.type = 'button';
      css(confirmBtn, {
        background: '#dc2626', color: '#fff', border: '1px solid #dc2626',
        borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      confirmBtns.appendChild(cancelBtn);
      confirmBtns.appendChild(confirmBtn);
      confirmBox.appendChild(confirmMsg);
      confirmBox.appendChild(confirmBtns);

      removeBtn.addEventListener('click', function () {
        confirmBox.style.display = 'block';
        topRow.style.display = 'none';
      });
      cancelBtn.addEventListener('click', function () {
        confirmBox.style.display = 'none';
        topRow.style.display = 'flex';
      });
      confirmBtn.addEventListener('click', function () {
        // TODO: wire to backend API call to remove insurance from appointment and/or patient record
        removeInsuranceTab(key);
      });

      bar.appendChild(topRow);
      bar.appendChild(confirmBox);
      return bar;
    }

    // Insurance modal only: give the Primary/Secondary tabs a Remove affordance.
    if (opts.removableInsurance) {
      comparisonTabs.forEach(function (t) {
        if ((t.key === 'primary' || t.key === 'secondary') && panels[t.key]) {
          panels[t.key].insertBefore(buildInsuranceRemoveBar(t.key), panels[t.key].firstChild);
        }
      });
    }

    // ---- A-C2: Add New Insurance ---------------------------------------------
    // Meeting notes 2026-07-28 §2.2 asked for an "Add New Insurance" button on
    // the Insurance modal. [Q3] — what happens to a policy already on file —
    // was left open there ("Need input from user") and is now RULED (Craig,
    // 2026-08-12): the user chooses the rank at add time, and the modal NEVER
    // silently decides the incumbent's fate.
    //
    //   rank free      → the new policy takes it.
    //   rank occupied  → REPLACE (cancel the incumbent, create the new policy in
    //                    its place), or DEMOTE the incumbent to the other rank.
    //
    // DEMOTE is now LIVE (D2 RESOLVED — Craig, 2026-08-13). It previously
    // rendered offered-but-disabled with the reason "On hold pending a
    // coverage-order decision", because moving a primary down to secondary IS a
    // COB swap and the plan decision was unruled. The ruling splits the swap by
    // LEVEL, and that is what makes this safe to enable:
    //   • PATIENT-level reorder stays OUT — athena has no reorder verb (a
    //     sequence number cannot be assigned while another ACTIVE insurance holds
    //     it), so it would require delete-then-create, which FrontRunner
    //     deliberately does not do (`FR-33`).
    //   • APPOINTMENT-level re-point is IN — the pointers live on the
    //     appointment, so moving the incumbent's rank on FUTURE appointments is
    //     expressible and is exactly what this affordance now does
    //     (`FR-60` / ST-E8, CORE-337).
    // So demoting here does NOT rewrite the patient's coverage order; it plans a
    // per-appointment re-point, which the Appointments tab then scopes.
    // The remaining disabled case is athena's own cap, not ours: ADR-ATH-021/018
    // cap-at-2 (the contract's `400 insurance_cap_exceeded`) when the other rank
    // is already occupied — there is nowhere for the incumbent to go.

    // The new-policy field set, in the same order (and under the same labels) as
    // buildInsuranceDefs — the added tab has to read like the tabs beside it.
    // Relationship is a select: enumerated values have no reason to be free
    // text (the Step-34 lesson). DELIBERATELY SMALLER than the comparison
    // tabs' unified set (2026-08-19): only fields a user can ENTER for a new
    // policy appear here — Insurance type is athena-derived from the package,
    // and Eligibility reason / Last verified are verification metadata athena
    // stamps after the fact; none of the three is typable. Copay was REMOVED
    // the same day (Craig's ruling — see buildInsuranceDefs), which retired
    // the primaryOnly flag; Status was removed in the same-day review (it is
    // engine-set in athena — picking Active/Inactive for a new policy posted
    // nothing and promised something). Payer, uniquely, is a FORM field but
    // NOT a comparison row: it names the new policy (required — it drives the
    // occupancy notice, the panel note, and data-payer), while on-file tabs
    // carry their payer on the panel, not in a row.
    var ADD_INS_FIELDS = [
      { label: 'Payer', required: true, placeholder: 'e.g. Aetna' },
      { label: 'Plan name', placeholder: 'e.g. Choice POS II' },
      // ⚠ **'Athena Package ID' ROW REMOVED 2026-08-15 (Craig).** It rendered an
      // honest '—' (athena assigns the id on CREATE) and was never typed, so it
      // showed the user nothing. Two facts it used to carry, preserved because
      // they still bind the live lane: Q5 (2026-07-28 §2.2) — whether athena's
      // create response returns the id or a GET
      // /patients/{patientid}/insurances read-back is needed — is STILL OPEN;
      // and a brand-new policy therefore has no catalog id, while the write
      // REQUIRES one, so an A-C2 add cannot post live today (the route refuses
      // it honestly rather than inventing an id).
      { label: 'Member ID', required: true },
      { label: 'Group number' },
      { label: 'Relationship', options: ['Self', 'Spouse', 'Child', 'Other'] },
      // Policyholder block (Craig, 2026-08-19: needed whenever the holder is
      // not Self). athena's CREATE contract requires policyholder name and sex
      // for every non-self-pay policy; NOT enforced as required here because a
      // live create is inexpressible on this lane today (package-id lookup is
      // Orion's, ASK B world) and a real create path would auto-fill these
      // from the patient when Relationship is Self rather than demand typing.
      { label: 'Policyholder first name', key: 'policyholder_first_name' },
      { label: 'Policyholder last name', key: 'policyholder_last_name' },
      { label: 'Policyholder DOB', placeholder: 'MM/DD/YYYY' },
      // Leading blank option, deliberately: selects seed their first option
      // into `values`, and silently defaulting a SEX would fabricate data —
      // unlike Relationship, where 'Self' is a sane default. Blank renders
      // '—' on the added tab and never posts (the '—' delta guard).
      { label: 'Policyholder sex', options: ['', 'Female', 'Male'] },
      // Address is granular — one field per athena/Orion write field (Craig,
      // 2026-08-19: the address is used in the POST when creating a policy).
      { label: 'Policyholder address 1', key: 'policyholder_address_line_1' },
      { label: 'Policyholder address 2', key: 'policyholder_address_line_2' },
      { label: 'Policyholder city', key: 'policyholder_city' },
      { label: 'Policyholder state', key: 'policyholder_state', placeholder: 'e.g. TX' },
      { label: 'Policyholder ZIP', key: 'policyholder_zip' },
      { label: 'Effective date', placeholder: 'MM/DD/YYYY' },
      { label: 'Termination date', placeholder: 'MM/DD/YYYY' },
    ];

    function rankLabel(rank) { return rank === 'primary' ? 'Primary' : 'Secondary'; }

    // Live rank occupancy, read from the DOM exactly as resolvedRank does — so a
    // tab the user just removed reads as free. The payer lives on the PANEL
    // (data-payer) since the Payer comparison row was removed (2026-08-19
    // review): a payer change is a carrier change, which is Replace, never a
    // field edit — so there is no per-row payer state left to read.
    function occupyingPayer(rank) {
      var panel = panels[rank];
      if (!panel) return null;
      var payer = panel.getAttribute('data-payer');
      return payer && payer !== '—' ? payer : null;
    }

    // Defs for an added policy. `keepExisting` is true on a Replace: the EXISTING
    // column keeps showing what is on file in athena, so the tab states the
    // change honestly (this policy replaces that one) instead of pretending the
    // rank was empty. On a plain add every EXISTING is null → '—' → every entered
    // value is a delta and posts.
    function buildAddedInsuranceDefs(rank, values, keepExisting) {
      var existingByLabel = {};
      if (keepExisting) {
        buildInsuranceDefs(p, rank)
          .forEach(function (d) {
            existingByLabel[d.label] = d.existing;
            // Composed rows (2026-08-20): surface each PART's existing under
            // the granular label the add form still uses, so a Replace keeps
            // showing the on-file policyholder details per field.
            if (d.parts) {
              d.parts.forEach(function (pt) {
                ADD_INS_FIELDS.forEach(function (f) {
                  if (f.key === pt.key) existingByLabel[f.label] = pt.existing;
                });
              });
            }
          });
      }
      return ADD_INS_FIELDS
        // Payer is entered on the form but is NOT a comparison row (2026-08-19
        // review — no insurance tab has one): it rides the panel's data-payer
        // and the panel note instead.
        .filter(function (f) { return f.label !== 'Payer'; })
        .map(function (f) {
          return {
            label: f.label,
            // `f.assigned` handling removed 2026-08-15 with the Athena Package
            // ID row — it was the flag's ONLY user, so the branch was dead.
            frhc: values[f.label],
            existing: Object.prototype.hasOwnProperty.call(existingByLabel, f.label)
              ? existingByLabel[f.label]
              : null,
          };
        });
    }

    // Inverse of dropInsuranceTab: builds the tab button + panel for a policy
    // added in-session and slots it into tab order AHEAD of the custom-render
    // tabs, so the bar still reads Primary · Secondary · Appointments.
    function addInsuranceTab(key, label, defs, panelNote, payer) {
      if (panels[key]) dropInsuranceTab(key);

      var tb = document.createElement('button');
      tb.type = 'button';
      tb.textContent = label;
      tb.setAttribute('role', 'tab');
      tb.id = 'post-tab-' + key;
      tb.setAttribute('aria-controls', 'post-panel-' + key);
      tb.setAttribute('aria-selected', 'false');
      tb.tabIndex = -1;
      css(tb, {
        background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
        padding: '12px 14px', fontSize: '13px', fontWeight: '600', color: THEME.slate500,
        cursor: 'pointer', fontFamily: 'inherit',
      });
      tb.addEventListener('click', function () { activate(key); });
      tb.addEventListener('keydown', function (e) { onTablistKeydown(e, key); });
      tabButtons[key] = tb;

      // Anchor = the first custom-render tab still on screen (Appointments).
      var anchorKey = null;
      comparisonTabs.forEach(function (t) {
        if (anchorKey === null && typeof t.render === 'function' && tabButtons[t.key]) anchorKey = t.key;
      });
      var insertAt = tabOrder.length;
      if (anchorKey) {
        tabBar.insertBefore(tb, tabButtons[anchorKey]);
        var ai = tabOrder.indexOf(anchorKey);
        if (ai >= 0) insertAt = ai;
      } else {
        tabBar.appendChild(tb);
      }

      var panel = document.createElement('div');
      panel.setAttribute('role', 'tabpanel');
      panel.id = 'post-panel-' + key;
      panel.setAttribute('aria-labelledby', 'post-tab-' + key);
      panel.tabIndex = 0;
      panel.style.display = 'none';
      // The entered payer rides the panel, exactly like the built-at-open tabs
      // (the Payer comparison row is gone — 2026-08-19 review).
      if (payer) panel.setAttribute('data-payer', payer);
      panels[key] = panel;
      body.appendChild(panel);

      tabs.splice(insertAt, 0, { key: key, label: label });
      tabOrder.splice(insertAt, 0, key);
      // startPostRun captures its sections from comparisonTabs, so an added
      // policy MUST join that array or it would render and never post.
      //
      // Drop any prior entry for this key FIRST. dropInsuranceTab deliberately
      // leaves comparisonTabs alone — startPostRun's `if (!panels[t.key]) return`
      // guard is what skips a removed tab — but that guard keys on the PANEL, so
      // once this rank has a panel again a stale entry passes it too and the
      // added policy is captured twice (observed: one add produced two
      // "Secondary Insurance" sections and double-counted the posted updates).
      for (var di = comparisonTabs.length - 1; di >= 0; di -= 1) {
        if (comparisonTabs[di].key === key) comparisonTabs.splice(di, 1);
      }
      var ctIdx = comparisonTabs.length;
      for (var ci = 0; ci < comparisonTabs.length; ci += 1) {
        if (typeof comparisonTabs[ci].render === 'function') { ctIdx = ci; break; }
      }
      comparisonTabs.splice(ctIdx, 0, { key: key, label: label, defs: defs });

      if (panelNote) {
        var note = el('div', 'cmp-added-source', panelNote);
        css(note, { fontSize: '12px', fontStyle: 'italic', color: THEME.slate500, margin: '0 0 10px' });
        panel.appendChild(note);
      }
      comparisonRows(key, defs, panel);
      // An added policy gets its own scoped Post button like any other tab.
      attachTabPostButton(key, panel);
      // An added policy is as removable as the ones built at open.
      if (opts.removableInsurance) {
        panel.insertBefore(buildInsuranceRemoveBar(key), panel.firstChild);
      }
      activate(key);
      refreshSubmitState();
    }

    // One-time banner confirming a policy was added (mirrors the removal one).
    var addedBanner = null;
    function showInsuranceAddedBanner(text) {
      if (!addedBanner) {
        addedBanner = el('div', null, text);
        addedBanner.setAttribute('role', 'status');
        css(addedBanner, {
          padding: '10px 14px', marginBottom: '14px', borderRadius: '8px',
          border: '1px solid #10b981', background: '#ecfdf5', color: '#065f46',
          fontSize: '13px', fontWeight: '600',
        });
        body.insertBefore(addedBanner, body.firstChild);
      } else {
        addedBanner.textContent = text;
      }
    }

    var addFormCard = null;
    function openAddInsuranceForm() {
      if (addFormCard) {
        var open = addFormCard.querySelector('input, select');
        if (open && typeof open.focus === 'function') open.focus();
        return;
      }

      var values = {};
      var rank = null;
      var disposition = null; // 'replace' once the chosen rank is occupied

      var card = document.createElement('div');
      card.className = 'ins-add-form';
      css(card, {
        marginBottom: '16px', padding: '14px', borderRadius: '8px',
        border: '1px solid ' + THEME.borderInput, background: THEME.inset,
      });

      var heading = el('div', null, 'Add New Insurance');
      css(heading, { fontSize: '13px', fontWeight: '700', color: THEME.navy, marginBottom: '10px' });
      card.appendChild(heading);

      // ---- Rank choice (the Q3 ruling: always explicit, never inferred) ----
      var rankRow = document.createElement('div');
      css(rankRow, { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', marginBottom: '10px' });
      var rankLab = el('span', null, 'Add as');
      css(rankLab, { fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: THEME.slate500 });
      rankRow.appendChild(rankLab);
      ['primary', 'secondary'].forEach(function (r) {
        var wrap = document.createElement('label');
        css(wrap, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: THEME.slate900 });
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'ins-add-rank';
        radio.value = r;
        radio.className = 'ins-add-rank';
        css(radio, { accentColor: THEME.navy, flex: 'none' });
        radio.addEventListener('change', function () {
          if (!radio.checked) return;
          rank = r;
          disposition = null;
          renderFields();
          refreshAddState();
        });
        wrap.appendChild(radio);
        wrap.appendChild(el('span', null, rankLabel(r)));
        rankRow.appendChild(wrap);
      });
      card.appendChild(rankRow);

      // ---- Occupancy notice + disposition choice ----
      var notice = document.createElement('div');
      notice.className = 'ins-add-notice';
      css(notice, {
        display: 'none', marginBottom: '10px', padding: '10px 12px', borderRadius: '6px',
        border: '1px solid rgba(180, 83, 9, 0.35)', background: THEME.amberBg,
      });
      var noticeMsg = el('div', 'ins-add-notice-msg', '');
      css(noticeMsg, { fontSize: '12px', fontWeight: '600', color: THEME.amber, marginBottom: '8px' });
      notice.appendChild(noticeMsg);
      var dispWrap = document.createElement('div');
      css(dispWrap, { display: 'flex', flexDirection: 'column', gap: '6px' });
      notice.appendChild(dispWrap);
      card.appendChild(notice);

      function dispositionChoice(value, text, disabledReason) {
        var wrap = document.createElement('label');
        css(wrap, {
          display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '12px',
          color: disabledReason ? THEME.slate500 : THEME.slate900,
          cursor: disabledReason ? 'default' : 'pointer',
        });
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'ins-add-disposition';
        radio.value = value;
        radio.className = 'ins-add-disposition';
        radio.disabled = !!disabledReason;
        css(radio, { accentColor: THEME.navy, marginTop: '2px', flex: 'none' });
        radio.addEventListener('change', function () {
          if (radio.checked) { disposition = value; refreshAddState(); }
        });
        var span = el('span', null, text);
        if (disabledReason) {
          var why = el('span', 'ins-add-disabled-reason', ' — ' + disabledReason);
          css(why, { fontStyle: 'italic' });
          span.appendChild(why);
        }
        wrap.appendChild(radio);
        wrap.appendChild(span);
        return wrap;
      }

      function renderNotice() {
        while (dispWrap.firstChild) dispWrap.removeChild(dispWrap.firstChild);
        var occupant = rank ? occupyingPayer(rank) : null;
        if (!occupant) {
          notice.style.display = 'none';
          return;
        }
        notice.style.display = 'block';
        noticeMsg.textContent = occupant + ' is already on file as the ' + rankLabel(rank).toLowerCase() +
          ' policy. Choose what happens to it.';
        dispWrap.appendChild(dispositionChoice(
          'replace',
          'Replace it — ' + occupant + ' is cancelled and the new policy is created in its place.',
          null
        ));
        var other = rank === 'primary' ? 'secondary' : 'primary';
        var otherOccupant = occupyingPayer(other);
        // The ONLY remaining disabled case is athena's own cap (ADR-ATH-021/018
        // cap-at-2; the API contract's `400 insurance_cap_exceeded`) — the D2 hold
        // is lifted, see the ruling block above.
        var demoteReason = otherOccupant
          ? 'not available, ' + otherOccupant + ' already holds the ' + other + ' rank and NextGen allows one policy per rank'
          : null;
        dispWrap.appendChild(dispositionChoice(
          'demote',
          'Move ' + occupant + ' to ' + other + ' on future appointments',
          demoteReason
        ));
      }

      // ---- Field entry ----
      var fieldsWrap = document.createElement('div');
      css(fieldsWrap, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginBottom: '10px' });
      card.appendChild(fieldsWrap);

      function renderFields() {
        while (fieldsWrap.firstChild) fieldsWrap.removeChild(fieldsWrap.firstChild);
        ADD_INS_FIELDS.forEach(function (f) {
          var wrap = document.createElement('label');
          css(wrap, { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0' });
          var lab = el('span', null, f.label + (f.required ? ' *' : ''));
          css(lab, { fontSize: '12px', fontWeight: '600', color: THEME.slate500 });
          wrap.appendChild(lab);

          var input;
          if (f.options) {
            input = document.createElement('select');
            f.options.forEach(function (o) {
              var opt = document.createElement('option');
              opt.value = o;
              opt.textContent = o;
              input.appendChild(opt);
            });
            if (values[f.label] == null) values[f.label] = f.options[0];
            input.value = values[f.label];
          } else {
            input = document.createElement('input');
            input.type = 'text';
            if (f.placeholder) input.placeholder = f.placeholder;
            input.value = values[f.label] || '';
          }
          input.className = 'ins-add-input';
          input.setAttribute('data-field', f.label);
          input.setAttribute('aria-label', 'New insurance ' + f.label);
          css(input, {
            width: '100%', minWidth: '0', padding: '5px 6px', border: '1px solid ' + THEME.borderInput,
            borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit', color: THEME.slate900,
            background: '#fff', boxSizing: 'border-box',
          });
          function capture() { values[f.label] = input.value; refreshAddState(); }
          input.addEventListener('input', capture);
          input.addEventListener('change', capture);
          wrap.appendChild(input);
          fieldsWrap.appendChild(wrap);
        });
      }

      // ---- Validation + footer ----
      var addFoot = document.createElement('div');
      css(addFoot, { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', flexWrap: 'wrap' });
      var addWhy = el('div', 'ins-add-blocked', '');
      css(addWhy, { fontSize: '12px', color: THEME.slate500, marginRight: 'auto', minWidth: '0' });
      var addCancel = el('button', null, 'Cancel');
      addCancel.type = 'button';
      css(addCancel, {
        background: 'transparent', border: 'none', color: THEME.teal, fontSize: '13px',
        fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 4px',
      });
      var addConfirm = el('button', null, 'Add policy');
      addConfirm.type = 'button';
      addConfirm.className = 'ins-add-confirm';
      css(addConfirm, {
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy, borderRadius: '8px',
        padding: '8px 18px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
      });
      addFoot.appendChild(addWhy);
      addFoot.appendChild(addCancel);
      addFoot.appendChild(addConfirm);
      card.appendChild(addFoot);

      // A blocked Add always states its reason — never a dead button.
      function blockedReason() {
        if (!rank) return 'Choose whether this is the primary or secondary policy.';
        var missing = ADD_INS_FIELDS.filter(function (f) {
          return f.required && !String(values[f.label] || '').trim();
        }).map(function (f) { return f.label; });
        if (missing.length) {
          return missing.join(' and ') + (missing.length === 1 ? ' is required.' : ' are required.');
        }
        if (occupyingPayer(rank) && !disposition) return 'Choose what happens to the policy already on file.';
        return null;
      }

      function refreshAddState() {
        renderNotice();
        var why = blockedReason();
        addWhy.textContent = why || '';
        addConfirm.disabled = !!why;
        css(addConfirm, why ? { opacity: '0.55', cursor: 'default' } : { opacity: '1', cursor: 'pointer' });
      }

      function closeAddForm() {
        if (card.parentNode) card.parentNode.removeChild(card);
        addFormCard = null;
      }
      addCancel.addEventListener('click', closeAddForm);

      addConfirm.addEventListener('click', function () {
        if (addConfirm.disabled || blockedReason()) return;
        var occupant = occupyingPayer(rank);
        var demoting = !!occupant && disposition === 'demote';
        var replacing = !!occupant && !demoting;
        var otherRank = rank === 'primary' ? 'secondary' : 'primary';
        // DEMOTE plans an APPOINTMENT-LEVEL re-point (D2 ruling, 2026-08-13): the
        // incumbent's policy record is NOT rewritten and the patient's coverage
        // order is NOT touched — only the pointers on future appointments move.
        // Recording it here is what turns the Appointments tab on; without a
        // re-point that tab correctly offers nothing.
        if (demoting) {
          plannedRepoint = {
            movedPayer: occupant,
            from: rankLabel(rank).toLowerCase(),
            to: rankLabel(otherRank).toLowerCase(),
          };
        }
        var defs = buildAddedInsuranceDefs(rank, values, replacing);
        // PRODUCTION CALL SITE (create): POST /patients/{patientid}/insurances
        // with `updateappointments: true` — a CREATE always sends it (Craig,
        // 2026-07-29, resolving [Q4]), so athena auto-applies the new policy to
        // every future appointment by sequence number and the create needs NO
        // per-appointment call. ⚠ The other half of that 07-29 ruling — "an
        // UPDATE of an existing policy instead issues explicit per-appointment
        // PUT /appointments/{appointmentid}/insurances calls" — is SUPERSEDED
        // (Craig, 2026-08-13): a field edit propagates through the appointment's
        // pointer, so it issues none. See the ruling block above
        // buildAppointmentsPostTabDef.
        // On Replace the incumbent is cancelled FIRST, matching the as-built
        // ordering (Updates → Deletes¹ → Creates → Deletes² → Reactivates),
        // where the delete of a policy being replaced precedes the create.
        // On Demote nothing about the incumbent's RECORD changes — it keeps its
        // insurance id and its fields; only the appointment pointers move, which
        // is why its tab is left exactly as it is.
        // Simulated here: the modal's own Submit run is the posting flow, and
        // the new tab joins it as a section like any other.
        if (replacing) dropInsuranceTab(rank);
        // The entered payer is named in the note (and carried on the panel via
        // data-payer) — the Payer comparison row is gone, 2026-08-19 review.
        var newPayer = String(values['Payer'] || '').trim();
        addInsuranceTab(
          rank,
          rankLabel(rank) + ' Insurance',
          defs,
          replacing
            ? 'New policy: ' + newPayer + ' — replaces ' + occupant + '. The policy on file is cancelled and this one created in its place. NextGen assigns the insurance ID on create.'
            : demoting
              ? 'New ' + rankLabel(rank).toLowerCase() + ' policy: ' + newPayer + ' — created in NextGen, which applies it to future appointments itself. ' + occupant + ' keeps its own record and moves to ' + otherRank + ' on the appointments you select.'
              : 'New policy: ' + newPayer + ' — Not yet on file in NextGen; every value below posts as a new policy. NextGen assigns the insurance ID on create.',
          newPayer
        );
        showInsuranceAddedBanner(
          replacing
            ? rankLabel(rank) + ' insurance replaced — review the values below, then Submit to cancel ' + occupant + ' and create the new policy.'
            : demoting
              ? rankLabel(rank) + ' insurance added and ' + occupant + ' moves to ' + otherRank + ' — pick the future appointments to re-point on the Appointments tab, then Submit.'
              : rankLabel(rank) + ' insurance added — review the values below, then Submit to create it in NextGen.'
        );
        // The Appointments tab renders from plannedRepoint, so it has to be
        // rebuilt now that a re-point exists.
        if (demoting) refreshAppointmentsPostTab();
        closeAddForm();
      });

      renderFields();
      refreshAddState();
      body.insertBefore(card, body.firstChild);
      addFormCard = card;
      var firstRank = card.querySelector('.ins-add-rank');
      if (firstRank && typeof firstRank.focus === 'function') firstRank.focus();
    }

    // Footer — Cancel (teal text link) + Submit (navy).
    var footer = document.createElement('div');
    css(footer, {
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '18px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: THEME.inset,
    });
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    css(cancel, {
      background: 'transparent', border: 'none', color: THEME.teal, fontSize: '13px',
      fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 4px',
    });
    cancel.addEventListener('mouseenter', function () { cancel.style.textDecoration = 'underline'; });
    cancel.addEventListener('mouseleave', function () { cancel.style.textDecoration = 'none'; });
    cancel.addEventListener('click', closePostModal);
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = 'Submit';
    css(submit, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy, borderRadius: '8px',
      padding: '8px 18px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
    });
    submit.addEventListener('click', function () {
      if (submit.disabled) return;
      // 26D: comparison-tab modals run the shared async three-phase posting
      // flow (startPostRun below — a hoisted declaration). A modal built
      // purely from custom-render tabs has nothing to post; its Submit just
      // closes (no such caller routes through this footer today).
      if (hasComparisonTabs) {
        startPostRun('footer');
      } else {
        closePostModal();
      }
    });
    // Per-tab posting modals (opts.perTabPosting — the Insurance modal, Craig
    // 2026-08-19) have NO modal-wide Submit: each rank posts from its own tab,
    // because each rank is its own athena PUT anyway and a global button
    // silently posted BOTH ranks' default-armed deltas when the user was only
    // looking at one. The footer keeps a single Close.
    // All-tab modals keep the one-stop Submit and gain a muted per-section
    // breakdown so its scope is explicit ("Demographic 3 · Primary 2 · …").
    var footerBreakdown = null;
    if (opts.perTabPosting) {
      cancel.textContent = 'Close';
      footer.appendChild(cancel);
    } else {
      footerBreakdown = el('div');
      css(footerBreakdown, {
        fontSize: '12px', color: THEME.slate500, marginRight: 'auto',
        minWidth: '0', overflowWrap: 'break-word',
      });
      footer.appendChild(footerBreakdown);
      footer.appendChild(cancel);
      footer.appendChild(submit);
    }

    // 26C: delta-derived Submit. Active on any modal with at least one true
    // comparison tab (the full Post Data modal + all scoped variants); modals
    // built purely from custom-render tabs keep the plain "Submit".
    // N = fields whose CHOSEN value differs from athena's existing (data-delta,
    // maintained per-row by comparisonRows); M = checked appointments on the
    // 26B tab. "apply to M" is only mentioned when insurance deltas exist —
    // the appointment application pushes the modal's resolved insurance values,
    // so it only means something when insurance is changing. N = 0 disables
    // Submit ("Nothing to post") regardless of M. Label only — the actual
    // async posting with per-item results is 26D.
    var hasComparisonTabs = comparisonTabs.some(function (t) { return typeof t.render !== 'function'; });
    function refreshSubmitState() {
      if (!hasComparisonTabs) return;
      refreshTabPostButtons();
      if (opts.perTabPosting) return; // no modal-wide Submit to relabel
      var n = 0;
      body.querySelectorAll('.comparison-field-row[data-delta="1"]').forEach(function () {
        n += 1;
      });
      var m = 0;
      body.querySelectorAll('.post-appointment').forEach(function (cb) {
        if (cb.checked && !cb.disabled) m += 1;
      });
      // Per-section breakdown beside the one-stop Submit \u2014 shown only when
      // MORE THAN ONE section carries deltas, i.e. exactly when the button's
      // scope is wider than a single tab and could surprise.
      if (footerBreakdown) {
        var parts = [];
        comparisonTabs.forEach(function (t) {
          if (typeof t.render === 'function' || !panels[t.key]) return;
          var c = panels[t.key].querySelectorAll('.comparison-field-row[data-delta="1"]').length;
          if (c) parts.push(t.label + ' ' + c);
        });
        footerBreakdown.textContent = parts.length > 1 ? 'Posts all tabs: ' + parts.join(' \u00B7 ') : '';
      }
      if (n === 0) {
        submit.textContent = 'Nothing to post';
        submit.disabled = true;
        css(submit, { opacity: '0.55', cursor: 'default' });
      } else {
        var label = 'Post ' + n + (n === 1 ? ' update' : ' updates');
        // "apply to M" now keys on a planned RE-POINT, not on any insurance
        // delta (ruling 2026-08-13): field edits and creates reach appointments
        // without a per-appointment call, so counting them here promised work
        // the run correctly no longer does.
        if (plannedRepoint && m > 0) {
          label += ' \u00B7 re-point ' + m + (m === 1 ? ' appointment' : ' appointments');
        }
        submit.textContent = label;
        submit.disabled = false;
        css(submit, { opacity: '1', cursor: 'pointer' });
      }
    }

    // ---- Per-tab Post buttons (Craig, 2026-08-19) ---------------------------
    // Scope becomes STRUCTURAL: a button inside the Primary tab posts primary
    // and nothing else \u2014 matching the wire protocol, where each rank is
    // already its own POST /api/patient/insurance \u2192 orionPatientCoverageUpdate
    // \u2192 athena PUT. The one-stop footer Submit stays only on all-tab modals
    // (the full Post Data surface, whose charter is review-everything).
    // Lazily initialized: the tab render loop calls attachTabPostButton (a
    // hoisted declaration) BEFORE this line's assignment would run, so a plain
    // `var x = {}` here would first be undefined at attach time and then WIPE
    // the attached buttons when the assignment executed.
    var tabPostButtons;
    function attachTabPostButton(key, panel) {
      if (!opts.perTabPosting || !panel) return;
      if (!tabPostButtons) tabPostButtons = {};
      // The Appointments tab earns its button only once a re-point is planned
      // (Demote) \u2014 before that the tab itself says there is nothing to apply.
      if (key === 'appointments' && !plannedRepoint) return;
      var isAppt = key === 'appointments';
      var wrap = el('div');
      css(wrap, {
        display: 'flex', justifyContent: 'flex-end', marginTop: '14px',
        paddingTop: '12px', borderTop: '1px solid ' + THEME.borderSoft,
      });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-post-btn';
      btn.setAttribute('data-post-tab', key);
      css(btn, {
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy, borderRadius: '8px',
        padding: '8px 18px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
      });
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        startPostRun('tab:' + key, key);
      });
      wrap.appendChild(btn);
      panel.appendChild(wrap);
      tabPostButtons[key] = btn;
      refreshTabPostButtons();
    }
    function refreshTabPostButtons() {
      if (!opts.perTabPosting || !tabPostButtons) return;
      Object.keys(tabPostButtons).forEach(function (key) {
        var btn = tabPostButtons[key];
        var panel = panels[key];
        // A removed tab took its button with it \u2014 drop the stale handle.
        if (!panel || !panel.contains(btn)) { delete tabPostButtons[key]; return; }
        var enabled;
        if (key === 'appointments') {
          var m = 0;
          panel.querySelectorAll('.post-appointment').forEach(function (cb) {
            if (cb.checked && !cb.disabled) m += 1;
          });
          enabled = !!plannedRepoint && m > 0;
          btn.textContent = enabled
            ? 'Re-point ' + m + (m === 1 ? ' appointment' : ' appointments')
            : 'Nothing to re-point';
        } else {
          var n = panel.querySelectorAll('.comparison-field-row[data-delta="1"]').length;
          var rank = key === 'primary' ? 'primary' : 'secondary';
          enabled = n > 0;
          btn.textContent = enabled
            ? 'Post ' + n + ' ' + rank + (n === 1 ? ' update' : ' updates')
            : 'Nothing to post';
        }
        btn.disabled = !enabled;
        css(btn, enabled ? { opacity: '1', cursor: 'pointer' } : { opacity: '0.55', cursor: 'default' });
      });
    }
    // Radios, custom inputs, and the 26B appointment checkboxes all bubble to
    // the body — one delegated pair covers every recompute trigger.
    body.addEventListener('change', refreshSubmitState);
    body.addEventListener('input', refreshSubmitState);
    refreshSubmitState();

    // ---- 26D: the async three-phase Submit ---------------------------------
    // Phase 1 (review) is the tabbed UI above. startPostRun captures the
    // resolved payload + runPatientId, flips the body to a sequential posting
    // view (rebuild-in-place, the 25D pattern), then settles into a results
    // summary with the R-24 note and a Done footer. Esc / X / overlay / Cancel
    // are refused mid-run via the module postRunActive flag (closePostModal).
    function startPostRun(source, scopeKey) {
      if (postRunActive) return;
      // --- capture: per-section delta fields, in tab order. Zero-delta
      // sections are omitted — posting nothing isn't work to show.
      // `scopeKey` (per-tab posting, 2026-08-19) narrows the capture to ONE
      // tab: a per-tab button posts its own rank and nothing else. Absent
      // scope = the all-tab footer Submit, unchanged.
      var sections = [];
      comparisonTabs.forEach(function (t) {
        if (typeof t.render === 'function') return; // custom tabs post nothing
        if (!panels[t.key]) return;                 // removed insurance tab
        if (scopeKey && t.key !== scopeKey) return; // out of this run's scope
        var deltas = [];
        panels[t.key].querySelectorAll('.comparison-field-row[data-delta="1"]').forEach(function (row) {
          var delta = {
            tab: row.getAttribute('data-tab'),
            field: row.getAttribute('data-field'),
            value: row.getAttribute('data-value'),
          };
          // Source-backed composed rows (2026-08-20): the chosen side's
          // granular parts ride the capture as {wireKey: value} — the posting
          // functions spread them instead of mapping the label to one key.
          var partsAttr = row.getAttribute('data-parts');
          if (partsAttr) {
            try { delta.parts = JSON.parse(partsAttr); } catch (e) { /* scalar fallback */ }
          }
          deltas.push(delta);
        });
        if (deltas.length) sections.push({ key: t.key, label: t.label, deltas: deltas });
      });
      // --- capture: the modal's RESOLVED insurance values — what the
      // appointment rows write (each rank's chosen Payer / Member ID, delta or
      // not: the applied set is the modal's CURRENT claim, exactly as the 25D
      // flow applies the session's current set). A removed insurance tab
      // resolves to null → the shared apply clears that coverage.
      function resolvedRank(key) {
        var panel = panels[key];
        if (!panel) return null;
        // Payer from the panel (data-payer — the Payer row is gone, 2026-08-19
        // review); Member ID from its row, delta or not, as before.
        var payer = panel.getAttribute('data-payer');
        var memberId = null;
        panel.querySelectorAll('.comparison-field-row').forEach(function (row) {
          if (row.getAttribute('data-field') === 'Member ID') memberId = row.getAttribute('data-value');
        });
        return payer && payer !== '—' ? { payer: payer, memberId: memberId } : null;
      }
      var resolvedInsurance = { primary: resolvedRank('primary'), secondary: resolvedRank('secondary') };
      // --- capture: checked appointments — ONLY when this run re-points coverage
      // (ruling of record 2026-08-13; see the block above buildAppointmentsPostTabDef).
      // Previously gated on `insDeltaCount > 0`, i.e. any insurance field delta,
      // which posted a per-appointment PUT for edits that propagate on their own
      // and for creates athena already applies itself.
      var selectedAppts = [];
      // A rank-scoped run never re-points (that is the Appointments tab's own
      // button); the unscoped footer Submit keeps collecting them as before.
      if (plannedRepoint && (!scopeKey || scopeKey === 'appointments')) {
        body.querySelectorAll('.post-appointment').forEach(function (cb) {
          if (cb.checked && !cb.disabled) {
            var id = cb.getAttribute('data-appt-id');
            APPOINTMENTS.forEach(function (a) { if (a.id === id) selectedAppts.push(a); });
          }
        });
      }
      // Nothing captured = nothing to run (the buttons are disabled at zero;
      // this is the parity guard). An appointments-scoped run legitimately has
      // ZERO sections — only checked rows.
      if (!sections.length && !selectedAppts.length) return;
      var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
      // Run-scoped patient binding: EVERY completion side effect (the
      // completion notify, the appointments-card re-render, the caller's
      // onPostComplete) binds to the patient captured HERE at Submit — never
      // to the mutable currentPatient read at close time. A patient switch
      // between run completion and modal close must not leak this run's
      // side effects onto the new patient.
      var runPatient = currentPatient;
      // eslint-disable-next-line no-console
      console.log('[NextGen-embed] Post Data run', {
        source: source,
        athenaPatientId: runPatientId,
        profilePatientId: currentPatient && currentPatient.id,
        sections: sections.map(function (s) { return { key: s.key, deltas: s.deltas }; }),
        appointments: selectedAppts.map(function (a) { return a.id; }),
      });

      postRunActive = true;
      // Chrome lock for the run — no tab hops, no header actions, no
      // mid-sequence cancel (the simplest honest behavior, as in 25D).
      cancel.disabled = true;
      submit.disabled = true;
      css(cancel, { opacity: '0.5', cursor: 'default' });
      css(submit, { opacity: '0.5', cursor: 'default' });
      tabBar.style.display = 'none';
      if (actionBar) actionBar.style.display = 'none';
      stopFrhcRefresh();

      // --- Phase 2 view: rebuild the body in place (25D pattern) ---
      while (body.firstChild) body.removeChild(body.firstChild);
      var phaseHead = el('div', null, 'Posting to NextGen');
      css(phaseHead, {
        fontSize: '12px', fontWeight: '700', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px',
      });
      body.appendChild(phaseHead);
      var summaryStatus = el('div');
      summaryStatus.setAttribute('role', 'status');
      summaryStatus.setAttribute('aria-live', 'polite');
      css(summaryStatus, { display: 'none', marginBottom: '10px' });
      body.appendChild(summaryStatus);
      var listWrap = el('div');
      css(listWrap, { display: 'flex', flexDirection: 'column', gap: '8px' });
      body.appendChild(listWrap);

      // One row per delta-bearing SECTION…
      var sectionItems = sections.map(function (s) {
        var row = el('div');
        css(row, {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
          padding: '10px 12px', background: '#fff',
        });
        var label = el('div', null, s.label + ' \u2014 ' + s.deltas.length + (s.deltas.length === 1 ? ' update' : ' updates'));
        css(label, { fontSize: '13px', fontWeight: '600', color: THEME.slate900 });
        var result = el('span', null, 'Queued');
        css(result, { fontSize: '12px', color: THEME.slate500 });
        row.appendChild(label);
        row.appendChild(result);
        listWrap.appendChild(row);
        return { section: s, resultEl: result };
      });
      // …then one row per selected appointment — the SHARED 25D/26B row
      // builder + shared result styler, locked for the run.
      var apptStates = selectedAppts.map(function (a) {
        var st = buildAppointmentSelectRow(a, {});
        st.cb.checked = true;
        st.cb.disabled = true;
        listWrap.appendChild(st.row);
        return st;
      });

      function bailOut() {
        // Mid-run patient switch: stop IMMEDIATELY — no further mutations. The
        // Step-16 reseed already reset the working copy, the reflections, and
        // the posted-stamp; close outright (25C-style), no completion notify.
        postRunActive = false;
        postModalCloseNotify = null;
        closePostModal();
      }

      var updatesPosted = 0;
      var apptResults = [];
      var idx = 0;
      // Demographic modal label -> orionPatientDemographicsUpdate input key.
      // Only these fields post live (2026-08-05, platform PR #2929) — the rest
      // are honestly reported as "not wired": coded fields (race/ethnicity/
      // marital status; language's row was removed 2026-08-19) need label→code
      // maps, and SSN is masked in the modal. 2026-08-20 (Craig): Full name
      // and Address post as source-backed COMPOSED rows — their granular wire
      // keys (first/middle/last name + the five address fields) ride the
      // delta's `parts` and bypass this label map; emergency contact stays
      // unwired (its wire field is itself a single composed contactname —
      // no parts to back it). Keep in lockstep with
      // ORION_WRITABLE_DEMOGRAPHIC_FIELDS in server.js.
      var DEMOGRAPHIC_POST_FIELD_KEYS = {
        'Preferred name': 'preferred_name',
        'Date of birth': 'date_of_birth',
        'Sex': 'gender',
        // 'Gender identity' REMOVED 2026-08-19 (Craig's field-set review) —
        // its display row is gone, so the label can never reach a delta.
        'Mobile phone': 'mobile_phone',
        'Home phone': 'home_phone',
        'Email': 'email',
      };
      // LIVE demographic post: app → server → orionPatientDemographicsUpdate
      // → Orion → athena PUT (partial update — only the changed, wired fields
      // are sent; the server drops empties so nothing is ever cleared). A 409
      // means the live lane isn't configured — fall back to the simulated
      // posting so credential-less demos behave exactly as before.
      function postDemographicSectionLive(item, done) {
        var fields = {};
        var wiredDeltas = [];
        var unwired = 0;
        item.section.deltas.forEach(function (f) {
          // Composed rows (Full name / Address, 2026-08-20) carry their
          // chosen source's granular parts — spread the wire keys verbatim.
          if (f.parts && Object.keys(f.parts).length) {
            Object.keys(f.parts).forEach(function (k) { fields[k] = f.parts[k]; });
            wiredDeltas.push(f);
            return;
          }
          var key = DEMOGRAPHIC_POST_FIELD_KEYS[f.field];
          if (key) { fields[key] = f.value; wiredDeltas.push(f); }
          else unwired += 1;
        });
        function simulate() {
          item.section.deltas.forEach(function (f) {
            ATHENA_POSTED_OVERRIDES[f.tab + '|' + f.field] = f.value;
          });
          updatesPosted += item.section.deltas.length;
          setRunResultState(item.resultEl, 'updated', 'Posted (simulated)');
          done();
        }
        if (!wiredDeltas.length) { simulate(); return; }
        fetch('/api/patient/demographics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields }),
        })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              return { status: res.status, body: body };
            });
          })
          .then(function (r) {
            if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
            if (r.status === 409 && r.body && r.body.error === 'live_lane_not_configured') { simulate(); return; }
            if (r.status === 200 && r.body && r.body.posted) {
              // Only the fields athena CONFIRMED move into the posted
              // overrides — unwired deltas stay visible as diffs.
              wiredDeltas.forEach(function (f) {
                ATHENA_POSTED_OVERRIDES[f.tab + '|' + f.field] = f.value;
              });
              updatesPosted += wiredDeltas.length;
              var label = 'Posted ' + wiredDeltas.length + ' to NextGen';
              if (unwired > 0) label += ' · ' + unwired + ' not wired for live posting';
              setRunResultState(item.resultEl, 'updated', label);
            } else {
              var msg = (r.body && r.body.message) ? r.body.message : 'Posting failed (HTTP ' + r.status + ').';
              setRunResultState(item.resultEl, 'failed', 'Failed — ' + msg);
            }
            done();
          })
          .catch(function (err) {
            if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
            setRunResultState(item.resultEl, 'failed', 'Failed — ' + (err && err.message ? err.message : 'network error'));
            done();
          });
      }
      // Insurance modal label -> OrionCoverageItemInput field key. Only these
      // post live (2026-08-14, platform PR #3110 / FR-154). Every other row is
      // infoOnly (Plan name, Insurance type, Last verified) and never produces
      // a delta at all. Plan name was REMOVED from this map in the 2026-08-19
      // review: athena's PUT has no plan-name field, and Orion treats a
      // changed plan name as a carrier change — the DELETE+POST package-change
      // pattern FrontRunner does not drive. The athena package id is
      // deliberately absent — Orion's concern, not the app's (Craig,
      // 2026-08-15; see the fetch below).
      // Keep in lockstep with ORION_WRITABLE_COVERAGE_FIELDS in server.js.
      var INSURANCE_POST_FIELD_KEYS = {
        'Member ID': 'member_id',
        'Group number': 'group_number',
        'Effective date': 'effective_date',
        'Termination date': 'termination_date',
        'Relationship': 'relationship_to_patient',
        // Policyholder block (Craig, 2026-08-19): both platform hops accept
        // these (CoverageWriteItem + the action-handler mirror, verified at
        // b39f40a1), and the delete/create predicate keys only on package id
        // + subscriber id — a policyholder correction is a plain athena PUT.
        // 2026-08-20 (Craig): on the PRIMARY/SECONDARY tabs, 'Policyholder
        // name' and 'Policyholder address' are source-backed COMPOSED rows —
        // their granular wire keys ride the delta's `parts` and bypass this
        // map. The seven granular labels below survive for the ADDED-policy
        // tab only (A-C2), whose rows are typed per part on the add form.
        'Policyholder DOB': 'policyholder_date_of_birth',
        'Policyholder sex': 'policyholder_gender',
        'Policyholder first name': 'policyholder_first_name',
        'Policyholder last name': 'policyholder_last_name',
        'Policyholder address 1': 'policyholder_address_line_1',
        'Policyholder address 2': 'policyholder_address_line_2',
        'Policyholder city': 'policyholder_city',
        'Policyholder state': 'policyholder_state',
        'Policyholder ZIP': 'policyholder_zip',
      };
      // LIVE insurance post: app → server → orionPatientCoverageUpdate →
      // Orion → athena coverage writers (whole-record per COB level; the
      // server resolves coverage_id from the Orion coverage read and pins the
      // patient). A 409 means the live lane isn't configured — fall back to
      // the simulated posting so credential-less demos behave exactly as
      // before. The response's per-level `operations` MUST be branched on:
      // an `uncertain` outcome is a non-idempotent athena CREATE that may or
      // may not have landed (ADR-ATH-010) — surfaced amber, never retried,
      // and never reflected into the posted overrides (we do not know what
      // athena holds).
      function postInsuranceSectionLive(item, done) {
        var fields = {};
        var wiredDeltas = [];
        var unwired = 0;
        item.section.deltas.forEach(function (f) {
          // Composed rows (Policyholder name / address, 2026-08-20) carry
          // their chosen source's granular parts — spread verbatim.
          if (f.parts && Object.keys(f.parts).length) {
            Object.keys(f.parts).forEach(function (k) { fields[k] = f.parts[k]; });
            wiredDeltas.push(f);
            return;
          }
          var key = INSURANCE_POST_FIELD_KEYS[f.field];
          if (key) { fields[key] = f.value; wiredDeltas.push(f); }
          else unwired += 1;
        });
        function simulate() {
          // The pre-#3110 deterministic mock, verbatim: overlay every delta,
          // fire the ST-D1 §6 manual-coverage-change trigger, count all.
          item.section.deltas.forEach(function (f) {
            ATHENA_POSTED_OVERRIDES[f.tab + '|' + f.field] = f.value;
          });
          insuranceChangedManually = true;
          updatesPosted += item.section.deltas.length;
          setRunResultState(item.resultEl, 'updated', 'Posted (simulated)');
          done();
        }
        if (!wiredDeltas.length) { simulate(); return; }
        var priority = item.section.key === 'primary' ? 1 : 2;
        // service_date — the DOS this coverage change is attributed to. Sourced
        // from the LAUNCHED ENCOUNTER (Craig, 2026-08-15), the same source the
        // GFE flow uses for expected date of service, because in a check-in
        // flow the encounter being checked in for IS the date the change
        // belongs to. Load-bearing for self-pay patients: Orion REFUSES a
        // write that queues a self-pay reactivation without one
        // (internal_writer.py:553) rather than guessing the billing period —
        // "today" would answer "open period" on all but the first of the
        // month, creating coverage that is then silently withdrawn while
        // reporting success. Sent unconditionally: harmless on non-self-pay
        // patients (Orion only consults it on the reactivation path), and
        // conditioning it on a client-side self-pay guess would be a
        // lookalike of a rule only Orion can evaluate. Never defaulted to
        // today — an absent encounter date sends nothing and lets Orion's
        // explicit refusal surface, which is the honest outcome.
        var encounterDate = runPatient && runPatient.encounter && runPatient.encounter.date;
        // ⚠ **athena_package_id REMOVED from the app entirely 2026-08-15
        // (Craig)** — this call previously carried an `athenaPackageId` per
        // item, sourced first from the (since removed) comparison row and then
        // from the profile. Ruling of record: the package id is Orion's
        // concern, not the app's. athena's own contract (V1
        // UpdatePatientInsuranceRequest.cs / CreatePatientInsuranceRequest.cs):
        // an insurance UPDATE is a PUT to .../insurances/{insuranceid} — the
        // policy is identified by insuranceid in the URL, which Orion already
        // resolves as coverage_id from its own read; only a CREATE (POST, no
        // id in the path) needs insurancepackageid, and the app never has
        // one for a new policy anyway (athena assigns ids on create; Q5).
        // NOTE the platform Action currently still REQUIRES athena_package_id
        // on every item, so live UPDATE posts are refused upstream until the
        // platform relaxes it for coverage_id-targeted items (ask filed with
        // Linnea) — the app deliberately builds to the CORRECT contract, not
        // to the over-strict one.
        fetch('/api/patient/insurance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coverages: [{ priority: priority, fields: fields }],
            ...(encounterDate ? { serviceDate: encounterDate } : {}),
          }),
        })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              return { status: res.status, body: body };
            });
          })
          .then(function (r) {
            if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
            if (r.status === 409 && r.body && r.body.error === 'live_lane_not_configured') { simulate(); return; }
            if (r.status === 400 && r.body && r.body.error === 'nothing_to_post') {
              // Live lane IS configured but this item is unpostable (the demo
              // placeholder package id is the expected cause). Never
              // simulate here — that would fake an athena reflection while
              // live mode is on.
              setRunResultState(item.resultEl, 'uncertain',
                'Not posted — no usable NextGen package id (demo placeholder)');
              done();
              return;
            }
            if (r.status === 200 && r.body && r.body.posted) {
              var ops = Array.isArray(r.body.operations) ? r.body.operations : [];
              var uncertainOp = ops.some(function (o) { return o && o.outcome === 'uncertain'; });
              var failedOp = ops.some(function (o) { return o && o.outcome === 'failed'; });
              if (uncertainOp) {
                setRunResultState(item.resultEl, 'uncertain',
                  'Uncertain at NextGen — may or may not have applied; reconcile, do not re-post');
                insuranceChangedManually = true; // coverage MAY have changed — recommend re-verify
                done();
                return;
              }
              if (failedOp) {
                setRunResultState(item.resultEl, 'failed', 'Failed at NextGen — see operations');
                done();
                return;
              }
              wiredDeltas.forEach(function (f) {
                ATHENA_POSTED_OVERRIDES[f.tab + '|' + f.field] = f.value;
              });
              insuranceChangedManually = true;
              updatesPosted += wiredDeltas.length;
              var label = 'Posted ' + wiredDeltas.length + ' to NextGen';
              if (unwired > 0) label += ' · ' + unwired + ' not wired for live posting';
              setRunResultState(item.resultEl, 'updated', label);
            } else {
              var msg = (r.body && r.body.message) ? r.body.message : 'Posting failed (HTTP ' + r.status + ').';
              setRunResultState(item.resultEl, 'failed', 'Failed — ' + msg);
            }
            done();
          })
          .catch(function (err) {
            if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
            setRunResultState(item.resultEl, 'failed', 'Failed — ' + (err && err.message ? err.message : 'network error'));
            done();
          });
      }
      function stepSection() {
        if (idx >= sectionItems.length) { idx = 0; stepAppt(); return; }
        var item = sectionItems[idx];
        setRunResultState(item.resultEl, 'pending', 'Posting\u2026');
        seqTimer = setTimeout(function () {
          seqTimer = null;
          if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
          // PRODUCTION CALL SITE (per section): the athena update endpoints
          // via the FrontRunner backend. 2026-08-05: the Demographic section
          // posts LIVE (orionPatientDemographicsUpdate, platform PR #2929).
          // ⚠ **SUPERSEDED 2026-08-14** — this block previously continued
          // "insurance sections remain the deterministic mock (no platform
          // lane yet)" and ran an inline `outcome = 'posted'` mock for them.
          // Platform PR #3110 (FR-154) shipped orionPatientCoverageUpdate, so
          // Primary/Secondary Insurance now post LIVE through
          // postInsuranceSectionLive (whole-record per COB level; the ST-D1
          // §6 manual-coverage-change trigger and the A-C2 single-door note
          // moved into it, firing on live and simulated posts alike).
          // 'failed' stays a REAL code path (R-25), and the credential-less
          // 409 fallback preserves the old mock behavior verbatim.
          if (item.section.key === 'demographic') {
            postDemographicSectionLive(item, function () { idx += 1; stepSection(); });
            return;
          }
          // Only primary/secondary reach here: the capture loop skips
          // custom-render tabs, and those are the only other comparison tabs.
          postInsuranceSectionLive(item, function () { idx += 1; stepSection(); });
        }, 600);
      }
      function stepAppt() {
        if (idx >= apptStates.length) { finishRun(); return; }
        var st = apptStates[idx];
        setRunResultState(st.result, 'pending', 'Updating\u2026');
        seqTimer = setTimeout(function () {
          seqTimer = null;
          if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) { bailOut(); return; }
          // The same INDIVIDUAL PUT/POST /appointments/{appointmentid}/
          // insurances call as the 25D card flow — the SHARED parametrized
          // apply, fed the MODAL'S resolved values (not session-current).
          var outcome = 'updated'; // deterministic mock; 'failed' stays real (R-25)
          if (outcome === 'updated') {
            applyInsuranceUpdateToAppointment(st.appt, resolvedInsurance);
            st.insLine.textContent = insuranceLineText(st.appt);
          }
          setRunResultState(st.result, outcome, outcome === 'updated' ? 'Updated' : 'Failed');
          apptResults.push(outcome);
          idx += 1;
          stepAppt();
        }, 600);
      }

      // --- Phase 3: settled results — summary + R-24 note + Done footer ---
      function finishRun() {
        postRunActive = false;
        var apptsUpdated = apptResults.filter(function (r) { return r === 'updated'; }).length;
        var summary = updatesPosted + (updatesPosted === 1 ? ' update posted' : ' updates posted');
        if (apptStates.length) {
          summary += ' \u00B7 ' + apptsUpdated + (apptsUpdated === 1 ? ' appointment updated' : ' appointments updated');
        }
        summaryStatus.textContent = summary;
        css(summaryStatus, {
          display: 'block', fontSize: '12px', fontWeight: '700',
          color: '#16a34a', background: 'rgba(22,163,74,0.08)',
          border: '1px solid rgba(22,163,74,0.35)', borderRadius: '6px', padding: '7px 10px',
        });
        // R-24: nothing pushes synchronously into the athena UI.
        var r24 = el('div', null, 'Posted via FrontRunner. Changes appear in NextGen after a manual refresh there.');
        css(r24, { fontSize: '12px', color: THEME.slate500, fontStyle: 'italic', marginTop: '10px' });
        body.appendChild(r24);
        // Posted-stamp — surfaces in the review phase on later opens.
        lastPostState = {
          date: rtvToday(),
          summary: updatesPosted + (updatesPosted === 1 ? ' update' : ' updates') +
            (apptStates.length ? ' \u00B7 ' + apptsUpdated + (apptsUpdated === 1 ? ' appointment' : ' appointments') : ''),
        };
        // Completion notify (the Step-13 refresh pattern, moved here from the
        // old fire-and-close submitPost): fired ONCE by closePostModal on any
        // close (Done / X / Esc / overlay); re-renders the appointments card
        // when rows were updated; chains the caller's completion hook (the
        // Demographics re-verify stamp).
        postModalCloseNotify = function () {
          // Context guard: if the athena context switched patients between run
          // completion and this close, EVERY side effect is skipped — the
          // notify, the card re-render, and the caller's onPostComplete all
          // belong to the run's patient, not whoever is in context now. (The
          // Step-16 different-patient branch also force-closes the modal and
          // nulls this callback, so this guard is the belt to that suspender.)
          if (!currentAthenaContext || currentAthenaContext.patientId !== runPatientId) return;
          try {
            // DECISION OF RECORD (Craig, 2026-08-12): this send STAYS — kept
            // deliberately as the mechanism for the automatic athenaOne
            // refresh after a post (athena's only documented one). Until that
            // date it had never been explicitly requested (it rode along in an
            // early Post Data step; the requested outbound sends were only
            // appResize/appPopin) — provenance in CHANGE-JOURNAL.md. It fires
            // ONLY here, on close of a completed posting run, never on render.
            window.AthenaMessaging.notifyPatientDataChange({
              // ATHENA patient id (launch context), NOT the FRHC profile id —
              // caught live 2026-08-13 (Craig): this carried runPatient.id,
              // the MOCK profile's 'P-100242', where the athena patient in
              // context was '27075'. Local-only since PR #35 (wire is
              // envelope-only), but pre-#35 the wrong id crossed the wire,
              // and any future parameterized send or audit use must carry
              // the id athena knows. Key renamed so profile ids can't
              // silently come back.
              athenaPatientId: runPatientId,
              postedAppointments: apptStates.map(function (st2) { return st2.appt.id; }),
            });
          } catch (e) { /* no-op outside athenaOne */ }
          if (apptsUpdated > 0 && runPatient) {
            renderAppointmentsCard(runPatient);
            wireCollapsibleCards();
          }
          if (typeof opts.onPostComplete === 'function') opts.onPostComplete();
        };
        while (footer.firstChild) footer.removeChild(footer.firstChild);
        var done = el('button', null, 'Done');
        done.type = 'button';
        css(done, {
          background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
          borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
          cursor: 'pointer', fontFamily: 'inherit',
        });
        done.addEventListener('click', closePostModal);
        footer.appendChild(done);
        done.focus();
      }

      stepSection();
    }

    dialog.appendChild(head);
    if (actionBar) dialog.appendChild(actionBar);
    dialog.appendChild(tabBar);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    activate(opts.initialTab || (comparisonTabs[0] && comparisonTabs[0].key) || (tabs[0] && tabs[0].key));
    return overlay;
  }

  // (26D: submitPost is GONE — the footer Submit now runs startPostRun inside
  // buildPostModalImpl: async per-section + per-appointment results, with the
  // Step-13 notify moved to run completion via postModalCloseNotify.)

  // Shared focus trap for the Post Data modal.
  function trapFocus(modalEl, e) {
    var list = [];
    modalEl.querySelectorAll('button, input, textarea, select, [tabindex]').forEach(function (n) {
      if (!n.disabled && n.tabIndex !== -1 && n.offsetParent !== null) list.push(n);
    });
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onModalKeydown(e) {
    if (e.key === 'Escape') {
      closePostModal();
      return;
    }
    if (e.key === 'Tab' && postModal) trapFocus(postModal, e);
  }

  // Mounts a freshly-built overlay as the (single) active Post Data modal.
  // Rebuilt fresh on every open so posted values and appointment selections
  // never carry over from a previous reconciliation session, which also keeps
  // each card's scoped modal independent of the others.
  function showPostOverlay(overlay) {
    if (postModal) {
      if (typeof postModal._cleanupLoading === 'function') postModal._cleanupLoading();
      postModal.remove();
      postModal = null;
    }
    postModal = overlay;
    // 27B: single registry slot for the whole post-overlay family (full Post
    // Data, scoped Demographics/Insurance Review, RTV) — replace-without-close
    // keeps the existing registration.
    if (!postModalDeregister) postModalDeregister = registerModalCloser(forceClosePostModal);
    postModal.style.display = 'flex';
    document.addEventListener('keydown', onModalKeydown);
    var firstTab = postModal.querySelector('[role="tab"][aria-selected="true"]') || postModal.querySelector('button');
    if (firstTab) firstTab.focus();
  }

  // Full Post Data modal (Demographic + Primary/Secondary Insurance comparison
  // tabs). Used by the header "Post Data" button only; the Insurance card opens
  // its own scoped modal (no Demographic tab) via CARD_WORKFLOWS.
  function openPostModal(initialTab) {
    if (!currentPatient) return;
    lastFocused = document.activeElement;
    var p = currentPatient;
    showPostOverlay(buildPostModalImpl(p, {
      // 26A: title matches the header launcher button ("Post Data").
      title: 'Post Data',
      sub: p.mrn ? p.name.full + ' · MRN ' + bareMrn(p.mrn) : p.name.full,
      comparisonTabs: [
        { key: 'demographic', label: 'Demographic', defs: buildDemographicDefs(p) },
        { key: 'primary', label: 'Primary Insurance', defs: buildInsuranceDefs(p, 'primary'), payer: (p.insurance && p.insurance.primary && p.insurance.primary.payer) || null },
        { key: 'secondary', label: 'Secondary Insurance', defs: buildInsuranceDefs(p, 'secondary'), payer: (p.insurance && p.insurance.secondary && p.insurance.secondary.payer) || null },
        // NextGen: N-level coverage — Tertiary gets its own tab when present.
      ].concat(p.insurance && p.insurance.tertiary ? [
        { key: 'tertiary', label: 'Tertiary Insurance', defs: buildInsuranceDefs(p, 'tertiary'), payer: p.insurance.tertiary.payer || null },
      ] : []).concat([
        // NextGen: no appointment reads, so no Appointments tab in Post Data.
      ]),
      initialTab: initialTab || 'demographic',
    }));
  }

  // Streamlined Post Data modal scoped to a single card's section. `buildOpts(p)`
  // returns { title, sub, comparisonTabs, initialTab }; the Submit/Cancel footer
  // is added by buildPostModalImpl.
  function openScopedPostModal(buildOpts) {
    if (!currentPatient) return;
    lastFocused = document.activeElement;
    showPostOverlay(buildPostModalImpl(currentPatient, buildOpts(currentPatient)));
  }

  function closePostModal() {
    // 26D: closes are REFUSED while a posting sequence is in flight — Esc, the
    // X button, the overlay click, and Cancel all funnel here, and the footer
    // is disabled anyway. The mid-run patient-switch bail-out clears
    // postRunActive before calling this, so IT closes cleanly.
    if (postRunActive) return;
    if (postModal) {
      if (typeof postModal._cleanupLoading === 'function') postModal._cleanupLoading();
      postModal.remove();
      postModal = null;
    }
    // R-25 (B1): drop the stamp-line refresher so a later run never targets the
    // now-detached headerNote node of a closed modal.
    postModalHeaderNoteRefresh = null;
    // 27B: release the registry slot (no-op during closeAllOpenModals, which
    // clears the registry before invoking closers).
    if (postModalDeregister) { var dereg = postModalDeregister; postModalDeregister = null; dereg(); }
    document.removeEventListener('keydown', onModalKeydown);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
    // 26D: a COMPLETED run notifies on close (the Step-13 refresh pattern,
    // moved from the old fire-and-close submitPost to completion). Fired once.
    if (typeof postModalCloseNotify === 'function') {
      var fn = postModalCloseNotify;
      postModalCloseNotify = null;
      fn();
    }
  }

  // ===========================================================================
  // Claim Verification
  // ---------------------------------------------------------------------------
  // A profile card + a tabbed modal that lets staff pick a pending claim, run a
  // cost check against real negotiated MRF rates, and review/update the raw claim
  // fields. Claims, the patient's benefit design, negotiated rates, and claim
  // submission/update all call real backend endpoints (athena-embed server.js).
  // Anything that cannot be determined — no active athenahealth session, a code
  // with no MRF rate, an unavailable benefit design — is surfaced honestly (e.g.
  // "Rate not available") rather than guessed.
  // ===========================================================================

  // Status-badge palette — orphaned by the 24A cull, ADOPTED by Step 24D1 for
  // the Claim Validation status badges (tidier than leaving it dead). Keys are
  // now the claim statuses; the amber/green tone values are the original shared
  // pill tones, the blue "overridden" tone is a 24D1 addition in the same style.
  // Style pass 2026-10-21: an override is a manual staff action, so it takes
  // the platform "special" tone (6.34:1); icon = the leading chip icon class.
  var CV_STATUS_TONES = {
    'Held for review': { bg: 'hsl(48 96% 89%)', fg: 'hsl(26 90% 37%)', border: 'hsl(48 97% 77%)', icon: 'chip-icon-warn' },
    'Ready to submit': { bg: 'hsl(152 76% 90%)', fg: 'hsl(163 94% 24%)', border: 'hsl(149 80% 84%)', icon: 'chip-icon-check' },
    'Reviewed & overridden': { bg: 'hsl(226 100% 94%)', fg: 'hsl(244 58% 51%)', border: 'hsl(228 96% 89%)', icon: '' },
  };

  // ===========================================================================
  // Real-Time Verification (PROTOTYPE)
  // ---------------------------------------------------------------------------
  // Launched from the "Real-Time Verification" button in the patient identity
  // header. A clearly-labelled mock prototype: pick a set of real-time checks
  // (eligibility, insurance discovery, demographics, credit check)
  // for the in-context patient, "run" them (simulated loading),
  // and review canned results. NOTHING here performs a real athenahealth,
  // FrontRunner, or credit call — the future live-call sites are
  // marked with a single `// TODO:` at the Run Checks handler.
  // (Five-by-Five was removed entirely 2026-08-05 per decision A-C4 —
  // out of V2 scope, no entry point remains.)
  // ===========================================================================

  // The four real-time checks offered in the modal. `result` is the canned
  // (mock) outcome shown after a run; `short` is the label used in History rows.
  // Step 15: entry ORDER here is the single source of display order (card rows,
  // modal list, pass-count all iterate this array): Demographics, Insurance
  // Discovery, Eligibility, Credit Check (last). The credit check keeps the
  // internal key 'financial'; its label was 'Financial Clearance' until
  // 2026-10-30 (Craig): Financial Clearance is now the Pre Check-In card (the
  // platform's clearance record), and this check is the credit check.
  var RTV_SERVICES = [
    {
      key: 'demographics', icon: '\uD83D\uDC64', name: 'Demographics', short: 'Demographics',
      desc: 'Verify patient identity, address, and contact info',
      result: 'Address verified. Phone number active. No discrepancies found.',
    },
    {
      key: 'discovery', icon: '\uD83D\uDD0D', name: 'Insurance Discovery', short: 'Insurance Discovery',
      desc: 'Search for active coverage across carriers',
      result: '3 active policies found \u2014 Blue Cross Blue Shield of Texas (Primary), Aetna (Secondary), Texas Medicaid (Tertiary). No additional coverage identified.',
    },
    {
      key: 'eligibility', icon: '\uD83D\uDEE1\uFE0F', name: 'Eligibility (270/271)', short: 'Eligibility',
      desc: 'Real-time eligibility and benefits verification',
      result: 'Active \u2014 Blue Cross Blue Shield of Texas. Deductible met: $1,200 of $1,500. Copay: $30 specialist.',
    },
    {
      key: 'financial', icon: '\uD83D\uDCB3', name: 'Credit Check', short: 'Credit Check',
      desc: 'Estimate ability to pay from credit data',
      result: 'Moderate ability to pay. Estimated patient responsibility within normal range. Payment plan may be appropriate.',
    },
  ];

  // Mock patient dataset for the right-hand Patient Information panel. The demo
  // patient (Olivia Torres) is already in context, so this is fixed prototype
  // data rather than a lookup.
  var RTV_PATIENT = {
    name: 'Olivia Torres',
    dob: '1987-03-14',
    mrn: 'MRN-100242',
    sex: 'Female',
    address: '4820 Bluebonnet Lane \u00B7 Apt 3B \u00B7 Austin, TX \u00B7 78745',
    phone: '(512) 555-0142',
    email: 'olivia.torres@example.com',
    insurance: {
      primary: { payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', memberId: 'XJT884512903' },
      secondary: { payer: 'Aetna', memberId: 'W2049913' },
    },
  };

  // Seed History rows (most recent first). Newly-run checks are prepended.
  // Part 2 (B1): exactly three deterministic pre-run rows. Each service's seeded
  // last-run stamp (RTV_LAST_RUN_SEED below) equals the date of its NEWEST row
  // here — the no-contradiction invariant between the History tab and the
  // per-check date stamps.
  var RTV_SEED_HISTORY = [
    { date: '2026-03-01', services: 'Eligibility, Credit Check', status: 'Completed' },
    { date: '2025-12-10', services: 'Insurance Discovery', status: 'Completed' },
    { date: '2025-09-02', services: 'Eligibility, Insurance Discovery, Demographics', status: 'Completed' },
  ];

  // Part 1 (29B): the unified CHECKS registry — ONE entry per check merging the
  // three formerly-parallel stores (last-run date, result, detail) so a check's
  // date and status can never be updated out of lockstep. Dates stay YYYY-MM-DD
  // (the format daysSince() and the History tab already use).
  //   - Seed dates mirror each check's newest History row above (the B1
  //     no-contradiction invariant between the History tab and the stamps).
  //   - Seed results/details are the PRE-RUN state (see the block comment above
  //     the legacy views below for the per-check rationale).
  //   - Reset to the seed on patient change (alongside insuranceDiscovered).
  // id/label/short mirror RTV_SERVICES (key/name/short) for registry consumers.
  var CHECKS_SEED = Object.freeze({
    demographics: Object.freeze({ id: 'demographics', label: 'Demographics', short: 'Demographics', lastRunAt: '2025-09-02', result: 'warn', detail: null }),
    discovery: Object.freeze({ id: 'discovery', label: 'Insurance Discovery', short: 'Insurance Discovery', lastRunAt: '2025-12-10', result: 'pass', detail: null }),
    eligibility: Object.freeze({ id: 'eligibility', label: 'Eligibility (270/271)', short: 'Eligibility', lastRunAt: '2026-03-01', result: 'fail', detail: 'Subscriber not found in current plan year' }),
    financial: Object.freeze({ id: 'financial', label: 'Credit Check', short: 'Credit Check', lastRunAt: '2026-03-01', result: 'pass', detail: null }),
  });
  function checksFromSeed() {
    var o = {};
    Object.keys(CHECKS_SEED).forEach(function (k) {
      var s = CHECKS_SEED[k];
      o[k] = { id: s.id, label: s.label, short: s.short, lastRunAt: s.lastRunAt, result: s.result, detail: s.detail, ranThisSession: false };
    });
    return o;
  }
  var CHECKS = checksFromSeed();

  // Legacy VIEWS (29B) — the old three store names survive ONLY as thin derived
  // views over CHECKS, never as copies (single-source-of-truth rule). Chosen over
  // a mechanical rename because buildReadiness() is a standing fence (byte-
  // identical, untouchable) and it reads these names; every reference OUTSIDE
  // buildReadiness() was migrated to CHECKS / the accessors below. Reads,
  // writes, and deletes all pass through to the registry:
  //   RTV_LAST_RUN[k]            <-> CHECKS[k].lastRunAt (a view write also
  //                                  flags ranThisSession — in-session by definition)
  //   RTV_CARD_SERVICE_STATUS[k] <-> CHECKS[k].result
  //   RTV_SERVICE_DETAIL[k]      <-> CHECKS[k].detail (delete -> null; a null
  //                                  detail reads as undefined so `|| fallback`
  //                                  callers behave exactly as before)
  function makeCheckView(field) {
    var target = {};
    Object.keys(CHECKS_SEED).forEach(function (k) { target[k] = true; });
    return new Proxy(target, {
      get: function (t, k) {
        if (!CHECKS[k]) return undefined;
        var v = CHECKS[k][field];
        return v === null ? undefined : v;
      },
      set: function (t, k, v) {
        if (CHECKS[k]) {
          CHECKS[k][field] = v;
          if (field === 'lastRunAt') CHECKS[k].ranThisSession = true;
        }
        return true;
      },
      deleteProperty: function (t, k) {
        if (CHECKS[k]) CHECKS[k][field] = null;
        return true;
      },
      has: function (t, k) { return !!CHECKS[k]; },
      getOwnPropertyDescriptor: function (t, k) {
        if (!CHECKS[k]) return undefined;
        var v = CHECKS[k][field];
        return { value: v === null ? undefined : v, enumerable: true, configurable: true, writable: true };
      },
    });
  }
  var RTV_LAST_RUN = makeCheckView('lastRunAt');

  // The two display accessors (29B) — ALL check-date/-result display reads
  // funnel through these (checkStamp wraps the existing fmtRunDate).
  function checkStamp(key) {
    return fmtRunDate(CHECKS[key] && CHECKS[key].lastRunAt);
  }
  function checkResult(key) {
    return (CHECKS[key] && CHECKS[key].result) || 'pass';
  }

  // 29C: stampCheck — the ONE write path for check state. Every mutation of a
  // CHECKS entry flows through this door: it stamps lastRunAt = today +
  // ranThisSession for each key, lets the caller's `apply(key, entry)` set
  // result/detail per key, then owns the COMPLETE render fan-out so no surface
  // can go stale: RTV card, readiness panel, collapsed key-status headers,
  // any open post-modal's header note (postModalHeaderNoteRefresh), and the
  // Insurance card when eligibility is among the stamped keys (its meters +
  // verified date reflect eligibility runs, Step 20). Callers do orchestration
  // ONLY (outcome logic via apply, History rows, accumulator stamps, data
  // re-pull) — none of them renders check surfaces itself afterward. The 29B
  // Proxy views stay readable for the fenced buildReadiness(), but no
  // production code writes through them (harness tripwire enforces this).
  function stampCheck(keys, apply) {
    keys.forEach(function (key) {
      var entry = CHECKS[key];
      if (!entry) return;
      entry.lastRunAt = rtvToday();
      entry.ranThisSession = true;
      if (typeof apply === 'function') apply(key, entry);
    });
    if (currentPatient) {
      renderRealTimeVerificationCard(currentPatient);
      renderReadinessPanel(currentPatient);
      if (keys.indexOf('eligibility') !== -1) renderInsuranceCard(currentPatient);
      wireCollapsibleCards();
    }
    if (typeof postModalHeaderNoteRefresh === 'function') postModalHeaderNoteRefresh();
  }

  // Today's date as YYYY-MM-DD (matches the History table format).
  function rtvToday() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Part 5 (B1): format a YYYY-MM-DD stamp as MM/DD/YYYY for display (date-only,
  // no time). Returns '' for a missing/malformed value so callers can guard.
  function fmtRunDate(dateStr) {
    if (!dateStr) return '';
    var parts = String(dateStr).split('-');
    if (parts.length !== 3) return '';
    return parts[1] + '/' + parts[2] + '/' + parts[0];
  }

  // Whole ROLLING days between a YYYY-MM-DD date and today (today minus N
  // calendar days — NOT a calendar month). Generic by design — reused by R-18
  // (180-day demographics) next. Compares at local midnight to avoid DST/tz drift.
  // 29D: named threshold constants — the R-17/R-18 staleness windows, at module
  // scope near the registry so every gate reads ONE named value instead of a
  // scattered literal. REGISTERED DUPLICATE: the `> 180` literal inside the
  // fenced buildReadiness() cannot be edited (byte-identical constraint); it
  // must always equal DEMOGRAPHICS_REVERIFY_DAYS — a harness tripwire
  // (harness29d) source-scans the fence and fails if the two ever diverge.
  var ELIGIBILITY_AUTO_RUN_DAYS = 30;   // staleness recommendation threshold (ST-C4 §2; ex-R-17 auto-run gate)
  var DEMOGRAPHICS_REVERIFY_DAYS = 180; // R-18: demographics re-verify ask when staler than this
  // Returns Infinity for a missing/unparseable date so callers treat "never
  // verified" as stale.
  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    var parts = String(dateStr).split('-');
    if (parts.length !== 3) return Infinity;
    var then = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(then.getTime())) return Infinity;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today.getTime() - then.getTime()) / (24 * 60 * 60 * 1000));
  }

  // ---------------------------------------------------------------------------
  // Real-Time Verification PROFILE CARD (distinct from the modal above).
  //
  // Module-level state so the card's pre-run vs post-run face survives the modal
  // being opened/closed multiple times. Per-service card statuses map the
  // existing modal's canned mock results (RTV_SERVICES[].result) onto a
  // pass / warn / fail indicator. Seeds below are the PRE-RUN state; Step 14:
  // running the checks applies the run outcome in runEligibilityCheck() — every
  // service resolves to pass EXCEPT eligibility, which stays fail until the
  // targeted discovery action resolves it (and is never re-failed afterwards):
  //   Eligibility        -> fail  (Step 10A: subscriber not found — drives the
  //                                readiness blocker scenario; was pass)
  //   Insurance Discovery-> pass  (no additional coverage found)
  //   Demographics       -> warn  (minor mismatch — address variance; passes on run)
  //   Credit Check       -> pass  (cleared)
  // All styling routed through css() (CSSOM) so the embed CSP is respected.
  // ---------------------------------------------------------------------------
  var rtvHasRun = false;
  // R-16: eligibility's last-verified date now lives in RTV_LAST_RUN.eligibility
  // (the shared per-check store, B1) — the rolling-day source of truth for the
  // >30-day staleness recommendation (ST-C4 §2 retired the auto-run this date
  // once gated). Stamped to today by any eligibility-inclusive run.
  // (rtvLastRunTime removed in B1: the RTV card no longer shows a run time.
  // eligibilityAutoChecked removed 2026-08-14: write-only since the retirement —
  // audit GAP-3.)
  // Step 16: whether Insurance Discovery has FOUND the patient's correct
  // insurance this session. This is the causal signal MANUAL eligibility runs
  // read: eligibility fails ("subscriber not found") while the insurance on
  // file is wrong, and PASSES on any (re-)run once discovery has fixed the
  // insurance context. ⚠ **CORRECTED 2026-08-14 (A-C1 executed)** — previously
  // ended "Discovery itself never sets eligibility — the follow-on eligibility
  // re-run (through the shared runEligibilityCheck path) does." The chained
  // re-run is REMOVED: discovery's completion applies its included eligibility
  // data directly (see runInsuranceDiscovery), with no follow-on run.
  var insuranceDiscovered = false;
  // Step 20: whether an eligibility-INCLUSIVE run has verified the insurance
  // accumulators for the CURRENT patient. false → the Insurance card renders
  // the `pre` accumulator set + the seeded last-known verified date; true →
  // the fixed `verified` set + the stamped date below. Reset on patient
  // change alongside insuranceDiscovered (same causal-scoping rule).
  var insuranceAccumsVerified = false;
  var insuranceVerifiedDate = null; // MM/DD/YYYY display stamp (matches the seeded format)
  // Step 20 single door: flip the displayed accumulators to their FIXED verified
  // sets and stamp the verified date to today. TWO callers, kept in lockstep
  // through this helper: every eligibility-INCLUSIVE run (runEligibilityCheck),
  // and discovery's completion — whose result INCLUDES eligibility data (A-C1),
  // so it verifies the accumulators without a separate run.
  function markEligibilityVerifiedToday() {
    insuranceAccumsVerified = true;
    var tp = rtvToday().split('-'); // reuse the existing today helper
    insuranceVerifiedDate = tp[1] + '/' + tp[2] + '/' + tp[0]; // MM/DD/YYYY (seeded format)
  }
  // ST-D1 §6 / ST-C4 §1: whether coverage was changed MANUALLY this session —
  // the A-C2 add or a Post Data insurance edit. Drives the "Insurance changed —
  // run eligibility" recommendation. Deliberately NOT set by discovery: the
  // subsume rule says a discovery-sourced coverage change produces no
  // eligibility recommendation, because the discovery result already carried the
  // eligibility data (Linnea, 2026-08-04). Set at the POSTED moment, not at
  // form-fill, so an add that is cancelled before Submit never triggers it.
  // Per-patient: reset on a DIFFERENT-patient switch with the rest of §1.
  var insuranceChangedManually = false;
  // R-18: demographics' last-verified date now lives in RTV_LAST_RUN.demographics
  // (the shared per-check store, B1) — seeded >180 days before today so the
  // re-verify ASK appears pre-run. Stamped to today by markDemographicsReverified()
  // and by any run that includes demographics. Both paths stamp this ONE signal.
  // 29B: the per-service status + detail stores are now VIEWS over CHECKS (the
  // seeds moved verbatim into CHECKS_SEED above — eligibility fail + "Subscriber
  // not found…", discovery/financial pass, demographics warn). The
  // readiness rollup (buildReadiness) keeps reading these names — one source of
  // truth via the pass-through views, not a parallel copy.
  var RTV_CARD_SERVICE_STATUS = makeCheckView('result');
  var RTV_SERVICE_DETAIL = makeCheckView('detail');
  // Indicator colors — grey (not yet run), green (pass), amber (warn), red (fail).
  // Green/amber match wireCardStatusDots; red mirrors the modal's blocking tone.
  var RTV_DOT_COLOR = { grey: '#94a3b8', pass: '#16a34a', warn: '#f59e0b', fail: '#dc2626' };

  // Current time as e.g. "10:30 AM" (set when a modal run completes).
  function rtvFormatTime(d) {
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  function rtvPassCount() {
    var n = 0;
    RTV_SERVICES.forEach(function (s) {
      if (checkResult(s.key) === 'pass') n++;
    });
    return n;
  }

  // ---- Step 19: shared met/total progress bar --------------------------------
  // ONE progress-bar implementation for the whole app: the pattern built for the
  // Member Eligibility card's plan-year accumulators (12C), now extracted so the
  // Insurance card's deductible/OOP-max bars reuse it. met/total are NUMBERS;
  // the % and bar width are COMPUTED here so the bar always matches the figures.
  function meterPct(met, total) {
    return total > 0 ? Math.min(100, Math.round((met / total) * 100)) : 0;
  }
  function buildMeterBar(met, total, ariaLabel) {
    var track = el('div');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(total));
    track.setAttribute('aria-valuenow', String(met));
    if (ariaLabel) track.setAttribute('aria-label', ariaLabel);
    css(track, {
      height: '6px', borderRadius: '999px', background: THEME.border,
      overflow: 'hidden', marginTop: '4px',
    });
    var fill = el('div');
    fill.className = 'accum-fill';
    css(fill, { height: '100%', width: meterPct(met, total) + '%', background: THEME.teal, borderRadius: '999px' });
    track.appendChild(fill);
    return track;
  }

  // ---- Step 19/20: Insurance card enrichment (Clearline layout) --------------
  // Static MOCK values merged over the FrontRunner payload's insurance objects
  // at render time (payer/plan/member/group/effective/status/copay come from the
  // payload; these fill the fields the payload doesn't carry yet). deductible /
  // oopMax use the SAME met/total-number accumulator shape as the Member
  // Eligibility card.
  //
  // Step 20 — before/after model: each plan carries TWO FIXED accumulator sets.
  //   pre      → shown before eligibility has been verified for this patient
  //              (with the seeded last-known verifiedDate).
  //   verified → what an eligibility verification "returns"; applied whenever an
  //              eligibility-INCLUSIVE run completes (verified date stamps to
  //              today). Values are FIXED — repeat runs re-apply the SAME set
  //              (deterministic, no incrementing, no drift past the total).
  // In a live integration the `verified` values would come from the eligibility
  // API response per coverage; this is the mock stand-in.
  var INSURANCE_CARD_ENRICHMENT = {
    primary: {
      coinsurance: '20% after deductible',
      accums: {
        pre: {
          deductible: { met: 820, total: 1500 },
          oopMax: { met: 1650, total: 6500 },
        },
        verified: {
          // Matches the RTV eligibility result text ("Deductible met: $1,200 of $1,500").
          deductible: { met: 1200, total: 1500 },
          oopMax: { met: 2350, total: 6500 },
        },
      },
      inNetwork: true,
      planType: 'PPO',
      phone: '1-800-521-2227',
      verifiedDate: '01/15/2026', // last-known (pre-verification) stamp
    },
    tertiary: {
      copay: '$0',
      coinsurance: '$0',
      planType: 'Medicaid',
      inNetwork: true,
      phone: '1-800-964-2777',
      verifiedDate: '03/05/2026',
    },
    secondary: {
      copay: '$25 primary',
      coinsurance: '30% after deductible',
      accums: {
        pre: {
          deductible: { met: 150, total: 1000 },
          oopMax: { met: 320, total: 4000 },
        },
        verified: {
          deductible: { met: 300, total: 1000 },
          oopMax: { met: 640, total: 4000 },
        },
      },
      inNetwork: true,
      planType: 'POS',
      phone: '1-800-872-3862',
      verifiedDate: '01/10/2026', // last-known (pre-verification) stamp
    },
  };

  // Renders the Insurance card body in the richer Clearline layout: per
  // insurance (Primary/Secondary) a header with shield + payer/plan + status
  // and rank pills, a Member ID/Group/Effective/Status grid, a benefits row
  // (copay, coinsurance, deductible + OOP-max met/total bars via the SHARED
  // buildMeterBar), an In-Network/plan-type/phone tags row, and a verified
  // date. Values render from the merged data objects — nothing inline-hardcoded
  // in markup. Idempotent: replaces the previous body content on each render,
  // INSIDE the existing card shell so Step-8 collapse wiring is untouched.
  function renderInsuranceCard(p) {
    var card = document.getElementById('insurance-card');
    if (!card) return;
    var host = card.querySelector('.card-body') || card;
    var oldKv = host.querySelector('.kv');
    if (oldKv && oldKv.parentNode) oldKv.parentNode.removeChild(oldKv);
    var oldRich = host.querySelector('.ins-rich');
    if (oldRich && oldRich.parentNode) oldRich.parentNode.removeChild(oldRich);

    function usd0(n) { return '$' + n.toLocaleString('en-US'); }

    function metricBlock(labelText, node) {
      var b = el('div');
      b.appendChild(el('div', 'ins-kv-label', labelText));
      b.appendChild(node);
      return b;
    }

    function barMetric(labelBase, acc) {
      var b = el('div');
      b.appendChild(el('div', 'ins-kv-label', labelBase + ' (' + meterPct(acc.met, acc.total) + '% MET)'));
      b.appendChild(el('div', 'ins-metric-amounts', usd0(acc.met) + ' / ' + usd0(acc.total)));
      b.appendChild(buildMeterBar(acc.met, acc.total, labelBase));
      return b;
    }

    function planBlock(rank, data, extra) {
      // Step 20: pick the accumulator set by verification state — `pre` until an
      // eligibility-inclusive run has verified this patient, then the FIXED
      // `verified` set; the verified date shows the stamped today-date once set,
      // else the seeded last-known stamp.
      var accums = extra.accums || {};
      var accSet = (insuranceAccumsVerified ? accums.verified : accums.pre) || {};
      var merged = {
        copay: data.copay || extra.copay || '\u2014',
        coinsurance: extra.coinsurance || '\u2014',
        deductible: accSet.deductible,
        oopMax: accSet.oopMax,
        inNetwork: !!extra.inNetwork,
        planType: extra.planType || '',
        phone: extra.phone || '',
        verifiedDate: (insuranceAccumsVerified && insuranceVerifiedDate) || extra.verifiedDate || '',
      };
      var block = el('div', 'ins-plan');

      var head = el('div', 'ins-plan-head');
      var shield = el('span', 'ins-shield', '\uD83D\uDEE1\uFE0F');
      shield.setAttribute('aria-hidden', 'true');
      head.appendChild(shield);
      var names = el('div', 'ins-head-names');
      names.appendChild(el('div', 'ins-payer', data.payer || '\u2014'));
      names.appendChild(el('div', 'ins-plan-name', data.planName || '\u2014'));
      head.appendChild(names);
      var pills = el('div', 'ins-pills');
      if (/^active/i.test(data.status || '')) pills.appendChild(el('span', 'ins-pill ins-pill-active chip-icon-check', 'Active'));
      pills.appendChild(el('span', 'ins-pill ins-pill-rank', rank === 'primary' ? 'Primary' : rank === 'secondary' ? 'Secondary' : rank === 'tertiary' ? 'Tertiary' : 'Coverage ' + rank));
      head.appendChild(pills);
      block.appendChild(head);

      var grid = el('div', 'ins-grid');
      [
        ['Member ID', data.memberId],
        ['Group Number', data.groupNumber],
        ['Effective Date', data.effectiveDate],
        ['Status', data.status],
      ].forEach(function (kv) {
        var cell = el('div');
        cell.appendChild(el('div', 'ins-kv-label', kv[0]));
        cell.appendChild(el('div', 'ins-kv-value', kv[1] || '\u2014'));
        grid.appendChild(cell);
      });
      block.appendChild(grid);

      var benefits = el('div', 'ins-benefits');
      benefits.appendChild(metricBlock('Copay', el('div', 'ins-kv-value', merged.copay)));
      benefits.appendChild(metricBlock('Coinsurance', el('div', 'ins-kv-value', merged.coinsurance)));
      if (merged.deductible) benefits.appendChild(barMetric('Deductible', merged.deductible));
      if (merged.oopMax) benefits.appendChild(barMetric('OOP Max', merged.oopMax));
      block.appendChild(benefits);

      var tags = el('div', 'ins-tags');
      if (merged.inNetwork) tags.appendChild(el('span', 'ins-pill ins-pill-network', 'In-Network'));
      if (merged.planType) tags.appendChild(el('span', 'ins-pill ins-pill-plantype', merged.planType));
      if (merged.phone) tags.appendChild(el('span', 'ins-phone', '\u260E ' + merged.phone));
      block.appendChild(tags);

      // 29D (Option B, decision of record): the per-plan stamp is its OWN product
      // concept — the insurance PACKAGE's verification — distinct from the checks'
      // "Last verified" language, so it reads "Package verified:" to keep the two
      // dates from ever being misread as the same fact. Dates + update mechanics
      // (accumulator stamps set by eligibility-inclusive runs) unchanged.
      if (merged.verifiedDate) block.appendChild(el('div', 'ins-verified', 'Package verified: ' + merged.verifiedDate));
      return block;
    }

    var wrap = el('div', 'ins-rich');
    var ins = (p && p.insurance) || {};
    if (ins.primary) wrap.appendChild(planBlock('primary', ins.primary, INSURANCE_CARD_ENRICHMENT.primary || {}));
    if (ins.secondary) wrap.appendChild(planBlock('secondary', ins.secondary, INSURANCE_CARD_ENRICHMENT.secondary || {}));
    // NextGen: coverages are N-level (ranked by defaultCob), not just two.
    if (ins.tertiary) wrap.appendChild(planBlock('tertiary', ins.tertiary, INSURANCE_CARD_ENRICHMENT.tertiary || {}));
    host.appendChild(wrap);
  }
  function rtvAllPassed() { return rtvPassCount() === RTV_SERVICES.length; }

  // ---------------------------------------------------------------------------
  // R-19 / R-20: Patient Readiness rollup (DATA MODEL only — Step 10A).
  // Pure function — reads the signals the app already computes and returns a
  // structured readiness object. NO DOM (10B renders it; 10C wires actions).
  // Signal sources (single source of truth — never parallel hardcoded data):
  //   - RTV_CARD_SERVICE_STATUS  FrontRunner's OWN per-service pass/warn/fail
  //                              (R-23: decisions come from our verification
  //                              results, not athena's flag)
  //   - RTV_LAST_RUN.demographics the Step-7 >180-day re-verify staleness state
  //   - currentPatient.alerts    care-gap / preventive alerts
  // Severity mapping:
  //   eligibility fail -> high (prompts insurance discovery, R-19); warn -> medium
  //   demographics stale >180d -> medium
  //   other RTV services fail -> high, warn -> low
  //   care-gap alerts -> low (informational; action wired later)
  // openIssueCount rule (documented choice): counts every NON-informational issue
  //   — i.e. all issues EXCEPT the informational care-gap alerts. So a blocker
  //   like the failed eligibility reads as an open issue while care gaps are
  //   surfaced but not counted as blockers.
  // verdict: 'ready' ONLY when there are no high AND no medium issues.
  // ---------------------------------------------------------------------------
  var READINESS_SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

  function buildReadiness() {
    var issues = [];

    // Eligibility — handled explicitly (fail -> high w/ discovery; warn -> medium).
    var eligStatus = RTV_CARD_SERVICE_STATUS.eligibility || 'pass';
    if (eligStatus === 'fail') {
      issues.push({
        id: 'eligibility',
        severity: 'high',
        title: 'Eligibility verification failed',
        detail: RTV_SERVICE_DETAIL.eligibility || 'Eligibility could not be verified',
        actionLabel: 'Run insurance discovery',
        actionKey: 'discovery',
        informational: false,
      });
    } else if (eligStatus === 'warn') {
      issues.push({
        id: 'eligibility',
        severity: 'medium',
        title: 'Eligibility needs review',
        detail: RTV_SERVICE_DETAIL.eligibility || 'Eligibility returned a warning',
        actionLabel: 'Run insurance discovery',
        actionKey: 'discovery',
        informational: false,
      });
    }

    // Demographics — the Step-7 >180-day re-verify staleness signal (NOT the
    // RTV 'demographics' service warn, which is intentionally skipped below to
    // avoid double-counting the same card).
    if (daysSince(RTV_LAST_RUN.demographics) > 180) {
      issues.push({
        id: 'demographics',
        severity: 'medium',
        title: 'Demographics re-verification recommended',
        detail: 'Last verified ' + RTV_LAST_RUN.demographics,
        actionLabel: 'Review demographics',
        actionKey: 'demographics',
        informational: false,
      });
    }

    // Other RTV services (every service EXCEPT eligibility + demographics, which
    // are handled above): fail -> high, warn -> low.
    RTV_SERVICES.forEach(function (s) {
      if (s.key === 'eligibility' || s.key === 'demographics') return;
      var st = RTV_CARD_SERVICE_STATUS[s.key] || 'pass';
      if (st === 'fail') {
        issues.push({
          id: s.key,
          severity: 'high',
          title: s.short + ' check failed',
          detail: RTV_SERVICE_DETAIL[s.key] || (s.name + ' could not be completed'),
          actionLabel: 'Re-run ' + s.short,
          actionKey: s.key,
          informational: false,
        });
      } else if (st === 'warn') {
        issues.push({
          id: s.key,
          severity: 'low',
          title: s.short + ' needs review',
          detail: RTV_SERVICE_DETAIL[s.key] || (s.name + ' returned a warning'),
          actionLabel: 'Review ' + s.short,
          actionKey: s.key,
          informational: false,
        });
      }
    });

    // Care-gap / preventive alerts — informational (action wired later or none).
    var alerts = (currentPatient && Array.isArray(currentPatient.alerts)) ? currentPatient.alerts : [];
    alerts.forEach(function (al, i) {
      issues.push({
        id: 'alert-' + i,
        severity: 'low',
        title: attnAlertLabel(al.message) || al.type || 'Care gap',
        detail: al.message || '',
        actionLabel: null,
        actionKey: 'alert',
        informational: true,
      });
    });

    // Sort high -> medium -> low (Array.sort is stable in modern engines, so
    // insertion order is preserved within a severity rank).
    issues.sort(function (a, b) {
      return READINESS_SEVERITY_RANK[a.severity] - READINESS_SEVERITY_RANK[b.severity];
    });

    var openIssueCount = issues.filter(function (it) { return !it.informational; }).length;
    var hasHighOrMedium = issues.some(function (it) {
      return it.severity === 'high' || it.severity === 'medium';
    });

    return {
      verdict: hasHighOrMedium ? 'needs-attention' : 'ready',
      openIssueCount: openIssueCount,
      issues: issues,
    };
  }

  // Builds (idempotently) the Real-Time Verification profile card and inserts
  // it after the Rate Search card. Mirrors the other
  // profile cards (head-bar h2, card-sub) and mints a "Run Checks" launcher
  // styled identically to the Open / Explore / Review buttons.
  function renderRealTimeVerificationCard(p) {
    var grid = document.querySelector('#tab-precheckin .card-grid');
    if (!grid) return;
    var existing = $('real-time-verification-card');
    // Step 13: keep re-renders position-stable — remember where the old card sat
    // so the rebuilt one goes back to the SAME slot (a refresh must not reorder).
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'real-time-verification-card';
    card.setAttribute('aria-label', 'Real-Time Verification');
    css(card, { position: 'relative' });

    // Header — status dot sits to the LEFT of the title (pairing with the
    // left-aligned per-service circles below, and clearing the top-right button).
    var h2 = el('h2');
    var headLeft = el('span');
    css(headLeft, { display: 'inline-flex', alignItems: 'center', gap: '8px' });
    var headColor = rtvHasRun ? (rtvAllPassed() ? RTV_DOT_COLOR.pass : RTV_DOT_COLOR.warn) : RTV_DOT_COLOR.grey;
    var headDot = el('span');
    css(headDot, {
      width: '8px', height: '8px', borderRadius: '50%', background: headColor,
      display: 'inline-block', flex: '0 0 auto',
    });
    headDot.setAttribute('aria-hidden', 'true');
    headLeft.appendChild(headDot);
    headLeft.appendChild(el('span', null, 'Real-Time Verification'));
    h2.appendChild(headLeft);
    card.appendChild(h2);

    card.appendChild(el('p', 'card-sub', 'Live eligibility, discovery & credit checks'));

    // Service list — all 5 services, each with a status circle on the left.
    var list = el('div');
    css(list, { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' });
    RTV_SERVICES.forEach(function (s) {
      var rowEl = el('div');
      css(rowEl, { display: 'flex', alignItems: 'center', gap: '10px' });
      var status = rtvHasRun ? checkResult(s.key) : null;
      var circle = el('span');
      css(circle, {
        width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
        background: status ? RTV_DOT_COLOR[status] : RTV_DOT_COLOR.grey,
      });
      circle.setAttribute('aria-hidden', 'true');
      var nameEl = el('span', null, s.name);
      css(nameEl, { fontSize: '13px', color: THEME.slate900, flex: '1 1 auto' });
      // Part 5.1 (B1): per-service last-run date, right-aligned + muted. Reads the
      // shared store so it stays in lockstep with the readiness panel + modal.
      var dateEl = el('span', null, checkStamp(s.key));
      css(dateEl, { fontSize: '12px', color: THEME.slate500, flex: '0 0 auto' });
      rowEl.appendChild(circle);
      rowEl.appendChild(nameEl);
      rowEl.appendChild(dateEl);
      list.appendChild(rowEl);
    });
    card.appendChild(list);

    // Post-run summary line (count passed + last-run time).
    if (rtvHasRun) {
      var summary = el('div', null,
        rtvPassCount() + ' of ' + RTV_SERVICES.length + ' checks passed');
      css(summary, { fontSize: '12px', color: THEME.slate500, fontWeight: '600', marginTop: '12px' });
      card.appendChild(summary);
    }

    // "Run Checks" / "Re-run Checks" launcher — identical styling to the Claims
    // & Billing "Open" / MRF "Explore" buttons (navy fill, top-right, teal hover).
    var runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'rtv-run-btn';
    runBtn.textContent = rtvHasRun ? 'Re-run Checks' : 'Run Checks';
    runBtn.setAttribute('aria-label', (rtvHasRun ? 'Re-run' : 'Run') + ' real-time verification checks');
    css(runBtn, {
      position: 'absolute', top: '10px', right: '12px',
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
      transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
    });
    runBtn.addEventListener('mouseenter', function () {
      runBtn.style.background = THEME.teal; runBtn.style.borderColor = THEME.teal;
    });
    runBtn.addEventListener('mouseleave', function () {
      runBtn.style.background = THEME.navy; runBtn.style.borderColor = THEME.navy;
    });
    runBtn.addEventListener('focus', function () {
      runBtn.style.boxShadow = '0 0 0 3px rgba(40, 71, 118, 0.3)';
    });
    runBtn.addEventListener('blur', function () {
      runBtn.style.boxShadow = 'none';
    });
    runBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openRealTimeVerificationModal();
    });
    card.appendChild(runBtn);

    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot
  }

  // ---- Member Eligibility (Step 12A) ----------------------------------------
  // Input-driven TPA member-benefits lookup on the Pre Check-In tab, mirroring
  // FrontRunner's Member Eligibility page. Unlike the patient-scoped cards (which
  // display the loaded patient), this is a lookup tool: the user enters a member
  // number + DOB, clicks "Check eligibility", and gets that member's TPA benefits.
  // The lookup is mocked (no TPA backend) — for this prototype ANY input resolves
  // to the fully-detailed canned member (Jordan Avery). Data lives in a structured
  // object so 12B/12C can extend the SAME object with vendor / accumulators /
  // benefits sections without hardcoding values in the render markup.
  var MEMBER_ELIGIBILITY_RESULT = {
    memberName: 'Jordan Avery',
    relationship: 'Subscriber',
    memberNumber: 'AET100245781',
    dob: 'Mar 12, 1984',
    network: 'MultiPlan PHCS Network',
    coverageStatus: 'Active coverage',
    // Section 1 (12A): member summary. 12B will add `vendor`; 12C `accumulators`
    // + `benefits`. Rendered from this array — never inlined in markup.
    summary: [
      { label: 'Plan', value: 'Aetna Choice POS II' },
      { label: 'Plan Type', value: 'PPO' },
      { label: 'Group', value: 'Avery Logistics LLC' },
      { label: 'Group #', value: 'GRP-884213' },
      { label: 'Effective', value: 'Jan 1, 2026' },
      { label: 'Termination', value: 'None on file' },
      { label: 'Network', value: 'In-Network' },
      { label: 'Subscriber', value: 'Jordan Avery (AET100245781)' },
    ],
    // Section 2–4 (12B): servicing provider / payer-discovery, responsible
    // payment vendor, and the simulated-271 disclosure. 12C will add
    // `accumulators` + `benefits` the same way.
    vendor: {
      servicingProvider: [
        { label: 'Servicing provider', value: 'Riverbend Primary Care' },
        { label: 'Provider NPI', value: '1483265702' },
      ],
      howWeFound: {
        title: 'How we found the payer',
        rows: [
          { label: 'Network', value: 'MultiPlan PHCS Network' },
          { label: 'Underlying payer / TPA', value: 'Aetna' },
          { label: 'Group / sponsor', value: 'Avery Logistics LLC' },
          { label: 'EDI payer ID', value: 'AET00001' },
        ],
        sourceNote: 'Source: 834 enrollment. Network, underlying payer, group/sponsor and EDI payer id parsed from the 834 enrollment.',
      },
      paymentVendor: {
        title: 'Responsible payment vendor',
        rows: [
          { label: 'Payer', value: 'Aetna' },
          { label: 'EDI payer ID', value: 'AET00001' },
          { label: 'Carrier type', value: 'Commercial' },
          { label: 'Network', value: 'In-Network' },
          { label: 'Claims address', value: 'PO Box 981106 \u00B7 El Paso, TX \u00B7 79998' },
        ],
        phone: '1-800-872-3862',
        portalLabel: 'Member portal',
      },
      // Honest-mock disclosure: no live X12 271 is exchanged. The retrieved
      // timestamp is generated at lookup time (memberEligRetrievedAt).
      simulated271: {
        payer: 'Aetna',
        network: 'MultiPlan PHCS Network',
      },
    },
    // Sections 5–7 (12C): plan-year accumulators, benefits-by-category, and the
    // estimate/validate footer. Accumulator met/total are NUMBERS — the render
    // computes the progress-bar % and the "remaining" amount from them so the
    // bar widths can never drift from the figures.
    accumulators: [
      {
        label: 'Deductible',
        rows: [
          { scope: 'Individual', met: 820, total: 1500 },
          { scope: 'Family', met: 980, total: 3000 },
        ],
      },
      {
        label: 'Out-of-pocket maximum',
        rows: [
          { scope: 'Individual', met: 1240, total: 6000 },
          { scope: 'Family', met: 2110, total: 12000 },
        ],
      },
    ],
    benefits: [
      { category: 'Primary Care Office Visit', network: 'In-network', priorAuth: false, note: null, costShare: '$25.00 copay' },
      { category: 'Specialist Office Visit', network: 'In-network', priorAuth: false, note: null, costShare: '$50.00 copay' },
      { category: 'Emergency Services', network: 'In-network', priorAuth: false, note: 'Copay waived if admitted.', costShare: '$350.00 copay + 20% coinsurance' },
      { category: 'Hospital \u2014 Inpatient', network: 'In-network', priorAuth: true, note: null, costShare: '20% coinsurance' },
      { category: 'Hospital \u2014 Outpatient', network: 'In-network', priorAuth: true, note: null, costShare: '20% coinsurance' },
      { category: 'Pharmacy', network: 'In-network', priorAuth: false, note: 'Tier 1 generic copay; tiers 2\u20134 coinsurance.', costShare: '$15.00 copay' },
      { category: 'Preventive Care', network: 'In-network', priorAuth: false, note: 'Covered in full per ACA.', costShare: '$0.00 copay + 0% coinsurance' },
    ],
    // Informational only — the embed has no "top bar Working Patient" concept;
    // this mirrors the FrontRunner reference guidance text (no functional wiring).
    footer: {
      title: 'Estimate & validate',
      text: 'Select a Working Patient in the top bar to build a cost estimate or validate a claim from this eligibility result.',
    },
  };

  // STEP 34 (decision of record — Craig, July 17, V2 scope review): the Member
  // Eligibility card has NO free-text fields. Member selection is a DROPDOWN of
  // ONLY the loaded patient's insurance packages — free-text entry invites
  // wrong-member lookups and doesn't match the front-desk workflow. The former
  // member-number + DOB text inputs and the sample-member chips (which existed
  // solely to fill those inputs) are gone. OPEN product question (Craig's
  // pending call, do not pre-answer here): how TPA member eligibility should
  // differ — if at all — from what the Insurance card already shows; that call
  // may reshape this card later.

  // Derive the selectable packages from the SAME patient-insurance data the
  // Insurance card renders (currentPatient.insurance). Coverage order:
  // primary, secondary, then any further ranks in object order — a patient
  // with N packages yields N options (derived, never a hardcoded pair).
  function memberEligPackages() {
    var ins = (currentPatient && currentPatient.insurance) || {};
    var ranks = [];
    ['primary', 'secondary'].forEach(function (r) { if (ins[r]) ranks.push(r); });
    Object.keys(ins).forEach(function (r) {
      if (r !== 'primary' && r !== 'secondary' && ins[r]) ranks.push(r);
    });
    return ranks.map(function (r) {
      var pkg = ins[r];
      var rankLabel = r.charAt(0).toUpperCase() + r.slice(1);
      var planBits = [pkg.payer, pkg.planName].filter(Boolean).join(' ');
      return { rank: r, pkg: pkg, label: rankLabel + ' \u2014 ' + (planBits || 'Unknown plan') };
    });
  }

  // ISO YYYY-MM-DD → "Mar 14, 1987" (matches the canned result's DOB style).
  // Parsed by parts — never via new Date(iso) — to avoid timezone off-by-one.
  function memberEligFormatDob(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '\u2014';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
  }

  // STEP 34 honest attribution: the canned lookup result must reflect the
  // SELECTED package — its payer/plan identity in the header, plan-name lines,
  // payer-vendor rows and the simulated-271 disclosure. The benefit/accumulator
  // CONTENT stays canned (capability data is mock by phase rule). Selecting
  // BCBS and receiving an Aetna-labeled result would be a mock-honesty failure.
  function buildMemberEligibilityResult(entry) {
    var pkg = entry.pkg;
    var base = MEMBER_ELIGIBILITY_RESULT;
    var patientName = (currentPatient && currentPatient.name && currentPatient.name.full) || '\u2014';
    var patientDob = memberEligFormatDob(currentPatient && currentPatient.dateOfBirth);
    var memberId = pkg.memberId || '\u2014';
    var payer = pkg.payer || '\u2014';
    var r = {
      memberName: patientName,
      relationship: pkg.relationship || base.relationship,
      memberNumber: memberId,
      dob: patientDob,
      network: base.network,
      coverageStatus: base.coverageStatus,
      summary: base.summary.map(function (row) {
        if (row.label === 'Plan') return { label: 'Plan', value: pkg.planName || payer };
        if (row.label === 'Group #') return { label: 'Group #', value: pkg.groupNumber || row.value };
        if (row.label === 'Effective') return { label: 'Effective', value: pkg.effectiveDate || row.value };
        if (row.label === 'Subscriber') return { label: 'Subscriber', value: patientName + ' (' + memberId + ')' };
        return row; // canned capability content (Plan Type, Group, Termination, Network)
      }),
      vendor: {
        servicingProvider: base.vendor.servicingProvider,
        howWeFound: {
          title: base.vendor.howWeFound.title,
          rows: base.vendor.howWeFound.rows.map(function (row) {
            if (row.label === 'Underlying payer / TPA') return { label: row.label, value: payer };
            return row;
          }),
          sourceNote: base.vendor.howWeFound.sourceNote,
        },
        paymentVendor: {
          title: base.vendor.paymentVendor.title,
          rows: base.vendor.paymentVendor.rows.map(function (row) {
            if (row.label === 'Payer') return { label: row.label, value: payer };
            return row;
          }),
          phone: base.vendor.paymentVendor.phone,
          portalLabel: base.vendor.paymentVendor.portalLabel,
        },
        simulated271: { payer: payer, network: base.vendor.simulated271.network },
      },
      accumulators: base.accumulators,
      benefits: base.benefits,
      footer: base.footer,
    };
    return r;
  }

  // Lookup state — null until a lookup resolves. The selection persists across
  // the card's re-renders (renderProfile can re-run, e.g. after an eligibility
  // run) so a selected/looked-up state isn't lost when the profile refreshes.
  // Patient SWITCH (28C/29C full re-seed) resets all three below.
  var memberEligibilityResult = null;
  var memberEligSelectedRank = ''; // '' = no package selected yet
  // 12B: when the mock lookup resolved — stamps the simulated-271 notice.
  // Module-scoped so the "retrieved" time survives renderProfile re-renders.
  var memberEligRetrievedAt = null;

  function renderMemberEligibilityCard() {
    var grid = document.querySelector('#tab-precheckin .card-grid');
    if (!grid) return;
    var existing = $('member-eligibility-card');
    // Step 13: position-stable re-render (see renderRealTimeVerificationCard).
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'member-eligibility-card';
    card.setAttribute('aria-label', 'Member Eligibility');

    card.appendChild(el('h2', null, 'Member Eligibility'));
    card.appendChild(el('p', 'card-sub', "Look up a third-party-administered (TPA) member's benefits for one of this patient's insurance packages \u2014 coverage status, the responsible payment vendor, and benefits-by-category cost-share."));

    // Part 5.4 (B1): read-only FrontRunner eligibility last-verified stamp from the
    // shared store. This card's OWN "Check eligibility" lookup writes NO date — it
    // simply mirrors the eligibility stamp the RTV runs maintain.
    var eligStamp = el('p', null, 'Eligibility last verified ' + checkStamp('eligibility') + ' (FrontRunner)');
    css(eligStamp, { fontSize: '12px', color: THEME.slate500, fontWeight: '600', margin: '6px 0 0' });
    card.appendChild(eligStamp);

    // ---- Package selector (STEP 34: NO free-text inputs) -------------------
    // A single native <select> whose options are DERIVED from the loaded
    // patient's insurance packages (memberEligPackages — same source the
    // Insurance card renders). The lookup uses the selected package's member
    // id + the patient's own profile DOB; the user supplies neither.
    var packages = memberEligPackages();
    var hasPackages = packages.length > 0;

    var fields = el('div');
    css(fields, {
      display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '12px',
      padding: '12px', borderRadius: '8px', background: THEME.well,
      border: '1px solid ' + THEME.wellBorder,
    });
    var selLabel = el('label', null, 'Insurance package');
    selLabel.setAttribute('for', 'member-elig-package');
    css(selLabel, {
      fontSize: '12px', fontWeight: '700', color: THEME.slate500Strong,
      textTransform: 'uppercase', letterSpacing: '0.4px',
    });
    fields.appendChild(selLabel);

    var pkgSelect = null;
    if (hasPackages) {
      pkgSelect = document.createElement('select');
      pkgSelect.id = 'member-elig-package';
      css(pkgSelect, {
        width: '100%', padding: '8px 10px', border: '1px solid ' + THEME.borderInput,
        borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit', boxSizing: 'border-box',
        color: THEME.slate900, background: '#fff', maxWidth: '420px',
      });
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a package\u2026';
      pkgSelect.appendChild(placeholder);
      packages.forEach(function (entry) {
        var opt = document.createElement('option');
        opt.value = entry.rank;
        opt.textContent = entry.label;
        pkgSelect.appendChild(opt);
      });
      // Restore a persisted selection only if that rank still exists.
      if (memberEligSelectedRank && packages.some(function (e) { return e.rank === memberEligSelectedRank; })) {
        pkgSelect.value = memberEligSelectedRank;
      } else {
        memberEligSelectedRank = pkgSelect.value ? pkgSelect.value : '';
      }
      pkgSelect.addEventListener('change', function () { memberEligSelectedRank = pkgSelect.value; });
      fields.appendChild(pkgSelect);
      var help = el('span', null, "The member id and date of birth come from the patient's profile \u2014 nothing to type.");
      css(help, { fontSize: '12px', color: THEME.slate500Strong });
      fields.appendChild(help);
    } else {
      // Honest empty state: zero insurance packages → no lookup possible.
      var emptyMsg = el('p', null, 'No insurance packages on file');
      emptyMsg.id = 'member-elig-empty';
      css(emptyMsg, { fontSize: '13px', fontWeight: '600', color: THEME.slate500Strong, margin: '2px 0 0' });
      fields.appendChild(emptyMsg);
    }
    card.appendChild(fields);

    // ---- Action buttons ---------------------------------------------------
    var actions = el('div');
    css(actions, { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' });

    var checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.textContent = 'Check eligibility';
    css(checkBtn, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
      transition: 'background 0.15s ease, border-color 0.15s ease',
    });
    // STEP 34: zero packages → the lookup action is DISABLED (honest empty
    // state; there is nothing to look up and no free-text escape hatch).
    if (!hasPackages) {
      checkBtn.disabled = true;
      css(checkBtn, { background: THEME.slate500, borderColor: THEME.slate500, cursor: 'not-allowed', opacity: '0.6' });
    } else {
      checkBtn.addEventListener('mouseenter', function () { checkBtn.style.background = THEME.teal; checkBtn.style.borderColor = THEME.teal; });
      checkBtn.addEventListener('mouseleave', function () { checkBtn.style.background = THEME.navy; checkBtn.style.borderColor = THEME.navy; });
    }

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    css(clearBtn, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
    });

    actions.appendChild(checkBtn);
    actions.appendChild(clearBtn);
    card.appendChild(actions);

    // ---- Result region (Section 1: member summary; populated on lookup) ----
    var resultRegion = el('div');
    resultRegion.id = 'member-elig-result';
    css(resultRegion, { marginTop: '16px' });
    card.appendChild(resultRegion);

    function renderResult() {
      while (resultRegion.firstChild) resultRegion.removeChild(resultRegion.firstChild);
      if (!memberEligibilityResult) { resultRegion.hidden = true; return; }
      resultRegion.hidden = false;
      var r = memberEligibilityResult;

      var divider = el('div');
      css(divider, { height: '1px', background: THEME.border, margin: '0 0 14px' });
      resultRegion.appendChild(divider);

      // Summary header: name + sub-line (left); network + coverage pills (right).
      var head = el('div');
      css(head, {
        display: 'flex', justifyContent: 'space-between', gap: '12px',
        flexWrap: 'wrap', alignItems: 'flex-start',
      });
      var left = el('div');
      css(left, { minWidth: '0' });
      var name = el('div', null, r.memberName);
      css(name, { fontSize: '16px', fontWeight: '700', color: THEME.slate900 });
      var sub = el('div', null, r.relationship + ' \u00B7 Member ' + r.memberNumber + ' \u00B7 DOB ' + r.dob);
      css(sub, { fontSize: '12px', color: THEME.slate500, marginTop: '2px' });
      left.appendChild(name); left.appendChild(sub);

      var pills = el('div');
      css(pills, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
      var netPill = el('span', null, r.network);
      css(netPill, {
        fontSize: '12px', fontWeight: '700', padding: '2px 10px', borderRadius: '999px',
        background: THEME.inset, color: THEME.navy, border: '1px solid ' + THEME.border,
        whiteSpace: 'nowrap',
      });
      // Reuse the existing success badge (green tone) for the active-coverage pill.
      var covPill = el('span', 'badge badge-green chip-icon-check', r.coverageStatus);
      pills.appendChild(netPill);
      pills.appendChild(covPill);

      head.appendChild(left);
      head.appendChild(pills);
      resultRegion.appendChild(head);

      // Detail grid — muted uppercase label over value; wraps under the embed width.
      var detail = el('div');
      css(detail, {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '12px 16px', marginTop: '14px',
      });
      r.summary.forEach(function (row) {
        var cell = el('div');
        css(cell, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
        var lbl = el('span', null, row.label);
        css(lbl, {
          fontSize: '12px', fontWeight: '700', color: THEME.slate500,
          textTransform: 'uppercase', letterSpacing: '0.4px',
        });
        var val = el('span', null, row.value);
        css(val, { fontSize: '13px', fontWeight: '600', color: THEME.slate900, wordBreak: 'break-word' });
        cell.appendChild(lbl); cell.appendChild(val);
        detail.appendChild(cell);
      });
      resultRegion.appendChild(detail);

      // Shared sub-block helpers (12B + 12C sections all use the same shell).
      // Sub-block shell: inset panel, consistent with the card's sectioned look.
      function subBlock() {
        var b = el('div');
        css(b, {
          background: THEME.inset, border: '1px solid ' + THEME.border,
          borderRadius: '8px', padding: '12px 14px', marginTop: '14px',
        });
        return b;
      }
      function blockTitle(text) {
        var t = el('h3', null, text);
        css(t, { fontSize: '13px', fontWeight: '700', color: THEME.slate900, margin: '0' });
        return t;
      }
      // Currency formatter for the accumulator amounts (numbers in the data).
      function money(n) {
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      // ---- 12B: vendor detail sections (below the member summary) ----------
      var v = r.vendor;
      if (v) {
        // Label→value rows: muted uppercase label column, wrapping value column.
        // Two columns at the 600px embed width; long values (claims address)
        // wrap via wordBreak instead of overflowing.
        function kvRows(rows) {
          var wrap = el('div');
          css(wrap, {
            display: 'grid', gridTemplateColumns: 'minmax(110px, 38%) 1fr',
            gap: '7px 12px', marginTop: '10px', alignItems: 'baseline',
          });
          rows.forEach(function (row) {
            var lbl = el('span', null, row.label);
            css(lbl, {
              fontSize: '12px', fontWeight: '700', color: THEME.slate500,
              textTransform: 'uppercase', letterSpacing: '0.4px',
            });
            var val = el('span', null, row.value);
            css(val, { fontSize: '13px', fontWeight: '600', color: THEME.slate900, wordBreak: 'break-word', minWidth: '0' });
            wrap.appendChild(lbl);
            wrap.appendChild(val);
          });
          return wrap;
        }

        // Section 2 — servicing provider / how we found the payer.
        var sec2 = subBlock();
        sec2.appendChild(blockTitle(r.network));
        sec2.appendChild(kvRows(v.servicingProvider));
        var hwfTitle = el('h4', null, v.howWeFound.title);
        css(hwfTitle, {
          fontSize: '12px', fontWeight: '700', color: THEME.slate900,
          margin: '12px 0 0', paddingTop: '10px', borderTop: '1px solid ' + THEME.border,
        });
        sec2.appendChild(hwfTitle);
        sec2.appendChild(kvRows(v.howWeFound.rows));
        var srcNote = el('p', null, v.howWeFound.sourceNote);
        css(srcNote, { fontSize: '12px', color: THEME.slate500, margin: '10px 0 0', lineHeight: '1.45' });
        sec2.appendChild(srcNote);
        resultRegion.appendChild(sec2);

        // Section 3 — responsible payment vendor.
        var sec3 = subBlock();
        sec3.appendChild(blockTitle(v.paymentVendor.title));
        sec3.appendChild(kvRows(v.paymentVendor.rows));
        var contact = el('div');
        css(contact, {
          display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center',
          marginTop: '12px', paddingTop: '10px', borderTop: '1px solid ' + THEME.border,
        });
        var phoneLink = document.createElement('a');
        phoneLink.href = 'tel:' + v.paymentVendor.phone.replace(/[^0-9+]/g, '');
        phoneLink.textContent = v.paymentVendor.phone;
        css(phoneLink, { fontSize: '13px', fontWeight: '600', color: THEME.slate900, textDecoration: 'none' });
        var portalLink = document.createElement('a');
        portalLink.href = '#';
        portalLink.textContent = v.paymentVendor.portalLabel;
        // Prototype placeholder — no member portal exists yet; keep the page put.
        portalLink.addEventListener('click', function (e) { e.preventDefault(); });
        css(portalLink, { fontSize: '13px', fontWeight: '600', color: THEME.teal });
        contact.appendChild(phoneLink);
        contact.appendChild(portalLink);
        sec3.appendChild(contact);
        resultRegion.appendChild(sec3);

        // Section 4 — simulated-271 disclosure (amber notice, honest-mock).
        // Date + time both formatted from the STORED lookup instant so the
        // notice never drifts if the profile re-renders on a later day.
        var ts = '';
        if (memberEligRetrievedAt) {
          var rd = memberEligRetrievedAt;
          var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
          ts = rd.getFullYear() + '-' + pad2(rd.getMonth() + 1) + '-' + pad2(rd.getDate()) +
            ' ' + rtvFormatTime(rd);
        }
        var notice = el('div', null,
          'Simulated 271 to ' + v.simulated271.payer + ' via ' + v.simulated271.network +
          ' \u2014 retrieved ' + ts + '. No live X12 271 was exchanged.');
        notice.setAttribute('role', 'note');
        css(notice, {
          background: THEME.amberBg, border: '1px solid rgba(180, 83, 9, 0.35)',
          borderRadius: '8px', padding: '10px 14px', marginTop: '14px',
          fontSize: '12px', fontWeight: '500', color: THEME.amber, lineHeight: '1.45',
        });
        resultRegion.appendChild(notice);
      }

      // ---- 12C: Section 5 — plan-year accumulators -------------------------
      // Progress % and "remaining" are COMPUTED from the met/total numbers so
      // the bars always match the figures.
      if (r.accumulators) {
        var sec5 = subBlock();
        sec5.appendChild(blockTitle('Plan-year accumulators'));
        r.accumulators.forEach(function (group, gi) {
          var gTitle = el('h4', null, group.label);
          css(gTitle, {
            fontSize: '12px', fontWeight: '700', color: THEME.slate900,
            margin: gi === 0 ? '10px 0 0' : '14px 0 0',
          });
          sec5.appendChild(gTitle);
          group.rows.forEach(function (row) {
            var remaining = Math.max(0, row.total - row.met);
            var line = el('div');
            css(line, { marginTop: '8px' });
            var top = el('div');
            css(top, { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' });
            var scope = el('span', null, row.scope);
            css(scope, { fontSize: '12px', fontWeight: '600', color: THEME.slate900 });
            var amounts = el('span', null, money(row.met) + ' of ' + money(row.total) + ' met');
            css(amounts, { fontSize: '12px', color: THEME.slate500 });
            top.appendChild(scope);
            top.appendChild(amounts);
            line.appendChild(top);
            // Step 19: the track+fill construction moved into the SHARED
            // buildMeterBar helper (also used by the Insurance card's
            // deductible/OOP bars) — same computed-% behavior as before.
            line.appendChild(buildMeterBar(row.met, row.total, group.label + ' \u2014 ' + row.scope));
            var rem = el('div', null, money(remaining) + ' remaining');
            css(rem, { fontSize: '12px', color: THEME.slate500, marginTop: '3px' });
            line.appendChild(rem);
            sec5.appendChild(line);
          });
        });
        resultRegion.appendChild(sec5);
      }

      // ---- 12C: Section 6 — benefits by category ---------------------------
      if (r.benefits) {
        var sec6 = subBlock();
        sec6.appendChild(blockTitle('Benefits by category'));
        var list = el('ul');
        css(list, { listStyle: 'none', margin: '4px 0 0', padding: '0' });
        r.benefits.forEach(function (b, i) {
          var item = el('li');
          css(item, {
            display: 'flex', justifyContent: 'space-between', gap: '4px 12px', flexWrap: 'wrap',
            padding: '9px 0', borderTop: i === 0 ? 'none' : '1px solid ' + THEME.border,
          });
          var left = el('div');
          css(left, { minWidth: '0', flex: '1 1 220px' });
          var nameRow = el('div');
          css(nameRow, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
          var cat = el('span', null, b.category);
          css(cat, { fontSize: '13px', fontWeight: '600', color: THEME.slate900 });
          nameRow.appendChild(cat);
          nameRow.appendChild(el('span', 'badge badge-blue', b.network));
          if (b.priorAuth) nameRow.appendChild(el('span', 'badge badge-amber chip-icon-warn', 'Prior auth'));
          left.appendChild(nameRow);
          if (b.note) {
            var bNote = el('div', null, b.note);
            css(bNote, { fontSize: '12px', color: THEME.slate500, marginTop: '2px' });
            left.appendChild(bNote);
          }
          var cost = el('div', null, b.costShare);
          css(cost, {
            fontSize: '13px', fontWeight: '600', color: THEME.slate900,
            textAlign: 'right', flex: '0 1 auto', wordBreak: 'break-word',
          });
          item.appendChild(left);
          item.appendChild(cost);
          list.appendChild(item);
        });
        sec6.appendChild(list);
        resultRegion.appendChild(sec6);
      }

      // ---- 12C: Section 7 — estimate & validate footer ----------------------
      // Informational guidance mirroring the reference — no functional wiring.
      if (r.footer) {
        var sec7 = subBlock();
        sec7.appendChild(blockTitle(r.footer.title));
        var guide = el('p', null, r.footer.text);
        css(guide, { fontSize: '12px', color: THEME.slate500, margin: '8px 0 0', lineHeight: '1.5' });
        sec7.appendChild(guide);
        resultRegion.appendChild(sec7);
      }
    }

    checkBtn.addEventListener('click', function () {
      // STEP 34: the lookup targets the SELECTED package — no free text. The
      // benefit/accumulator content stays canned (mock by phase rule) but the
      // payer/plan attribution comes from the selected package (honest mock).
      if (!pkgSelect || !pkgSelect.value) return; // no package selected yet
      var entry = null;
      packages.forEach(function (e) { if (e.rank === pkgSelect.value) entry = e; });
      if (!entry) return;
      memberEligSelectedRank = entry.rank;
      memberEligibilityResult = buildMemberEligibilityResult(entry);
      memberEligRetrievedAt = new Date(); // stamps the simulated-271 notice
      renderResult();
      wireCollapsibleCards(); // refresh the collapsed key-status text (idempotent)
      // Step 13: an eligibility lookup ran — re-pull FrontRunner-sourced data.
      // The lookup result above lives in module state and is restored by the
      // refresh's re-render, so it survives (renderResult() runs again inside
      // renderMemberEligibilityCard()).
      refreshFrontRunnerData();
    });
    clearBtn.addEventListener('click', function () {
      memberEligSelectedRank = '';
      if (pkgSelect) pkgSelect.value = '';
      memberEligibilityResult = null;
      memberEligRetrievedAt = null;
      renderResult();
      wireCollapsibleCards();
    });

    renderResult(); // restore result region if a lookup already resolved
    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot
  }

  // Shared, headless eligibility/verification run — the SINGLE run path used by
  // every human-initiated trigger: the modal's "Run Checks" button, the readiness
  // recommendation actions, discovery's completion (via runInsuranceDiscovery),
  // and the Post Data remedies. NOTHING calls this automatically (ST-C4 §2
  // retired the launch auto-run; A-C1 execution 2026-08-14 removed discovery's
  // chained eligibility re-run — a discovery-inclusive run applies its INCLUDED
  // eligibility data inside this one door, see below).
  // Applies the canned per-service results (already held in RTV_CARD_SERVICE_STATUS;
  // a live API call will later populate these), flips the profile card to its
  // post-run face, stamps the last-verified date, records the run in History, and
  // refreshes the card + readiness panel. Pass an optional { label } for the
  // History "Services Run" text.
  //
  // Every run is a human gesture (ST-C4 §2 — nothing auto-runs); metered runs
  // count toward billed usage BY DESIGN, with no suppression here. (The former
  // { auto } option and the History rows' auto flag were removed 2026-08-14 —
  // dead since the launch auto-run's retirement; audit GAP-3 cleanup.)
  function runEligibilityCheck(opts) {
    opts = opts || {};
    // Step 18: a run may be scoped to a SUBSET of services (the modal's
    // selection). opts.services is the list of service keys that actually ran;
    // it DEFAULTS to all services. Unselected services are never touched — they
    // keep their prior status, detail, and verification stamps — ⚠ with ONE
    // dated exception, ruled Craig 2026-08-14: ELIGIBILITY, when DISCOVERY is
    // in the run (see the A-C1 block below).
    var runKeys = (opts.services && opts.services.length)
      ? opts.services
      : RTV_SERVICES.map(function (s) { return s.key; });
    function serviceRan(key) { return runKeys.indexOf(key) !== -1; }
    // A-C1 (James + Craig 2026-08-04; applied to EVERY discovery door per
    // Craig's 2026-08-14 ruling): the discovery result INCLUDES eligibility
    // data, so ANY discovery-inclusive run also refreshes eligibility from
    // that data — no separate metered eligibility run. Living at this single
    // door means the Insurance modal's "Run Discovery", the readiness action,
    // the Post Data remedy, and the RTV modal's scoped run cannot disagree.
    // Discovery FINDING the correct insurance is also what sets the causal
    // flag — one source of truth, before the eligibility outcome is stamped.
    if (serviceRan('discovery')) insuranceDiscovered = true;
    var eligibilityIncluded = serviceRan('discovery') && !serviceRan('eligibility');
    var stampKeys = eligibilityIncluded ? runKeys.concat(['eligibility']) : runKeys;
    function serviceStamped(key) { return stampKeys.indexOf(key) !== -1; }
    // Flip the card to its post-run state.
    rtvHasRun = true;
    // R-16: this run is the most recent ELIGIBILITY verification — but only if
    // eligibility was actually part of it (Step 18) or arrived as discovery's
    // included data (A-C1).
    if (serviceStamped('eligibility')) {
      // Step 20: eligibility verified → BOTH insurances' displayed accumulators
      // move to their FIXED `verified` sets and the verified date stamps to
      // today (repeat runs re-apply the same values — no drift). Runs that
      // touch neither eligibility nor discovery never reach these. In a live
      // integration the values would come from the eligibility response (or
      // the discovery response's included eligibility data).
      markEligibilityVerifiedToday();
    }

    // Record the run in shared History (most recent first).
    // Part 2/4a (B1): default the History label to the services that ACTUALLY
    // ran (derived from runKeys) so a scoped run never records a row implying
    // checks it didn't perform. Callers passing an explicit label keep theirs.
    // A-C1: when eligibility arrived as included data, the row says so rather
    // than implying a second metered run.
    var label = opts.label || runKeys.map(function (k) {
      for (var li = 0; li < RTV_SERVICES.length; li++) {
        if (RTV_SERVICES[li].key === k) return RTV_SERVICES[li].short;
      }
      return k;
    }).join(', ');
    if (eligibilityIncluded) label += ' (incl. eligibility)';
    RTV_SEED_HISTORY.unshift({ date: rtvToday(), services: label, status: 'Completed' });
    // 29C: the check-state portion of the run — dates + outcomes for the
    // services that ran, PLUS eligibility when it arrived as discovery's
    // included data (A-C1: stampKeys, not runKeys) — goes through the single
    // stampCheck door, which also owns the full render fan-out (RTV card,
    // readiness panel, Insurance card when eligibility ran, collapsed headers,
    // open-modal note). Outcome logic per key (unchanged semantics):
    //   - Step 14 (scoped by Step 18): every run service PASSES and drops any
    //     stale failure detail — EXCEPT eligibility.
    //   - Eligibility guard (Step 14/16/18): fails ("subscriber not found")
    //     until discovery has FOUND the correct insurance (insuranceDiscovered);
    //     once resolved it passes on this and every later (re-)run. `=== 'pass'`
    //     stays as the belt-and-braces alias of the same resolved state. (A
    //     discovery-inclusive run set the flag above, so its included
    //     eligibility data always stamps a pass.)
    //   - Demographics' >180-day staleness signal (buildReadiness, untouched)
    //     reads the same stamped date — no separate assignment needed.
    stampCheck(stampKeys, function (key, entry) {
      if (key === 'eligibility') {
        if (insuranceDiscovered || entry.result === 'pass') {
          entry.result = 'pass';
          entry.detail = null;
        } else {
          entry.result = 'fail';
          entry.detail = entry.detail || 'Subscriber not found in current plan year';
        }
        return;
      }
      entry.result = 'pass';
      entry.detail = null;
    });
    // Step 13: this is the SINGLE run path for every trigger — so re-pull
    // FrontRunner data once, after the run's own state changes above are
    // applied. Nothing auto-runs (ST-C4 §2), so the refresh's re-render cannot
    // fire anything (no loop).
    refreshFrontRunnerData();
  }

  function openRealTimeVerificationModal() {
    if (!currentPatient) return;
    lastFocused = document.activeElement;
    var p = currentPatient;

    function clearNode(node) {
      while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    // Per-open state: which services are checked, the run phase, and the History
    // rows (a fresh copy of the seed so each open starts clean).
    var selected = {};
    RTV_SERVICES.forEach(function (s) { selected[s.key] = false; });
    var phase = 'select'; // 'select' | 'loading' | 'results'
    var lastRunServices = [];
    var history = RTV_SEED_HISTORY.map(function (h) {
      return { date: h.date, services: h.services, status: h.status };
    });

    function selectedKeys() {
      return RTV_SERVICES.filter(function (s) { return selected[s.key]; }).map(function (s) { return s.key; });
    }
    function serviceByKey(key) {
      for (var i = 0; i < RTV_SERVICES.length; i++) {
        if (RTV_SERVICES[i].key === key) return RTV_SERVICES[i];
      }
      return null;
    }

    // ---- Overlay + dialog chrome (mirrors buildPostModalImpl) ---------------
    var overlay = document.createElement('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)', display: 'none',
      alignItems: 'center', justifyContent: 'center', padding: '24px', zIndex: '1000',
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePostModal();
    });

    var dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'post-modal-title');
    css(dialog, {
      // Step 11: cap at the athena embed iframe width (~600px) — see note above.
      background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '600px', maxHeight: '90vh',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 45px rgba(0,0,0,0.28)',
    });

    var head = document.createElement('div');
    css(head, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      padding: '16px 20px', backgroundImage: THEME.navyGradient, color: '#fff',
    });
    var titleWrap = document.createElement('div');
    var title = el('div', null, 'Real-Time Verification');
    title.id = 'post-modal-title';
    css(title, { fontSize: '16px', fontWeight: '700' });
    var sub = el('div', null, 'Pick a patient, then run eligibility, insurance discovery, demographics, and patient credit checks.');
    css(sub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    var xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.textContent = '\u00D7';
    xBtn.setAttribute('aria-label', 'Close');
    css(xBtn, {
      background: 'transparent', border: 'none', color: '#fff', fontSize: '24px', lineHeight: '1',
      cursor: 'pointer', padding: '2px 8px', borderRadius: '8px',
    });
    xBtn.addEventListener('click', closePostModal);
    head.appendChild(titleWrap);
    head.appendChild(xBtn);

    // Body — two panels side by side (left: services/results, right: info/history).
    var body = document.createElement('div');
    css(body, { padding: '18px 20px', overflowY: 'auto', flex: '1', background: '#fff' });
    var grid = document.createElement('div');
    css(grid, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', alignItems: 'start' });
    var leftPanel = document.createElement('div');
    var rightPanel = document.createElement('div');
    grid.appendChild(leftPanel);
    grid.appendChild(rightPanel);
    body.appendChild(grid);

    // Small reusable helpers --------------------------------------------------
    function sectionHeader(num, text, subText) {
      var wrap = el('div');
      css(wrap, { marginBottom: '12px' });
      var row = el('div');
      css(row, { display: 'flex', alignItems: 'center', gap: '8px' });
      var badge = el('span', null, num);
      css(badge, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px',
        borderRadius: '50%', background: THEME.navy, color: '#fff', fontSize: '12px', fontWeight: '700', flex: 'none',
      });
      var h = el('div', null, text);
      css(h, { fontSize: '14px', fontWeight: '700', color: THEME.slate900 });
      row.appendChild(badge);
      row.appendChild(h);
      wrap.appendChild(row);
      if (subText) {
        var s = el('div', null, subText);
        css(s, { fontSize: '12px', color: THEME.slate500, marginTop: '4px', marginLeft: '28px' });
        wrap.appendChild(s);
      }
      return wrap;
    }

    function patientChip() {
      var chip = el('div');
      css(chip, {
        display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 14px',
        borderRadius: '999px', background: THEME.inset, border: '1px solid ' + THEME.borderInput,
        fontSize: '13px', fontWeight: '600', color: THEME.slate900,
      });
      chip.appendChild(el('span', null, RTV_PATIENT.name));
      var mrn = el('span', null, '\u00B7 ' + RTV_PATIENT.mrn);
      css(mrn, { color: THEME.slate500, fontWeight: '500' });
      chip.appendChild(mrn);
      return chip;
    }

    // ---- LEFT PANEL ---------------------------------------------------------
    function renderLeft() {
      clearNode(leftPanel);
      if (phase === 'select') { renderSelect(); }
      else if (phase === 'loading') { renderLoading(); }
      else { renderResults(); }
    }

    function selectedCount() { return selectedKeys().length; }

    function renderSelect() {
      // Section 1 header + "Select all" control.
      var hdrRow = el('div');
      css(hdrRow, { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' });
      hdrRow.appendChild(sectionHeader('1', 'Select services', 'Choose which real-time checks to run for this patient'));

      var allLabel = document.createElement('label');
      css(allLabel, { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: '600', color: THEME.slate900, cursor: 'pointer', whiteSpace: 'nowrap', flex: 'none' });
      var allCb = document.createElement('input');
      allCb.type = 'checkbox';
      var allText = el('span', null, 'Select all (' + selectedCount() + '/' + RTV_SERVICES.length + ')');
      allCb.checked = selectedCount() === RTV_SERVICES.length;
      allCb.addEventListener('change', function () {
        var on = allCb.checked;
        RTV_SERVICES.forEach(function (s) { selected[s.key] = on; });
        renderLeft();
      });
      allLabel.appendChild(allCb);
      allLabel.appendChild(allText);
      hdrRow.appendChild(allLabel);
      leftPanel.appendChild(hdrRow);

      // Service cards.
      var list = el('div');
      css(list, { display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' });
      RTV_SERVICES.forEach(function (s) {
        var card = document.createElement('label');
        var on = selected[s.key];
        css(card, {
          display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 14px',
          border: '1px solid ' + (on ? THEME.navy : THEME.border), borderRadius: '8px',
          background: on ? 'rgba(40, 71, 118, 0.06)' : '#fff', cursor: 'pointer',
        });
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = on;
        css(cb, { marginTop: '2px', flex: 'none' });
        cb.setAttribute('aria-label', s.name);
        cb.addEventListener('change', function () {
          selected[s.key] = cb.checked;
          renderLeft();
        });
        var icon = el('span', null, s.icon);
        css(icon, { fontSize: '18px', lineHeight: '1.2', flex: 'none' });
        var textWrap = el('div');
        var name = el('div', null, s.name);
        css(name, { fontSize: '13px', fontWeight: '700', color: THEME.slate900 });
        var desc = el('div', null, s.desc);
        css(desc, { fontSize: '12px', color: THEME.slate500, marginTop: '2px' });
        // Part 5.2 (B1): per-service last-verified date on each checklist row,
        // sourced from the shared store (MM/DD/YYYY).
        var lastV = el('div', null, 'Last verified ' + checkStamp(s.key));
        css(lastV, { fontSize: '12px', color: THEME.slate500, marginTop: '2px' });
        textWrap.appendChild(name);
        textWrap.appendChild(desc);
        textWrap.appendChild(lastV);
        card.appendChild(cb);
        card.appendChild(icon);
        card.appendChild(textWrap);
        list.appendChild(card);
      });
      leftPanel.appendChild(list);

      // Section 2 — patient (already known).
      leftPanel.appendChild(sectionHeader('2', 'Find the patient'));
      var chipWrap = el('div');
      css(chipWrap, { marginBottom: '20px' });
      chipWrap.appendChild(patientChip());
      var chipNote = el('div', null, 'Already in this patient\u2019s context \u2014 no search needed.');
      css(chipNote, { fontSize: '12px', color: THEME.slate500, marginTop: '6px' });
      chipWrap.appendChild(chipNote);
      leftPanel.appendChild(chipWrap);

      // Run Checks — disabled until at least one service is selected.
      var runBtn = el('button', null, 'Run Checks');
      runBtn.type = 'button';
      var enabled = selectedCount() > 0;
      css(runBtn, {
        background: enabled ? THEME.navy : THEME.borderInput, color: '#fff',
        border: '1px solid ' + (enabled ? THEME.navy : THEME.borderInput), borderRadius: '8px',
        padding: '9px 20px', fontSize: '13px', fontWeight: '600',
        cursor: enabled ? 'pointer' : 'not-allowed', fontFamily: 'inherit', opacity: enabled ? '1' : '0.7',
      });
      runBtn.disabled = !enabled;
      runBtn.addEventListener('click', runChecks);
      leftPanel.appendChild(runBtn);
    }

    function renderLoading() {
      var box = el('div');
      css(box, {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px',
        padding: '48px 20px', border: '1px solid ' + THEME.border, borderRadius: '8px', background: THEME.inset,
      });
      var spinner = document.createElement('span');
      spinner.setAttribute('aria-hidden', 'true');
      css(spinner, {
        display: 'inline-block', width: '28px', height: '28px',
        border: '3px solid ' + THEME.border, borderTopColor: THEME.navy, borderRadius: '50%', boxSizing: 'border-box',
      });
      if (typeof spinner.animate === 'function') {
        spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 700, iterations: Infinity });
      }
      var label = el('div', null, 'Running checks\u2026');
      label.setAttribute('role', 'status');
      label.setAttribute('aria-live', 'polite');
      css(label, { fontSize: '13px', fontWeight: '600', color: THEME.slate900 });
      box.appendChild(spinner);
      box.appendChild(label);
      leftPanel.appendChild(box);
    }

    function renderResults() {
      var hdr = el('div', null, 'Verification results');
      css(hdr, { fontSize: '14px', fontWeight: '700', color: THEME.slate900, marginBottom: '12px' });
      leftPanel.appendChild(hdr);

      var list = el('div');
      css(list, { display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' });
      lastRunServices.forEach(function (key) {
        var s = serviceByKey(key);
        if (!s) return;
        var row = el('div');
        css(row, {
          display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px',
          border: '1px solid ' + THEME.border, borderRadius: '8px', background: '#fff',
        });
        // Step 17: the row reflects the ACTUAL shared post-run status (the same
        // RTV_CARD_SERVICE_STATUS the card dot and readiness panel read) — the
        // modal must never claim a pass the shared state doesn't show.
        var passed = checkResult(key) === 'pass';
        var check = el('span', null, passed ? '\u2713' : '\u2715');
        css(check, {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px',
          borderRadius: '50%',
          background: passed ? 'rgba(16, 185, 129, 0.15)' : 'rgba(220, 38, 38, 0.12)',
          color: passed ? '#047857' : '#dc2626',
          fontSize: '13px', fontWeight: '700', flex: 'none', marginTop: '1px',
        });
        var textWrap = el('div');
        var name = el('div', null, s.name);
        css(name, { fontSize: '13px', fontWeight: '700', color: THEME.slate900 });
        var resText = el('div', null, passed ? s.result : ((CHECKS[key] && CHECKS[key].detail) || (s.name + ' could not be completed')));
        css(resText, { fontSize: '12px', color: passed ? THEME.slate500 : '#b91c1c', marginTop: '3px', lineHeight: '1.5' });
        textWrap.appendChild(name);
        textWrap.appendChild(resText);
        row.appendChild(check);
        row.appendChild(textWrap);
        list.appendChild(row);
      });
      leftPanel.appendChild(list);

      var againBtn = el('button', null, 'Run Again');
      againBtn.type = 'button';
      css(againBtn, {
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy, borderRadius: '8px',
        padding: '9px 20px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
      });
      againBtn.addEventListener('click', function () {
        // Reset to the selection step; selections are cleared for a fresh run.
        RTV_SERVICES.forEach(function (s) { selected[s.key] = false; });
        phase = 'select';
        renderLeft();
      });
      leftPanel.appendChild(againBtn);
    }

    function runChecks() {
      // TODO: Replace mock results with live API calls per service — Eligibility: athenahealth 270/271 endpoint; Insurance Discovery: athenahealth discovery API; Demographics: FrontRunner demographic verification; Credit Check: credit data API
      var keys = selectedKeys();
      if (!keys.length) return;
      lastRunServices = keys;
      phase = 'loading';
      renderLeft();
      // Step 16 patient-scoping applies here too: if the athena context switches
      // patients while the mock run is loading, abort — this run's discovery
      // must not mark the NEW patient's insurance as discovered.
      var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
      setTimeout(function () {
        if (currentAthenaContext && currentAthenaContext.patientId !== runPatientId) return;
        var label = keys.map(function (k) { var s = serviceByKey(k); return s ? s.short : k; }).join(', ');
        // Step 17 fix, centralized 2026-08-14: a discovery-inclusive run
        // SUCCEEDS and sets the shared causal flag — but that now happens
        // INSIDE runEligibilityCheck (one source of truth for every discovery
        // door), which also applies discovery's included eligibility data per
        // Craig's 2026-08-14 A-C1 ruling: selecting Insurance Discovery
        // without Eligibility still refreshes eligibility (stamp + verified
        // flip + "(incl. eligibility)" History suffix), the ruled exception
        // to Step-18 scoping. No modal-local status writes.
        // Route the modal run through the SAME shared run path as every other
        // human-initiated trigger: it records the History row, flips the card to
        // its post-run face, and refreshes the readiness panel.
        // Step 18: pass the selection so ONLY the chosen services are updated —
        // unselected services keep their prior status untouched (eligibility-
        // via-discovery excepted, per the ruling above).
        runEligibilityCheck({ label: label, services: keys });
        phase = 'results';
        renderLeft();
        // Re-sync this modal's local History view from the shared seed (which the
        // run just prepended to) so the new row shows without double-recording it.
        history = RTV_SEED_HISTORY.map(function (h) {
          return { date: h.date, services: h.services, status: h.status };
        });
        renderHistory();
      }, 1100);
    }

    // ---- RIGHT PANEL — Patient Information / History tabs --------------------
    var infoPanel, historyPanel, infoTabBtn, historyTabBtn;

    function activateTab(which) {
      var infoActive = which === 'info';
      infoPanel.style.display = infoActive ? 'block' : 'none';
      historyPanel.style.display = infoActive ? 'none' : 'block';
      [[infoTabBtn, infoActive], [historyTabBtn, !infoActive]].forEach(function (pair) {
        var btn = pair[0];
        var active = pair[1];
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        btn.tabIndex = active ? 0 : -1;
        css(btn, {
          color: active ? THEME.navy : THEME.slate500,
          borderBottom: active ? '2px solid ' + THEME.navy : '2px solid transparent',
        });
      });
    }

    function renderRight() {
      clearNode(rightPanel);
      var tabBar = el('div');
      tabBar.setAttribute('role', 'tablist');
      tabBar.setAttribute('aria-label', 'Patient detail sections');
      css(tabBar, { display: 'flex', gap: '2px', borderBottom: '1px solid ' + THEME.border, marginBottom: '14px' });

      function mkTab(label, which) {
        var tb = el('button', null, label);
        tb.type = 'button';
        tb.setAttribute('role', 'tab');
        css(tb, {
          background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
          padding: '10px 12px', fontSize: '13px', fontWeight: '600', color: THEME.slate500,
          cursor: 'pointer', fontFamily: 'inherit',
        });
        tb.addEventListener('click', function () { activateTab(which); });
        return tb;
      }
      infoTabBtn = mkTab('Patient Information', 'info');
      historyTabBtn = mkTab('History', 'history');
      tabBar.appendChild(infoTabBtn);
      tabBar.appendChild(historyTabBtn);
      rightPanel.appendChild(tabBar);

      infoPanel = el('div');
      infoPanel.setAttribute('role', 'tabpanel');
      historyPanel = el('div');
      historyPanel.setAttribute('role', 'tabpanel');
      rightPanel.appendChild(infoPanel);
      rightPanel.appendChild(historyPanel);

      renderInfo();
      renderHistory();
      activateTab('info');
    }

    function infoGroup(titleText) {
      var g = el('div');
      css(g, { marginBottom: '16px' });
      var t = el('div', null, titleText);
      css(t, { fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: THEME.slate500, marginBottom: '8px' });
      g.appendChild(t);
      return g;
    }
    function infoRow(label, value) {
      var row = el('div');
      css(row, { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid ' + THEME.borderSoft });
      var l = el('div', null, label);
      css(l, { fontSize: '12px', color: THEME.slate500, flex: 'none' });
      var v = el('div', null, value);
      css(v, { fontSize: '13px', color: THEME.slate900, fontWeight: '600', textAlign: 'right' });
      row.appendChild(l);
      row.appendChild(v);
      return row;
    }

    function renderInfo() {
      clearNode(infoPanel);
      var demo = infoGroup('Demographics');
      demo.appendChild(infoRow('Name', RTV_PATIENT.name));
      demo.appendChild(infoRow('DOB', RTV_PATIENT.dob));
      demo.appendChild(infoRow('MRN', bareMrn(RTV_PATIENT.mrn)));
      demo.appendChild(infoRow('Sex', RTV_PATIENT.sex));
      demo.appendChild(infoRow('Address', RTV_PATIENT.address));
      demo.appendChild(infoRow('Phone', RTV_PATIENT.phone));
      demo.appendChild(infoRow('Email', RTV_PATIENT.email));
      infoPanel.appendChild(demo);

      var ins = infoGroup('Insurance');
      var pr = RTV_PATIENT.insurance.primary;
      var sec = RTV_PATIENT.insurance.secondary;
      ins.appendChild(infoRow('Primary', pr.payer + ' \u2014 ' + pr.plan));
      ins.appendChild(infoRow('Primary Member ID', pr.memberId));
      ins.appendChild(infoRow('Secondary', sec.payer));
      ins.appendChild(infoRow('Secondary Member ID', sec.memberId));
      infoPanel.appendChild(ins);
    }

    function renderHistory() {
      if (!historyPanel) return;
      clearNode(historyPanel);
      var scroller = el('div');
      css(scroller, { overflowX: 'auto', border: '1px solid ' + THEME.border, borderRadius: '8px' });
      var table = document.createElement('table');
      css(table, { width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '320px' });
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      ['Date', 'Services Run', 'Status'].forEach(function (label) {
        var th = el('th', null, label);
        css(th, {
          textAlign: 'left', padding: '10px 12px', fontSize: '12px', fontWeight: '700',
          textTransform: 'uppercase', letterSpacing: '0.5px', color: THEME.slate500,
          background: THEME.inset, borderBottom: '1px solid ' + THEME.border, whiteSpace: 'nowrap',
        });
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      history.forEach(function (h) {
        var tr = document.createElement('tr');
        function cell(text, isStatus) {
          var td = el('td');
          css(td, { padding: '10px 12px', borderBottom: '1px solid ' + THEME.border, verticalAlign: 'middle', color: THEME.slate900 });
          if (isStatus) {
            var pill = el('span', null, text);
            css(pill, {
              display: 'inline-block', padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '600',
              background: 'rgba(16, 185, 129, 0.12)', color: '#047857', whiteSpace: 'nowrap',
            });
            td.appendChild(pill);
          } else {
            td.textContent = text;
          }
          return td;
        }
        tr.appendChild(cell(h.date));
        tr.appendChild(cell(h.services));
        tr.appendChild(cell(h.status, true));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroller.appendChild(table);
      historyPanel.appendChild(scroller);
    }

    // Footer — Close (teal text link), matching the other modals' Cancel.
    var footer = document.createElement('div');
    css(footer, {
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '18px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: THEME.inset,
    });
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    css(cancel, {
      background: 'transparent', border: 'none', color: THEME.teal, fontSize: '13px',
      fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 4px',
    });
    cancel.addEventListener('mouseenter', function () { cancel.style.textDecoration = 'underline'; });
    cancel.addEventListener('mouseleave', function () { cancel.style.textDecoration = 'none'; });
    cancel.addEventListener('click', closePostModal);
    footer.appendChild(cancel);

    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    renderLeft();
    renderRight();
    showPostOverlay(overlay);
  }

  // ===========================================================================
  // Good Faith Estimates (No Surprises Act). The module-level GFE_ESTIMATES
  // array is the single source of truth for both the profile card and the GFE
  // manager modal; Save / Issue mutate GFE_ESTIMATES in place; the card
  // re-renders on modal close (see the modal's closeModal).
  //
  // 36 (2026-08-17, Craig): the GFE surface was reshaped to match the
  // PRODUCTION GFE builder (frhc-platform, website transparency-suite —
  // GFEWizard.tsx + lib/gfe-validator.ts + lib/gfe-disclosures.ts, live at
  // /claritev/integrity-source?tab=gfe), where fee estimates are no longer
  // separate from GFEs — while staying patient-focused: the embed keeps its
  // single-patient launch context (no patient search / "Register new"), seeds
  // the payer from the patient's athena coverage instead of an insurance-
  // masters lookup, and auto-fills patient/provider/encounter fields.
  //   - the 23E1 Fee-Estimate / Official-GFE `kind` split is RETIRED
  //     everywhere: every estimate IS a GFE; statuses are Draft → Issued.
  //     The Finalize / Send-to-Patient lifecycle retired with it — delivery
  //     intent is set on the form and recorded at issuance (Prod's model),
  //     never a post-hoc Send.
  //   - the issue gate mirrors Prod's validator: Tax ID and ICD-10 diagnosis
  //     are OPTIONAL (Prod's own reasoning — practices issue before billing /
  //     diagnosis are finalised); patient contact is email OR phone; per-line
  //     CPT/HCPCS + description + numeric amount are required; total > $0.
  //     Payer is optional too: in Prod a payer-less GFE prices as in-network
  //     (direct) by default (usePricingDecisionForMaster's no-master branch).
  //   - statutory disclosures are Prod's fixed CMS set VERBATIM and version-
  //     stamped at issuance; the editable per-estimate disclosure textarea was
  //     REMOVED (statutory text is not estimate-specific).
  //   - Visit Type Bundle, Bundling & NCCI Edits, Benefits Summary and the
  //     Calculate button were REMOVED (no Prod counterpart; Step 31/33
  //     discipline — removed, not hidden).
  // STEP 35 STANDS for Print / Download PDF / Email — none returned (Craig,
  // 2026-08-17: FrontRunner Patient Portal delivery only). The portal toggle
  // is NEW capability (delivery intent recorded at issuance), not a Step-35
  // return.
  // 23E2a: mock practice/provider registration record — the source a real
  // integration would pre-fill the provider fields from (provider NPI +
  // practice EIN + default CMS Place of Service for office encounters).
  // Expected date of service seeds from the live encounter (p.encounter.date).
  var GFE_PRACTICE = {
    providerNpi: '1477563391',            // mock 10-digit NPI (encounter provider)
    taxId: '74-2938416',                  // mock 9-digit practice EIN
    placeOfService: '11 \u2014 Office',   // CMS POS code (office-visit encounter)
  };

  // 36: CMS Place of Service options for the Service-location select — a
  // curated subset of Prod's PLACE_OF_SERVICE_CODES (shared/claim-editor
  // schemas; the full CMS set doesn't earn its bytes in a mock select).
  var GFE_POS_OPTIONS = [
    '02 \u2014 Telehealth (other than patient\u2019s home)',
    '10 \u2014 Telehealth in patient\u2019s home',
    '11 \u2014 Office',
    '19 \u2014 Off-campus outpatient hospital',
    '21 \u2014 Inpatient hospital',
    '22 \u2014 On-campus outpatient hospital',
    '23 \u2014 Emergency room \u2014 hospital',
    '81 \u2014 Independent laboratory',
  ];

  // 36: statutory NSA disclosures — Prod's STATUTORY_GFE_DISCLOSURES VERBATIM
  // (transparency-suite/lib/gfe-disclosures.ts; the text is fixed by CMS
  // regulation, never tenant- or estimate-specific). Issuance stamps the
  // version id onto the record, mirroring Prod's `disclosures_version`
  // lockstep rule: wording changes get a NEW version key and existing entries
  // are never mutated, so an issued GFE's exact statutory text stays
  // reproducible from its stamp. (Supersedes the 23E2b paraphrased set and
  // the editable GFE_DISCLOSURE one-liner it led with — both removed.)
  var GFE_NSA_DISCLOSURES = [
    'This Good Faith Estimate shows the costs of items and services that are reasonably expected for your health care needs for an item or service.',
    'The estimate is based on information known at the time the estimate was created and does not include any unknown or unexpected costs that may arise during treatment.',
    'You may contact the health care provider or facility listed to let them know the billed charges are higher than the Good Faith Estimate.',
    'You have the right to initiate the patient-provider dispute resolution process if the actual billed charges are at least $400 higher than the Good Faith Estimate.',
    'Make sure to save a copy or picture of your Good Faith Estimate.',
    'For questions or more information about your right to a Good Faith Estimate, visit www.cms.gov/nosurprises or call 1-800-985-3059.',
  ];
  var GFE_DISCLOSURES_VERSION = 'cms-nsa-v1';

  // 36: FrontRunner discount determinations (financial assistance / sliding
  // fee), keyed by patient id — the mock stand-in for the patient FA /
  // sliding-fee resolution Prod's wizard reads (its GfeDiscountSource shape:
  // kind financial_assistance | sliding_fee, tierLabel, discountPercentage,
  // referenceId). Olivia carries a sliding-fee tier so the receipt's discount
  // row is demonstrable; every other patient exercises the honest empty state
  // ("No active discount on file"). Resolved from the LOADED patient at form
  // open — never module state — so a patient switch resolves THAT patient
  // (ST-C5 isolation).
  // ⚠ OPEN (Craig/JD, 2026-08-17): a discount may ALSO be configured athena-
  // side depending on practice configuration; its semantics are unverified
  // from this environment and are NOT modeled. A future athena-sourced
  // discount is a new `kind` on this same shape, not a reshape.
  var FRHC_DISCOUNT_DETERMINATIONS = {
    'P-100242': {
      kind: 'sliding_fee', referenceId: 'SF-2026-0118',
      tierLabel: 'Sliding fee \u2014 Tier 2', discountPercentage: 20,
    },
  };
  function gfeResolveDiscountSource(p) {
    var pid = p && p.id;
    return (pid && FRHC_DISCOUNT_DETERMINATIONS[pid]) || null;
  }
  function gfeDiscountKindLabel(source) {
    return source && source.kind === 'financial_assistance'
      ? 'financial assistance' : 'sliding fee';
  }

  // 36: money-ish input → number ($/commas tolerated); NaN on blank so the
  // validator can tell "empty" from "zero".
  function gfeParseAmount(v) {
    if (v === null || v === undefined) return NaN;
    var s = String(v).replace(/[$,\s]/g, '');
    if (s === '') return NaN;
    return Number(s);
  }

  // 36: totals — Prod's computeServiceItemsBreakdown reduced to the embed's
  // needs: gross = Σ amount × units; the resolved FrontRunner discount comes
  // off the gross; the remainder is the patient's responsibility. A $0
  // patientResponsibility is deliberately NOT blocked (a 100% assistance plan
  // legitimately owes $0 — the gross still issues as the statutory record;
  // Prod's validator carries the same note).
  function gfeComputeTotals(items, discountSource) {
    var gross = 0;
    (items || []).forEach(function (it) {
      var amt = gfeParseAmount(it.amount); if (isNaN(amt)) amt = 0;
      var units = Number(it.units); if (isNaN(units) || units <= 0) units = 1;
      gross += amt * units;
    });
    gross = Math.round(gross * 100) / 100;
    var pct = discountSource ? (Number(discountSource.discountPercentage) || 0) : 0;
    var discountAmount = Math.round(gross * pct) / 100;
    var patientResponsibility = Math.round((gross - discountAmount) * 100) / 100;
    return { grossTotal: gross, discountAmount: discountAmount, patientResponsibility: patientResponsibility };
  }

  // 36: the issue gate and the NSA validation panel share this ONE validator —
  // the same one-source-of-truth property 23E2b's gfeNsaMissingFields had,
  // which this replaces. Field set and MESSAGES mirror Prod's
  // lib/gfe-validator.ts verbatim, so the panel reads exactly like
  // Production's "No Surprises Act validation" rail. Per the 2026-08-17
  // rulings: Tax ID, ICD-10 diagnosis and payer are OPTIONAL (Prod treatment);
  // patient contact is email OR phone; warnings never block issuance.
  // `rec` is a plain field snapshot, so the same function serves live form
  // state and saved estimate rows (via gfeValidationRec).
  function gfeValidateDraft(rec) {
    rec = rec || {};
    var issues = [];
    function err(field, message) { issues.push({ field: field, message: message, severity: 'error' }); }
    function warn(field, message) { issues.push({ field: field, message: message, severity: 'warning' }); }
    function blank(v) { return v === undefined || v === null || String(v).trim() === ''; }

    [
      ['patientName', 'Patient name'],
      ['patientDob', 'Patient date of birth'],
      ['providerName', 'Provider / facility name'],
      ['providerNpi', 'Provider NPI'],
      ['serviceLocation', 'Service location'],
      ['expectedDateOfService', 'Expected date of service'],
    ].forEach(function (f) {
      if (blank(rec[f[0]])) err(f[0], f[1] + ' is required by the No Surprises Act GFE schema.');
    });
    // Embed-only refinement: Prod guarantees NPI shape through its NPPES
    // lookup, which the embed doesn't have — 23E2b's light 10-digit check
    // carries forward as the stand-in.
    if (!blank(rec.providerNpi)) {
      var npiDigits = String(rec.providerNpi).replace(/\D/g, '');
      if (npiDigits.length !== 10) err('providerNpi', 'Provider NPI must be a 10-digit NPI.');
    }
    if (blank(rec.patientEmail) && blank(rec.patientPhone)) {
      err('patientContact', 'Provide at least one patient contact (email or phone) so the GFE can be delivered.');
    }

    var items = rec.serviceItems || [];
    if (!items.length) err('serviceItems', 'At least one service line is required.');
    items.forEach(function (item, idx) {
      var line = 'Line ' + (idx + 1) + ': ';
      if (blank(item.cptCode)) err('serviceItems[' + idx + '].cptCode', line + 'CPT/HCPCS code is required.');
      if (blank(item.description)) err('serviceItems[' + idx + '].description', line + 'description is required.');
      if (isNaN(gfeParseAmount(item.amount))) err('serviceItems[' + idx + '].amount', line + 'a numeric amount is required.');
      if (!item.units || Number(item.units) <= 0) {
        warn('serviceItems[' + idx + '].units', line + 'units default to 1, but should be greater than zero.');
      }
    });

    if (!blank(rec.expectedDateOfService)) {
      var dos = new Date(rec.expectedDateOfService);
      if (!isNaN(dos.getTime())) {
        var diffDays = (dos.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
        if (diffDays >= 0 && diffDays < 3) {
          warn('expectedDateOfService', 'GFE delivered fewer than 3 business days before service \u2014 confirm patient consent for short-notice scheduling.');
        }
        if (diffDays < -1) {
          warn('expectedDateOfService', 'Expected date of service is in the past \u2014 re-confirm the schedule before issuing.');
        }
      }
    }

    if (rec.totalEstimate != null && rec.totalEstimate <= 0) {
      err('totalEstimate', 'Total estimate must be greater than $0.');
    }
    return issues;
  }
  function gfeIssueBlockers(rec) {
    return gfeValidateDraft(rec).filter(function (i) { return i.severity === 'error'; });
  }
  // Saved records store the gross under `grossTotal`; the validator's field
  // name is Prod's (`totalEstimate`). Shallow shim, not a stored duplicate.
  function gfeValidationRec(estm) {
    var rec = {};
    for (var k in estm) { if (Object.prototype.hasOwnProperty.call(estm, k)) rec[k] = estm[k]; }
    rec.totalEstimate = estm.grossTotal;
    return rec;
  }

  // ST-C5 §1 (the audit's second state-isolation gap): created GFEs must not
  // survive a patient switch. GFE_ESTIMATES was a module-level literal mutated
  // in place; it's now a frozen seed + per-patient working copy, exactly like
  // CLAIMS/APPOINTMENTS.
  var GFE_ESTIMATES_SEED = [
    {
      id: 'GFE-2026-001',
      createdDate: '2026-06-03',
      patientName: 'Olivia Torres',
      patientDob: '1987-03-14',
      patientEmail: 'olivia.torres@example.com',
      patientPhone: '(512) 555-0142',
      providerName: 'Dr. Rachel Nguyen, MD \u2014 Austin Central Clinic',
      providerNpi: '1477563391',
      taxId: '74-2938416',
      serviceLocation: '11 \u2014 Office',
      expectedDateOfService: '2026-06-03',
      payer: 'Blue Cross Blue Shield of Texas',
      plan: 'BlueChoice PPO',
      diagnosisCode: 'E11.9',
      serviceItems: [
        { cptCode: '99213', description: 'Office visit, est. patient \u2013 low complexity', amount: 118.00, units: 1, modifier: null, pricingSource: 'Claritev MRF' },
        { cptCode: '85025', description: 'Complete CBC with differential', amount: 22.00, units: 1, modifier: null, pricingSource: 'Claritev MRF' },
      ],
      grossTotal: 140.00,
      discountSource: { kind: 'sliding_fee', referenceId: 'SF-2026-0118', tierLabel: 'Sliding fee \u2014 Tier 2', discountPercentage: 20 },
      discountAmount: 28.00,
      patientResponsibility: 112.00,
      status: 'Issued',
      issuedDate: '2026-06-03',
      deliverPortal: true,
      // Same shape gfeStampIssue writes, so the detail view shows honest
      // recorded state for the pre-seeded row too (27D-b rule, carried over).
      deliveries: [
        { channel: 'frontrunner-portal', at: '2026-06-03', note: 'GFE posted to the patient\u2019s FrontRunner Patient Portal inbox (simulated \u2014 the embed has no portal write lane).' },
        { channel: 'athena-chart', at: '2026-06-03', appointmentId: 'APT-88843', simulated: true, note: 'NextGen chart attach \u2014 appointment APT-88843 (simulated \u2014 no callable NextGen document lane exists; request shape unverified).' },
      ],
      department: 'Internal Medicine',
      lastActivity: '2026-06-03',
      disclosuresRecorded: true,
      disclosuresVersion: 'cms-nsa-v1',
      nsaDisclosures: GFE_NSA_DISCLOSURES.slice(),
    },
    {
      // Draft — demonstrates the Save lifecycle (issue it later from detail).
      id: 'GFE-2026-002',
      createdDate: '2026-06-10',
      patientName: 'Olivia Torres',
      patientDob: '1987-03-14',
      patientEmail: 'olivia.torres@example.com',
      patientPhone: '(512) 555-0142',
      providerName: 'Dr. Rachel Nguyen, MD \u2014 Austin Central Clinic',
      providerNpi: '1477563391',
      taxId: '74-2938416',
      serviceLocation: '11 \u2014 Office',
      expectedDateOfService: '2026-09-02',
      payer: 'Blue Cross Blue Shield of Texas',
      plan: 'BlueChoice PPO',
      diagnosisCode: 'E11.9',
      serviceItems: [
        { cptCode: '99214', description: 'Office visit, est. patient \u2013 mod. complexity', amount: 155.00, units: 1, modifier: null, pricingSource: 'Claritev MRF' },
      ],
      grossTotal: 155.00,
      discountSource: { kind: 'sliding_fee', referenceId: 'SF-2026-0118', tierLabel: 'Sliding fee \u2014 Tier 2', discountPercentage: 20 },
      discountAmount: 31.00,
      patientResponsibility: 124.00,
      status: 'Draft',
      deliverPortal: true,
      deliveries: [],
      department: 'Internal Medicine',
      lastActivity: '2026-06-10',
    },
  ];
  // Deep copy — estimates are mutated in place (status flips, delivery
  // stamps), so a shallow copy would let patient A's edits reach through into
  // the seed and leak to B anyway, which is the bug this fixes.
  function gfeFromSeed() { return JSON.parse(JSON.stringify(GFE_ESTIMATES_SEED)); }
  var GFE_ESTIMATES = gfeFromSeed();

  function gfeFmtMoney(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  // Status-dot color: amber if any estimate is still a Draft, green if all
  // are Issued, grey if there are none. (36: statuses are Draft/Issued only.)
  function gfeStatusDotColor() {
    if (!GFE_ESTIMATES.length) return '#94a3b8';
    var anyDraft = GFE_ESTIMATES.some(function (e) { return e.status === 'Draft'; });
    return anyDraft ? '#f59e0b' : '#16a34a';
  }

  // Card summary line, e.g. "2 estimates on file · 1 draft · 1 issued".
  function buildGfeSummary() {
    var n = GFE_ESTIMATES.length;
    if (!n) return 'No estimates on file';
    var counts = {};
    GFE_ESTIMATES.forEach(function (e) {
      var s = (e.status || '').toLowerCase();
      counts[s] = (counts[s] || 0) + 1;
    });
    var segs = [];
    Object.keys(counts).forEach(function (s) { segs.push(counts[s] + ' ' + s); });
    var head = n + ' estimate' + (n === 1 ? '' : 's') + ' on file';
    return segs.length ? head + ' \u00B7 ' + segs.join(' \u00B7 ') : head;
  }

  // Status pill — Draft = amber, Issued = indigo. The long form appends
  // "· Delivered" when the record carries delivery attempts (36: the sent
  // flag/Finalized/Sent statuses retired with the fee-estimate kind).
  function gfeStatusBadge(estm, longForm) {
    var issued = estm.status === 'Issued';
    var delivered = !!(estm.deliveries && estm.deliveries.length);
    var tone = issued
      ? { bg: 'rgba(79, 70, 229, 0.12)', fg: '#4338ca' }
      : { bg: THEME.amberBg, fg: THEME.amber };
    var label = issued ? (longForm && delivered ? 'Issued \u00B7 Delivered' : 'Issued') : 'Draft';
    var span = el('span', null, label);
    css(span, {
      display: 'inline-block', padding: '2px 9px', borderRadius: '999px',
      fontSize: '12px', fontWeight: '600', whiteSpace: 'nowrap', background: tone.bg, color: tone.fg,
    });
    return span;
  }

  // Compact label→value sub-grid for estimate-list rows (card face + modal
  // list view share this ONE builder so the column set never drifts).
  // Two-column grid so the set fits the ~600px embed without a horizontal-
  // scroll table. `compact` tightens spacing on the card face. (36: the
  // 23E1 "Type" column retired with the kind split.)
  function gfeRowMetaGrid(estm, compact) {
    var grid = el('div');
    css(grid, {
      display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: compact ? '6px 12px' : '8px 14px', marginTop: compact ? '8px' : '10px',
    });
    [
      ['Provider', estm.providerName || '\u2014'],
      ['Department', estm.department || '\u2014'],
      ['Service location', estm.serviceLocation || '\u2014'],
      ['Insurance', estm.payer ? (estm.payer + (estm.plan ? ' \u00B7 ' + estm.plan : '')) : 'None \u2014 in-network (direct)'],
      ['Created', estm.createdDate || '\u2014'],
      ['Last Activity', estm.lastActivity || estm.createdDate || '\u2014'],
    ].forEach(function (pair) {
      var cell = el('div');
      css(cell, { minWidth: '0' });
      var l = el('div', null, pair[0]);
      css(l, {
        fontSize: '12px', fontWeight: '700', textTransform: 'uppercase',
        letterSpacing: '0.4px', color: THEME.slate500, marginBottom: '2px',
      });
      var v = el('div', null, pair[1]);
      css(v, {
        fontSize: compact ? '12px' : '13px', color: THEME.slate900,
        fontWeight: '600', overflowWrap: 'anywhere', lineHeight: '1.35',
      });
      cell.appendChild(l);
      cell.appendChild(v);
      grid.appendChild(cell);
    });
    return grid;
  }

  // 36: receipt-style totals block (Prod's PatientResponsibilitySummary):
  // gross at the top, the FrontRunner discount in the middle when one
  // applies, and the patient's out-of-pocket responsibility dominant at the
  // bottom — the number front-desk staff read with the patient.
  function gfeReceipt(totals, discountSource) {
    var box = el('div');
    box.id = 'gfe-totals';
    css(box, { border: '1px solid ' + THEME.border, borderRadius: '10px', overflow: 'hidden', background: '#fff' });
    function line(label, value, valueColor) {
      var r = el('div');
      css(r, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: '10px', padding: '10px 14px', borderBottom: '1px solid ' + THEME.borderSoft,
      });
      var l = el('div', null, label);
      css(l, { fontSize: '12px', color: THEME.slate500, minWidth: '0' });
      var v = el('div', null, value);
      css(v, { fontSize: '13px', fontWeight: '700', color: valueColor || THEME.slate900, whiteSpace: 'nowrap' });
      r.appendChild(l); r.appendChild(v);
      return r;
    }
    box.appendChild(line('Gross total estimate', gfeFmtMoney(totals.grossTotal)));
    var hasDiscount = !!(discountSource && totals.discountAmount > 0);
    if (hasDiscount) {
      box.appendChild(line(
        'FrontRunner ' + gfeDiscountKindLabel(discountSource) + ' \u2014 ' +
          discountSource.tierLabel + ' (' + discountSource.discountPercentage + '%)',
        '\u2212' + gfeFmtMoney(totals.discountAmount), '#047857'));
    }
    var respWrap = el('div');
    css(respWrap, { padding: '12px 14px', background: THEME.inset });
    var respTop = el('div');
    css(respTop, { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' });
    var respLabel = el('div', null, 'Patient responsibility');
    css(respLabel, {
      fontSize: '12px', fontWeight: '700', textTransform: 'uppercase',
      letterSpacing: '0.5px', color: THEME.slate500,
    });
    var respVal = el('div', null, gfeFmtMoney(totals.patientResponsibility));
    css(respVal, { fontSize: '18px', fontWeight: '800', color: THEME.slate900, whiteSpace: 'nowrap' });
    respTop.appendChild(respLabel); respTop.appendChild(respVal);
    respWrap.appendChild(respTop);
    var respNote = el('div', null, hasDiscount
      ? discountSource.tierLabel + ' applied \u2014 recorded with the GFE.'
      : 'No active discount on file \u2014 patient owes the full estimated amount.');
    css(respNote, { fontSize: '12px', color: THEME.slate500, marginTop: '4px', lineHeight: '1.4' });
    respWrap.appendChild(respNote);
    box.appendChild(respWrap);
    return box;
  }

  // 36: the appointment tied to the LAUNCH encounter — the target the
  // simulated athenaNet chart attach names (JD's ask routes through athena's
  // add-document-to-chart endpoint, keyed by patient + appointment; the
  // request shape is unverified from this environment, so no field names are
  // encoded — see the delivery note text).
  function gfeCurrentAppointmentId(p) {
    var encId = p && p.encounter && p.encounter.id;
    if (!encId) return null;
    for (var i = 0; i < APPOINTMENTS.length; i++) {
      if (APPOINTMENTS[i].encounterId === encId) return APPOINTMENTS[i].id;
    }
    return null;
  }

  // 36: the ONE issuance stamp — form-Issue and detail-Issue both write
  // through here (status flip, disclosure recording with version, and the
  // delivery attempts the record's portal toggle asked for).
  function gfeStampIssue(estm, p) {
    estm.status = 'Issued';
    estm.issuedDate = rtvToday();
    estm.lastActivity = rtvToday();
    estm.disclosuresRecorded = true;
    estm.disclosuresVersion = GFE_DISCLOSURES_VERSION;
    estm.nsaDisclosures = GFE_NSA_DISCLOSURES.slice();
    estm.deliveries = [];
    if (estm.deliverPortal) {
      estm.deliveries.push({
        channel: 'frontrunner-portal', at: rtvToday(),
        note: 'GFE posted to the patient\u2019s FrontRunner Patient Portal inbox (simulated \u2014 the embed has no portal write lane).',
      });
      var apptId = gfeCurrentAppointmentId(p);
      estm.deliveries.push({
        channel: 'athena-chart', at: rtvToday(), appointmentId: apptId, simulated: true,
        note: 'NextGen chart attach' +
          (apptId ? ' \u2014 appointment ' + apptId : ' \u2014 no appointment resolved from the launch encounter') +
          ' (simulated \u2014 no callable NextGen document lane exists; request shape unverified).',
      });
    }
  }

  // 36: validator field key → form input DOM id (Prod's lib/gfe-field-ids.ts)
  // — the validation panel uses this to jump to / highlight the offending
  // input. The form registers live elements in its own map; these ids are the
  // shared naming contract (and the testable surface).
  var GFE_FIELD_DOM_IDS = {
    patientName: 'gfe-patient-name',
    patientDob: 'gfe-patient-dob',
    patientContact: 'gfe-patient-email',
    providerName: 'gfe-provider-name',
    providerNpi: 'gfe-provider-npi',
    taxId: 'gfe-provider-tin',
    serviceLocation: 'gfe-service-location',
    expectedDateOfService: 'gfe-dos',
    diagnosisCode: 'gfe-dx',
    serviceItems: 'gfe-line-cpt-0',
    totalEstimate: 'gfe-totals',
  };
  function gfeFieldDomId(field) {
    if (GFE_FIELD_DOM_IDS[field]) return GFE_FIELD_DOM_IDS[field];
    var m = /^serviceItems\[(\d+)\]\.([a-zA-Z]+)$/.exec(field);
    if (m) {
      var sub = { cptCode: 'cpt', description: 'description', amount: 'amount', units: 'units' }[m[2]] || 'cpt';
      return 'gfe-line-' + sub + '-' + m[1];
    }
    return null;
  }

  // 36: reference code search for the per-line CPT/HCPCS typeahead — the mock
  // stand-in for Prod's CodeLookupInput (payer-INDEPENDENT: it fills code +
  // description only; the payer-specific rate comes from Apply MRF).
  function gfeCodeSearch(q) {
    q = String(q || '').toLowerCase();
    if (!q) return [];
    var seen = {}; var out = [];
    for (var i = 0; i < MRF_RATES.length && out.length < 8; i++) {
      var r = MRF_RATES[i];
      if (seen[r.cpt]) continue;
      if (r.cpt.toLowerCase().indexOf(q) !== -1 || r.description.toLowerCase().indexOf(q) !== -1) {
        seen[r.cpt] = true;
        out.push({ cpt: r.cpt, description: r.description });
      }
    }
    return out;
  }

  // 36: the payer-specific Claritev MRF rate for one line (Apply MRF). Three
  // honest provenance states — the mock analogs of Prod's per-line rate
  // lookup states (match / no-match / rates-unavailable-for-this-payer).
  function gfeMrfRateFor(payerState, code) {
    if (!payerState || !payerState.payer) return { state: 'no-payer' };
    for (var i = 0; i < MRF_RATES.length; i++) {
      var r = MRF_RATES[i];
      if (r.cpt === code && r.payer === payerState.payer && r.plan === payerState.plan) {
        return { state: 'match', rate: r.negotiatedRate, description: r.description, payer: r.payer, plan: r.plan };
      }
    }
    return { state: 'no-match' };
  }

  // Next sequential GFE id (max existing GFE-2026-NNN + 1, zero-padded).
  function gfeNextId() {
    var next = 1;
    GFE_ESTIMATES.forEach(function (e) {
      var m = /GFE-2026-(\d+)/.exec(e.id || '');
      if (m) next = Math.max(next, Number(m[1]) + 1);
    });
    return 'GFE-2026-' + ('000' + next).slice(-3);
  }

  // Builds (idempotently) the Good Faith Estimates profile card and inserts it
  // after the Real-Time Verification card.
  function renderGoodFaithEstimatesCard(p) {
    var grid = document.querySelector('#tab-appointment .card-grid');
    if (!grid) return;
    var existing = $('good-faith-estimates-card');
    // Step 13: position-stable re-render (see renderRealTimeVerificationCard).
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'good-faith-estimates-card';
    card.setAttribute('aria-label', 'Good Faith Estimates');
    css(card, { position: 'relative' });

    var h2 = el('h2');
    var headLeft = el('span');
    css(headLeft, { display: 'inline-flex', alignItems: 'center', gap: '8px' });
    var dot = el('span');
    css(dot, {
      width: '8px', height: '8px', borderRadius: '50%', background: gfeStatusDotColor(),
      display: 'inline-block', flex: '0 0 auto',
    });
    dot.setAttribute('aria-hidden', 'true');
    headLeft.appendChild(dot);
    headLeft.appendChild(el('span', null, 'Good Faith Estimates'));
    h2.appendChild(headLeft);
    card.appendChild(h2);

    card.appendChild(el('p', 'card-sub', 'No Surprises Act \u2014 patient cost transparency'));

    // 23D-fix: summary line (left) + "+ New GFE" shortcut (right) share a row in
    // the card BODY, so the button only shows when the card is expanded (the
    // Step-8 collapse wrapper hides everything after the <h2>). The shortcut
    // opens the SAME modal directly on the form view — no duplicate form.
    var summaryRow = el('div');
    css(summaryRow, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '10px', marginTop: '12px',
    });
    var summary = el('div', null, buildGfeSummary());
    css(summary, { fontSize: '12px', color: THEME.slate500, fontWeight: '600' });
    summaryRow.appendChild(summary);
    var newGfeBtn = document.createElement('button');
    newGfeBtn.type = 'button';
    newGfeBtn.textContent = '+ New GFE';
    newGfeBtn.setAttribute('aria-label', 'Create a new good faith estimate');
    css(newGfeBtn, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2', flex: '0 0 auto',
    });
    newGfeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openGfeManagerModal('form');
    });
    summaryRow.appendChild(newGfeBtn);
    card.appendChild(summaryRow);

    var list = el('div');
    css(list, { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' });
    if (!GFE_ESTIMATES.length) {
      var empty = el('div', null, 'No estimates on file.');
      css(empty, { fontSize: '13px', color: THEME.slate500 });
      list.appendChild(empty);
    } else {
      GFE_ESTIMATES.forEach(function (estm) {
        // Compact multi-line row: top line (ID · status · patient resp) plus the
        // shared label→value sub-grid carrying the full Clearline column set.
        var row = el('div');
        css(row, {
          border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
          padding: '10px 12px', background: '#fff',
        });
        var topLine = el('div');
        css(topLine, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
        var idEl = el('span', null, estm.id);
        css(idEl, { fontSize: '13px', fontWeight: '700', color: THEME.slate900, flex: '0 0 auto' });
        var badge = gfeStatusBadge(estm, false);
        var amount = el('span', null, gfeFmtMoney(estm.patientResponsibility));
        css(amount, { marginLeft: 'auto', fontSize: '13px', fontWeight: '700', color: THEME.slate900, flex: '0 0 auto' });
        topLine.appendChild(idEl);
        topLine.appendChild(badge);
        topLine.appendChild(amount);
        row.appendChild(topLine);
        row.appendChild(gfeRowMetaGrid(estm, true));
        list.appendChild(row);
      });
    }
    card.appendChild(list);

    var manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'gfe-manage-btn';
    manageBtn.textContent = 'Manage';
    manageBtn.setAttribute('aria-label', 'Manage good faith estimates');
    css(manageBtn, {
      position: 'absolute', top: '10px', right: '12px',
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
      transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
    });
    manageBtn.addEventListener('mouseenter', function () {
      manageBtn.style.background = THEME.teal; manageBtn.style.borderColor = THEME.teal;
    });
    manageBtn.addEventListener('mouseleave', function () {
      manageBtn.style.background = THEME.navy; manageBtn.style.borderColor = THEME.navy;
    });
    manageBtn.addEventListener('focus', function () {
      manageBtn.style.boxShadow = '0 0 0 3px rgba(40, 71, 118, 0.3)';
    });
    manageBtn.addEventListener('blur', function () {
      manageBtn.style.boxShadow = 'none';
    });
    manageBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openGfeManagerModal();
    });
    card.appendChild(manageBtn);

    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot
  }

  // GFE Manager modal — stepped single-column navigation (List -> Detail / Form)
  // mirroring the Claims & Billing modal's 150ms slide. Reuses the shared shell.
  // initialView (23D-fix): 'form' opens directly on the new-GFE form view (the
  // card-body shortcut); default/omitted opens the list (Manage — unchanged).
  function openGfeManagerModal(initialView) {
    if (!currentPatient) return;
    var p = currentPatient;
    var prevFocus = document.activeElement;
    // Honest identity: live Orion demographics carry no MRN — render without
    // one rather than falling back to the mock's MRN-100242 (that fallback
    // was mock data masquerading as live; caught in the 2026-08-04 audit).
    var pName = (p.name && p.name.full) ? p.name.full : '—';
    var pMrn = p.mrn || null;

    // --- shared builders ---------------------------------------------------
    function navyBtn(label) {
      var b = el('button', null, label); b.type = 'button';
      css(b, {
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      return b;
    }
    function outlineBtn(label) {
      var b = el('button', null, label); b.type = 'button';
      css(b, {
        background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      return b;
    }
    function linkBtn(label) {
      var b = el('button', null, label); b.type = 'button';
      css(b, {
        background: 'none', border: 'none', padding: '0', color: THEME.teal,
        fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
      });
      return b;
    }
    function detailSection(labelText) {
      var sec = el('div');
      css(sec, { border: '1px solid ' + THEME.border, borderRadius: '10px', background: '#fff', overflow: 'hidden' });
      var st = el('div', null, labelText);
      css(st, {
        fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px',
        color: THEME.slate500, padding: '12px 16px', borderBottom: '1px solid ' + THEME.border, background: THEME.inset,
      });
      sec.appendChild(st);
      var inner = el('div'); css(inner, { padding: '16px' });
      sec.appendChild(inner);
      sec._body = inner;
      return sec;
    }
    function kvGrid(pairs) {
      var grid = el('div');
      css(grid, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' });
      pairs.forEach(function (pair) {
        var cell = el('div');
        var l = el('div', null, pair[0]);
        css(l, {
          fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px',
          color: THEME.slate500, marginBottom: '4px',
        });
        cell.appendChild(l);
        if (pair[1] && pair[1].nodeType) {
          var holder = el('div'); holder.appendChild(pair[1]); cell.appendChild(holder);
        } else {
          var v = el('div', null, pair[1]);
          css(v, { fontSize: '13px', color: THEME.slate900, fontWeight: '600' });
          cell.appendChild(v);
        }
        grid.appendChild(cell);
      });
      return grid;
    }
    function dxPill(code) {
      var span = el('span', null, code);
      css(span, {
        display: 'inline-block', padding: '3px 10px', borderRadius: '999px', fontSize: '12px',
        fontWeight: '600', background: THEME.inset, color: THEME.slate900,
        border: '1px solid ' + THEME.borderInput, whiteSpace: 'nowrap',
      });
      return span;
    }
    function fieldRow(label, valueNode) {
      var row = el('div');
      css(row, { display: 'flex', flexDirection: 'column', gap: '4px' });
      var l = el('div', null, label);
      css(l, { fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px', color: THEME.slate500 });
      row.appendChild(l);
      row.appendChild(valueNode);
      return row;
    }
    function styleInput(inp) {
      css(inp, {
        width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: '13px',
        border: '1px solid ' + THEME.borderInput, borderRadius: '6px', fontFamily: 'inherit',
        color: THEME.slate900, background: '#fff',
      });
    }

    // --- View 1: GFE list --------------------------------------------------
    function buildGfeListView() {
      var view = el('div');
      css(view, { display: 'flex', flexDirection: 'column', gap: '16px' });

      var topBar = el('div');
      css(topBar, { display: 'flex', justifyContent: 'flex-end' });
      var newBtn = navyBtn('+ New GFE');
      newBtn.addEventListener('click', function () { navigate(buildGfeFormView, 'left'); });
      topBar.appendChild(newBtn);
      view.appendChild(topBar);

      var listWrap = el('div');
      css(listWrap, { display: 'flex', flexDirection: 'column', gap: '10px' });
      GFE_ESTIMATES.forEach(function (estm) {
        var row = el('button'); row.type = 'button';
        row.setAttribute('aria-label', 'Open estimate ' + estm.id);
        css(row, {
          display: 'flex', alignItems: 'center', gap: '14px', width: '100%', textAlign: 'left',
          padding: '14px 16px', border: '1px solid ' + THEME.border, borderRadius: '10px',
          background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        });
        row.addEventListener('mouseenter', function () {
          row.style.borderColor = THEME.teal; row.style.boxShadow = '0 1px 6px rgba(15,23,42,0.08)';
        });
        row.addEventListener('mouseleave', function () {
          row.style.borderColor = THEME.border; row.style.boxShadow = 'none';
        });
        row.addEventListener('click', function () {
          navigate(function () { return buildGfeDetailView(estm); }, 'left');
        });

        // Top line: GFE ID (prominent) + status badge, patient resp emphasized
        // right; beneath, the shared label→value sub-grid (full column set).
        var info = el('div'); css(info, { flex: '1', minWidth: '0' });
        var idLine = el('div'); css(idLine, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
        var id = el('span', null, estm.id); css(id, { fontSize: '14px', fontWeight: '700', color: THEME.slate900 });
        idLine.appendChild(id); idLine.appendChild(gfeStatusBadge(estm, true));
        var amt = el('span', null, gfeFmtMoney(estm.patientResponsibility));
        css(amt, { marginLeft: 'auto', fontSize: '14px', fontWeight: '700', color: THEME.slate900 });
        idLine.appendChild(amt);
        info.appendChild(idLine);
        info.appendChild(gfeRowMetaGrid(estm, false));

        var chev = el('span', null, '\u203A');
        css(chev, { fontSize: '20px', color: THEME.slate500, lineHeight: '1', flex: '0 0 auto', alignSelf: 'center' });

        row.appendChild(info); row.appendChild(chev);
        listWrap.appendChild(row);
      });
      view.appendChild(listWrap);

      return view;
    }

    // --- View 2: GFE detail ------------------------------------------------
    // 36: read-only, shaped to Prod's GFE detail. Drafts get "Edit draft"
    // (reopening the ONE form prefilled — the 23C in-place edit mode is
    // retired with the second editor it duplicated) and the Issue action
    // (the SAME gfeValidateDraft gate as the form panel, against the saved
    // record — one source of truth, no bypass path). Issued records are
    // IMMUTABLE (23E1 rule, unchanged).
    function buildGfeDetailView(estm) {
      var view = el('div');
      css(view, { display: 'flex', flexDirection: 'column', gap: '16px' });

      // Top bar: Back link (left) + mode note / edit control (right).
      var topBar = el('div');
      css(topBar, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' });
      var back = linkBtn('\u2190 Back to estimates');
      back.addEventListener('click', function () { navigate(buildGfeListView, 'right'); });
      topBar.appendChild(back);
      var topRight = el('div');
      css(topRight, { display: 'flex', alignItems: 'center', gap: '8px' });
      if (estm.status === 'Issued') {
        var lockNote = el('span', null, 'Issued \u2014 locked');
        css(lockNote, { fontSize: '12px', fontWeight: '600', color: THEME.slate500, fontStyle: 'italic' });
        topRight.appendChild(lockNote);
      } else {
        var editBtn = outlineBtn('Edit draft');
        editBtn.addEventListener('click', function () {
          navigate(function () { return buildGfeFormView(estm); }, 'left');
        });
        topRight.appendChild(editBtn);
      }
      topBar.appendChild(topRight);
      view.appendChild(topBar);

      var headSec = detailSection('Estimate');
      var headPairs = [
        ['GFE ID', estm.id],
        ['Status', gfeStatusBadge(estm, true)],
        ['Created', estm.createdDate || '\u2014'],
      ];
      if (estm.status === 'Issued') headPairs.push(['Issued Date', estm.issuedDate || '\u2014']);
      headPairs.push(
        ['Patient', (estm.patientName || '\u2014') + (estm.patientDob ? ' \u00B7 DOB ' + estm.patientDob : '')],
        ['Contact', [estm.patientEmail, estm.patientPhone].filter(Boolean).join(' \u00B7 ') || '\u2014'],
        ['Provider / facility', estm.providerName || '\u2014'],
        ['Provider NPI', estm.providerNpi || '\u2014'],
        ['Tax ID', estm.taxId || '\u2014'],
        ['Payer \u00B7 Plan', estm.payer ? (estm.payer + (estm.plan ? ' \u00B7 ' + estm.plan : '')) : 'None \u2014 in-network (direct)'],
        ['Service location', estm.serviceLocation || '\u2014'],
        ['Expected DOS', estm.expectedDateOfService || '\u2014']
      );
      headSec._body.appendChild(kvGrid(headPairs));
      view.appendChild(headSec);

      // Diagnosis — single optional ICD-10 (Prod's field; the 23-era
      // multi-code Diagnosis Codes list retired with the reshape).
      var dxSec = detailSection('Diagnosis (ICD-10)');
      var dxWrap = el('div');
      css(dxWrap, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
      if (estm.diagnosisCode) {
        dxWrap.appendChild(dxPill(estm.diagnosisCode));
      } else {
        var none = el('span', null, 'None \u2014 a diagnosis hasn\u2019t been finalised yet.');
        css(none, { fontSize: '13px', color: THEME.slate500 });
        dxWrap.appendChild(none);
      }
      dxSec._body.appendChild(dxWrap);
      view.appendChild(dxSec);

      // Service items — Prod's line shape (amount × units; modifier shown
      // with the code), plus the shared receipt under the table.
      var itemsSec = detailSection('Service items');
      css(itemsSec._body, { display: 'flex', flexDirection: 'column', gap: '12px' });
      var scroller = el('div'); css(scroller, { overflowX: 'auto' });
      var table = document.createElement('table');
      css(table, { width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '480px' });
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      [['CPT/HCPCS', 'left'], ['Description', 'left'], ['Amount', 'right'], ['Units', 'right'], ['Line total', 'right']].forEach(function (c) {
        var th = document.createElement('th'); th.textContent = c[0];
        css(th, {
          textAlign: c[1], padding: '10px 12px', fontSize: '12px', fontWeight: '700',
          textTransform: 'uppercase', letterSpacing: '0.5px', color: THEME.slate500,
          background: THEME.inset, borderBottom: '1px solid ' + THEME.border, whiteSpace: 'nowrap',
        });
        htr.appendChild(th);
      });
      thead.appendChild(htr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      (estm.serviceItems || []).forEach(function (item) {
        var units = Number(item.units); if (isNaN(units) || units <= 0) units = 1;
        var amt = Number(item.amount) || 0;
        var codeCell = (item.cptCode || '\u2014') + (item.modifier ? ' \u00B7 mod ' + item.modifier : '');
        var tr = document.createElement('tr');
        [[codeCell, 'left'], [item.description || '\u2014', 'left'], [gfeFmtMoney(amt), 'right'], [String(units), 'right'], [gfeFmtMoney(amt * units), 'right']].forEach(function (cell, idx) {
          var td = document.createElement('td'); td.textContent = cell[0];
          css(td, {
            padding: '10px 12px', borderBottom: '1px solid ' + THEME.borderSoft, color: THEME.slate900,
            textAlign: cell[1], verticalAlign: 'top', whiteSpace: idx === 1 ? 'normal' : 'nowrap',
          });
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody); scroller.appendChild(table);
      itemsSec._body.appendChild(scroller);
      itemsSec._body.appendChild(gfeReceipt({
        grossTotal: estm.grossTotal || 0,
        discountAmount: estm.discountAmount || 0,
        patientResponsibility: estm.patientResponsibility || 0,
      }, estm.discountSource || null));
      var provenance = [];
      (estm.serviceItems || []).forEach(function (item) {
        if (item.pricingSource && provenance.indexOf(item.pricingSource) === -1) provenance.push(item.pricingSource);
      });
      if (provenance.length) {
        var provNote = el('div', null, 'Pricing source: ' + provenance.join(', '));
        css(provNote, { fontSize: '12px', color: THEME.slate500 });
        itemsSec._body.appendChild(provNote);
      }
      view.appendChild(itemsSec);

      // 27D-b: recorded NSA disclosures — renders EXACTLY what issuance
      // recorded on the row (estm.nsaDisclosures, written by gfeStampIssue /
      // seeded on the pre-issued mock row). Never a hardcoded list: an Issued
      // row with no recorded set shows nothing here. (36: the stamp also
      // names the recorded disclosures VERSION — Prod's lockstep rule.)
      if (estm.disclosuresRecorded && estm.nsaDisclosures && estm.nsaDisclosures.length) {
        var nsaRecSec = detailSection('Recorded NSA Disclosures');
        var nsaRecList = el('div');
        nsaRecList.id = 'gfe-detail-nsa-disclosures';
        css(nsaRecList, { display: 'flex', flexDirection: 'column', gap: '6px' });
        estm.nsaDisclosures.forEach(function (text) {
          var row = el('div');
          css(row, { display: 'flex', gap: '8px', fontSize: '12px', color: THEME.slate500, lineHeight: '1.5' });
          var mark = el('span', null, '\u2713');
          css(mark, { flex: '0 0 auto', fontWeight: '700', color: '#16a34a' });
          row.appendChild(mark);
          row.appendChild(el('span', null, text));
          nsaRecList.appendChild(row);
        });
        var recStamp = el('div', null,
          'Recorded at issuance' + (estm.issuedDate ? ' \u00B7 ' + estm.issuedDate : '') +
          (estm.disclosuresVersion ? ' \u00B7 version ' + estm.disclosuresVersion : ''));
        css(recStamp, { fontSize: '12px', fontWeight: '600', color: THEME.slate500, marginTop: '8px' });
        nsaRecSec._body.appendChild(nsaRecList);
        nsaRecSec._body.appendChild(recStamp);
        view.appendChild(nsaRecSec);
      }

      // 36: Delivery — the attempts issuance recorded (Prod's delivery
      // history). Drafts show the configured intent honestly: nothing is
      // delivered until issuance.
      var delSec = detailSection('Delivery');
      css(delSec._body, { display: 'flex', flexDirection: 'column', gap: '8px' });
      if (estm.deliveries && estm.deliveries.length) {
        estm.deliveries.forEach(function (d) {
          var row = el('div');
          css(row, {
            display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 12px',
            borderRadius: '8px', background: THEME.inset, border: '1px solid ' + THEME.borderInput,
          });
          var head = el('div', null,
            (d.channel === 'athena-chart' ? 'NextGen chart (simulated)' : 'FrontRunner Patient Portal') +
            (d.at ? ' \u00B7 ' + d.at : ''));
          css(head, { fontSize: '12px', fontWeight: '700', color: THEME.slate900 });
          row.appendChild(head);
          if (d.note) {
            var note = el('div', null, d.note);
            css(note, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.45' });
            row.appendChild(note);
          }
          delSec._body.appendChild(row);
        });
      } else {
        var noneYet = el('div', null, 'No delivery attempts yet.');
        css(noneYet, { fontSize: '13px', color: THEME.slate500 });
        delSec._body.appendChild(noneYet);
        var intent = el('div', null,
          'FrontRunner Patient Portal delivery: ' + (estm.deliverPortal ? 'On' : 'Off') +
          ' \u2014 recorded at issuance.');
        css(intent, { fontSize: '12px', color: THEME.slate500 });
        delSec._body.appendChild(intent);
      }
      view.appendChild(delSec);

      // Issue from detail (Drafts) — the same validator the form panel reads,
      // run against the SAVED record; the click handler re-checks so the gate
      // cannot be bypassed. (23E2b property, carried over the reshape.)
      if (estm.status === 'Draft') {
        var blockers = gfeIssueBlockers(gfeValidationRec(estm));
        var issueBox = el('div');
        css(issueBox, { display: 'flex', flexDirection: 'column', gap: '6px' });
        var detIssueBtn = navyBtn('Issue GFE');
        css(detIssueBtn, { width: '100%', padding: '10px 16px', fontSize: '14px' });
        if (blockers.length) {
          detIssueBtn.disabled = true;
          css(detIssueBtn, { opacity: '0.5', cursor: 'not-allowed' });
          var missNote = el('div', null,
            blockers.length + ' required field' + (blockers.length === 1 ? '' : 's') +
            ' missing: ' + blockers.map(function (b) { return b.message; }).join(' '));
          css(missNote, { fontSize: '12px', fontWeight: '600', color: THEME.amber, lineHeight: '1.5' });
          issueBox.appendChild(detIssueBtn);
          issueBox.appendChild(missNote);
        } else {
          detIssueBtn.addEventListener('click', function () {
            if (gfeIssueBlockers(gfeValidationRec(estm)).length) return; // gate re-checked at click
            gfeStampIssue(estm, p);
            replaceCurrent(function () { return buildGfeDetailView(estm); });
          });
          var readyNote = el('div', null,
            'All required fields complete. Issuing locks the record (Draft \u2192 Issued) and records the statutory disclosures (' +
            GFE_DISCLOSURES_VERSION + ') and delivery with it.');
          css(readyNote, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.5' });
          issueBox.appendChild(detIssueBtn);
          issueBox.appendChild(readyNote);
        }
        view.appendChild(issueBox);
      }
      // STEP 35: the detail view's "Download PDF" stub stays removed — go-live
      // scope decision (Craig, July 17), reaffirmed 2026-08-17 (portal
      // delivery only; no print/download unless JD rules otherwise).

      return view;
    }

    // --- View 3: GFE form (create + Draft edit) -----------------------------
    // 36: ONE form for both create and Draft-edit, shaped to Prod's GFEWizard
    // section-for-section: Patient & encounter → Service items (+ receipt) →
    // Delivery → No Surprises Act validation → Issue. Prod's wizard only
    // CREATES (its detail page is read-only); the embed's Save-draft
    // lifecycle reuses this same form for Draft edits instead of keeping the
    // 23C second editor. Patient-focused per the 2026-08-17 rulings: the
    // patient is the launch-context patient (read-only summary, no search /
    // "Register new"), and the payer seeds from their athena coverage.
    function buildGfeFormView(existing) {
      var view = el('div');
      css(view, { display: 'flex', flexDirection: 'column', gap: '16px' });

      var back = linkBtn('\u2190 Back to estimates');
      css(back, { alignSelf: 'flex-start' });
      back.addEventListener('click', function () { navigate(buildGfeListView, 'right'); });
      view.appendChild(back);

      var heading = el('div', null, existing ? 'Edit draft ' + existing.id : 'New Good Faith Estimate');
      css(heading, { fontSize: '15px', fontWeight: '700', color: THEME.slate900 });
      view.appendChild(heading);

      var contact = p.contact || {};
      var enc = p.encounter || {};
      var prim = mrfPrimaryInsurance(p);

      // 36: the FrontRunner discount resolves from the LOADED patient at form
      // open (patient-keyed mock; ST-C5 — never module state). Draft edits
      // re-resolve rather than trusting the stamped copy, so a changed
      // determination re-prices the draft.
      var discountSource = gfeResolveDiscountSource(p);

      // Payer state — seeded from the patient's athena coverage (the
      // patient-focused stand-in for Prod's insurance-masters lookup).
      // Clearable: Prod's validator leaves payer OPTIONAL because a payer-less
      // GFE prices as in-network (direct) by default; same here, stated
      // honestly on the field.
      var payerState = existing
        ? (existing.payer ? { payer: existing.payer, plan: existing.plan || '' } : null)
        : (prim.payer ? { payer: prim.payer, plan: prim.plan } : null);

      // Service lines — input-backed state (strings; converted on save).
      var formLines = existing
        ? existing.serviceItems.map(function (it) {
            return {
              cptCode: it.cptCode || '', description: it.description || '',
              amount: it.amount == null ? '' : String(it.amount),
              units: String(it.units || 1), modifier: it.modifier || '',
              pricingSource: it.pricingSource || null, _mrfNote: null,
            };
          })
        : [{ cptCode: '', description: '', amount: '0', units: '1', modifier: '', pricingSource: null, _mrfNote: null }];

      var fieldEls = {}; // input DOM id → live element (validation jump targets)
      var lastIssues = [];

      function registerField(id, elx) { elx.id = id; fieldEls[id] = elx; }
      function highlightField(id, on) {
        var elx = fieldEls[id];
        if (!elx) return;
        elx.style.outline = on ? '2px solid rgba(220, 38, 38, 0.65)' : '';
        elx.style.outlineOffset = on ? '2px' : '';
      }
      function jumpToField(field) {
        var id = gfeFieldDomId(field);
        if (!id || !fieldEls[id]) return;
        var elx = fieldEls[id];
        if (typeof elx.scrollIntoView === 'function') elx.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (typeof elx.focus === 'function') elx.focus({ preventScroll: true });
        highlightField(id, true);
        window.setTimeout(function () { highlightField(id, false); }, 2500);
      }

      function wiredInput(id, seedValue, placeholder, type) {
        var inp = document.createElement('input');
        inp.type = type || 'text';
        inp.value = seedValue || '';
        if (placeholder) inp.placeholder = placeholder;
        styleInput(inp);
        registerField(id, inp);
        inp.addEventListener('input', updateAll);
        return inp;
      }

      // --- Patient & encounter ------------------------------------------------
      var patSec = detailSection('Patient & encounter');
      css(patSec._body, { display: 'flex', flexDirection: 'column', gap: '14px' });

      // Read-only identity summary — the launch-context patient (Prod's
      // patient picker / "Register new" deliberately absent: athena hands the
      // embed exactly one patient). Discount badge mirrors Prod's
      // CharityTierBadge line under the selected patient.
      var sumBox = el('div');
      css(sumBox, {
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '12px 14px',
        borderRadius: '10px', background: THEME.inset, border: '1px solid ' + THEME.borderInput,
      });
      var sumName = el('div', null, pName);
      css(sumName, { fontSize: '13px', fontWeight: '700', color: THEME.slate900 });
      sumBox.appendChild(sumName);
      var sumMeta = el('div', null,
        ['DOB ' + (p.dateOfBirth || '\u2014'), contact.email, contact.mobilePhone || contact.homePhone]
          .filter(Boolean).join(' \u00B7 '));
      css(sumMeta, { fontSize: '12px', color: THEME.slate500 });
      sumBox.appendChild(sumMeta);
      var sumIds = el('div', null, ['Patient ID ' + (p.id || '\u2014'), pMrn].filter(Boolean).join(' \u00B7 '));
      css(sumIds, { fontSize: '12px', color: THEME.slate500 });
      sumBox.appendChild(sumIds);
      if (discountSource) {
        var badgeRow = el('div');
        css(badgeRow, { marginTop: '6px' });
        var dBadge = el('span', null,
          'FrontRunner ' + gfeDiscountKindLabel(discountSource) + ': ' +
          discountSource.tierLabel + ' (' + discountSource.discountPercentage + '%)');
        css(dBadge, {
          display: 'inline-block', padding: '2px 9px', borderRadius: '999px', fontSize: '12px',
          fontWeight: '600', background: 'rgba(16, 185, 129, 0.14)', color: '#047857',
        });
        badgeRow.appendChild(dBadge);
        sumBox.appendChild(badgeRow);
      }
      patSec._body.appendChild(sumBox);

      var patGrid = el('div');
      css(patGrid, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' });
      var nameInput = wiredInput('gfe-patient-name', existing ? existing.patientName : (p.name && p.name.full));
      patGrid.appendChild(fieldRow('Patient legal name *', nameInput));
      var dobInput = wiredInput('gfe-patient-dob', existing ? existing.patientDob : p.dateOfBirth, 'YYYY-MM-DD', 'date');
      patGrid.appendChild(fieldRow('Date of birth *', dobInput));
      var emailInput = wiredInput('gfe-patient-email', existing ? existing.patientEmail : contact.email);
      patGrid.appendChild(fieldRow('Patient email', emailInput));
      var phoneInput = wiredInput('gfe-patient-phone', existing ? existing.patientPhone : (contact.mobilePhone || contact.homePhone));
      patGrid.appendChild(fieldRow('Patient phone', phoneInput));
      var npiInput = wiredInput('gfe-provider-npi', existing ? existing.providerNpi : GFE_PRACTICE.providerNpi, '10-digit NPI');
      patGrid.appendChild(fieldRow('Provider / facility (10-digit NPI) *', npiInput));
      var provNameInput = wiredInput('gfe-provider-name',
        existing ? existing.providerName
          : [enc.provider, enc.location].filter(Boolean).join(' \u2014 '));
      patGrid.appendChild(fieldRow('Provider / facility name *', provNameInput));
      var tinInput = wiredInput('gfe-provider-tin', existing ? existing.taxId : GFE_PRACTICE.taxId, '9-digit EIN');
      patGrid.appendChild(fieldRow('Tax ID', tinInput));

      var posSelect = document.createElement('select');
      styleInput(posSelect);
      GFE_POS_OPTIONS.forEach(function (label) {
        var opt = document.createElement('option');
        opt.value = label; opt.textContent = label;
        posSelect.appendChild(opt);
      });
      posSelect.value = existing ? (existing.serviceLocation || GFE_PRACTICE.placeOfService) : GFE_PRACTICE.placeOfService;
      registerField('gfe-service-location', posSelect);
      posSelect.addEventListener('change', updateAll);
      patGrid.appendChild(fieldRow('Service location *', posSelect));
      var dosInput = wiredInput('gfe-dos', existing ? existing.expectedDateOfService : enc.date, 'YYYY-MM-DD', 'date');
      patGrid.appendChild(fieldRow('Expected date of service *', dosInput));
      patSec._body.appendChild(patGrid);

      // Payer / insurance — seeded box, clearable (optional per Prod).
      var payerWrap = el('div');
      css(payerWrap, { display: 'flex', flexDirection: 'column', gap: '6px' });
      registerField('gfe-payer', payerWrap);
      function renderPayer() {
        while (payerWrap.firstChild) payerWrap.removeChild(payerWrap.firstChild);
        var boxEl = el('div');
        css(boxEl, {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          padding: '10px 12px', borderRadius: '8px', background: '#fff',
          border: '1px solid ' + THEME.borderInput,
        });
        if (payerState) {
          var pv = el('div', null, payerState.payer + (payerState.plan ? ' \u2014 ' + payerState.plan : ''));
          css(pv, { fontSize: '13px', fontWeight: '600', color: THEME.slate900, minWidth: '0', overflowWrap: 'anywhere' });
          boxEl.appendChild(pv);
          var clearBtn = linkBtn('Clear');
          clearBtn.setAttribute('aria-label', 'Clear payer');
          clearBtn.addEventListener('click', function () { payerState = null; renderPayer(); updateAll(); });
          boxEl.appendChild(clearBtn);
        } else {
          var noneWrap = el('div');
          css(noneWrap, { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', flexWrap: 'wrap' });
          var noneTxt = el('span', null, 'No payer');
          css(noneTxt, { fontSize: '13px', fontWeight: '600', color: THEME.slate500 });
          noneWrap.appendChild(noneTxt);
          var badge = el('span', null, 'In-network (direct)');
          css(badge, {
            display: 'inline-block', padding: '2px 9px', borderRadius: '999px', fontSize: '12px',
            fontWeight: '600', background: 'rgba(37, 99, 235, 0.12)', color: '#1d4ed8',
          });
          noneWrap.appendChild(badge);
          boxEl.appendChild(noneWrap);
          if (prim.payer) {
            var restoreBtn = linkBtn('Use patient\u2019s coverage');
            restoreBtn.addEventListener('click', function () {
              payerState = { payer: prim.payer, plan: prim.plan };
              renderPayer(); updateAll();
            });
            boxEl.appendChild(restoreBtn);
          }
        }
        payerWrap.appendChild(boxEl);
        var hint = el('div', null,
          'Seeded from the patient\u2019s NextGen coverage. Defaults to in-network (direct) pricing when no payer is set.');
        css(hint, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.4' });
        payerWrap.appendChild(hint);
      }
      renderPayer();
      patSec._body.appendChild(fieldRow('Payer / insurance', payerWrap));

      var dxInput = wiredInput('gfe-dx', existing ? existing.diagnosisCode : '', 'e.g. E11.9');
      var dxWrap = el('div');
      css(dxWrap, { display: 'flex', flexDirection: 'column', gap: '4px' });
      dxWrap.appendChild(dxInput);
      var dxHint = el('div', null, 'Optional \u2014 leave blank if a diagnosis hasn\u2019t been finalised yet.');
      css(dxHint, { fontSize: '12px', color: THEME.slate500 });
      dxWrap.appendChild(dxHint);
      patSec._body.appendChild(fieldRow('Diagnosis code (ICD-10)', dxWrap));
      view.appendChild(patSec);

      // --- Service items ------------------------------------------------------
      // Prod's line shape: CPT/HCPCS + Description + Amount + Units + Modifier,
      // per-line Apply MRF (payer-specific Claritev rate with honest
      // provenance), receipt underneath. The CPT typeahead is the mock
      // CodeLookupInput analog — payer-independent, fills code + description
      // only.
      var itemsSec = detailSection('Service items');
      css(itemsSec._body, { display: 'flex', flexDirection: 'column', gap: '12px' });
      var linesWrap = el('div');
      css(linesWrap, { display: 'flex', flexDirection: 'column', gap: '12px' });
      itemsSec._body.appendChild(linesWrap);

      var addLineBtn = outlineBtn('+ Add line');
      css(addLineBtn, { alignSelf: 'flex-start', padding: '6px 14px', fontSize: '12px' });
      addLineBtn.addEventListener('click', function () {
        closeActiveSugg();
        formLines.push({ cptCode: '', description: '', amount: '0', units: '1', modifier: '', pricingSource: null, _mrfNote: null });
        renderLines();
        updateAll();
      });
      itemsSec._body.appendChild(addLineBtn);

      var receiptWrap = el('div');
      itemsSec._body.appendChild(receiptWrap);
      var pricingFoot = el('div');
      css(pricingFoot, { display: 'none', fontSize: '12px', color: THEME.slate500 });
      itemsSec._body.appendChild(pricingFoot);
      view.appendChild(itemsSec);

      // 27D-a (carried over the reshape): the CPT suggestion list dismisses on
      // outside interaction via ONE document-level `pointerdown` listener,
      // wired only while a list is open (add/remove parity — a leaked listener
      // was the original 27D defect). A 27B force-close can remove the modal
      // with a list open; the first pointerdown after that self-heals by
      // unwiring itself when the list is no longer connected.
      var activeSugg = null; // { list, anchor, close }
      function closeActiveSugg() { if (activeSugg) activeSugg.close(); }
      function onDocPointerDown(e) {
        if (!activeSugg) { document.removeEventListener('pointerdown', onDocPointerDown); return; }
        if (!activeSugg.list.isConnected) { closeActiveSugg(); return; }
        if (activeSugg.list.contains(e.target) || activeSugg.anchor === e.target) return;
        closeActiveSugg();
      }
      function openSuggFor(anchor, listEl, matches, onPick) {
        closeActiveSugg();
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        matches.forEach(function (m) {
          var b = el('button');
          b.type = 'button';
          b.setAttribute('aria-label', 'Use CPT ' + m.cpt + ' \u2014 ' + m.description);
          css(b, {
            display: 'flex', gap: '8px', alignItems: 'baseline', width: '100%', textAlign: 'left',
            padding: '8px 10px', border: 'none', borderBottom: '1px solid ' + THEME.borderSoft,
            background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
          });
          var codeSpan = el('span', null, m.cpt);
          css(codeSpan, { fontSize: '12px', fontWeight: '700', color: THEME.slate900, flex: '0 0 auto' });
          var descSpan = el('span', null, m.description);
          css(descSpan, { fontSize: '12px', color: THEME.slate500, minWidth: '0' });
          b.appendChild(codeSpan); b.appendChild(descSpan);
          b.addEventListener('click', function () { onPick(m); closeActiveSugg(); });
          listEl.appendChild(b);
        });
        listEl.style.display = 'block';
        activeSugg = {
          list: listEl, anchor: anchor,
          close: function () {
            while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
            listEl.style.display = 'none';
            activeSugg = null;
            document.removeEventListener('pointerdown', onDocPointerDown);
          },
        };
        document.addEventListener('pointerdown', onDocPointerDown);
      }

      function renderLines() {
        while (linesWrap.firstChild) linesWrap.removeChild(linesWrap.firstChild);
        formLines.forEach(function (line, idx) { linesWrap.appendChild(buildLineRow(line, idx)); });
      }

      function buildLineRow(line, idx) {
        var boxEl = el('div');
        css(boxEl, {
          border: '1px solid ' + THEME.borderSoft, borderRadius: '10px', padding: '12px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        });

        var grid1 = el('div');
        css(grid1, { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(160px, 2fr)', gap: '10px' });
        var cptWrap = el('div');
        css(cptWrap, { position: 'relative' });
        var cptInput = document.createElement('input');
        cptInput.type = 'text';
        cptInput.placeholder = 'Code or description';
        cptInput.value = line.cptCode;
        styleInput(cptInput);
        registerField('gfe-line-cpt-' + idx, cptInput);
        cptWrap.appendChild(cptInput);
        var suggList = el('div');
        css(suggList, {
          display: 'none', position: 'absolute', top: '100%', left: '0', right: '0', zIndex: '30',
          marginTop: '4px', background: '#fff', border: '1px solid ' + THEME.border, borderRadius: '8px',
          boxShadow: '0 6px 18px rgba(15,23,42,0.12)', maxHeight: '180px', overflowY: 'auto',
        });
        cptWrap.appendChild(suggList);
        grid1.appendChild(fieldRow('CPT/HCPCS *', cptWrap));

        var descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description (auto-fills)';
        descInput.value = line.description;
        styleInput(descInput);
        registerField('gfe-line-description-' + idx, descInput);
        descInput.addEventListener('input', function () { line.description = descInput.value; updateAll(); });
        grid1.appendChild(fieldRow('Description *', descInput));
        boxEl.appendChild(grid1);

        var grid2 = el('div');
        css(grid2, { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '10px', alignItems: 'end' });
        var amountInput = document.createElement('input');
        amountInput.type = 'text';
        amountInput.placeholder = '0.00';
        amountInput.value = line.amount;
        styleInput(amountInput);
        registerField('gfe-line-amount-' + idx, amountInput);
        amountInput.addEventListener('input', function () { line.amount = amountInput.value; updateAll(); });
        grid2.appendChild(fieldRow('Amount ($) *', amountInput));
        var unitsInput = document.createElement('input');
        unitsInput.type = 'number';
        unitsInput.min = '1';
        unitsInput.value = line.units;
        styleInput(unitsInput);
        registerField('gfe-line-units-' + idx, unitsInput);
        unitsInput.addEventListener('input', function () { line.units = unitsInput.value; updateAll(); });
        grid2.appendChild(fieldRow('Units', unitsInput));
        var modInput = document.createElement('input');
        modInput.type = 'text';
        modInput.placeholder = 'e.g. 25';
        modInput.value = line.modifier;
        styleInput(modInput);
        registerField('gfe-line-modifier-' + idx, modInput);
        modInput.addEventListener('input', function () { line.modifier = modInput.value; });
        grid2.appendChild(fieldRow('Modifier', modInput));
        boxEl.appendChild(grid2);

        // Footer: Apply MRF (payer-specific rate) + honest provenance + Remove.
        var footRow = el('div');
        css(footRow, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
        var applyBtn = outlineBtn('Apply MRF');
        css(applyBtn, { padding: '6px 12px', fontSize: '12px' });
        applyBtn.setAttribute('aria-label', 'Apply Claritev MRF rate to line ' + (idx + 1));
        var mrfNote = el('div', null, line._mrfNote || '');
        css(mrfNote, {
          display: line._mrfNote ? 'block' : 'none', fontSize: '12px',
          color: THEME.slate500, lineHeight: '1.4', flex: '1 1 160px', minWidth: '0',
        });
        applyBtn.addEventListener('click', function () {
          var res = gfeMrfRateFor(payerState, (line.cptCode || '').trim());
          if (res.state === 'match') {
            line.amount = String(res.rate);
            amountInput.value = res.rate.toFixed(2);
            if (!line.description) { line.description = res.description; descInput.value = res.description; }
            line.pricingSource = 'Claritev MRF';
            line._mrfNote = 'Claritev MRF negotiated rate applied \u2014 ' + res.payer + ' \u00B7 ' + res.plan + '.';
          } else if (res.state === 'no-payer') {
            line._mrfNote = 'Claritev MRF rates are payer-specific \u2014 no payer selected.';
          } else {
            line._mrfNote = 'No Claritev MRF rate on file for this code + payer.';
          }
          mrfNote.textContent = line._mrfNote;
          mrfNote.style.display = 'block';
          updateAll();
        });
        footRow.appendChild(applyBtn);
        footRow.appendChild(mrfNote);
        var rmBtn = linkBtn('Remove');
        rmBtn.setAttribute('aria-label', 'Remove line ' + (idx + 1));
        css(rmBtn, { color: '#dc2626', marginLeft: 'auto' });
        if (formLines.length === 1) {
          rmBtn.disabled = true;
          css(rmBtn, { opacity: '0.4', cursor: 'not-allowed' });
        } else {
          rmBtn.addEventListener('click', function () {
            closeActiveSugg();
            formLines.splice(idx, 1);
            renderLines();
            updateAll();
          });
        }
        footRow.appendChild(rmBtn);
        boxEl.appendChild(footRow);

        // Typeahead: fills code + description (rates come from Apply MRF).
        cptInput.addEventListener('input', function () {
          line.cptCode = cptInput.value;
          updateAll();
          var q = cptInput.value.trim();
          var matches = q ? gfeCodeSearch(q) : [];
          if (!matches.length) {
            if (activeSugg && activeSugg.anchor === cptInput) closeActiveSugg();
            return;
          }
          openSuggFor(cptInput, suggList, matches, function (m) {
            line.cptCode = m.cpt; cptInput.value = m.cpt;
            line.description = m.description; descInput.value = m.description;
            updateAll();
          });
        });
        // 27D-a: Escape closes the LIST only — stopPropagation keeps the event
        // from reaching the modal's Escape handler; a second Escape (no list
        // open) closes the modal as before.
        cptInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && activeSugg && activeSugg.anchor === cptInput) {
            e.stopPropagation();
            closeActiveSugg();
          }
        });

        return boxEl;
      }
      renderLines();

      // --- Delivery -----------------------------------------------------------
      // FrontRunner Patient Portal ONLY (Craig, 2026-08-17): no email
      // delivery, no print/download (Step 35 stands). The athenaNet
      // chart-attach (JD's ask — athena's add-document-to-chart endpoint,
      // keyed by patient + appointment) folds into this toggle FOR NOW and is
      // SIMULATED: no callable athena document lane exists, and the request
      // shape is unverified from this environment, so no athena field names
      // are encoded anywhere. Whether it stays under this toggle or gets its
      // own is an OPEN question for JD.
      var delSec = detailSection('Delivery');
      css(delSec._body, { display: 'flex', flexDirection: 'column', gap: '8px' });
      var portalOn = existing ? existing.deliverPortal !== false : true;
      var delRow = el('div');
      css(delRow, { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' });
      var delText = el('div');
      css(delText, { minWidth: '0' });
      var delLabel = el('div', null, 'FrontRunner Patient Portal');
      css(delLabel, { fontSize: '13px', fontWeight: '700', color: THEME.slate900 });
      delText.appendChild(delLabel);
      var apptId = gfeCurrentAppointmentId(p);
      var delSub = el('div', null,
        'Posts the GFE PDF to the patient\u2019s FrontRunner Patient Portal inbox, and attaches the GFE document to the patient\u2019s NextGen chart' +
        (apptId ? ' (appointment ' + apptId + ')' : '') +
        ' \u2014 chart attach simulated: no callable NextGen document lane exists yet.');
      css(delSub, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.45' });
      delText.appendChild(delSub);
      delRow.appendChild(delText);
      var portalSwitch = el('button');
      portalSwitch.type = 'button';
      portalSwitch.setAttribute('role', 'switch');
      portalSwitch.setAttribute('aria-label', 'Deliver to FrontRunner Patient Portal');
      registerField('gfe-deliver-portal', portalSwitch);
      var knob = el('span');
      portalSwitch.appendChild(knob);
      function syncSwitch() {
        portalSwitch.setAttribute('aria-checked', portalOn ? 'true' : 'false');
        css(portalSwitch, {
          position: 'relative', width: '40px', height: '22px', borderRadius: '999px',
          border: '1px solid ' + (portalOn ? THEME.navy : THEME.borderInput),
          background: portalOn ? THEME.navy : '#e2e8f0', cursor: 'pointer', flex: '0 0 auto',
          padding: '0', fontFamily: 'inherit',
        });
        css(knob, {
          position: 'absolute', top: '2px', left: portalOn ? '20px' : '2px',
          width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
          transition: 'left 0.15s ease', display: 'block',
        });
      }
      portalSwitch.addEventListener('click', function () { portalOn = !portalOn; syncSwitch(); });
      syncSwitch();
      delRow.appendChild(portalSwitch);
      delSec._body.appendChild(delRow);
      view.appendChild(delSec);

      // --- No Surprises Act validation ---------------------------------------
      // Prod's validation rail: live error/warning list from the ONE shared
      // validator, row hover highlights the offending input, click jumps to
      // it; the fixed statutory disclosures render beneath.
      var nsaSec = detailSection('No Surprises Act validation');
      css(nsaSec._body, { display: 'flex', flexDirection: 'column', gap: '10px' });
      var nsaStatus = el('div');
      nsaSec._body.appendChild(nsaStatus);
      var nsaRows = el('div');
      css(nsaRows, { display: 'flex', flexDirection: 'column', gap: '4px' });
      nsaSec._body.appendChild(nsaRows);
      var nsaJumpHint = el('div', null, 'Hover a row to highlight the field on the form, or click to jump to it.');
      css(nsaJumpHint, { display: 'none', fontSize: '12px', color: THEME.slate500 });
      nsaSec._body.appendChild(nsaJumpHint);
      var nsaDiscHead = el('div', null, 'Statutory disclosures (delivered with every GFE)');
      css(nsaDiscHead, {
        fontSize: '12px', fontWeight: '700', textTransform: 'uppercase',
        letterSpacing: '0.4px', color: THEME.slate500, marginTop: '4px',
      });
      nsaSec._body.appendChild(nsaDiscHead);
      var nsaDiscList = el('div');
      css(nsaDiscList, { display: 'flex', flexDirection: 'column', gap: '4px' });
      GFE_NSA_DISCLOSURES.forEach(function (text) {
        var row = el('div');
        css(row, { display: 'flex', gap: '8px', alignItems: 'flex-start' });
        var dot = el('span', null, '\u2022');
        css(dot, { color: THEME.slate500, flex: '0 0 auto', lineHeight: '1.5', fontSize: '12px' });
        var bodyTxt = el('span', null, text);
        css(bodyTxt, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.5', minWidth: '0' });
        row.appendChild(dot); row.appendChild(bodyTxt);
        nsaDiscList.appendChild(row);
      });
      nsaSec._body.appendChild(nsaDiscList);
      var nsaVersion = el('div', null, 'Version ' + GFE_DISCLOSURES_VERSION + ' \u2014 recorded with every issued GFE.');
      css(nsaVersion, { fontSize: '12px', color: THEME.slate500 });
      nsaSec._body.appendChild(nsaVersion);
      view.appendChild(nsaSec);

      function issueRow(issue, tone) {
        var b = el('button');
        b.type = 'button';
        b.textContent = '\u2022 ' + issue.message;
        css(b, {
          display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
          padding: '2px 0', fontSize: '12px', lineHeight: '1.5', color: tone, cursor: 'pointer',
          fontFamily: 'inherit',
        });
        var id = gfeFieldDomId(issue.field);
        b.addEventListener('mouseenter', function () { if (id) highlightField(id, true); });
        b.addEventListener('mouseleave', function () { if (id) highlightField(id, false); });
        b.addEventListener('click', function () { jumpToField(issue.field); });
        return b;
      }

      function renderNsaPanel() {
        while (nsaStatus.firstChild) nsaStatus.removeChild(nsaStatus.firstChild);
        while (nsaRows.firstChild) nsaRows.removeChild(nsaRows.firstChild);
        var errors = lastIssues.filter(function (i) { return i.severity === 'error'; });
        var warnings = lastIssues.filter(function (i) { return i.severity === 'warning'; });
        var head = el('div', null, errors.length
          ? errors.length + ' required field' + (errors.length === 1 ? '' : 's') + ' missing'
          : 'All required fields complete \u2014 ready to issue');
        css(head, { fontSize: '12px', fontWeight: '700', color: errors.length ? '#dc2626' : '#047857' });
        nsaStatus.appendChild(head);
        errors.forEach(function (issue) { nsaRows.appendChild(issueRow(issue, '#dc2626')); });
        warnings.forEach(function (issue) { nsaRows.appendChild(issueRow(issue, THEME.amber)); });
        nsaJumpHint.style.display = lastIssues.length ? 'block' : 'none';
      }

      // --- Issue --------------------------------------------------------------
      var issueSec = detailSection('Issue');
      css(issueSec._body, { display: 'flex', flexDirection: 'column', gap: '8px' });
      var statusLabel = el('div', null, 'Status');
      css(statusLabel, { fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.4px', color: THEME.slate500 });
      issueSec._body.appendChild(statusLabel);
      var statusBadge = el('span');
      css(statusBadge, {
        display: 'inline-block', alignSelf: 'flex-start', padding: '2px 9px', borderRadius: '999px',
        fontSize: '12px', fontWeight: '600', whiteSpace: 'nowrap',
      });
      issueSec._body.appendChild(statusBadge);
      var issueBtn = navyBtn('Issue GFE');
      css(issueBtn, { width: '100%', padding: '10px 16px', fontSize: '14px' });
      issueSec._body.appendChild(issueBtn);
      var issueHint = el('div', null,
        'Issuing locks the record (Draft \u2192 Issued) and records the statutory disclosures (' +
        GFE_DISCLOSURES_VERSION + ') and delivery with it.');
      css(issueHint, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.5' });
      issueSec._body.appendChild(issueHint);

      // INTERIM (register row 5, Craig 2026-08-17): Prod's builder has NO
      // user-facing save — its saveDraft() is internal to Download PDF /
      // Issue. Save stays here because Print/Download are out of scope (Step
      // 35) and the Draft→Issued lifecycle needs a creation path; Craig
      // expects this to flip to issue-only strict parity — re-rule before
      // building anything else on Save.
      var saveBtn = outlineBtn(existing ? 'Save changes (draft)' : 'Save as draft');
      css(saveBtn, { width: '100%', padding: '10px 16px', fontSize: '13px' });
      issueSec._body.appendChild(saveBtn);
      var saveHint = el('div', null, 'Saves a Draft to the estimate list \u2014 issue it later from the estimate detail.');
      css(saveHint, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.5' });
      issueSec._body.appendChild(saveHint);
      view.appendChild(issueSec);

      function renderIssueState() {
        var errors = lastIssues.filter(function (i) { return i.severity === 'error'; });
        var ready = !errors.length;
        statusBadge.textContent = ready
          ? 'Ready to issue'
          : errors.length + ' required field' + (errors.length === 1 ? '' : 's') + ' missing';
        css(statusBadge, {
          background: ready ? 'rgba(16, 185, 129, 0.14)' : 'rgba(220, 38, 38, 0.12)',
          color: ready ? '#047857' : '#dc2626',
        });
        issueBtn.disabled = !ready;
        css(issueBtn, { opacity: ready ? '1' : '0.5', cursor: ready ? 'pointer' : 'not-allowed' });
      }

      function formSnapshot() {
        return {
          patientName: nameInput.value.trim(),
          patientDob: dobInput.value.trim(),
          patientEmail: emailInput.value.trim(),
          patientPhone: phoneInput.value.trim(),
          providerName: provNameInput.value.trim(),
          providerNpi: npiInput.value.trim(),
          taxId: tinInput.value.trim(),
          serviceLocation: posSelect.value,
          expectedDateOfService: dosInput.value.trim(),
          diagnosisCode: dxInput.value.trim(),
          payer: payerState ? payerState.payer : null,
          plan: payerState ? payerState.plan : null,
          serviceItems: formLines,
        };
      }

      function updateAll() {
        var snap = formSnapshot();
        var totals = gfeComputeTotals(snap.serviceItems, discountSource);
        snap.totalEstimate = totals.grossTotal;
        lastIssues = gfeValidateDraft(snap);
        while (receiptWrap.firstChild) receiptWrap.removeChild(receiptWrap.firstChild);
        receiptWrap.appendChild(gfeReceipt(totals, discountSource));
        var anyMrf = formLines.some(function (ln) { return ln.pricingSource === 'Claritev MRF'; });
        pricingFoot.textContent = anyMrf ? 'Pricing source: Claritev MRF (mock reference set)' : '';
        pricingFoot.style.display = anyMrf ? 'block' : 'none';
        renderNsaPanel();
        renderIssueState();
      }

      // 23E2b property, carried over: Save and Issue both persist through
      // this ONE builder (single source of truth for the saved shape); Issue
      // only adds the gfeStampIssue stamps on top.
      function buildEstimateFromForm() {
        var snap = formSnapshot();
        var totals = gfeComputeTotals(formLines, discountSource);
        return {
          id: existing ? existing.id : gfeNextId(),
          createdDate: existing ? existing.createdDate : rtvToday(),
          patientName: snap.patientName,
          patientDob: snap.patientDob,
          patientEmail: snap.patientEmail,
          patientPhone: snap.patientPhone,
          providerName: snap.providerName,
          providerNpi: snap.providerNpi,
          taxId: snap.taxId,
          serviceLocation: snap.serviceLocation,
          expectedDateOfService: snap.expectedDateOfService,
          diagnosisCode: snap.diagnosisCode,
          payer: snap.payer,
          plan: snap.plan,
          serviceItems: formLines.map(function (ln) {
            var amt = gfeParseAmount(ln.amount); if (isNaN(amt)) amt = 0;
            var units = Number(ln.units); if (isNaN(units) || units <= 0) units = 1;
            return {
              cptCode: (ln.cptCode || '').trim(),
              description: (ln.description || '').trim(),
              amount: amt, units: units,
              modifier: (ln.modifier || '').trim() || null,
              pricingSource: ln.pricingSource || null,
            };
          }),
          grossTotal: totals.grossTotal,
          discountSource: discountSource ? JSON.parse(JSON.stringify(discountSource)) : null,
          discountAmount: totals.discountAmount,
          patientResponsibility: totals.patientResponsibility,
          status: 'Draft',
          deliverPortal: portalOn,
          deliveries: [],
          department: existing ? existing.department : (enc.department || 'Internal Medicine'),
          lastActivity: rtvToday(),
        };
      }
      function upsert(rec) {
        for (var i = 0; i < GFE_ESTIMATES.length; i++) {
          if (GFE_ESTIMATES[i].id === rec.id) { GFE_ESTIMATES[i] = rec; return rec; }
        }
        GFE_ESTIMATES.push(rec);
        return rec;
      }

      saveBtn.addEventListener('click', function () {
        closeActiveSugg();
        upsert(buildEstimateFromForm());
        navigate(buildGfeListView, 'right');
      });
      // Gated by the same validation state the NSA panel shows: the button is
      // disabled by renderIssueState() while errors remain, AND the click
      // handler re-runs the validator so the gate cannot be bypassed.
      issueBtn.addEventListener('click', function () {
        if (issueBtn.disabled) return;
        var snap = formSnapshot();
        snap.totalEstimate = gfeComputeTotals(snap.serviceItems, discountSource).grossTotal;
        if (gfeIssueBlockers(snap).length) { updateAll(); return; } // re-check at click
        closeActiveSugg();
        var rec = buildEstimateFromForm();
        gfeStampIssue(rec, p);
        upsert(rec);
        navigate(function () { return buildGfeDetailView(rec); }, 'left');
      });

      updateAll();
      return view;
    }

    // --- stepped slide navigation -----------------------------------------
    var currentView = null;
    var isTransitioning = false;
    function navigate(buildFn, direction) {
      if (isTransitioning) return;
      var incoming = buildFn();
      if (!currentView) {
        viewport.appendChild(incoming);
        currentView = incoming;
        return;
      }
      isTransitioning = true;
      var outgoing = currentView;
      var enterFrom = direction === 'left' ? '100%' : '-100%';
      var exitTo = direction === 'left' ? '-100%' : '100%';
      css(outgoing, { position: 'absolute', top: '0', left: '0', width: '100%' });
      css(incoming, { position: 'absolute', top: '0', left: '0', width: '100%', transform: 'translateX(' + enterFrom + ')' });
      viewport.appendChild(incoming);
      var targetH = Math.max(outgoing.offsetHeight, incoming.offsetHeight);
      css(viewport, { height: targetH + 'px' });
      void incoming.offsetWidth;
      css(outgoing, { transition: 'transform 150ms ease', transform: 'translateX(' + exitTo + ')' });
      css(incoming, { transition: 'transform 150ms ease', transform: 'translateX(0)' });
      currentView = incoming;
      window.setTimeout(function () {
        if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
        css(incoming, { position: 'static', transform: '', transition: '', width: 'auto' });
        css(viewport, { height: 'auto' });
        if (body) body.scrollTop = 0;
        isTransitioning = false;
      }, 180);
    }
    // Re-render the current view in place (no slide) — used after a mutation.
    function replaceCurrent(buildFn) {
      var fresh = buildFn();
      if (currentView && currentView.parentNode === viewport) {
        viewport.replaceChild(fresh, currentView);
      } else {
        viewport.appendChild(fresh);
      }
      currentView = fresh;
    }

    // --- modal shell -------------------------------------------------------
    var overlay = el('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', zIndex: '1000', overflowY: 'auto',
    });
    var dialog = el('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Good Faith Estimates');
    css(dialog, {
      // Step 11: cap at the athena embed iframe width (~600px) — see note above.
      background: '#ffffff', borderRadius: '12px', width: '100%', maxWidth: '600px',
      maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      boxShadow: '0 20px 45px rgba(0,0,0,0.28)', color: THEME.slate900, fontFamily: 'inherit',
    });

    function closeModal() {
      deregisterCloser(); // 27B: idempotent — no-op when the registry already cleared it
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      // Reflect any Finalize / Send / Save-as-Draft mutations on the card face.
      // (On a 27B force-close this renders the OLD patient's card for a beat;
      // the Step-16 re-render immediately replaces it — harmless.)
      if (currentPatient) {
        renderGoodFaithEstimatesCard(currentPatient);
        // Re-wire collapse on the freshly rebuilt GFE card (preserves its state).
        wireCollapsibleCards();
      }
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape' && document.body.lastElementChild === overlay) closeModal();
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKey);
    // 27B: a patient switch force-closes this modal through the shared
    // registry (the 180ms view-slide timer is self-contained to detached
    // nodes and needs no clearing).
    var deregisterCloser = registerModalCloser(closeModal);

    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '16px 20px', color: '#ffffff',
      borderTopLeftRadius: '12px', borderTopRightRadius: '12px', backgroundImage: THEME.navyGradient,
    });
    var headText = el('div');
    var hTitle = el('div', null, 'Good Faith Estimates'); css(hTitle, { fontSize: '16px', fontWeight: '700' });
    var hSub = el('div', null, [pName, pMrn].filter(Boolean).join(' \u00B7 '));
    css(hSub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    headText.appendChild(hTitle); headText.appendChild(hSub);
    head.appendChild(headText);

    var body = el('div');
    css(body, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '20px', background: '#ffffff' });
    var viewport = el('div');
    css(viewport, { position: 'relative', overflow: 'hidden' });
    body.appendChild(viewport);

    var footer = el('div');
    css(footer, {
      flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '10px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: '#ffffff',
      borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
    });
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    css(cancel, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    cancel.addEventListener('click', closeModal);
    footer.appendChild(cancel);

    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    navigate(initialView === 'form' ? buildGfeFormView : buildGfeListView, 'left');
    cancel.focus();
  }

  // ===========================================================================
  // MRF negotiated rates (mock). MRF-SIDECAR: the MRF screen itself no longer
  // reads MRF_RATES — the Rate Search modal uses MRF_SEARCH_MOCK below. MRF_RATES
  // stays for the GFE CPT picker / Apply MRF and the claim-detail "CPT lines vs
  // MRF rates" section. All data is mock (inlined here, not fetched); all
  // styling is applied via css() (CSSOM) so the embed's CSP is respected.
  // ===========================================================================
  // Step 24C: extended toward the Clearline curated-MRF reference (24C-fix:
  // 11 records — all for the patient's two plans).
  // The ORIGINAL 6 rows keep their exact prior field values (GFE seeds/visit
  // bundles depend on 99213/99214/85025 for the two existing plans); every row
  // additionally carries the CMS-schema fields the reference shows (codeType,
  // negotiatedType, arrangement, billingClass, posCodes, modifiers — constant
  // across this curated professional-services slice, which mirrors the
  // reference). New rows for the EXISTING plans intentionally enrich the GFE
  // CPT picker (additive, journaled). 24C-fix: every row belongs to one of the
  // patient's two plans — the explorer is scoped to the patient's plan(s), so
  // rows for other payers would be unreachable dead data (the 24C
  // UnitedHealthcare filter-demo row was removed for exactly that reason).
  var MRF_RATES = [
    { cpt: '99213', description: 'Office visit, est. patient \u2013 low complexity', negotiatedRate: 118.00, patientResp: 30.00, billedCharge: 165.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '99214', description: 'Office visit, est. patient \u2013 mod. complexity', negotiatedRate: 155.00, patientResp: 30.00, billedCharge: 210.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '85025', description: 'Complete CBC with differential', negotiatedRate: 22.00, patientResp: 4.40, billedCharge: 35.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Austin Diagnostic Laboratory', npi: '1558342706', taxId: '74-1076934' },
    { cpt: '99213', description: 'Office visit, est. patient \u2013 low complexity', negotiatedRate: 104.00, patientResp: 20.80, billedCharge: 165.00, payer: 'Aetna', plan: 'Aetna Choice POS II', planType: 'POS', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '99214', description: 'Office visit, est. patient \u2013 mod. complexity', negotiatedRate: 138.00, patientResp: 27.60, billedCharge: 210.00, payer: 'Aetna', plan: 'Aetna Choice POS II', planType: 'POS', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '85025', description: 'Complete CBC with differential', negotiatedRate: 19.00, patientResp: 3.80, billedCharge: 35.00, payer: 'Aetna', plan: 'Aetna Choice POS II', planType: 'POS', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Austin Diagnostic Laboratory', npi: '1558342706', taxId: '74-1076934' },
    // 24C additions — existing plans (these DO surface in the GFE CPT picker):
    { cpt: '99203', description: 'Office visit, new patient \u2013 low complexity', negotiatedRate: 142.00, patientResp: 30.00, billedCharge: 195.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '93000', description: 'Electrocardiogram, complete with interpretation', negotiatedRate: 31.00, patientResp: 6.20, billedCharge: 55.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '80053', description: 'Comprehensive metabolic panel', negotiatedRate: 14.50, patientResp: 2.90, billedCharge: 28.00, payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO', planType: 'PPO', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Austin Diagnostic Laboratory', npi: '1558342706', taxId: '74-1076934' },
    { cpt: '99396', description: 'Preventive visit, est. patient 40\u201364', negotiatedRate: 168.00, patientResp: 0.00, billedCharge: 240.00, payer: 'Aetna', plan: 'Aetna Choice POS II', planType: 'POS', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11', modifiers: null, providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
    { cpt: '90834', description: 'Psychotherapy, 45 minutes', negotiatedRate: 87.00, patientResp: 17.40, billedCharge: 130.00, payer: 'Aetna', plan: 'Aetna Choice POS II', planType: 'POS', codeType: 'CPT', negotiatedType: 'negotiated', arrangement: 'ffs', billingClass: 'professional', posCodes: '11, 02', modifiers: '95', providerName: 'Bluebonnet Family Medicine PLLC', npi: '1093817465', taxId: '74-2918305' },
  ];

  function fmtMrfMoney(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  // Patient's primary insurance — HONEST NULLS (Step 37 fix): a missing payer
  // or plan stays null instead of falling back to the documented demo
  // defaults. The old fallback ('Blue Cross Blue Shield of Texas' /
  // 'BlueChoice PPO') fabricated coverage: a patient with no primary on file
  // was shown another payer's rates, and a primary carrying a payer but no
  // planName (the Humana appointment patient) rendered a hybrid
  // "Humana / BlueChoice PPO". Callers compose a display label via
  // mrfPlanLabel(...) and treat null as "no primary coverage on file".
  function mrfPrimaryInsurance(p) {
    var pr = (p && p.insurance && p.insurance.primary) || {};
    return {
      payer: pr.payer || null,
      plan: pr.planName || null,
    };
  }

  // Display label for a plan entry: the plan name when known, else the payer
  // alone — a payer-only policy is real coverage with an unknown plan label,
  // never a reason to invent one. Null when there is no coverage at all.
  function mrfPlanLabel(pl) {
    return (pl && (pl.plan || pl.payer)) || null;
  }

  // ===========================================================================
  // MRF-SIDECAR (2026-10-02, D-105 to D-116; PM-64 6a): the MRF screen is
  // FrontRunner's Clearline › Rate Search — FrontRunner's only MRF screen
  // (frhc-platform website/client/src/features/clearline/components/
  // ClearlineRateSearchTab.tsx). FrontRunner dropped its bulk MRF Explorer and
  // detail view on purpose, so the Step 37 Explorer (presets, column picker,
  // "Patient view", constants line + chips, filters, detail) is gone. Every
  // user-facing string below is FrontRunner's, verbatim (D-108), unless a
  // comment says otherwise.
  //
  // MRF_SEARCH_MOCK is shaped like FrontRunner's MrfRateRecord
  // (website/client/src/features/mrf-rate-search/types/index.ts) plus `payer`,
  // which only the prototype's plan filter reads. It is deliberately separate
  // from MRF_RATES above, which the GFE flow and the claim-detail
  // "CPT lines vs MRF rates" section still read. Synthetic data only.
  // ===========================================================================
  var MRF_SEARCH_MOCK = [
    // CPT 99213 · NPI 1093817465 — on BOTH active plans, on the patient's
    // EXPIRED plan, and on two other payers' plans (PM-64 scenario: only the
    // active primary + secondary rows may ever show).
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 118.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'BlueChoice PPO', planType: 'PPO', payer: 'Blue Cross Blue Shield of Texas', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 112.50, negotiatedType: 'fee schedule', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'BlueChoice PPO', planType: 'PPO', payer: 'Blue Cross Blue Shield of Texas', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 104.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Aetna Choice POS II', planType: 'POS', payer: 'Aetna', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 109.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Choice Plus PPO', planType: 'PPO', payer: 'UnitedHealthcare', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 97.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Cigna Open Access Plus', planType: 'EPO', payer: 'Cigna', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99213', negotiatedRate: 101.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Humana Gold Plus HMO', planType: 'HMO', payer: 'Humana', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    // CPT 99214 · NPI 1093817465 — a percentage-of-billed-charges rate on the
    // active primary (never rendered as dollars) beside a dollar rate on the
    // secondary.
    { billingCodeType: 'CPT', billingCode: '99214', negotiatedRate: 72, negotiatedType: 'percentage', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'BlueChoice PPO', planType: 'PPO', payer: 'Blue Cross Blue Shield of Texas', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'CPT', billingCode: '99214', negotiatedRate: 138.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Aetna Choice POS II', planType: 'POS', payer: 'Aetna', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    // CPT 85025 · TIN 74-1076934 — a TIN-only row (no NPI) on the active
    // primary: the Provider column falls back to the TIN.
    { billingCodeType: 'CPT', billingCode: '85025', negotiatedRate: 22.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'BlueChoice PPO', planType: 'PPO', payer: 'Blue Cross Blue Shield of Texas', providerNpi: null, providerTaxId: '74-1076934', state: 'TX' },
    // HCPCS G0438 · NPI 1093817465 — rates ONLY on other payers' plans (D-113:
    // the patient's plans match no MRF data → the same "No MRF rate found").
    { billingCodeType: 'HCPCS', billingCode: 'G0438', negotiatedRate: 168.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Choice Plus PPO', planType: 'PPO', payer: 'UnitedHealthcare', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
    { billingCodeType: 'HCPCS', billingCode: 'G0438', negotiatedRate: 159.00, negotiatedType: 'negotiated', negotiationArrangement: 'ffs', billingClass: 'professional', planName: 'Cigna Open Access Plus', planType: 'EPO', payer: 'Cigna', providerNpi: '1093817465', providerTaxId: '74-2918305', state: 'TX' },
  ];

  // FrontRunner's verbatim copy (ClearlineRateSearchTab.tsx; D-108), plus the
  // app-wide messages the rulings set for the two patient-plan states.
  var MRF_TEXT = {
    title: 'Rate Search',
    subtitle: 'Look up a real Claritev contracted MRF negotiated rate by billing code and provider.',
    // FrontRunner's Rate Search tool-card description (clearline/lib/stages.ts).
    cardSub: 'Look up a real Claritev contracted rate by provider identifier + code.',
    bannerTitle: 'About these rates',
    banner: 'Each result is a real Claritev-curated Machine-Readable File (MRF) negotiated rate for the code + provider you enter — a benchmark contracted price, not a quote and not what a specific payer will actually pay. This is an on-demand lookup and nothing is saved.',
    noMatch: 'No MRF rate found for this code and provider.',
    notConfigured: 'MRF rate search isn\'t available in this environment yet.',
    errorFallback: 'Failed to look up the rate.',
    percentNote: '(percentage-based — not a dollar amount)',
    noPlan: 'MRF rates are by insurance plan. This patient has no active plan — for self-pay pricing, use Good Faith Estimates.', // D-101
    insuranceUnavailable: 'Insurance unavailable — retry', // D-114
  };

  // D-109 freemium copy. PROVISIONAL — Dev to capture FrontRunner's exact
  // rendering (PM-64). Limit text = the action-handler's 402 message
  // (billing_gate.py); warning text = FreemiumAllowanceWarningToast.tsx.
  // The allowance is set per client in FrontRunner; 25 is a mock value.
  var MRF_FREEMIUM_MOCK = { serviceName: 'Price Transparency Data (MRF)', allowance: 25, used: 20 };
  function mrfFreemiumLimitText() {
    var f = MRF_FREEMIUM_MOCK;
    return 'Your free monthly allowance of ' + f.allowance + ' ' + f.serviceName +
      ' transaction' + (f.allowance === 1 ? '' : 's') + ' is used up. Upgrade to continue.';
  }
  function mrfFreemiumWarningText() {
    var f = MRF_FREEMIUM_MOCK;
    var pct = Math.round((f.used / f.allowance) * 100);
    return 'You\'ve used ' + pct + '% of your free ' + f.serviceName + ' allowance (' +
      f.used + ' of ' + f.allowance + ' free real-time transaction' + (f.allowance === 1 ? '' : 's') +
      ') this month. Upgrade to keep ' + f.serviceName + ' running without interruption.';
  }

  // DEMO-ONLY trigger: ?mrf=<mode> on the launch URL forces one Rate Search
  // state so it can be shown without a live FrontRunner. Unknown values are
  // ignored; the normal path has no artificial delay.
  var MRF_DEMO_MODES = ['searching', 'not-configured', 'error', 'freemium-limit', 'freemium-warning', 'insurance-unavailable'];
  function mrfDemoMode() {
    try {
      var m = new URLSearchParams(window.location.search).get('mrf');
      return MRF_DEMO_MODES.indexOf(m) !== -1 ? m : null;
    } catch (e) {
      return null;
    }
  }

  // The patient's plans for MRF (D-113): the active primary and secondary
  // plans the Insurance screen shows (same "Active…" status test as its pill);
  // a primary or secondary whose status isn't active (cancelled, expired)
  // doesn't count, and nothing in p.insuranceHistory is ever a candidate.
  function mrfPlanIsActive(pl) {
    return !!(pl && pl.payer && /^active/i.test(pl.status || ''));
  }
  function mrfPatientActivePlans(p) {
    var ins = (p && p.insurance) || {};
    var candidates = [ins.primary, ins.secondary];
    return candidates.filter(mrfPlanIsActive).map(function (pl) {
      return { payer: pl.payer, planName: pl.planName || null };
    });
  }

  // Prototype of the D-106/D-116 filter. Dev builds the real one; where it
  // runs (the Rate Search Action vs the sidecar) is Dev's call under D-106.
  // Matching here is an exact payer + plan-name compare on synthetic data.
  // Real Claritev plan names will not match athena coverage names exactly,
  // and that mapping is an open design problem for Dev.
  // D-117: only a confident match counts. A patient plan with no plan name
  // matches nothing (it would match every plan of that payer — ambiguous),
  // and a partial name match is no match; both end in "No MRF rate found".
  function mrfFilterToPatientPlans(rows, patient) {
    var plans = mrfPatientActivePlans(patient).filter(function (pl) { return !!pl.planName; });
    return rows.filter(function (r) {
      return plans.some(function (pl) {
        return r.payer === pl.payer && r.planName === pl.planName;
      });
    });
  }

  // Mock of FrontRunner's single-code Rate Search: code type + code + the NPI
  // or TIN, then the patient's-plans filter. Identifiers compare on digits so
  // "74-2918305" and "742918305" are the same TIN.
  function mrfMockSearch(params, patient) {
    var code = params.billingCode.trim().toUpperCase();
    var ident = params.providerIdentifier.replace(/\D/g, '');
    var matches = MRF_SEARCH_MOCK.filter(function (r) {
      if (r.billingCodeType !== params.billingCodeType) return false;
      if (String(r.billingCode).toUpperCase() !== code) return false;
      var rid = params.providerIdentifierType === 'NPI' ? r.providerNpi : r.providerTaxId;
      return !!rid && String(rid).replace(/\D/g, '') === ident;
    });
    return mrfFilterToPatientPlans(matches, patient);
  }

  // FrontRunner's units guard (mrf-rate-search/lib/negotiated-type.ts): any
  // negotiated type containing "percent" is a percentage of billed charges,
  // NEVER a dollar amount.
  function mrfIsPercentageType(t) {
    return /percent/i.test(t || '');
  }
  function mrfFormatNegotiatedRate(r) {
    if (mrfIsPercentageType(r.negotiatedType)) {
      return r.negotiatedRate == null ? '— % of billed charges' : r.negotiatedRate + '% of billed charges';
    }
    return r.negotiatedRate == null ? '—' : fmtMrfMoney(r.negotiatedRate);
  }
  function mrfJoin(parts) {
    var s = parts.filter(function (x) { return x != null && x !== ''; }).join(' · ');
    return s || '—';
  }

  // MRF-SIDECAR: the Rate Search modal. Patient-plan state is decided at open
  // (no active plan → D-101; plans unreadable → D-114), then the FrontRunner
  // form: nothing pre-filled (D-110), Search disabled until code + identifier
  // are non-blank, nothing shown before a search, a search only on click
  // (D-109). No permission gate beyond app access (D-107). A patient switch
  // force-closes it through the shared registry (D-43), clearing any pending
  // search, so the next open is an empty form.
  function openMrfRateSearchModal() {
    if (!currentPatient) return;
    var p = currentPatient;
    var prevFocus = document.activeElement;
    var demo = mrfDemoMode();
    var pendingTimer = null;
    var closed = false;
    // D-114 demo: the first plans read in this modal fails; Retry succeeds.
    var planReadAttempts = 0;

    var overlay = el('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', zIndex: '1000', overflowY: 'auto',
    });
    var dialog = el('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', MRF_TEXT.title);
    css(dialog, {
      // Step 11: cap at the athena embed iframe width (~600px).
      background: '#ffffff', borderRadius: '12px', width: '100%', maxWidth: '600px',
      maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      boxShadow: '0 20px 45px rgba(0,0,0,0.28)', color: THEME.slate900, fontFamily: 'inherit',
    });

    function closeModal() {
      closed = true;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      deregisterCloser(); // 27B: idempotent — no-op when the registry already cleared it
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape' && document.body.lastElementChild === overlay) closeModal();
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKey);
    // 27B / D-43: a patient switch force-closes this modal through the registry.
    var deregisterCloser = registerModalCloser(closeModal);

    // --- header (shared shell: navy gradient + patient identity) ---
    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '16px 20px', color: '#ffffff',
      borderTopLeftRadius: '12px', borderTopRightRadius: '12px',
      backgroundImage: THEME.navyGradient,
    });
    var headText = el('div');
    var hTitle = el('div', null, MRF_TEXT.title); css(hTitle, { fontSize: '16px', fontWeight: '700' });
    var hSub = el('div', null, identitySubLine(p));
    css(hSub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    headText.appendChild(hTitle); headText.appendChild(hSub);
    head.appendChild(headText);

    // --- body ---
    var body = el('div');
    css(body, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '20px', background: '#ffffff' });

    function muted(text, testId) {
      var n = el('p', null, text);
      if (testId) n.setAttribute('data-testid', testId);
      css(n, { fontSize: '13px', color: THEME.slate500, margin: '12px 0 0' });
      return n;
    }
    function styleControl(node) {
      css(node, {
        background: '#ffffff', color: THEME.slate900, border: '1px solid ' + THEME.borderInput,
        borderRadius: '8px', padding: '7px 10px', fontSize: '13px', fontFamily: 'inherit',
        colorScheme: 'light', width: '100%', boxSizing: 'border-box',
      });
      return node;
    }
    function makeSelect(id, values) {
      var sel = document.createElement('select');
      sel.id = id;
      sel.setAttribute('data-testid', id);
      values.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        sel.appendChild(opt);
      });
      return styleControl(sel);
    }
    function field(labelText, control) {
      var wrap = el('div');
      css(wrap, { flex: '1 1 120px', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px' });
      var lab = document.createElement('label');
      lab.htmlFor = control.id;
      lab.textContent = labelText;
      css(lab, { fontSize: '12px', fontWeight: '600', color: THEME.slate900 });
      wrap.appendChild(lab); wrap.appendChild(control);
      return wrap;
    }

    // Pre-form states: decided by the patient's plans when the modal opens.
    function renderPlanGate(text, testId, withRetry) {
      var box = el('div');
      box.setAttribute('data-testid', testId);
      css(box, {
        border: '1px solid ' + THEME.border, borderRadius: '8px', padding: '14px',
        fontSize: '13px', color: THEME.slate900, background: THEME.inset,
      });
      box.appendChild(el('div', null, text));
      if (withRetry) {
        var retry = el('button', null, 'Retry');
        retry.type = 'button';
        retry.setAttribute('data-testid', 'mrf-insurance-retry');
        css(retry, {
          marginTop: '10px', background: '#ffffff', color: THEME.navy,
          border: '1px solid ' + THEME.navy, borderRadius: '8px', padding: '6px 14px',
          fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
        });
        retry.addEventListener('click', renderBody);
        box.appendChild(retry);
      }
      body.appendChild(box);
    }

    function renderBody() {
      while (body.firstChild) body.removeChild(body.firstChild);
      planReadAttempts += 1;
      if (demo === 'insurance-unavailable' && planReadAttempts === 1) {
        renderPlanGate(MRF_TEXT.insuranceUnavailable, 'mrf-insurance-unavailable', true);
        return;
      }
      if (!mrfPatientActivePlans(p).length) {
        renderPlanGate(MRF_TEXT.noPlan, 'mrf-no-plan', false);
        return;
      }
      renderSearch();
    }

    function renderSearch() {
      var intro = el('p', null, MRF_TEXT.subtitle);
      intro.setAttribute('data-testid', 'mrf-subtitle');
      css(intro, { fontSize: '13px', color: THEME.slate500, margin: '0 0 12px' });
      body.appendChild(intro);

      // "About these rates" banner (FrontRunner's reality banner).
      var banner = el('div');
      banner.setAttribute('role', 'note');
      banner.setAttribute('data-testid', 'rate-search-reality-banner');
      css(banner, {
        border: '1px solid ' + THEME.border, borderRadius: '8px', padding: '10px 12px',
        background: THEME.inset, marginBottom: '14px',
      });
      var bTitle = el('div', null, MRF_TEXT.bannerTitle);
      css(bTitle, { fontSize: '13px', fontWeight: '700', color: THEME.slate900, marginBottom: '4px' });
      var bText = el('div', null, MRF_TEXT.banner);
      bText.setAttribute('data-testid', 'rate-search-banner-text');
      css(bText, { fontSize: '12px', color: THEME.slate500, lineHeight: '1.45' });
      banner.appendChild(bTitle); banner.appendChild(bText);
      body.appendChild(banner);

      // --- form (FrontRunner's four fields + Search), one row that wraps ---
      var form = el('div');
      form.setAttribute('data-testid', 'rate-search-form');
      css(form, {
        border: '1px solid ' + THEME.wellBorder, borderRadius: '8px', padding: '12px',
        background: THEME.well,
      });
      var row = el('div');
      css(row, { display: 'flex', flexWrap: 'wrap', gap: '10px' });
      var codeType = makeSelect('rate-search-code-type', ['CPT', 'HCPCS']);
      var code = styleControl(document.createElement('input'));
      code.type = 'text'; code.id = 'rate-search-code';
      code.setAttribute('data-testid', 'rate-search-code');
      code.placeholder = 'e.g. 99213';
      var identType = makeSelect('rate-search-identifier-type', ['NPI', 'TIN']);
      var ident = styleControl(document.createElement('input'));
      ident.type = 'text'; ident.id = 'rate-search-identifier';
      ident.setAttribute('data-testid', 'rate-search-identifier');
      ident.placeholder = '10-digit NPI';
      row.appendChild(field('Code type', codeType));
      row.appendChild(field('Code', code));
      row.appendChild(field('Provider identifier', identType));
      row.appendChild(field('Identifier', ident));
      form.appendChild(row);

      var searchBtn = el('button');
      searchBtn.type = 'button';
      searchBtn.setAttribute('data-testid', 'rate-search-submit');
      css(searchBtn, {
        marginTop: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px',
        background: THEME.navy, color: '#ffffff', border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '7px 16px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      var spinner = el('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      spinner.setAttribute('data-testid', 'rate-search-spinner');
      css(spinner, {
        width: '12px', height: '12px', borderWidth: '2px', margin: '0',
        display: 'none', flex: '0 0 auto',
      });
      searchBtn.appendChild(spinner);
      searchBtn.appendChild(el('span', null, 'Search'));
      form.appendChild(searchBtn);

      var outcome = el('div');
      outcome.setAttribute('data-testid', 'rate-search-outcome');
      form.appendChild(outcome);
      body.appendChild(form);

      var searching = false;
      function canSearch() {
        return code.value.trim() !== '' && ident.value.trim() !== '';
      }
      function syncButton() {
        var enabled = canSearch() && !searching;
        searchBtn.disabled = !enabled;
        css(searchBtn, { opacity: enabled ? '1' : '0.55', cursor: enabled ? 'pointer' : 'not-allowed' });
        spinner.style.display = searching ? 'inline-block' : 'none';
      }
      function clearOutcome() {
        while (outcome.firstChild) outcome.removeChild(outcome.firstChild);
      }
      code.addEventListener('input', syncButton);
      ident.addEventListener('input', syncButton);
      identType.addEventListener('change', function () {
        ident.placeholder = identType.value === 'NPI' ? '10-digit NPI' : 'Tax ID';
      });

      function renderResults(rows) {
        var wrap = el('div');
        wrap.setAttribute('data-testid', 'rate-search-results');
        css(wrap, { marginTop: '12px', border: '1px solid ' + THEME.border, borderRadius: '8px', overflow: 'hidden' });
        var table = document.createElement('table');
        css(table, { width: '100%', borderCollapse: 'collapse', fontSize: '12px', tableLayout: 'fixed' });
        var cols = [
          { label: 'Negotiated rate', width: '24%' },
          { label: 'Plan', width: '28%' },
          { label: 'Arrangement', width: '20%' },
          { label: 'Provider', width: '17%' },
          { label: 'State', width: '11%' },
        ];
        var thead = document.createElement('thead');
        var htr = document.createElement('tr');
        cols.forEach(function (c) {
          var th = document.createElement('th');
          th.textContent = c.label;
          css(th, {
            width: c.width, textAlign: 'left', padding: '8px 6px', fontSize: '12px', fontWeight: '700',
            color: THEME.slate500, background: THEME.inset, borderBottom: '1px solid ' + THEME.border,
          });
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        rows.forEach(function (r, i) {
          var tr = document.createElement('tr');
          tr.setAttribute('data-testid', 'rate-search-result-' + i);
          function td(content) {
            var c = document.createElement('td');
            css(c, {
              padding: '8px 6px', borderBottom: '1px solid ' + THEME.borderSoft,
              verticalAlign: 'top', color: THEME.slate900, overflowWrap: 'break-word',
            });
            if (typeof content === 'string') c.textContent = content; else c.appendChild(content);
            tr.appendChild(c);
            return c;
          }
          var rateCell = td(mrfFormatNegotiatedRate(r));
          css(rateCell, { fontWeight: '600' });
          if (mrfIsPercentageType(r.negotiatedType)) {
            var note = el('span', null, ' ' + MRF_TEXT.percentNote);
            css(note, { fontSize: '12px', fontWeight: '400', color: THEME.slate500 });
            rateCell.appendChild(note);
          }
          td(mrfJoin([r.planName, r.planType]));
          td(mrfJoin([r.negotiationArrangement, r.negotiatedType]));
          var provCell = td(r.providerNpi || r.providerTaxId || '—');
          css(provCell, { fontFamily: THEME.mono, fontSize: '12px' });
          td(r.state || '—');
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        outcome.appendChild(wrap);
      }

      function showOutcome(result) {
        clearOutcome();
        if (result.status === 'ok') {
          if (demo === 'freemium-warning') {
            var warn = el('div', null, mrfFreemiumWarningText());
            warn.setAttribute('data-testid', 'rate-search-freemium-warning');
            css(warn, {
              marginTop: '12px', fontSize: '12px', color: THEME.amber, background: THEME.amberBg,
              border: '1px solid rgba(180, 83, 9, 0.35)', borderRadius: '6px', padding: '8px 10px',
            });
            outcome.appendChild(warn);
          }
          renderResults(result.records);
          return;
        }
        if (result.status === 'no_match') {
          outcome.appendChild(muted(MRF_TEXT.noMatch, 'rate-search-no-match'));
        } else if (result.status === 'not_configured') {
          outcome.appendChild(muted(MRF_TEXT.notConfigured, 'rate-search-not-configured'));
        } else {
          var err = el('p', null, result.message);
          err.setAttribute('role', 'alert');
          err.setAttribute('data-testid', 'rate-search-error');
          css(err, { fontSize: '13px', color: '#dc2626', margin: '12px 0 0' });
          outcome.appendChild(err);
        }
      }

      function runSearch() {
        if (!canSearch() || searching) return;
        var params = {
          billingCodeType: codeType.value,
          billingCode: code.value,
          providerIdentifierType: identType.value,
          providerIdentifier: ident.value,
        };
        searching = true;
        syncButton();
        clearOutcome();
        pendingTimer = setTimeout(function () {
          pendingTimer = null;
          if (closed) return;
          var result;
          if (demo === 'not-configured') result = { status: 'not_configured' };
          else if (demo === 'error') result = { status: 'error', message: MRF_TEXT.errorFallback };
          else if (demo === 'freemium-limit') result = { status: 'error', message: mrfFreemiumLimitText() };
          else {
            var rows = mrfMockSearch(params, p);
            result = rows.length ? { status: 'ok', records: rows } : { status: 'no_match' };
          }
          searching = false;
          syncButton();
          showOutcome(result);
        }, demo === 'searching' ? 1500 : 0);
      }
      searchBtn.addEventListener('click', runSearch);
      syncButton();
    }

    // --- footer (Cancel only — read-only lookup) ---
    var footer = el('div');
    css(footer, {
      flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '10px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: '#ffffff',
      borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
    });
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    css(cancel, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    cancel.addEventListener('click', closeModal);
    footer.appendChild(cancel);

    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    renderBody();
    var firstField = dialog.querySelector('#rate-search-code-type');
    (firstField || cancel).focus();
  }

  // MRF-SIDECAR: the Rate Search launcher CARD on the Clearline tab. Nothing
  // shows before a search (D-105), so the face is FrontRunner's tool-card
  // title + description and a launcher — no rate preview. Step-13 slot-stable
  // re-render; the title matches STATUS_BY_TITLE exactly so
  // wireCardStatusDots() gives it its dot.
  function renderMrfRateSearchCard(p) {
    var grid = document.querySelector('#tab-clearline .card-grid');
    if (!grid) return;
    var existing = $('mrf-rate-search-card');
    // Step 13: position-stable re-render (see renderRealTimeVerificationCard).
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'mrf-rate-search-card';
    card.setAttribute('aria-label', MRF_TEXT.title);
    css(card, { position: 'relative' });

    card.appendChild(el('h2', null, MRF_TEXT.title));
    card.appendChild(el('p', 'card-sub', MRF_TEXT.cardSub));

    // Launcher — same top-right placement/styling as the GFE card's "Manage".
    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Search rates';
    openBtn.setAttribute('aria-label', 'Open Rate Search');
    openBtn.setAttribute('data-testid', 'mrf-open-rate-search');
    css(openBtn, {
      position: 'absolute', top: '10px', right: '12px',
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
      transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
    });
    openBtn.addEventListener('mouseenter', function () {
      openBtn.style.background = THEME.teal; openBtn.style.borderColor = THEME.teal;
    });
    openBtn.addEventListener('mouseleave', function () {
      openBtn.style.background = THEME.navy; openBtn.style.borderColor = THEME.navy;
    });
    openBtn.addEventListener('focus', function () {
      openBtn.style.boxShadow = '0 0 0 3px rgba(40, 71, 118, 0.3)';
    });
    openBtn.addEventListener('blur', function () {
      openBtn.style.boxShadow = 'none';
    });
    openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openMrfRateSearchModal();
    });
    card.appendChild(openBtn);

    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot

    // Re-run the shared dot wiring so THIS card gets its STATUS_BY_TITLE dot
    // (init ran it before the profile existed). Must run BEFORE
    // wireCollapsibleCards mutates the h2.
    wireCardStatusDots();
  }

  // ===========================================================================
  // Claim Validation (Step 24D1 — dataset + card face + claims list)
  // ---------------------------------------------------------------------------
  // Single-patient slice of Clearline's multi-patient Claim Validation worklist:
  // the card loads ONLY the loaded athena patient's claims (no patient column,
  // no cross-patient search, no batch upload — deliberately dropped, consistent
  // with the GFE/Member Eligibility precedent). The patient payload has no
  // claims key, so the dataset is a client-side mock constant here. STRICT
  // Step-16 patient scoping: frozen seed -> mutable working copy -> re-seed in
  // the different-patient branch of onPatientContextChanged. Claims carry
  // per-CPT `lines` (code/description/billed — 24D2 upgrade of D1's bare
  // cptCodes; line billed amounts sum to the claim charge) for the detail
  // view's CPT-vs-MRF section, and each finding carries a `detail` string
  // (24D2) explaining the check. D3's async Re-check will mutate the working
  // copy (renders are idempotent so tiles/rows/key-status follow the data).
  // Payers are the PATIENT'S actual plans (BCBS BlueChoice PPO primary / Aetna
  // Choice POS II secondary) — not the reference screenshot's demo payers.
  // All mock; all styling via css() (CSSOM) so the embed CSP is respected.
  // ===========================================================================
  var CLAIM_VALIDATION_SEED = Object.freeze([
    {
      id: 'AH-CLM-100203', payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO',
      status: 'Held for review', eligibility: 'Eligible', readiness: 'Needs attention',
      findings: [
        { severity: 'blocking', label: '99213 \u2194 90471 (PTP conflict)',
          detail: 'CPT 99213 and 90471 form an NCCI procedure-to-procedure pair; modifier 25 may be required on the E/M.' },
        { severity: 'blocking', label: 'Modifier 25 required on 99213',
          detail: 'An office E/M visit billed with a same-day immunization administration requires modifier 25 on the E/M line to indicate a significant, separately identifiable service.' },
        { severity: 'advisory', label: 'Dx E11.9 \u2014 higher-specificity code available',
          detail: 'E11.9 (Type 2 diabetes without complications) is unspecified; documentation may support a higher-specificity diabetes code.' },
      ],
      risk: { level: 'High', score: 82 }, charge: 385.00,
      serviceDate: '2026-06-03',
      lines: [
        { cpt: '99213', description: 'Office visit, est. patient \u2013 low complexity', billed: 165.00 },
        { cpt: '90471', description: 'Immunization administration, single vaccine', billed: 45.00 },
        { cpt: '90715', description: 'Tdap vaccine, 7 years or older', billed: 175.00 },
      ],
    },
    {
      id: 'AH-CLM-100198', payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO',
      status: 'Ready to submit', eligibility: 'Eligible', readiness: 'Clean',
      findings: [],
      risk: { level: 'Low', score: 12 }, charge: 155.00,
      serviceDate: '2026-05-21',
      lines: [
        { cpt: '99214', description: 'Office visit, est. patient \u2013 mod. complexity', billed: 155.00 },
      ],
    },
    {
      id: 'AH-CLM-100187', payer: 'Blue Cross Blue Shield of Texas', plan: 'BlueChoice PPO',
      status: 'Ready to submit', eligibility: 'Eligible', readiness: 'Clean',
      findings: [
        { severity: 'info', label: 'Lab panel frequency window verified',
          detail: 'Plan limits this panel to one per 90 days; the prior CBC on file falls outside the window for this service date.' },
      ],
      risk: { level: 'Low', score: 8 }, charge: 22.00,
      serviceDate: '2026-05-21',
      lines: [
        { cpt: '85025', description: 'Complete CBC with differential', billed: 22.00 },
      ],
    },
    {
      id: 'AH-CLM-100164', payer: 'Aetna', plan: 'Aetna Choice POS II',
      status: 'Held for review', eligibility: 'No check', readiness: 'Check error',
      findings: [
        { severity: 'advisory', label: 'Secondary COB order unconfirmed',
          detail: 'Aetna is on file as the secondary plan; the coordination-of-benefits order has not been confirmed with the payer for this plan year.' },
        { severity: 'advisory', label: 'POS 02 vs modifier 95 telehealth mismatch',
          detail: 'The line is coded POS 02 (telehealth) but modifier 95 is missing; this payer requires both on synchronous telehealth psychotherapy.' },
      ],
      risk: { level: 'Medium', score: 54 }, charge: 87.00,
      serviceDate: '2026-04-17',
      lines: [
        { cpt: '90834', description: 'Psychotherapy, 45 minutes', billed: 87.00 },
      ],
    },
    {
      id: 'AH-CLM-100142', payer: 'Aetna', plan: 'Aetna Choice POS II',
      status: 'Reviewed & overridden', eligibility: 'Eligible', readiness: 'Clean',
      findings: [
        { severity: 'info', label: 'Preventive frequency override documented',
          detail: 'Payer frequency edit overridden per documented approval; the annual preventive visit is allowed after the plan-year rollover.' },
      ],
      risk: { level: 'Low', score: 15 }, charge: 168.00,
      serviceDate: '2026-03-30',
      lines: [
        { cpt: '99396', description: 'Preventive visit, est. patient 40\u201364', billed: 168.00 },
      ],
    },
  ]);

  function claimsFromSeed() {
    // Deep copy — findings/risk are nested and D3 will mutate the working rows.
    return JSON.parse(JSON.stringify(CLAIM_VALIDATION_SEED));
  }
  var CLAIMS = claimsFromSeed();

  // Single source of truth for every derived surface (tiles, dot tip, collapsed
  // key-status). "Needs attention" counts non-clean readiness (Needs attention /
  // Check error); pass rate = share of claims with NO blocking findings.
  function claimStats() {
    var total = CLAIMS.length;
    var ready = 0, held = 0, needsAttention = 0, passing = 0;
    CLAIMS.forEach(function (c) {
      if (c.status === 'Ready to submit') ready += 1;
      if (c.status === 'Held for review') held += 1;
      if (c.readiness === 'Needs attention' || c.readiness === 'Check error') needsAttention += 1;
      var blocked = (c.findings || []).some(function (f) { return f.severity === 'blocking'; });
      if (!blocked) passing += 1;
    });
    return {
      total: total, ready: ready, held: held, needsAttention: needsAttention,
      passRate: total ? Math.round((passing / total) * 100) : 0,
    };
  }

  // Shared one-liner for the collapsed key-status AND the status-dot tip, so
  // they can never disagree.
  function claimsSummaryLine() {
    var s = claimStats();
    if (!s.total) return 'No claims on file';
    if (s.held) return s.total + ' claims \u00B7 ' + s.held + ' held for review';
    if (s.needsAttention) {
      return s.total + ' claims \u00B7 ' + s.needsAttention +
        (s.needsAttention === 1 ? ' needs attention' : ' need attention');
    }
    return 'All ' + s.total + ' claims ready';
  }

  // Status-dot entry (color + tip) — data-driven, computed at wire time so a
  // re-rendered card always reflects the CURRENT working claims.
  function claimsDotStatus(green, amber) {
    var s = claimStats();
    return {
      color: (s.held || s.needsAttention) ? amber : green,
      tip: claimsSummaryLine(),
    };
  }

  var CLAIM_RISK_COLORS = { High: '#dc2626', Medium: '#d97706', Low: '#16a34a' };

  // 24D2: severity ordering + tones shared by the card's summary chips AND the
  // detail modal's finding rows (single source — blocking red, advisory amber,
  // info the soft blue of the "overridden" badge family).
  var CLAIM_FINDING_ORDER = { blocking: 0, advisory: 1, info: 2 };
  var CLAIM_FINDING_TONES = {
    blocking: { bg: 'hsl(0 86% 96%)', fg: '#b91c1c', border: 'hsl(0 84% 88%)' },
    advisory: { bg: 'hsl(48 96% 89%)', fg: 'hsl(26 90% 37%)', border: 'hsl(48 97% 77%)' },
    info: { bg: 'hsl(214 95% 96%)', fg: 'hsl(226 71% 40%)', border: 'hsl(213 97% 87%)' },
  };

  // MRF rate row for a claim CPT — the claim's OWN payer+plan only (the honest
  // contract lookup; no cross-plan fallback). Null = no contracted rate on file.
  function claimMrfRate(claim, cpt) {
    for (var i = 0; i < MRF_RATES.length; i++) {
      var r = MRF_RATES[i];
      if (r.cpt === cpt && r.payer === claim.payer && r.plan === claim.plan) return r;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 24D3: the Re-check rule — deterministic, realistic, idempotent. Re-validation
  // CLEARS advisory/info findings; BLOCKING findings PERSIST (coding errors need
  // real correction in the billing system, which the embed can't perform — same
  // honesty principle as eligibility staying failed until discovery). Status /
  // readiness / risk follow the result:
  //   - no blocking left → promote to Ready to submit / Clean / risk Low with
  //     score = max(10, round(score/2)) — halved ONLY on the promoting run
  //     (already-Ready claims skip the risk change, so repeats don't drift);
  //   - blockers remain → stays Held for review / Needs attention; risk level
  //     unchanged, score reduced by 10 (floor 40) ONLY on a run that actually
  //     cleared advisories (repeat re-checks clear nothing → no further drift).
  // 'Reviewed & overridden' is treated like any other claim (its info finding
  // clears and it promotes to Ready) — no special case; the override note lives
  // in the finding, which a fresh re-validation legitimately re-resolves.
  // Always stamps lastChecked (date-only, rtvToday() — the app's per-check
  // stamp philosophy). Mutates the WORKING COPY row in place; callers re-render.
  function recheckClaim(claim) {
    var before = (claim.findings || []).length;
    claim.findings = (claim.findings || []).filter(function (f) {
      return f.severity === 'blocking';
    });
    var clearedAny = claim.findings.length !== before;
    if (claim.findings.length) {
      claim.status = 'Held for review';
      claim.readiness = 'Needs attention';
      if (clearedAny) claim.risk.score = Math.max(40, claim.risk.score - 10);
    } else if (claim.status !== 'Ready to submit') {
      claim.status = 'Ready to submit';
      claim.readiness = 'Clean';
      claim.risk = { level: 'Low', score: Math.max(10, Math.round(claim.risk.score / 2)) };
    }
    claim.lastChecked = rtvToday();
  }

  // ---------------------------------------------------------------------------
  // 24D2: claim DETAIL modal — direct-to-detail (single view per row; the card
  // face already IS the list, so no stepped list view inside the modal). Shared
  // 600px shell (navy header with patient name·MRN, Cancel footer, Esc/overlay
  // close); renders straight from the working-copy claim object so mutations
  // reflect automatically on re-open. Sections: claim header kv-grid (incl.
  // Last checked stamp once a re-check has run) → findings (blocking→advisory→
  // info, toned, with detail lines) → CPT lines vs MRF rates (honest "no
  // contracted rate" marker; subtle variance note when billed exceeds contract)
  // → footnote describing the Re-check rule. 24D3: the ONLY claim mutation is
  // the footer's Re-check action (no resolve/override actions — per-claim only,
  // no re-check-all; no per-row affordance, the row click already lands here).
  // ---------------------------------------------------------------------------
  function openClaimDetailModal(claim) {
    if (!currentPatient) return;
    var p = currentPatient;
    var prevFocus = document.activeElement;

    var overlay = el('div');
    css(overlay, {
      position: 'fixed', inset: '0', background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', zIndex: '1000', overflowY: 'auto',
    });
    var dialog = el('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Claim ' + claim.id);
    css(dialog, {
      background: '#ffffff', borderRadius: '12px', width: '100%', maxWidth: '600px',
      maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      boxShadow: '0 20px 45px rgba(0,0,0,0.28)', color: THEME.slate900, fontFamily: 'inherit',
    });

    function closeModal() {
      deregisterCloser(); // 27B: idempotent — no-op when the registry already cleared it
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape' && document.body.lastElementChild === overlay) closeModal();
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKey);
    // 27B: a patient switch force-closes this modal through the shared
    // registry (retires the 24D3 note: a stale claim detail can no longer
    // survive a context switch; the Re-check timer's runPatientId bail-out
    // still guards the 1s relabel window).
    var deregisterCloser = registerModalCloser(closeModal);

    // --- header (shared shell: navy gradient, title + patient name·MRN) ---
    var head = el('div');
    css(head, {
      flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '16px 20px', color: '#ffffff',
      borderTopLeftRadius: '12px', borderTopRightRadius: '12px',
      backgroundImage: THEME.navyGradient,
    });
    var headText = el('div');
    var hTitle = el('div', null, 'Claim ' + claim.id); css(hTitle, { fontSize: '16px', fontWeight: '700' });
    var hSub = el('div', null, identitySubLine(p));
    css(hSub, { fontSize: '12px', color: 'rgba(255,255,255,0.78)', marginTop: '2px' });
    headText.appendChild(hTitle); headText.appendChild(hSub);
    head.appendChild(headText);

    // --- body ---
    var body = el('div');
    css(body, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '20px', background: '#ffffff' });

    function sectionHeading(text) {
      var h = el('div', null, text);
      css(h, {
        fontSize: '12px', fontWeight: '700', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px',
      });
      return h;
    }

    // 24D3: the whole body renders from the working-copy claim via ONE function
    // so Re-check can re-render the modal in place after the mutation.
    function renderDetail() {
    while (body.firstChild) body.removeChild(body.firstChild);

    // --- 1. Claim header: id + status + charge, then the kv-grid ---
    var idLine = el('div');
    css(idLine, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
    var idEl = el('span', null, claim.id);
    css(idEl, { fontFamily: THEME.mono, fontWeight: '700', fontSize: '15px', color: THEME.slate900 });
    var tone = CV_STATUS_TONES[claim.status] || CV_STATUS_TONES['Held for review'];
    var badge = el('span', tone.icon || null, claim.status);
    css(badge, {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      background: tone.bg, color: tone.fg, border: '1px solid ' + tone.border,
      borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: '600',
      whiteSpace: 'normal',
    });
    var charge = el('span', null, fmtMrfMoney(claim.charge));
    css(charge, { fontWeight: '700', fontSize: '15px', color: THEME.slate900, marginLeft: 'auto' });
    idLine.appendChild(idEl); idLine.appendChild(badge); idLine.appendChild(charge);
    body.appendChild(idLine);

    var kv = el('div');
    css(kv, {
      display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 14px',
      marginTop: '12px', fontSize: '13px',
    });
    function kvRow(label, valueNode) {
      var l = el('div', null, label);
      css(l, { color: THEME.slate500, fontWeight: '600', fontSize: '12px' });
      kv.appendChild(l); kv.appendChild(valueNode);
    }
    function kvText(label, text) {
      var v = el('div', null, text);
      css(v, { color: THEME.slate900 });
      kvRow(label, v);
    }
    kvText('Payer \u00B7 Plan', claim.payer + ' \u2014 ' + claim.plan);
    kvText('Service date', claim.serviceDate);
    kvText('Eligibility', claim.eligibility);
    // 24D3: per-check stamp (only after a re-check has run — the seed has none).
    if (claim.lastChecked) kvText('Last checked', claim.lastChecked);
    var rdyVal = el('div', null, claim.readiness);
    css(rdyVal, {
      color: (claim.readiness === 'Clean') ? '#16a34a'
        : (claim.readiness === 'Not run' ? THEME.slate500 : '#d97706'),
      fontWeight: (claim.readiness === 'Clean' || claim.readiness === 'Not run') ? '400' : '600',
    });
    kvRow('Readiness', rdyVal);
    var riskVal = el('div', null, claim.risk.level + ' (' + claim.risk.score + ')');
    css(riskVal, { color: CLAIM_RISK_COLORS[claim.risk.level] || THEME.slate500, fontWeight: '600' });
    kvRow('Risk', riskVal);
    body.appendChild(kv);

    // --- 2. Findings (blocking → advisory → info, toned, with detail lines) ---
    var findWrap = el('div');
    css(findWrap, { marginTop: '20px' });
    findWrap.appendChild(sectionHeading('Findings'));
    var findList = el('div');
    css(findList, { display: 'flex', flexDirection: 'column', gap: '8px' });
    var ordered = (claim.findings || []).slice().sort(function (a, b) {
      return (CLAIM_FINDING_ORDER[a.severity] || 0) - (CLAIM_FINDING_ORDER[b.severity] || 0);
    });
    if (!ordered.length) {
      var clean = el('div');
      var cleanTone = CV_STATUS_TONES['Ready to submit'];
      css(clean, {
        background: cleanTone.bg, border: '1px solid ' + cleanTone.border,
        borderRadius: '8px', padding: '12px 14px', fontSize: '13px',
        color: cleanTone.fg, fontWeight: '600',
      });
      clean.textContent = 'No findings \u2014 claim passed all checks';
      findList.appendChild(clean);
    }
    ordered.forEach(function (f) {
      var ft = CLAIM_FINDING_TONES[f.severity] || CLAIM_FINDING_TONES.info;
      var box = el('div');
      css(box, {
        background: ft.bg, border: '1px solid ' + ft.border,
        borderRadius: '8px', padding: '10px 12px',
      });
      var topLine = el('div');
      css(topLine, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
      var sev = el('span', null, f.severity);
      css(sev, {
        color: ft.fg, fontSize: '12px', fontWeight: '700',
        textTransform: 'uppercase', letterSpacing: '0.05em', flex: '0 0 auto',
      });
      var lab = el('span', null, f.label);
      css(lab, { fontSize: '13px', fontWeight: '600', color: THEME.slate900 });
      topLine.appendChild(sev); topLine.appendChild(lab);
      box.appendChild(topLine);
      if (f.detail) {
        var det = el('div', null, f.detail);
        css(det, { fontSize: '12px', color: THEME.slate500, marginTop: '4px', lineHeight: '1.45' });
        box.appendChild(det);
      }
      findList.appendChild(box);
    });
    findWrap.appendChild(findList);
    body.appendChild(findWrap);

    // --- 3. CPT lines vs MRF rates (the contracted-rate signals) ---
    var cptWrap = el('div');
    css(cptWrap, { marginTop: '20px' });
    cptWrap.appendChild(sectionHeading('CPT lines vs MRF rates'));
    var cptList = el('div');
    css(cptList, { display: 'flex', flexDirection: 'column', gap: '6px' });
    (claim.lines || []).forEach(function (ln) {
      var lnRow = el('div');
      css(lnRow, {
        display: 'flex', flexDirection: 'column', gap: '3px',
        border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
        padding: '8px 12px', background: '#fff',
      });
      var lnTop = el('div');
      css(lnTop, { display: 'flex', alignItems: 'baseline', gap: '10px' });
      var code = el('span', null, ln.cpt);
      css(code, { fontFamily: THEME.mono, fontWeight: '700', fontSize: '13px', color: THEME.slate900, flex: '0 0 auto' });
      var desc = el('span', null, ln.description);
      css(desc, {
        fontSize: '13px', color: THEME.slate500, flex: '1 1 auto', minWidth: '0',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      var billed = el('span', null, fmtMrfMoney(ln.billed));
      css(billed, { fontWeight: '700', fontSize: '13px', color: THEME.slate900, flex: '0 0 auto' });
      lnTop.appendChild(code); lnTop.appendChild(desc); lnTop.appendChild(billed);
      lnRow.appendChild(lnTop);

      var rate = claimMrfRate(claim, ln.cpt);
      var lnSub = el('div');
      css(lnSub, { display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '12px', flexWrap: 'wrap' });
      if (rate) {
        var contracted = el('span', null, 'Contracted: ' + fmtMrfMoney(rate.negotiatedRate));
        css(contracted, { color: THEME.slate500 });
        lnSub.appendChild(contracted);
        var diff = ln.billed - rate.negotiatedRate;
        if (diff >= 1) {
          var varn = el('span', null, '+' + fmtMrfMoney(diff) + ' over contract');
          css(varn, { color: '#d97706', fontWeight: '600' });
          lnSub.appendChild(varn);
        }
      } else {
        // Honest rate signal: this CPT has no MRF row for the claim's plan.
        var none = el('span', null, 'No contracted rate on file for ' + claim.plan);
        css(none, { color: THEME.slate500, fontStyle: 'italic' });
        lnSub.appendChild(none);
      }
      lnRow.appendChild(lnSub);
      cptList.appendChild(lnRow);
    });
    cptWrap.appendChild(cptList);
    body.appendChild(cptWrap);

    // --- 4. Footer note — honest description of what Re-check actually does ---
    var note = el('div', null,
      'Findings reflect ACE coding checks and MRF rate signals for this claim. ' +
      'Re-check re-validates the claim: advisory and informational findings clear, ' +
      'but blocking findings persist until corrected in the billing system.');
    css(note, { marginTop: '20px', fontSize: '12px', color: THEME.slate500, fontStyle: 'italic', lineHeight: '1.5' });
    body.appendChild(note);
    } // end renderDetail
    renderDetail();

    // --- footer (Re-check primary + Cancel) ---
    var footer = el('div');
    css(footer, {
      flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '10px',
      padding: '14px 20px', borderTop: '1px solid ' + THEME.border, background: '#ffffff',
      borderBottomLeftRadius: '12px', borderBottomRightRadius: '12px',
    });
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    css(cancel, {
      background: '#fff', color: THEME.navy, border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    cancel.addEventListener('click', closeModal);
    footer.appendChild(cancel);

    // 24D3: the Re-check action — the app's established async pattern (disable +
    // relabel ~1s), strict Step-16 patient scoping (runPatientId captured at
    // click; if the athena context switched patients mid-run, ABORT without
    // mutating — the D1 re-seed already reset the working copy). On completion:
    // mutate via recheckClaim, re-render the modal in place, then re-render the
    // card + refresh collapse key-status/dot (all recompute from claimStats()/
    // claimsSummaryLine() — the single sources).
    var recheck = el('button', null, 'Re-check'); recheck.type = 'button';
    css(recheck, {
      background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
      borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', fontFamily: 'inherit',
    });
    recheck.addEventListener('click', function () {
      if (recheck.disabled) return;
      var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
      var original = recheck.textContent;
      recheck.disabled = true;
      recheck.classList.add('is-pending');
      recheck.textContent = 'Re-checking\u2026';
      setTimeout(function () {
        recheck.disabled = false;
        recheck.classList.remove('is-pending');
        recheck.textContent = original;
        if (currentAthenaContext && currentAthenaContext.patientId !== runPatientId) return;
        recheckClaim(claim);
        renderDetail();
        if (currentPatient) renderClaimValidationCard(currentPatient);
        wireCollapsibleCards(); // refresh collapsed key-status (idempotent)
      }, 1000);
    });
    footer.appendChild(recheck);

    dialog.appendChild(head); dialog.appendChild(body); dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    cancel.focus();
  }

  function renderClaimValidationCard(p) {
    var grid = document.querySelector('#tab-clearline .card-grid');
    if (!grid) return;
    var existing = $('claim-validation-card');
    // Step 13: position-stable re-render (see renderRealTimeVerificationCard).
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var card = el('section', 'card');
    card.id = 'claim-validation-card';
    card.setAttribute('aria-label', 'Claim Validation');
    css(card, { position: 'relative' });

    card.appendChild(el('h2', null, 'Claim Validation'));
    card.appendChild(el('p', 'card-sub',
      'Pre-submission claim integrity review \u2014 ACE coding checks + MRF rate signals'));

    // Status tiles — the reference's tile strip, patient-scoped. Tile set chosen
    // for a single patient's few claims: Total / Ready / Held / Needs attention /
    // Pass rate ("Skipped 0" adds nothing at this scale). All derived.
    var s = claimStats();
    var tiles = el('div');
    css(tiles, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' });
    [
      ['Total', String(s.total)],
      ['Ready', String(s.ready)],
      ['Held', String(s.held)],
      ['Needs attention', String(s.needsAttention)],
      ['Pass rate', s.passRate + '%'],
    ].forEach(function (t) {
      var tile = el('div');
      css(tile, {
        border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
        padding: '6px 12px', background: '#fff', flex: '1 1 auto',
        minWidth: '86px', textAlign: 'center',
      });
      var val = el('div', null, t[1]);
      css(val, { fontSize: '16px', fontWeight: '700', color: THEME.slate900 });
      var lab = el('div', null, t[0]);
      css(lab, {
        fontSize: '12px', fontWeight: '600', color: THEME.slate500,
        textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '2px',
      });
      tile.appendChild(val); tile.appendChild(lab);
      tiles.appendChild(tile);
    });
    card.appendChild(tiles);

    // Claims list — 23B-style compact rows (NOT a wide table). 24D2: rows are
    // now navigable — GFE-list-row affordance (button, hover border/shadow,
    // trailing chevron) opening the read-only claim-detail modal.
    var list = el('div');
    css(list, { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' });
    if (!CLAIMS.length) {
      var empty = el('div', null, 'No claims on file for this patient.');
      css(empty, { fontSize: '13px', color: THEME.slate500 });
      list.appendChild(empty);
    }
    CLAIMS.forEach(function (c) {
      var row = el('button');
      row.type = 'button';
      row.setAttribute('data-claim-id', c.id);
      row.setAttribute('aria-label', 'Open claim ' + c.id);
      css(row, {
        display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
        textAlign: 'left', border: '1px solid ' + THEME.borderSoft, borderRadius: '8px',
        padding: '10px 12px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      });
      row.addEventListener('mouseenter', function () {
        row.style.borderColor = THEME.teal; row.style.boxShadow = '0 1px 6px rgba(15,23,42,0.08)';
      });
      row.addEventListener('mouseleave', function () {
        row.style.borderColor = THEME.borderSoft; row.style.boxShadow = 'none';
      });
      row.addEventListener('click', function () { openClaimDetailModal(c); });

      // Info column (flex 1) — the D1 content lines live here; chevron trails.
      var info = el('div');
      css(info, { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1', minWidth: '0' });

      // Top line: claim ID + status badge + charge (right-aligned).
      var top = el('div');
      css(top, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
      var id = el('span', null, c.id);
      css(id, { fontFamily: THEME.mono, fontWeight: '700', fontSize: '13px', color: THEME.slate900 });
      var tone = CV_STATUS_TONES[c.status] || CV_STATUS_TONES['Held for review'];
      var badge = el('span', tone.icon || null, c.status);
      css(badge, {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        background: tone.bg, color: tone.fg, border: '1px solid ' + tone.border,
        borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: '600',
        whiteSpace: 'normal',
      });
      var charge = el('span', null, fmtMrfMoney(c.charge));
      css(charge, { fontWeight: '700', fontSize: '13px', color: THEME.slate900, marginLeft: 'auto' });
      top.appendChild(id); top.appendChild(badge); top.appendChild(charge);
      info.appendChild(top);

      // Sub line 1: payer · plan · service date.
      var meta1 = el('div', null,
        c.payer + ' \u2014 ' + c.plan + ' \u00B7 DOS ' + c.serviceDate);
      css(meta1, { fontSize: '12px', color: THEME.slate500 });
      info.appendChild(meta1);

      // Sub line 2: eligibility · readiness · risk (level + score).
      var meta2 = el('div');
      css(meta2, { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: '12px' });
      var elig = el('span', null, 'Eligibility: ' + c.eligibility);
      css(elig, { color: THEME.slate500 });
      var rdy = el('span', null, 'Readiness: ' + c.readiness);
      css(rdy, {
        color: (c.readiness === 'Clean') ? '#16a34a' : (c.readiness === 'Not run' ? THEME.slate500 : '#d97706'),
        fontWeight: (c.readiness === 'Clean' || c.readiness === 'Not run') ? '400' : '600',
      });
      var risk = el('span', null, 'Risk: ' + c.risk.level + ' (' + c.risk.score + ')');
      css(risk, { color: CLAIM_RISK_COLORS[c.risk.level] || THEME.slate500, fontWeight: '600' });
      meta2.appendChild(elig); meta2.appendChild(rdy); meta2.appendChild(risk);
      info.appendChild(meta2);

      // Findings summary — compact severity-count chips, or an honest "No
      // findings". 24D2: tones come from the shared CLAIM_FINDING_TONES (same
      // palette as the detail modal's finding rows — single source).
      var counts = { blocking: 0, advisory: 0, info: 0 };
      (c.findings || []).forEach(function (f) { if (counts[f.severity] != null) counts[f.severity] += 1; });
      var fWrap = el('div');
      css(fWrap, { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' });
      var any = false;
      ['blocking', 'advisory', 'info'].forEach(function (sev) {
        if (!counts[sev]) return;
        any = true;
        var ct = CLAIM_FINDING_TONES[sev];
        var chip = el('span', null, counts[sev] + ' ' + sev);
        css(chip, {
          background: ct.bg, color: ct.fg, border: '1px solid ' + ct.border,
          borderRadius: '999px', padding: '1px 8px', fontSize: '12px', fontWeight: '600',
        });
        fWrap.appendChild(chip);
      });
      if (!any) {
        var none = el('span', null, 'No findings');
        css(none, { fontSize: '12px', color: THEME.slate500 });
        fWrap.appendChild(none);
      }
      info.appendChild(fWrap);

      // Trailing chevron — the GFE-list navigation affordance.
      var chev = el('span', null, '\u203A');
      css(chev, { fontSize: '20px', color: THEME.slate500, lineHeight: '1', flex: '0 0 auto', alignSelf: 'center' });

      row.appendChild(info); row.appendChild(chev);
      list.appendChild(row);
    });
    card.appendChild(list);

    grid.insertBefore(card, mountBefore); // Step 13: back into the same slot

    // Same 24C timing rule: dot wiring must run BEFORE wireCollapsibleCards
    // mutates the h2 (title lookup keys on its textContent). Idempotent.
    wireCardStatusDots();
  }

  // Maps each profile card (keyed by its heading) to its "Review" launcher.
  // Each card opens a streamlined Post Data modal scoped to that section;
  // Insurance omits the Demographic tab.
  // R-25 (B1): brief pending treatment for the SYNCHRONOUS header-action runs
  // ("Demographic Verification", "Check Eligibility"). Mirrors the disable+relabel
  // pattern runInsuranceDiscovery already uses: disable the clicked button, relabel
  // it, run the shared check after a short beat, then restore. This adds NO new run
  // logic — runFn just invokes the shared runEligibilityCheck path. ("Run Discovery"
  // keeps its own pending phase inside runInsuranceDiscovery.)
  function runHeaderActionCheck(btn, pendingLabel, runFn) {
    if (!btn || btn.disabled) { runFn(); return; }
    var original = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-pending');
    btn.textContent = pendingLabel;
    // Scope the deferred run to the patient it was started for — mirrors the
    // patient-switch abort in runInsuranceDiscovery. If the athena context
    // switches patients during the brief pending window, drop the run so a stale
    // timeout can't stamp/verify the NEW patient. Restore the button either way.
    var runPatientId = currentAthenaContext && currentAthenaContext.patientId;
    setTimeout(function () {
      var aborted = !!(currentAthenaContext && currentAthenaContext.patientId !== runPatientId);
      if (!aborted) runFn();
      btn.disabled = false;
      btn.classList.remove('is-pending');
      btn.textContent = original;
    }, 700);
  }

  var CARD_WORKFLOWS = {
    Demographics: function () {
      openScopedPostModal(function (p) {
        return {
          title: 'Demographic Data',
          sub: identitySubLine(p),
          // Part 5.6 (B1) + R-25: muted last-verified line, scoped to THIS
          // (Demographics) modal only. A FUNCTION so the live refresher re-reads the
          // shared store after a run — the stamp updates in place, not only on open.
          headerNote: function () {
            return 'Demographics last verified ' + checkStamp('demographics');
          },
          comparisonTabs: [{
            key: 'demographic',
            label: 'Demographic',
            defs: buildDemographicOnlyDefs(p).concat(buildContactDefs(p)),
          }],
          initialTab: 'demographic',
          // 26D (reworks the 10C-fix): the footer Submit now runs the SHARED
          // async three-phase posting flow; the demographics re-verify stamp
          // chains at COMPLETION (fired on Done/close alongside the Step-13
          // notify) via the SAME complete operation the header shortcut uses.
          // Scoped per-instance HERE so the other modals that share
          // openScopedPostModal/buildPostModalImpl are NOT affected.
          onPostComplete: function () {
            markDemographicsReverified();
          },
          headerActions: [
            {
              // R-18 resolve action: confirms demographics are current, stamping
              // today's date and clearing the amber re-verify chip on the strip.
              label: 'Confirm Demographics Current',
              message: 'Demographics confirmed current \u2014 re-verify recommendation cleared.',
              onClick: function () {
                markDemographicsReverified();
              },
            },
            {
              // Part 1 (R-25): real (mock) run — funnels through the shared
              // runEligibilityCheck path scoped to demographics only, which flips
              // the demographics status, stamps RTV_LAST_RUN.demographics, prepends
              // the History row, re-renders the RTV card + readiness panel, refreshes
              // this modal's stamp line, and fires the Step-13 FrontRunner re-pull.
              // Future live-call site for FrontRunner's demographic verification API.
              label: 'Demographic Verification',
              message: 'Demographic verification in progress. FrontRunner data will refresh once complete.',
              onClick: function (ctx, btn) {
                runHeaderActionCheck(btn, 'Verifying\u2026', function () {
                  runEligibilityCheck({ label: 'Demographics', services: ['demographics'] });
                });
              },
            },
          ],
        };
      });
    },
    Insurance: function () {
      openScopedPostModal(function (p) {
        var primaryDefs = buildInsuranceDefs(p, 'primary');
        var secondaryDefs = buildInsuranceDefs(p, 'secondary');
        return {
          title: 'Insurance Data',
          sub: identitySubLine(p),
          comparisonTabs: [
            { key: 'primary', label: 'Primary Insurance', defs: primaryDefs, payer: (p.insurance && p.insurance.primary && p.insurance.primary.payer) || null },
            { key: 'secondary', label: 'Secondary Insurance', defs: secondaryDefs, payer: (p.insurance && p.insurance.secondary && p.insurance.secondary.payer) || null },
            // 26B: restored (pre-26A shape) — insurance review + applying the
            // updates to appointments, one scoped surface (shared 25D engine).
            buildAppointmentsPostTabDef(),
          ],
          initialTab: 'primary',
          removableInsurance: true,
          // Per-tab posting (Craig, 2026-08-19): each rank posts from its own
          // tab — each is its own athena PUT anyway, and the modal-wide Submit
          // silently posted BOTH ranks' default-armed deltas when the user was
          // only looking at one. The footer keeps a single Close.
          perTabPosting: true,
          // A-C2 (meeting notes 2026-07-28 §2.2): the Insurance modal is the one
          // surface that can add a policy, so the Add affordance is scoped here
          // and NOT to the full Post Data modal — which is a review-and-post
          // surface over what already exists.
          addableInsurance: true,
          // R-25: muted last-verified line for the Insurance modal, matching the
          // Demographics modal's treatment (same fmtRunDate helper, muted style). A
          // FUNCTION so the live refresher re-reads the shared store after a run.
          headerNote: function () {
            return 'Eligibility last verified ' + checkStamp('eligibility') +
              ' \u00B7 Insurance Discovery last verified ' + checkStamp('discovery');
          },
          headerActions: [
            {
              // Part 2 (R-25): real (mock) run — shared runEligibilityCheck scoped to
              // eligibility only. The Step-14/16 guard still applies (fails while
              // insuranceDiscovered is false; passes after discovery), and a Step-20
              // eligibility run flips the Insurance card accumulators to verified.
              label: 'Check Eligibility',
              message: 'Eligibility check in progress. FrontRunner insurance data will refresh once complete.',
              onClick: function (ctx, btn) {
                runHeaderActionCheck(btn, 'Checking\u2026', function () {
                  runEligibilityCheck({ label: 'Eligibility', services: ['eligibility'] });
                });
              },
            },
            {
              // Part 2 (R-25): real (mock) run — the shared runInsuranceDiscovery.
              // Passing the clicked button gives it the same pending label
              // ("Running discovery…"), re-entry guard, and patient-switch abort
              // it already uses on the readiness panel. Its completion applies
              // the included eligibility data too (A-C1 — no chained re-run).
              label: 'Run Discovery',
              message: 'Discovery in progress. FrontRunner insurance data will refresh once complete.',
              onClick: function (ctx, btn) {
                runInsuranceDiscovery(btn);
              },
            },
          ],
          // STEP 31: the "Insurance Order (COB)" swap control that sat above the
          // tabs (bodyTop) was removed — see the product decision of record near
          // buildPostModalImpl and CHANGE-JOURNAL.md.
        };
      });
    },
    // 27A: the Balance workflow (scoped "Balance Data" modal + its inert
    // Financial Clearance placeholder headerAction) was REMOVED — dead since
    // the Balance card was superseded by Good Faith Estimates (no h2 matches
    // this key, so wireCards never wired it).
  };

  function wireCards() {
    document.querySelectorAll('.card-grid .card').forEach(function (card) {
      var heading = card.querySelector('h2');
      var key = heading ? heading.textContent.trim() : '';
      var action = CARD_WORKFLOWS[key];
      if (!action) return;

      css(card, { position: 'relative' });

      // Clearly labeled "Review" button replaces the prior chevron affordance.
      // Styled to match the modal's primary action button (navy fill, white
      // text) so it reads consistently with the app's other action buttons.
      var review = document.createElement('button');
      review.type = 'button';
      review.textContent = 'Review';
      review.setAttribute('aria-label', 'Review ' + key + ' \u2014 open Post Data');
      css(review, {
        position: 'absolute', top: '10px', right: '12px',
        background: THEME.navy, color: '#fff', border: '1px solid ' + THEME.navy,
        borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit', lineHeight: '1.2',
        transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      });
      review.addEventListener('mouseenter', function () {
        review.style.background = THEME.teal;
        review.style.borderColor = THEME.teal;
      });
      review.addEventListener('mouseleave', function () {
        review.style.background = THEME.navy;
        review.style.borderColor = THEME.navy;
      });
      review.addEventListener('focus', function () {
        review.style.boxShadow = '0 0 0 3px rgba(40, 71, 118, 0.3)';
      });
      review.addEventListener('blur', function () {
        review.style.boxShadow = 'none';
      });
      review.addEventListener('click', function (e) {
        e.stopPropagation();
        action();
      });
      card.appendChild(review);
    });
  }

  // Subtle at-a-glance status dot prepended to the Demographics / Insurance
  // card titles (and the data-driven entries below). Green = no action needed,
  // amber = attention recommended.
  // Hovering the dot reveals a one-line tooltip. Derived from the existing mock
  // data and styled entirely via css() (CSSOM) so the embed CSP is respected.
  function wireCardStatusDots() {
    var GREEN = '#16a34a';
    var AMBER = '#f59e0b';
    // Keyed by card <h2> title text (the Demographics card has no id), so the
    // lookup works regardless of the section's id attribute.
    var STATUS_BY_TITLE = {
      Demographics: { color: GREEN, tip: 'Patient data verified' },
      Insurance: { color: GREEN, tip: 'Eligibility active and verified' },
      // 27A: the stale Balance entry (no matching card since the Balance card
      // was superseded by Good Faith Estimates) was removed with the rest of
      // the dead Balance path.
      // 24D1: the stale 'Claims & Billing' entry (hardcoded "1 claim needs
      // attention", no matching card since the 24A cull) is REPLACED by a
      // data-driven Claim Validation entry — computed from the working claims
      // at wire time, so a re-rendered card always gets a current dot + tip.
      'Claim Validation': claimsDotStatus(GREEN, AMBER),
      // MRF-SIDECAR: nothing is loaded before a search (D-105), so the tip
      // describes the lookup rather than claiming rates are on file.
      'Rate Search': { color: GREEN, tip: 'MRF negotiated-rate lookup by code + provider' },
      // 25B: amber while on the stale-possible nightly dataview, green once
      // refreshed live; tip = the freshness stamp (shared with the card face).
      Appointments: appointmentsDotStatus(GREEN, AMBER),
    };

    document.querySelectorAll('.card-grid .card').forEach(function (card) {
      var h2 = card.querySelector('h2');
      if (!h2 || h2.querySelector('.status-dot-wrap')) return;
      var s = STATUS_BY_TITLE[h2.textContent.trim()];
      if (!s) return;

      // Anchor wrapper so the tooltip positions relative to the dot itself.
      var wrap = el('span');
      wrap.className = 'status-dot-wrap';
      css(wrap, {
        position: 'relative', display: 'inline-flex', alignItems: 'center',
        flex: '0 0 auto',
      });

      var dot = el('span');
      css(dot, {
        width: '8px', height: '8px', borderRadius: '50%',
        background: s.color, display: 'inline-block', flex: '0 0 auto',
        cursor: 'default',
      });
      dot.setAttribute('aria-hidden', 'true');

      // Tooltip — reset the inherited uppercase/letter-spacing from .card h2 so
      // the explanation reads as normal sentence text.
      var tip = el('span', null, s.tip);
      css(tip, {
        position: 'absolute', top: 'calc(100% + 8px)', left: '0',
        background: THEME.slate900, color: '#ffffff', padding: '5px 9px',
        borderRadius: '6px', fontSize: '12px', fontWeight: '500',
        // Wraps within the panel: on the banner header the dot sits further
        // right, and a one-line tip overflowed a 340px panel.
        lineHeight: '1.3', whiteSpace: 'normal', width: 'max-content',
        maxWidth: 'min(240px, 60vw)', textTransform: 'none',
        letterSpacing: 'normal', opacity: '0', pointerEvents: 'none',
        transition: 'opacity 0.15s ease', zIndex: '20',
        boxShadow: '0 4px 12px rgba(15, 23, 42, 0.18)',
      });

      function show() { tip.style.opacity = '1'; }
      function hide() { tip.style.opacity = '0'; }
      wrap.addEventListener('mouseenter', show);
      wrap.addEventListener('mouseleave', hide);

      wrap.appendChild(dot);
      wrap.appendChild(tip);

      // Group the dot together with the existing title text into a single
      // left-aligned flex item. The .card h2 is `display: flex; justify-content:
      // space-between`, so leaving the dot as a separate flex item would push the
      // title text to the opposite (right) edge — under the Review button. The
      // group keeps "dot + title" on the left while the Review button stays right.
      var leftGroup = el('span');
      css(leftGroup, {
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        minWidth: '0',
      });
      while (h2.firstChild) {
        leftGroup.appendChild(h2.firstChild);
      }
      leftGroup.insertBefore(wrap, leftGroup.firstChild);
      h2.appendChild(leftGroup);
    });
  }

  // ---------------------------------------------------------------------------
  // Step 8: collapsible cards. ONE shared mechanism for all four cards (the two
  // static shells + the JS-built RTV / GFE). Each card's <h2> becomes the toggle;
  // everything after it is wrapped in a .card-body that hides when collapsed. The
  // header also shows a chevron + a muted "key live status" string sourced from
  // existing data (never hardcoded). Idempotent: safe to re-run after the JS cards
  // re-render. Collapse state is remembered per card id so re-renders don't lose it.
  // ---------------------------------------------------------------------------
  var cardCollapseState = {}; // card id -> true (collapsed) / false (expanded); default collapsed

  // The concise live-status line for a card's collapsed header. Sourced from the
  // same state that drives the rest of the UI — no hardcoded status strings.
  function collapsibleKeyStatus(id) {
    if (id === 'demographics-card') {
      // Same state that drives the Step-7 re-verify chip.
      return daysSince(CHECKS.demographics.lastRunAt) > DEMOGRAPHICS_REVERIFY_DAYS
        ? 'Re-verify recommended'
        : 'Verified \u00B7 ' + checkStamp('demographics');
    }
    if (id === 'insurance-card') {
      var ins = (currentPatient && currentPatient.insurance) || {};
      return (ins.primary && ins.primary.status) ? ins.primary.status : 'Coverage on file';
    }
    if (id === 'real-time-verification-card') {
      // Post-run: the session run's outcome. Pre-run: ⚠ **CORRECTED 2026-08-14
      // (Craig)** — previously read 'Not yet run', which was false in spirit:
      // the checks HAVE run (the card rows carry per-check last-run dates);
      // only this session hadn't, and with the launch auto-run retired the
      // line rendered on every launch. The header now mirrors the readiness
      // recommendation door (eligibility staleness / manual insurance change —
      // the ONE source of that signal, no duplicated thresholds) and says
      // nothing when there is nothing to recommend — an empty key-status is
      // the honest null (the Medicaid screening cards already render one).
      if (rtvHasRun) return rtvPassCount() + ' of ' + RTV_SERVICES.length + ' checks passed';
      return buildReadinessRecommendations().length ? 'Re-run recommended' : '';
    }
    if (id === 'good-faith-estimates-card') {
      return buildGfeSummary();
    }
    if (id === 'financial-clearance-card') {
      return fcChipFor(fcState).label;
    }
    if (id === 'member-eligibility-card') {
      return memberEligibilityResult
        ? memberEligibilityResult.coverageStatus + ' \u00B7 ' + memberEligibilityResult.memberName
        : 'Look up TPA member benefits';
    }
    if (id === 'mrf-rate-search-card') {
      // MRF-SIDECAR: the same patient-plan gate the modal applies at open
      // (D-101: no active plan → no search).
      return currentPatient && mrfPatientActivePlans(currentPatient).length
        ? 'Search by code + provider'
        : 'No active plan \u2014 self-pay';
    }
    if (id === 'claim-validation-card') {
      // Shared with the status-dot tip (claimsSummaryLine) — single source.
      return claimsSummaryLine();
    }
    if (id === 'appointments-card') {
      // 25B: data-driven count + date signal, from the shared summary helper.
      return appointmentsSummaryLine();
    }
    return '';
  }

  function setCardCollapsed(card, collapsed) {
    if (!card) return;
    card.classList.toggle('is-collapsed', collapsed);
    var h2 = card.querySelector(':scope > h2');
    if (h2) h2.setAttribute('aria-expanded', String(!collapsed));
    if (card.id) cardCollapseState[card.id] = collapsed;
  }

  function toggleCardCollapsed(card) {
    setCardCollapsed(card, !card.classList.contains('is-collapsed'));
  }

  function wireCollapsibleCards() {
    document.querySelectorAll('.card-grid .card').forEach(function (card) {
      var h2 = card.querySelector(':scope > h2');
      if (!h2) return;
      var id = card.id || '';

      if (!card.classList.contains('is-collapsible')) {
        // Wrap everything AFTER the <h2> (the card body, including the absolute
        // top-right action button) so it can be shown/hidden as a single unit.
        // Exception: elements marked .card-collapse-keep stay OUTSIDE the body —
        // an always-visible summary strip between the header and the collapsible
        // detail (the Medicaid screening cards). The card gets .has-collapse-keep
        // so the CSS keeps the normal header seam instead of the flush-collapsed
        // one.
        var body = document.createElement('div');
        body.className = 'card-body';
        body.id = (id || 'card') + '-body';
        var node = h2.nextSibling;
        while (node) {
          var next = node.nextSibling;
          if (node.nodeType === 1 && node.classList.contains('card-collapse-keep')) {
            card.classList.add('has-collapse-keep');
          } else {
            body.appendChild(node);
          }
          node = next;
        }
        card.appendChild(body);

        // Disclosure chevron at the FAR LEFT of the header — keeps clear of the
        // absolute top-right action button (Review / Run Checks / Manage).
        var chev = el('span', 'card-collapse-chevron', '\u25B8');
        chev.setAttribute('aria-hidden', 'true');
        h2.insertBefore(chev, h2.firstChild);

        // Muted key-status, placed after the title.
        h2.appendChild(el('span', 'card-key-status'));

        // The header itself is the toggle (accessible button semantics + keys).
        h2.setAttribute('role', 'button');
        h2.setAttribute('tabindex', '0');
        h2.setAttribute('aria-controls', body.id);
        h2.addEventListener('click', function () { toggleCardCollapsed(card); });
        h2.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            toggleCardCollapsed(card);
          }
        });

        card.classList.add('is-collapsible');
      }

      // The top-right action button (Review / Run Checks / Search rates …)
      // sits on the card header; .has-head-action reserves room for it there
      // (styles.css). Re-marked on every wire: re-renders rebuild these
      // buttons.
      var bodyEl = card.querySelector(':scope > .card-body');
      var hasAction = false;
      if (bodyEl) {
        Array.prototype.forEach.call(bodyEl.children, function (child) {
          if (child.tagName === 'BUTTON' && child.style.position === 'absolute') {
            child.classList.add('card-head-action');
            hasAction = true;
          }
        });
      }
      card.classList.toggle('has-head-action', hasAction);

      // Refresh the key-status text from live data on every (re-)wire.
      var ksEl = h2.querySelector('.card-key-status');
      if (ksEl) {
        ksEl.textContent = collapsibleKeyStatus(id);
        // A status-bearing chip (Financial Clearance) carries its tone; every
        // other card keeps the neutral title chip.
        var tone = id === 'financial-clearance-card' ? fcChipFor(fcState).tone : '';
        if (tone) ksEl.setAttribute('data-tone', tone);
        else ksEl.removeAttribute('data-tone');
      }

      // Apply collapse state — default collapsed; remembered across JS re-renders.
      var collapsed = (id && id in cardCollapseState) ? cardCollapseState[id] : true;
      setCardCollapsed(card, collapsed);
    });
  }

  // ===========================================================================
  // Financial Clearance (handoff 2026-10-30, Craig) — a Pre Check-In card. The
  // header carries the status chip; expanding the card shows the clearance
  // in place (Craig, 2026-10-30 — no View button, no pop-up): the last-run
  // line with Run Financial Clearance, then Income & Household, read only.
  // ---------------------------------------------------------------------------
  // Data: GET /api/financial-clearance/:id (the platform's clearance record,
  // pinned test patient) and POST …/run (the platform button's own action,
  // then a re-read). Fail honest: no sample, cached or stale data — a failed
  // read shows an error, a failed run shows "Clearance didn't run". No toast
  // (Craig, 2026-10-30): the chip and the last-run line are the confirmation.
  // Hidden by decision and never received from the server: coverage,
  // recommended path/action, reasons, estimate, balance, payments.
  // Approver/date and screening date have no source yet: "Not recorded".
  // Styling lives in styles.css (.fc-*), so the embed CSP is respected.

  var FC_STATUS = {
    clear: { label: 'Clear', tone: 'success' },
    needs_action: { label: 'Needs action', tone: 'caution' },
    blocked: { label: 'Blocked', tone: 'destructive' },
  };
  var FC_NOT_RECORDED = 'Not recorded';

  function fcFreshState(key) {
    return { key: key, loading: false, envelope: null, running: false, runError: null, rereadFailed: false, requestSeq: 0 };
  }
  var fcState = fcFreshState(null);

  function fcPatientId() {
    return String(fcState.key || '');
  }

  // "10/30/2026, 2:14 PM" in the viewer's time zone.
  function fcFmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fcFmtMoney(n) {
    var whole = Math.round(n * 100) % 100 === 0;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  }

  // The chip for the card header. Every state carries text (never colour alone).
  function fcChipFor(state) {
    var env = state.envelope;
    if (!env) return state.loading ? { label: 'Loading…', tone: 'neutral' } : { label: '', tone: '' };
    if (env.source === 'not_configured') return { label: 'Not connected', tone: 'neutral' };
    if (env.status === 'error') return { label: 'Couldn’t load', tone: 'neutral' };
    var c = env.clearance;
    if (!c) return { label: 'Not run', tone: 'neutral' };
    return FC_STATUS[c.status] || { label: 'Status unknown', tone: 'neutral' };
  }

  function fcLastRunAt(state) {
    var env = state.envelope;
    return env && env.status === 'ok' && env.clearance ? env.clearance.lastRefreshedAt : null;
  }

  // The card's status line, mirroring "Demographics last verified <date>".
  function fcLastRunText(state) {
    if (state.running) return 'Financial clearance running…';
    var env = state.envelope;
    if (!env) return state.loading ? 'Loading financial clearance…' : '';
    // Not connected: no note in the card (Craig, 2026-10-30, demo); the
    // header chip alone says so.
    if (env.source === 'not_configured') return '';
    if (env.status === 'error') return '';
    var at = fcFmtDateTime(fcLastRunAt(state));
    return at ? 'Financial clearance last run ' + at : 'Financial clearance not run yet';
  }

  function fetchFinancialClearance(patientId) {
    return fetch('/api/financial-clearance/' + encodeURIComponent(patientId), {
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function postFinancialClearanceRun(patientId) {
    return fetch('/api/financial-clearance/' + encodeURIComponent(patientId) + '/run', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  // Repaint the card (its collapsed chip and its expanded body). Collapse
  // state survives: wireCollapsibleCards() remembers it per card id.
  function fcRefreshViews() {
    if (currentPatient) {
      renderFinancialClearanceCard(currentPatient, { patientId: fcPatientId() });
      wireCollapsibleCards();
    }
  }

  // `quiet`: the caller (the card render) paints the loading state itself.
  function fcLoad(quiet) {
    var state = fcState;
    var seq = ++state.requestSeq;
    state.loading = true;
    state.envelope = null;
    state.rereadFailed = false;
    if (quiet !== true) fcRefreshViews();
    fetchFinancialClearance(fcPatientId()).then(function (envelope) {
      // Stale-response guard: a patient switch or a newer retry wins.
      if (fcState !== state || state.requestSeq !== seq) return;
      if (envelope.status === 'error' && envelope.error) {
        console.warn('[NextGen-embed] Financial clearance read failed: ' + envelope.error.code);
      }
      state.envelope = envelope;
      state.loading = false;
      fcRefreshViews();
    }).catch(function (err) {
      if (fcState !== state || state.requestSeq !== seq) return;
      console.warn('[NextGen-embed] Financial clearance request failed: ' + (err && err.message ? err.message : err));
      state.envelope = { status: 'error', source: 'transport', clearance: null };
      state.loading = false;
      fcRefreshViews();
    });
  }

  // Run Financial Clearance: direct (no confirm step), the platform's action.
  function fcRun() {
    var state = fcState;
    if (state.running) return;
    state.running = true;
    state.runError = null;
    state.rereadFailed = false;
    // The button is disabled while in flight; hand focus back to it after.
    state.refocusRun = true;
    fcRefreshViews();
    postFinancialClearanceRun(fcPatientId()).then(function (r) {
      if (fcState !== state) return;
      state.running = false;
      if (!r.ok || !r.body || r.body.ran !== true) {
        var code = (r.body && r.body.code) || ('HTTP ' + r.status);
        console.warn('[NextGen-embed] Financial clearance run failed: ' + code + (r.body && r.body.requestId ? ' (requestId ' + r.body.requestId + ')' : ''));
        state.runError = code === 'module_inactive'
          ? 'Financial Clearance isn’t active for this client.'
          : 'Clearance didn’t run. Try again.';
      } else {
        // The run happened; show the re-read record, or say honestly that it
        // could not be loaded — never the pre-run values.
        state.envelope = r.body.envelope;
        state.rereadFailed = r.body.envelope && r.body.envelope.status === 'error';
      }
      fcRefreshViews();
    }).catch(function (err) {
      if (fcState !== state) return;
      console.warn('[NextGen-embed] Financial clearance run request failed: ' + (err && err.message ? err.message : err));
      state.running = false;
      state.runError = 'Clearance didn’t run. Try again.';
      fcRefreshViews();
    });
  }

  // Builds (idempotently, position-stable) the card on the Pre Check-In tab,
  // after Real-Time Verification. Everything after the <h2> becomes the
  // collapsible body (wireCollapsibleCards), so expanding the card shows it.
  function renderFinancialClearanceCard(p, context) {
    var patientId = (context && context.patientId) || (p && p.mrn) || 'unknown';
    if (fcState.key !== String(patientId)) {
      fcState = fcFreshState(String(patientId));
      fcLoad(true); // this render paints the loading state below
    }
    var state = fcState;
    var env = state.envelope;
    var grid = document.querySelector('#tab-precheckin .card-grid');
    if (!grid) return;
    var existing = $('financial-clearance-card');
    // Remember which control had focus so a repaint doesn't drop it.
    var active = document.activeElement;
    var refocusKey = existing && active && existing.contains(active) ? active.getAttribute('data-fc-focus') : null;
    if (state.refocusRun && !state.running) {
      refocusKey = 'run';
      state.refocusRun = false;
    }
    var mountBefore = existing && existing.parentNode === grid ? existing.nextSibling : null;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!mountBefore) {
      var rtv = $('real-time-verification-card');
      mountBefore = rtv && rtv.parentNode === grid ? rtv.nextSibling : null;
    }

    var card = el('section', 'card fc-card');
    card.id = 'financial-clearance-card';
    card.setAttribute('aria-label', 'Financial Clearance');
    var h2 = el('h2', null, 'Financial Clearance');
    h2.setAttribute('data-fc-focus', 'header');
    card.appendChild(h2);

    // Status line + Run Financial Clearance (styled like the Demographics
    // modal's "Demographic Verification" button).
    var bar = el('div', 'fc-bar');
    var line = el('span', 'fc-last-run', fcLastRunText(state));
    line.setAttribute('role', 'status');
    line.setAttribute('aria-live', 'polite');
    bar.appendChild(line);
    var notConfigured = !!(env && env.source === 'not_configured');
    var run = el('button', 'fc-btn fc-btn-primary fc-run-btn', state.running ? 'Running\u2026' : 'Run Financial Clearance');
    run.type = 'button';
    run.setAttribute('data-fc-focus', 'run');
    run.disabled = state.running || notConfigured || (state.loading && !env);
    run.addEventListener('click', fcRun);
    bar.appendChild(run);
    card.appendChild(bar);

    if (state.runError) {
      var runErr = el('p', 'fc-alert', state.runError);
      runErr.setAttribute('role', 'alert');
      card.appendChild(runErr);
    }

    if (state.loading && !env) {
      card.appendChild(el('p', 'fc-message muted', 'Loading financial clearance\u2026'));
    } else if (env && env.status === 'error') {
      var msg = el('div', 'fc-alert');
      msg.setAttribute('role', 'alert');
      msg.appendChild(el('span', null, state.rereadFailed
        ? 'Clearance ran, but the result couldn\u2019t be loaded. Try again.'
        : 'Couldn\u2019t load financial clearance. Try again.'));
      var retry = el('button', 'fc-btn fc-btn-outline', 'Try again');
      retry.type = 'button';
      retry.setAttribute('data-fc-focus', 'retry');
      retry.addEventListener('click', fcLoad);
      msg.appendChild(retry);
      card.appendChild(msg);
    } else {
      fcRenderIncomeHousehold(card, env);
    }

    if (mountBefore) grid.insertBefore(card, mountBefore);
    else grid.appendChild(card);

    if (refocusKey) {
      // wireCollapsibleCards() runs right after this render and moves the body
      // into .card-body, which drops focus, so restore it on the next tick.
      setTimeout(function () {
        var c = $('financial-clearance-card');
        var target = c && (c.querySelector('[data-fc-focus="' + refocusKey + '"]'));
        if (target && !target.disabled) target.focus();
        else if (c) { var head = c.querySelector(':scope > h2'); if (head) head.focus(); }
      }, 0);
    }
  }

  function fcRow(label, value, sub) {
    var row = el('div', 'fc-row');
    row.appendChild(el('dt', 'fc-row-label', label));
    var dd = el('dd', 'fc-row-value');
    if (value && value.nodeType === 1) dd.appendChild(value);
    else dd.appendChild(el('span', value == null ? 'fc-not-recorded' : null, value == null ? FC_NOT_RECORDED : value));
    if (sub) dd.appendChild(el('span', 'fc-row-sub', sub));
    row.appendChild(dd);
    return row;
  }

  function fcTierPill(tier) {
    if (!tier) return null;
    var text = tier.discountPercentage > 0
      ? tier.discountPercentage + '% discount · FPL ' + tier.fplRange
      : 'Not eligible · FPL ' + tier.fplRange;
    return el('span', 'badge ' + (tier.discountPercentage > 0 ? 'badge-green' : 'badge-neutral'), text);
  }

  function fcApprovalLine(approval) {
    // No approval source on the clearance record yet (Craig, 2026-10-30).
    return 'Approved by: ' + (approval && approval.by ? approval.by + (approval.at ? ' on ' + fcFmtDateTime(approval.at) : '') : FC_NOT_RECORDED);
  }

  function fcRenderIncomeHousehold(body, env) {
    var c = (env && env.clearance) || {};
    var section = el('section', 'fc-section');
    section.setAttribute('aria-labelledby', 'fc-income-title');
    var head = el('div', 'fc-section-head');
    var title = el('h3', 'fc-caps', 'Income & household');
    title.id = 'fc-income-title';
    head.appendChild(title);
    head.appendChild(el('span', 'badge badge-neutral', 'View only'));
    section.appendChild(head);
    if (env && env.identity && env.identity.kind === 'pinned') {
      section.appendChild(el('p', 'fc-identity muted', 'FrontRunner record: staging test patient #' + env.identity.patientId + ' (no NextGen patient link yet)'));
    }
    var dl = el('dl', 'fc-rows');
    dl.appendChild(fcRow('Qualifying tier', fcTierPill(c.tier)));
    dl.appendChild(fcRow('Household size', c.householdSize != null ? c.householdSize + (c.householdSize === 1 ? ' person' : ' people') : null, fcApprovalLine(c.householdSizeApproval)));
    dl.appendChild(fcRow('Annual income', c.annualIncome != null ? fcFmtMoney(c.annualIncome) : null, fcApprovalLine(c.annualIncomeApproval)));
    dl.appendChild(fcRow('FPL percentage', c.fplPercentage != null ? c.fplPercentage + '%' : null));
    dl.appendChild(fcRow('Screening date', c.screeningDate ? fcFmtDateTime(c.screeningDate) : null));
    section.appendChild(dl);
    body.appendChild(section);
  }

  // ===========================================================================
  // Medicaid Renewal tab (handoff 2026-10-21, Craig) — ONE modal for the open
  // patient, headed by the Medicaid Renewal Board column the patient is in.
  // ---------------------------------------------------------------------------
  // Data: GET /api/medicaid-renewal/:patientId (server.js →
  // lib/medicaid-renewal.js), which reads the platform's allow-listed Medicaid
  // documents for a PINNED staging patient and returns an honest null for every
  // field the platform has no source for (see that module + the contract doc,
  // docs/CONTRACT-medicaid-renewal-sidecar-2026-10-21.md). This tab renders what
  // the envelope says and never fills a gap: no placement guess, no
  // recomputed progress, no member-ID rule.
  //
  // Actionable (addendum 2026-10-30, Craig; it wins over the earlier "display
  // only" rule): case status, assignee, Start case, Confirm placement, the
  // member ID fix, the seven-step panel, the step 1 dialogs and Send. Every
  // write goes through one save pattern (mrAsk / mrSaveBar below): confirm,
  // saving, saved, or the error with "Try again"; the screen changes only
  // after the save succeeds. Writes the platform has go to FrontRunner; the
  // rest fail honestly as contract gaps (lib/medicaid-renewal-actions.js). A
  // sample patient's save is simulated and says so. Heavy work (uploads,
  // forms, the packet, replacing a determination, the final close) stays in
  // FrontRunner behind "Open in FrontRunner".
  //
  // UI wording follows the main product (Craig, 2026-10-26: read from the
  // Replit preview's Medicaid Renewal board and Bob Testpatient's case
  // workspace, /medicaid-renewal?wf=9002). The product's wording wins; strings
  // with no product source (the notice strips, "Nothing sent yet.", the NEXT
  // APPT tile) stay sidecar-authored. Closed / denied cases follow the
  // product's stepper (2026-10-30).
  //
  // Sample data (review only): ?medicaidSample=bob|carol|alice|gita|untracked|
  // error|olivia, only when the server sets MEDICAID_RENEWAL_SAMPLE_DATA=1
  // (off by default, Craig 2026-10-30); the Olivia Torres mock profile then
  // opens on the "olivia" sample (server.js). A sample envelope is labelled
  // "Sample data" in the UI, and its saves are simulated.
  // ===========================================================================
  // Column header colour + body tint (Craig, 2026-10-21): the platform's own
  // column hues, from website/client/src/features/medicaid-renewal/lib/
  // population-vocab.ts lines 39-42 (Replit repo LIVE -V2, as read by Craig):
  // Unknown / Needs Screening = stone, Medicaid Eligible = teal, ACA /
  // Marketplace Eligible = violet, No Longer Eligible = pink. Values are the
  // sidecar theme layer's --category-* tokens (styles.css :root): header =
  // -fg, tint = -bg, border = -border. The style spec gives violet and pink
  // exactly (Tailwind 700 / 100 / 200); stone and teal follow the same
  // Tailwind shades but are NOT read from the Replit code (not reachable
  // here). The reachable frhc-platform code (medicaid-redetermination
  // board-category-colors.ts) still has emerald / blue / red / slate. White
  // header text contrast: 10.27, 5.47, 7.10 and 6.04 to 1, all WCAG AA. The
  // column name is always shown, so colour is never the only signal.
  function mrCategory(name) {
    return {
      header: 'hsl(var(--category-' + name + '-fg))',
      tint: 'hsl(var(--category-' + name + '-bg))',
      border: 'hsl(var(--category-' + name + '-border))',
    };
  }
  var MR_COLUMNS = {
    unknown_screening: Object.assign(mrCategory('stone'), { icon: '?' }),
    medicaid_eligible: Object.assign(mrCategory('teal'), { icon: '\u2713' }),
    aca_marketplace: Object.assign(mrCategory('violet'), { icon: '\u21C4' }),
    no_longer_eligible: Object.assign(mrCategory('pink'), { icon: '\u2715' }),
  };

  var MR_NOTICES = {
    unknown_screening: 'Income unknown. Screening is needed before a program can be chosen.',
    medicaid_eligible: 'Likely qualifies for Medicaid. Renew coverage before the deadline.',
    aca_marketplace: 'Over the Medicaid income limit. Marketplace coverage with a subsidy may fit.',
    no_longer_eligible: 'No longer eligible. Review the reason with the patient.',
  };

  // Placement chip hues from the same population-vocab.ts: Staff confirmed =
  // sky, Predicted placement = lime (category -bg / -fg / -border, Tailwind
  // 100 / 700 / 200 like the column hues; text on fill 5.17 and 4.60 to 1).
  // Labels and explanations are the product's: its only placement explanation
  // is the Predicted tooltip; "Recorded by staff." is the staff-confirmed one.
  // Both also open the "Why this placement" section.
  var MR_PLACEMENT_CHIPS = {
    staff_confirmed: Object.assign({
      label: 'Staff confirmed', tip: 'Recorded by staff.',
    }, mrChipTone('sky')),
    predicted: Object.assign({
      label: 'Predicted placement',
      tip: 'Predicted from the recorded screening (income, household, age); not a recorded outcome.',
    }, mrChipTone('lime')),
  };
  function mrChipTone(name) {
    var c = mrCategory(name);
    return { bg: c.tint, fg: c.header, border: c.border };
  }

  // Channels as in the main product: Email, SMS, Portal (no Letter; Craig,
  // 2026-10-26). Email and SMS send through frhc-platform's
  // medicaidOutreachSend (email | sms | letter); it has no portal channel, so
  // a Portal send fails as a contract gap. The three templates are the
  // sidecar's SAMPLE data: the product's template names are "Appointment
  // reminder (demo)" and "Medicaid renewal reminder (email)", and their bodies
  // are not confirmed.
  var MR_CHANNELS = [
    { id: 'email', label: 'Email' },
    { id: 'sms', label: 'SMS' },
    { id: 'portal', label: 'Portal' },
  ];
  var MR_TEMPLATES = [
    { id: 'confirm', label: 'Confirm your information' },
    { id: 'documents', label: 'Documents needed' },
    { id: 'reminder', label: 'Renewal reminder' },
  ];

  function mrTemplateText(templateId, firstName, renewalDate) {
    var hello = firstName ? 'Hello ' + firstName + ', ' : 'Hello, ';
    if (templateId === 'documents') {
      return hello + 'we still need documents for your Medicaid renewal. Please upload them in the patient portal or bring them to your next visit.';
    }
    if (templateId === 'reminder') {
      return hello + 'a reminder that your Medicaid renewal is due' +
        (renewalDate ? ' ' + mrFormatDate(renewalDate) : '') + '. Contact us if you need help.';
    }
    return hello + 'your Medicaid renewal is due. Please confirm your information in the patient portal.';
  }

  // Per-patient module state. Reset on every patient switch (mrKey change), so
  // a section opened or a draft typed for one patient never carries over.
  var mrState = null;

  function mrFreshState(key) {
    return {
      key: key,
      loading: true,
      envelope: null,
      requestSeq: 0,
      screeningRetrying: false,
      open: { why: true, comms: false, screening: false },
      // Case progress card's "See all steps" list — collapsed by default.
      stepsOpen: false,
      // Actionable addendum: the write in progress (mrAsk), the step shown in
      // the step panel (null = the current step), per-step drafts, the
      // member ID draft, the placement choice and the open step 1 dialog.
      save: null,
      stepOpen: null,
      drafts: {},
      memberIdDraft: '',
      memberIdError: null,
      placementChoice: null,
      dialog: null,
      comms: { channel: 'email', template: 'confirm', subject: '', message: null },
    };
  }

  function mrSampleParam() {
    try {
      return new URLSearchParams(window.location.search).get('medicaidSample') || '';
    } catch (e) {
      return '';
    }
  }

  // Calendar-day DATE values (renewal date) — formatted on UTC so the day never
  // shifts with the browser's zone.
  function mrFormatDate(iso) {
    if (!iso) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return null;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Appointment values carry the practice's wall clock in their digits (the
  // board's apptDatePart rule) — read verbatim, never converted.
  function mrFormatAppt(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
    if (!m) return null;
    var date = mrFormatDate(m[1] + '-' + m[2] + '-' + m[3]);
    if (!m[4]) return date;
    var h = Number(m[4]);
    return date + ' · ' + ((h % 12) || 12) + ':' + m[5] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function mrFormatSentAt(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fetchMedicaidRenewal(patientId) {
    var url = '/api/medicaid-renewal/' + encodeURIComponent(patientId);
    var sample = mrSampleParam();
    if (sample) url += '?sample=' + encodeURIComponent(sample);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function mrLoad(opts) {
    var state = mrState;
    var seq = ++state.requestSeq;
    var patientId = state.key.split('|')[0];
    if (!(opts && opts.keepEnvelope)) {
      state.loading = true;
      state.envelope = null;
    }
    mrRender();
    fetchMedicaidRenewal(patientId).then(function (envelope) {
      // Stale-response guard: a patient switch or a newer retry wins.
      if (mrState !== state || state.requestSeq !== seq) return;
      if (envelope.status === 'error' && envelope.error) {
        // Technical detail goes to the console, never the UI copy.
        console.warn('[NextGen-embed] Medicaid Renewal read failed: ' + envelope.error.code);
      }
      state.envelope = envelope;
      state.loading = false;
      state.screeningRetrying = false;
      mrRender();
    }).catch(function (err) {
      if (mrState !== state || state.requestSeq !== seq) return;
      console.warn('[NextGen-embed] Medicaid Renewal request failed: ' + (err && err.message ? err.message : err));
      state.envelope = { status: 'error', source: 'transport', renewal: null };
      state.loading = false;
      state.screeningRetrying = false;
      mrRender();
    });
  }

  // Render door, called from renderProfile on every (re-)render. A new patient
  // (or sample) resets the tab state and fetches; a same-patient re-render
  // (a FrontRunner refresh) repaints from state without refetching.
  function renderMedicaidRenewalTab(p, context) {
    var patientId = (context && context.patientId) || (p && p.mrn) || 'unknown';
    var key = patientId + '|' + mrSampleParam();
    if (!mrState || mrState.key !== key) {
      mrState = mrFreshState(key);
      mrLoad();
      return;
    }
    mrRender();
  }

  // ---- Small builders --------------------------------------------------------

  function mrChip(text, cls, tip) {
    var c = el('span', 'mr-chip' + (cls ? ' ' + cls : ''), text);
    if (tip) c.title = tip;
    return c;
  }

  function mrButton(text, cls, onClick) {
    var b = el('button', 'btn mr-btn ' + (cls || 'mr-btn-secondary'), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function mrTile(label, valueNode, extraNodes) {
    var tile = el('div', 'mr-tile');
    tile.appendChild(el('div', 'mr-caps', label));
    var v = el('div', 'mr-tile-value');
    if (typeof valueNode === 'string') v.textContent = valueNode;
    else v.appendChild(valueNode);
    tile.appendChild(v);
    (extraNodes || []).forEach(function (n) { if (n) tile.appendChild(n); });
    return tile;
  }

  // Collapsible section row: grey caps label, 44px tap height, chevron.
  function mrSection(id, label, renderBody) {
    var wrap = el('section', 'mr-section');
    var open = !!mrState.open[id];
    var btn = el('button', 'mr-section-row');
    btn.type = 'button';
    btn.id = 'mr-sec-' + id;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-controls', 'mr-sec-' + id + '-body');
    btn.appendChild(el('span', 'mr-caps', label));
    var chev = el('span', 'mr-section-chevron', open ? '▾' : '▸');
    chev.setAttribute('aria-hidden', 'true');
    btn.appendChild(chev);
    btn.addEventListener('click', function () {
      mrState.open[id] = !mrState.open[id];
      mrRender();
      var again = $('mr-sec-' + id);
      if (again) again.focus();
    });
    wrap.appendChild(btn);
    var body = el('div', 'mr-section-body');
    body.id = 'mr-sec-' + id + '-body';
    body.hidden = !open;
    if (open) renderBody(body);
    wrap.appendChild(body);
    return wrap;
  }

  function mrKv(rows) {
    var kv = el('div', 'kv mr-kv');
    rows.forEach(function (r) {
      var row = el('div', 'kv-row');
      row.appendChild(el('span', 'kv-label', r[0]));
      // r[2]: an optional extra class on the value (e.g. 'is-money').
      row.appendChild(el('span', 'kv-value' + (r[2] ? ' ' + r[2] : ''), r[1]));
      kv.appendChild(row);
    });
    return kv;
  }

  // Whole-tab message (no data / load error), in place of the modal.
  function mrMessage(root, title, body, extra) {
    var box = el('div', 'mr-message');
    box.appendChild(el('h2', 'mr-message-title', title));
    box.appendChild(el('p', 'mr-message-body', body));
    (extra || []).forEach(function (n) { if (n) box.appendChild(n); });
    root.appendChild(box);
  }

  function mrHeader(colKey, label, placement, isLoading) {
    var col = MR_COLUMNS[colKey] || MR_COLUMNS.unknown_screening;
    var head = el('div', 'mr-head');
    css(head, { background: col.header });
    if (!isLoading) {
      var icon = el('span', 'mr-head-icon', col.icon);
      icon.setAttribute('aria-hidden', 'true');
      head.appendChild(icon);
    }
    head.appendChild(el('h2', 'mr-head-title', label));
    var chip = placement && MR_PLACEMENT_CHIPS[placement];
    if (chip) {
      var pill = mrChip(chip.label, 'mr-chip-onhead', chip.tip);
      css(pill, { background: chip.bg, color: chip.fg, borderColor: chip.border });
      head.appendChild(pill);
    }
    return head;
  }

  // ---- The modal -------------------------------------------------------------

  function mrRender() {
    var root = $('mr-root');
    if (!root || !mrState) return;
    while (root.firstChild) root.removeChild(root.firstChild);

    if (mrState.loading) {
      var shell = el('div', 'mr-modal is-loading');
      shell.setAttribute('aria-busy', 'true');
      var head = mrHeader('unknown_screening', 'Loading Medicaid renewal info…', null, true);
      head.classList.add('is-loading');
      shell.appendChild(head);
      var sk = el('div', 'mr-body');
      sk.appendChild(el('div', 'mr-skel mr-skel-line'));
      var skTiles = el('div', 'mr-tiles');
      for (var i = 0; i < 3; i++) skTiles.appendChild(el('div', 'mr-skel mr-skel-tile'));
      sk.appendChild(skTiles);
      sk.appendChild(el('div', 'mr-skel mr-skel-strip'));
      for (var j = 0; j < 3; j++) sk.appendChild(el('div', 'mr-skel mr-skel-row'));
      shell.appendChild(sk);
      root.appendChild(shell);
      return;
    }

    var env = mrState.envelope || {};
    if (env.source === 'sample') {
      root.appendChild(el('div', 'mr-sample-banner', 'Sample data — not a real patient.'));
    }

    if (env.status === 'error') {
      mrMessage(root, 'Couldn’t load Medicaid renewal info', 'Check your connection and try again.', [
        mrButton('Try again', null, function () { mrLoad(); }),
      ]);
      return;
    }
    if (env.status !== 'ok' || !env.renewal) {
      mrMessage(root, 'No Medicaid renewal info for this patient', 'This patient isn’t tracked for renewal yet.', [
        env.source === 'not_configured'
          ? el('p', 'mr-footnote', 'Live Medicaid data isn’t connected in this build.')
          : null,
      ]);
      return;
    }

    var r = env.renewal;
    var identity = env.identity || {};
    var colKey = MR_COLUMNS[r.column] ? r.column : 'unknown_screening';
    var col = MR_COLUMNS[colKey];

    var modal = el('div', 'mr-modal');
    css(modal, { borderColor: col.border });
    var saveBar = mrSaveBar('tab');
    if (saveBar) modal.appendChild(saveBar);
    modal.appendChild(mrHeader(colKey, r.columnLabel, r.placement));

    var body = el('div', 'mr-body');
    css(body, { background: col.tint });

    // 1. Member ID warning — urgent, so first. Data-driven only.
    if (r.memberId && r.memberId.flagged) {
      var warn = el('div', 'mr-warning');
      warn.setAttribute('role', 'alert');
      warn.appendChild(el('div', 'mr-warning-title', 'Member ID to fix: ' + (r.memberId.value || '—')));
      warn.appendChild(el('div', null, r.memberId.message || 'This member ID failed validation.'));
      warn.appendChild(el('div', null, 'Correct it in the insurance record.'));
      mrMemberIdFix(warn);
      body.appendChild(warn);
    }

    // 2. Patient name + case badge + discount / program chips.
    var who = el('div', 'mr-who');
    var name = identity.fullName ||
      (identity.kind === 'pinned' ? 'Staging test patient #' + identity.patientId : 'Patient');
    who.appendChild(el('div', 'mr-name', name));
    var chips = el('div', 'mr-chips');
    chips.appendChild(r.case
      ? mrChip('Case open' + (r.case.statusLabel ? ': ' + r.case.statusLabel : ''), 'mr-chip-neutral')
      : mrChip('No case', 'mr-chip-neutral'));
    if (r.discount && r.discount.label) chips.appendChild(mrChip(r.discount.label, 'mr-chip-neutral'));
    if (r.program && r.program.code) chips.appendChild(mrChip(r.program.code, 'mr-chip-special'));
    who.appendChild(chips);
    body.appendChild(who);

    // 3. Stat tiles.
    var tiles = el('div', 'mr-tiles');
    var flag = r.renewalFlag === 'overdue' ? el('span', 'badge badge-red chip-icon-warn', 'Renewal passed')
      : r.renewalFlag === 'due_soon' ? el('span', 'badge badge-amber chip-icon-warn', 'Due soon') : null;
    var renewsTile = mrTile('Renewal due', mrFormatDate(r.renewalDate) || 'No renewal date', [flag]);
    if (r.renewalFlag === 'overdue') renewsTile.querySelector('.mr-tile-value').classList.add('is-overdue');
    tiles.appendChild(renewsTile);
    var fplTile = mrTile('FPL', r.fplPercent == null ? 'Unknown' : r.fplPercent + '%');
    if (r.fplPercent != null) fplTile.querySelector('.mr-tile-value').classList.add('is-money');
    tiles.appendChild(fplTile);
    var appt = r.nextAppointment || {};
    tiles.appendChild(mrTile('Next appt',
      !appt.available ? 'Not available' : (mrFormatAppt(appt.at) || 'None')));
    body.appendChild(tiles);

    // 4. Notice strip.
    var notice = el('div', 'mr-notice', MR_NOTICES[colKey]);
    css(notice, { borderLeftColor: col.header, color: col.header });
    body.appendChild(notice);

    // 5. Case + Assignee. The Case tile shows the stage and the editable case
    // status (or Start case); progress lives in the Case progress card below
    // (tracker addendum). Assignee is editable when a staff list is supplied.
    var caseTiles = el('div', 'mr-tiles mr-tiles-2');
    caseTiles.appendChild(mrTile('Case', r.case ? (r.case.statusLabel || 'Open') : 'No case', mrCaseControls(r)));
    // With a supplied staff list, no assignee means unassigned; without one
    // the platform gave no assignee source, so it is "Not available".
    var hasStaff = !!(r.case && Array.isArray(r.case.assigneeOptions) && r.case.assigneeOptions.length);
    var assignee = !r.case ? '—'
      : r.case.assignee ? (r.case.assignee.name || 'Unassigned') : hasStaff ? 'Unassigned' : 'Not available';
    caseTiles.appendChild(mrTile('Assignee', assignee, mrAssigneeControls(r)));
    body.appendChild(caseTiles);

    // 5b. Case progress card — only with a case AND a product-supplied
    // caseProgress; otherwise nothing at all.
    var progressCard = mrCaseProgressCard(r);
    if (progressCard) body.appendChild(progressCard);

    // 6. Sections — only "Why this placement" open on first load.
    body.appendChild(mrSection('why', 'Why this placement', function (b) {
      // The product's placement explanation leads, for a placement that has
      // one (Predicted placement / Staff confirmed); with no placement chip
      // there is no product sentence, so none is shown.
      var why = MR_PLACEMENT_CHIPS[r.placement];
      if (why) b.appendChild(el('p', 'mr-why-lead', why.tip));
      b.appendChild(mrKv([
        ['Result', (r.result && r.result.label) || '—'],
        // Product casing and en dash ("Under 100% FPL", "138–250% FPL").
        ['Income band', (r.incomeBand && r.incomeBand.label) || 'Income unknown',
          r.incomeBand && r.incomeBand.label && r.incomeBand.key !== 'unknown' ? 'is-money' : ''],
      ]));
    }));
    body.appendChild(mrSection('placement', 'Confirm placement', function (b) {
      mrRenderPlacement(b, r);
    }));
    body.appendChild(mrSection('comms', 'Patient communication', function (b) {
      mrRenderComms(b, r, identity);
    }));
    body.appendChild(mrSection('screening', 'Screening results', function (b) {
      mrRenderScreening(b, r);
    }));

    if (identity.kind === 'pinned') {
      body.appendChild(el('p', 'mr-footnote',
        'Staging test patient (set on the server) — not matched to this NextGen patient.'));
    }

    modal.appendChild(body);
    root.appendChild(modal);
    mrRenderDialog(root, r);
  }

  // ---- Case progress card (tracker addendum, 2026-10-26) --------------------
  // The product's case progress tracker ("pizza tracker"): a rail of the
  // case's steps, the step panel, and a "See all steps" list. Everything
  // comes from `r.case.caseProgress` exactly as supplied — counts, statuses,
  // titles and percent are never derived here (Craig: the sidecar reads
  // progress from the product). Actionable addendum (2026-10-30): when the
  // case carries per-step detail, rail nodes and list rows are buttons that
  // open a step in the panel; the current step is editable, done steps are
  // read-only, later steps are locked. After a save the percent is hidden
  // until the product supplies it again. Colours: done = success, current =
  // info, not started = neutral (platform status tokens).
  var MR_STEP_STATUS = {
    done: { label: 'Done', chip: 'mr-chip-success' },
    in_progress: { label: 'In progress', chip: 'mr-chip-info' },
    not_started: { label: 'Not started', chip: 'mr-chip-neutral' },
    denied: { label: 'Denied', chip: 'mr-chip-destructive' },
  };
  // Closed and denied cases follow the product's CaseStepper (Craig,
  // 2026-10-30: match the product). The summary is always "N of 7 steps done
  // · P%", with the real percent and never 100. A denied case shows "Denied"
  // (a cross) on the LAST step only. A closed case adds no wording, and its
  // nodes are plain and non-interactive. The sidecar's own "Closed" / "All
  // steps done" wording is gone.
  function mrShownStatus(cp, st) {
    return cp.closed === 'denied' && st.position === cp.totalSteps ? 'denied' : st.status;
  }

  function mrUsableProgress(cp) {
    return !!(cp && Array.isArray(cp.steps) && cp.steps.length &&
      cp.totalSteps === cp.steps.length && typeof cp.doneCount === 'number');
  }

  function mrStepName(cp, st) {
    return 'Step ' + st.position + ' of ' + cp.totalSteps + ': ' + st.title +
      ' · ' + MR_STEP_STATUS[mrShownStatus(cp, st)].label;
  }

  function mrStepDot(cp, st, isCurrent, interactive) {
    var denied = mrShownStatus(cp, st) === 'denied';
    var done = !denied && st.status === 'done';
    var dot = el('span', 'mr-cp-dot ' + (denied ? 'is-denied' : done ? 'is-done' : isCurrent ? 'is-current' : 'is-todo'),
      denied ? '✕' : done ? '✓' : String(st.position));
    if (interactive) {
      // The button around it carries the name.
      dot.setAttribute('aria-hidden', 'true');
    } else {
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', mrStepName(cp, st));
      dot.title = mrStepName(cp, st);
    }
    return dot;
  }

  function mrSelectStep(pos, focusId) {
    mrState.stepOpen = pos;
    mrRender();
    mrFocus(focusId);
  }

  function mrCaseProgressCard(r) {
    var cp = r.case && r.case.caseProgress;
    if (!mrUsableProgress(cp)) return null;
    var closed = cp.closed === 'closed' || cp.closed === 'denied';
    // A closed or denied case has plain, non-interactive nodes (as the product).
    var interactive = !!r.case.stepDetail && !closed;
    var current = cp.currentPosition != null && !closed
      ? cp.steps.filter(function (st) { return st.position === cp.currentPosition; })[0] || null
      : null;
    var shownPos = interactive ? (mrState.stepOpen || (current && current.position) || null) : null;
    var shown = shownPos ? cp.steps.filter(function (st) { return st.position === shownPos; })[0] || null : null;

    var card = el('section', 'mr-cp');
    card.setAttribute('aria-label', 'Case progress');

    // Header: label + "N of M steps done · P%" (percent only when supplied).
    var head = el('div', 'mr-cp-head');
    head.appendChild(el('span', 'mr-caps', 'Case progress'));
    var summary = cp.doneCount + ' of ' + cp.totalSteps + ' steps done';
    if (typeof cp.percentComplete === 'number') summary += ' · ' + cp.percentComplete + '%';
    var sumEl = el('span', 'mr-cp-summary', summary);
    sumEl.id = 'mr-cp-summary';
    head.appendChild(sumEl);
    card.appendChild(head);

    // Rail: one node per step, joined by a line filled up to the current step
    // (or, on a closed case, to the last done step).
    var n = cp.steps.length;
    var rail = el('ol', 'mr-cp-rail');
    rail.setAttribute('aria-label', 'Case steps');
    css(rail, { gridTemplateColumns: 'repeat(' + n + ', minmax(0, 1fr))' });
    var track = el('div', 'mr-cp-track');
    track.setAttribute('aria-hidden', 'true');
    css(track, { left: 'calc(100% / ' + (2 * n) + ')', right: 'calc(100% / ' + (2 * n) + ')' });
    var fillTo = current ? current.position : cp.doneCount;
    var fill = el('div', 'mr-cp-fill');
    css(fill, { width: n > 1 && fillTo > 1 ? ((Math.min(fillTo, n) - 1) / (n - 1)) * 100 + '%' : '0%' });
    track.appendChild(fill);
    rail.appendChild(track);
    cp.steps.forEach(function (st) {
      var li = el('li', 'mr-cp-node');
      var isCur = !!(current && st.position === current.position);
      var dot = mrStepDot(cp, st, isCur, interactive);
      if (interactive) {
        var nb = el('button', 'mr-cp-node-btn' + (shownPos === st.position ? ' is-shown' : ''));
        nb.type = 'button';
        nb.id = 'mr-cp-node-' + st.position;
        nb.setAttribute('aria-label', mrStepName(cp, st));
        nb.setAttribute('aria-pressed', shownPos === st.position ? 'true' : 'false');
        if (isCur) nb.setAttribute('aria-current', 'step');
        nb.title = mrStepName(cp, st);
        nb.appendChild(dot);
        nb.addEventListener('click', function () { mrSelectStep(st.position, 'mr-cp-node-' + st.position); });
        li.appendChild(nb);
      } else {
        li.appendChild(dot);
      }
      rail.appendChild(li);
    });
    card.appendChild(rail);

    // The step panel (interactive) or the current step block. A denied case
    // shows its last step with the product's "Denied" badge; a closed case
    // shows no block (the product has no closed wording).
    var block = el('div', 'mr-cp-current');
    var line = el('div', 'mr-cp-current-head');
    if (cp.closed === 'denied') {
      var last = cp.steps[cp.steps.length - 1];
      line.appendChild(el('span', 'mr-cp-current-title', 'Step ' + last.position + ' of ' + cp.totalSteps + ': ' + last.title));
      line.appendChild(mrChip(MR_STEP_STATUS.denied.label, MR_STEP_STATUS.denied.chip));
      block.appendChild(line);
    } else if (!closed) {
      var st0 = interactive ? shown : current;
      if (st0) {
        var title = el(interactive ? 'h3' : 'span', 'mr-cp-current-title', 'Step ' + st0.position + ' of ' + cp.totalSteps + ': ' + st0.title);
        line.appendChild(title);
        line.appendChild(mrChip(MR_STEP_STATUS[st0.status].label, MR_STEP_STATUS[st0.status].chip));
        block.appendChild(line);
        if (st0.description) block.appendChild(el('p', 'mr-cp-desc', st0.description));
        if (interactive) {
          block.classList.add('mr-step-panel');
          block.id = 'mr-step-panel';
          block.tabIndex = -1;
          block.setAttribute('role', 'region');
          block.setAttribute('aria-label', 'Step ' + st0.position + ': ' + st0.title);
          mrStepBody(block, r, cp, st0);
        }
      }
    }
    if (block.firstChild) card.appendChild(block);

    // "See all N steps".
    var listId = 'mr-cp-all';
    var toggle = el('button', 'mr-cp-toggle', mrState.stepsOpen ? 'Hide all steps' : 'See all ' + n + ' steps');
    toggle.type = 'button';
    toggle.id = 'mr-cp-toggle';
    toggle.setAttribute('aria-expanded', mrState.stepsOpen ? 'true' : 'false');
    toggle.setAttribute('aria-controls', listId);
    toggle.addEventListener('click', function () {
      mrState.stepsOpen = !mrState.stepsOpen;
      mrRender();
      var again = $('mr-cp-toggle');
      if (again) again.focus();
    });
    card.appendChild(toggle);

    var list = el('ol', 'mr-cp-list');
    list.id = listId;
    list.hidden = !mrState.stepsOpen;
    if (mrState.stepsOpen) {
      cp.steps.forEach(function (st) {
        var row = el('li', 'mr-cp-row');
        var inner = row;
        if (interactive) {
          inner = el('button', 'mr-cp-row-btn' + (shownPos === st.position ? ' is-shown' : ''));
          inner.type = 'button';
          inner.id = 'mr-cp-row-' + st.position;
          inner.setAttribute('aria-pressed', shownPos === st.position ? 'true' : 'false');
          inner.addEventListener('click', function () { mrSelectStep(st.position, 'mr-step-panel'); });
          row.appendChild(inner);
        }
        inner.appendChild(mrStepDot(cp, st, current && st.position === current.position, interactive));
        var text = el(interactive ? 'span' : 'div', 'mr-cp-row-text');
        var top = el(interactive ? 'span' : 'div', 'mr-cp-row-head');
        top.appendChild(el('span', 'mr-cp-row-title', (interactive ? 'Step ' + st.position + ': ' : '') + st.title));
        var shownSt = MR_STEP_STATUS[mrShownStatus(cp, st)];
        top.appendChild(mrChip(shownSt.label, shownSt.chip));
        text.appendChild(top);
        if (st.description) text.appendChild(el(interactive ? 'span' : 'p', 'mr-cp-desc', st.description));
        inner.appendChild(text);
        list.appendChild(row);
      });
    }
    card.appendChild(list);
    return card;
  }

  // ---- Writes: the shared save pattern (actionable addendum, 2026-10-30) ---
  // Every write goes through mrAsk(): a bar at the top of the modal (or of the
  // open dialog) asks the question with Confirm / Cancel, then shows "Saving
  // to FrontRunner…", then "Saved to FrontRunner." or the error with "Try
  // again". `apply` changes the tab's copy of the envelope ONLY after the
  // server says the save succeeded, so nothing on screen changes before that.
  // The door is POST /api/medicaid-renewal/:patientId/actions/:action
  // (server.js → lib/medicaid-renewal-actions.js): a live write where the
  // platform has one, a typed `not_available` failure where it does not, and
  // a SIMULATED save (said so on screen) for a sample patient.
  // ?medicaidSimulateFailure=1 makes a sample save fail, to review the error.

  var MR_COLUMN_LABELS = {
    medicaid_eligible: 'Medicaid Eligible',
    aca_marketplace: 'ACA / Marketplace Eligible',
    no_longer_eligible: 'No Longer Eligible',
    unknown_screening: 'Unknown / Needs Screening',
  };
  // The product's case status words (board-api.ts CASE_STATUS_LABELS);
  // `closed` is left out: the final close stays in FrontRunner.
  var MR_CASE_STATUSES = [
    { id: 'new', label: 'New' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'submitted', label: 'Submitted' },
  ];

  function mrFailParam() {
    try {
      return new URLSearchParams(window.location.search).get('medicaidSimulateFailure') === '1';
    } catch (e) {
      return false;
    }
  }

  function mrFirstName() {
    var identity = (mrState.envelope && mrState.envelope.identity) || {};
    return identity.firstName || 'the patient';
  }

  function mrFocus(id) {
    var n = $(id);
    if (n && !n.disabled) n.focus();
  }

  function mrPostAction(action, payload) {
    var patientId = mrState.key.split('|')[0];
    var body = { payload: payload || {} };
    var sample = mrSampleParam();
    if (sample) body.sample = sample;
    if (mrFailParam()) body.simulateFailure = true;
    return fetch('/api/medicaid-renewal/' + encodeURIComponent(patientId) + '/actions/' + encodeURIComponent(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // opts: { question, action, payload, apply(renewal, result), scope:
  // 'tab' | 'dialog', returnFocus: element id }.
  function mrAsk(opts) {
    if (mrState.save && mrState.save.phase === 'saving') return;
    mrState.save = Object.assign({ phase: 'confirm', scope: 'tab' }, opts);
    mrRender();
    mrFocus('mr-save-confirm');
  }

  function mrSaveRun() {
    var state = mrState;
    var s = state.save;
    if (!s) return;
    s.phase = 'saving';
    s.error = null;
    mrRender();
    mrFocus('mr-save-status');
    mrPostAction(s.action, s.payload).then(function (out) {
      if (mrState !== state || state.save !== s) return;
      if (out && out.ok) {
        if (s.apply) s.apply(state.envelope.renewal, out);
        s.phase = 'saved';
        s.simulated = !!out.simulated;
      } else {
        s.phase = 'error';
        s.error = (out && out.error) || { code: 'unknown' };
        console.warn('[NextGen-embed] Medicaid Renewal ' + s.action + ' not saved: ' + s.error.code);
      }
      mrRender();
      mrFocus(s.phase === 'saved' ? 'mr-save-status' : 'mr-save-retry');
    }).catch(function (err) {
      if (mrState !== state || state.save !== s) return;
      console.warn('[NextGen-embed] Medicaid Renewal ' + s.action + ' request failed: ' + (err && err.message ? err.message : err));
      s.phase = 'error';
      s.error = { code: 'transport' };
      mrRender();
      mrFocus('mr-save-retry');
    });
  }

  function mrSaveClose() {
    var s = mrState.save;
    mrState.save = null;
    mrRender();
    if (s && s.returnFocus) mrFocus(s.returnFocus);
  }

  // The bar, for one scope. Null when there is nothing to show there.
  function mrSaveBar(scope) {
    var s = mrState.save;
    if (!s || s.scope !== scope) return null;
    var bar = el('div', 'mr-savebar is-' + s.phase);
    var text = el('div', 'mr-savebar-text');
    text.id = 'mr-save-status';
    text.tabIndex = -1;
    bar.appendChild(text);
    var actions = el('div', 'mr-actions');
    if (s.phase === 'confirm') {
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Confirm change');
      text.textContent = s.question;
      var yes = mrButton('Confirm', 'btn-primary', mrSaveRun);
      yes.id = 'mr-save-confirm';
      var no = mrButton('Cancel', null, mrSaveClose);
      no.id = 'mr-save-cancel';
      actions.appendChild(yes);
      actions.appendChild(no);
      bar.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mrSaveClose(); }
      });
    } else if (s.phase === 'saving') {
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-busy', 'true');
      text.textContent = 'Saving to FrontRunner…';
    } else if (s.phase === 'saved') {
      bar.setAttribute('role', 'status');
      text.textContent = s.simulated
        ? 'Saved (sample data — nothing was sent to FrontRunner).'
        : 'Saved to FrontRunner.';
      var ok = mrButton('Dismiss', null, mrSaveClose);
      ok.id = 'mr-save-dismiss';
      actions.appendChild(ok);
    } else {
      bar.setAttribute('role', 'alert');
      var e = s.error || {};
      var partial = typeof e.completedWrites === 'number' && e.completedWrites > 0;
      text.textContent = partial
        ? 'Couldn’t save everything to FrontRunner. ' + e.completedWrites + ' of ' + e.totalWrites +
          ' changes were saved; open the case in FrontRunner to check.'
        : 'Couldn’t save to FrontRunner. Nothing was changed.';
      var why = e.code === 'not_available' ? 'This action isn’t connected to FrontRunner yet.'
        : e.code === 'invalid_input' && e.message ? e.message
        : e.code === 'not_configured' ? 'Live Medicaid data isn’t connected in this build.'
        : e.code === 'no_case' ? 'This patient has no case in FrontRunner.'
        : e.code === 'simulated_failure' ? 'Simulated failure (sample data).' : null;
      if (why) bar.appendChild(el('div', 'mr-savebar-detail', why));
      var again = mrButton('Try again', 'btn-primary', mrSaveRun);
      again.id = 'mr-save-retry';
      actions.appendChild(again);
      var close = mrButton('Dismiss', null, mrSaveClose);
      close.id = 'mr-save-dismiss';
      actions.appendChild(close);
    }
    if (actions.firstChild) bar.appendChild(actions);
    return bar;
  }

  // While a save is in flight, every other write control waits.
  function mrBusy() {
    return !!(mrState.save && mrState.save.phase === 'saving');
  }

  // A native checkbox in a 44px label: role "checkbox", named by its text,
  // Space toggles it.
  function mrTick(id, label, checked, disabled, onChange) {
    var wrap = el('label', 'mr-tick' + (disabled ? ' is-readonly' : ''));
    wrap.setAttribute('for', id);
    var box = el('input', 'mr-tick-box');
    box.type = 'checkbox';
    box.id = id;
    box.checked = !!checked;
    box.disabled = !!disabled;
    if (onChange) box.addEventListener('change', function () { onChange(box.checked); });
    wrap.appendChild(box);
    wrap.appendChild(el('span', 'mr-tick-label', label));
    return wrap;
  }

  function mrTextField(id, label, value, opts, onInput) {
    var wrap = el('label', 'mr-field');
    wrap.setAttribute('for', id);
    wrap.appendChild(el('span', 'mr-field-label', label));
    var input = el(opts && opts.multiline ? 'textarea' : 'input', 'mr-input' + (opts && opts.multiline ? ' mr-textarea' : ''));
    if (opts && opts.multiline) input.rows = 3;
    else input.type = (opts && opts.type) || 'text';
    input.id = id;
    input.value = value || '';
    if (opts && opts.placeholder) input.placeholder = opts.placeholder;
    if (opts && opts.describedBy) input.setAttribute('aria-describedby', opts.describedBy);
    input.addEventListener('input', function () { onInput(input.value); });
    wrap.appendChild(input);
    return wrap;
  }

  // "Open in FrontRunner" — the case page, only when the server supplies its
  // address (FRONTRUNNER_APP_URL + a live case). Otherwise a disabled button
  // that says why; the address is never guessed.
  function mrOpenInFrontRunner(note) {
    var env = mrState.envelope || {};
    var url = env.links && env.links.caseUrl;
    var wrap = el('div', 'mr-fr');
    if (note) wrap.appendChild(el('p', 'mr-muted', note));
    if (url) {
      var a = el('a', 'btn mr-btn mr-btn-secondary mr-fr-link', 'Open in FrontRunner');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap.appendChild(a);
    } else {
      var b = mrButton('Open in FrontRunner', null, function () {});
      b.disabled = true;
      wrap.appendChild(b);
      wrap.appendChild(el('p', 'mr-footnote', 'The FrontRunner link isn’t set up for this patient.'));
    }
    return wrap;
  }

  // ---- Case and assignee controls --------------------------------------------

  function mrCaseControls(r) {
    if (!r.case) {
      var start = mrButton('Start case', 'btn-primary', function () {
        mrAsk({
          question: 'Start a Medicaid renewal case for ' + mrFirstName() + '?',
          action: 'startCase',
          payload: {},
          returnFocus: 'mr-start-case',
          apply: function (rn) {
            rn.case = { id: 'sample-started', stage: 'not_started', statusLabel: 'Not Started', assignee: null, caseStatus: 'new' };
            rn.outreach = { status: 'ok', attempts: [] };
          },
        });
      });
      start.id = 'mr-start-case';
      start.disabled = mrBusy();
      return [start];
    }
    var current = r.case.caseStatus || '';
    var opts = MR_CASE_STATUSES.slice();
    if (!current) opts.unshift({ id: '', label: 'Not available' });
    var sel = mrSelect('mr-case-status', 'Case status', opts, current, function (v) {
      if (!v || v === current) return;
      var label = MR_CASE_STATUSES.filter(function (x) { return x.id === v; })[0].label;
      mrAsk({
        question: 'Change the case status to ' + label + '?',
        action: 'caseStatus',
        payload: { status: v },
        returnFocus: 'mr-case-status',
        apply: function (rn) { rn.case.caseStatus = v; },
      });
    });
    sel.querySelector('select').disabled = mrBusy();
    return [sel];
  }

  function mrAssigneeControls(r) {
    if (!r.case) return [];
    var options = Array.isArray(r.case.assigneeOptions) ? r.case.assigneeOptions : [];
    if (!options.length) return [el('p', 'mr-footnote', 'Staff list not available yet.')];
    var currentName = r.case.assignee && r.case.assignee.name ? r.case.assignee.name : '';
    var names = options.slice();
    if (currentName && names.indexOf(currentName) < 0) names.unshift(currentName);
    var opts = names.map(function (n) { return { id: n, label: n }; });
    if (!currentName) opts.unshift({ id: '', label: 'Unassigned' });
    var sel = mrSelect('mr-assignee', 'Assign to', opts, currentName, function (v) {
      if (!v || v === currentName) return;
      mrAsk({
        question: 'Assign this case to ' + v + '?',
        action: 'assignee',
        payload: { name: v },
        returnFocus: 'mr-assignee',
        apply: function (rn) { rn.case.assignee = { name: v }; },
      });
    });
    sel.querySelector('select').disabled = mrBusy();
    return [sel];
  }

  // ---- Member ID fix -----------------------------------------------------------

  var MR_MEMBER_ID = /^A[0-9]{8}$/;

  function mrMemberIdFix(warn) {
    var errId = 'mr-member-id-error';
    var form = el('div', 'mr-member-fix');
    form.appendChild(mrTextField('mr-member-id', 'Correct member ID', mrState.memberIdDraft,
      { placeholder: 'A12345678', describedBy: mrState.memberIdError ? errId : null },
      function (v) { mrState.memberIdDraft = v; }));
    if (mrState.memberIdError) {
      var err = el('p', 'mr-field-error', mrState.memberIdError);
      err.id = errId;
      form.appendChild(err);
    }
    var save = mrButton('Save member ID', null, function () {
      var v = String(mrState.memberIdDraft || '').trim().toUpperCase();
      if (!MR_MEMBER_ID.test(v)) {
        mrState.memberIdError = 'Enter the letter A followed by eight digits.';
        mrRender();
        mrFocus('mr-member-id');
        return;
      }
      mrState.memberIdError = null;
      mrAsk({
        question: 'Save member ID ' + v + ' to the insurance record?',
        action: 'memberId',
        payload: { value: v },
        returnFocus: 'mr-member-id-save',
        apply: function (rn) {
          rn.memberId = { value: v, flagged: false, message: null };
          mrState.memberIdDraft = '';
        },
      });
    });
    save.id = 'mr-member-id-save';
    save.disabled = mrBusy();
    form.appendChild(save);
    warn.appendChild(form);
  }

  // ---- Confirm placement -------------------------------------------------------

  function mrRenderPlacement(b, r) {
    var choice = mrState.placementChoice || r.column;
    var opts = Object.keys(MR_COLUMN_LABELS).map(function (k) { return { id: k, label: MR_COLUMN_LABELS[k] }; });
    b.appendChild(el('p', 'mr-muted', 'Choose the board column for this patient. Confirming records it as staff confirmed.'));
    b.appendChild(mrSelect('mr-placement-col', 'Board column', opts, choice, function (v) {
      mrState.placementChoice = v;
    }));
    var go = mrButton('Confirm placement', 'btn-primary', function () {
      var col = mrState.placementChoice || r.column;
      mrAsk({
        question: 'Confirm placement in ' + MR_COLUMN_LABELS[col] + '?',
        action: 'confirmPlacement',
        payload: { column: col },
        returnFocus: 'mr-placement-go',
        apply: function (rn) {
          rn.column = col;
          rn.columnLabel = MR_COLUMN_LABELS[col];
          rn.placement = 'staff_confirmed';
          rn.result = { key: 'staff_confirmed', label: 'Staff-recorded outcome' };
          mrState.placementChoice = null;
        },
      });
    });
    go.id = 'mr-placement-go';
    go.disabled = mrBusy();
    b.appendChild(go);
  }

  // ---- Step panel (under the case progress rail) -------------------------------

  // Draft per step, seeded from the step's saved detail the first time the
  // step is opened. Drafts live on screen only until the step is saved.
  function mrDraft(pos, d) {
    if (mrState.drafts[pos]) return mrState.drafts[pos];
    var draft;
    if (pos === 1) draft = { ticks: Object.assign({}, d.verify.approvals) };
    else if (pos === 2) draft = { filter: 'qualifies', selected: d.programs.selected.slice() };
    else if (pos === 3) {
      draft = { received: {}, newDoc: '' };
      d.documents.items.forEach(function (it) { draft.received[it.id] = !!it.received; });
    } else if (pos === 4) draft = { ticks: { reviewed: !!d.workreq.reviewed, confirmed: !!d.workreq.confirmed } };
    else if (pos === 6) draft = { confirmation: d.submit.confirmation || '', note: d.submit.note || '' };
    else if (pos === 7) {
      draft = { checks: Object.assign({}, d.decision.checks), decision: d.decision.decision, note: d.decision.note || '' };
    } else draft = {};
    mrState.drafts[pos] = draft;
    return draft;
  }

  // After a step save: the step is done, the next is current, and the percent
  // is dropped until the product supplies the new one (never recomputed).
  function mrAdvance(rn, pos) {
    var cp = rn.case.caseProgress;
    cp.steps.forEach(function (st) {
      if (st.position === pos) st.status = 'done';
      if (st.position === pos + 1) st.status = 'in_progress';
    });
    cp.doneCount += 1;
    cp.currentPosition = pos + 1 <= cp.totalSteps ? pos + 1 : null;
    delete cp.percentComplete;
    delete mrState.drafts[pos];
    mrState.stepOpen = cp.currentPosition;
  }

  function mrSaveContinue(pos, enabled, payloadFn, applyFn) {
    var btn = mrButton('Save & Continue', 'btn-primary', function () {
      mrAsk({
        question: 'Save step ' + pos + ' and move to step ' + (pos + 1) + '?',
        action: 'saveStep',
        payload: payloadFn(),
        returnFocus: 'mr-step-panel',
        apply: function (rn) {
          applyFn(rn.case.stepDetail);
          mrAdvance(rn, pos);
        },
      });
    });
    btn.id = 'mr-step-save';
    btn.disabled = !enabled || mrBusy();
    return btn;
  }

  function mrStepBody(panel, r, cp, st) {
    var d = r.case.stepDetail;
    var pos = st.position;
    var isCurrent = cp.currentPosition === pos && !cp.closed;
    var isDone = st.status === 'done';
    if (!isCurrent && !isDone) {
      panel.appendChild(el('p', 'mr-step-locked',
        cp.currentPosition
          ? 'Finish step ' + cp.currentPosition + ' first. Later steps open once the one before is saved.'
          : 'This step is not open.'));
      return;
    }
    var ro = !isCurrent;
    if (isDone) panel.appendChild(el('p', 'mr-step-done', 'This step is done. To change it, open the case in FrontRunner.'));
    var draft = ro ? null : mrDraft(pos, d);
    var actions = el('div', 'mr-actions');

    if (pos === 1) {
      panel.appendChild(mrKv(d.verify.facts.map(function (f) { return [f.label, f.value]; })));
      var t1 = ro ? d.verify.approvals : draft.ticks;
      var group1 = el('div', 'mr-ticks');
      group1.setAttribute('role', 'group');
      group1.setAttribute('aria-label', 'Approvals');
      [['demographics', 'I approved the demographics information'],
        ['insurance', 'I approved the insurance information'],
        ['financial', 'I approved the financial information']].forEach(function (x) {
        group1.appendChild(mrTick('mr-s1-' + x[0], x[1], t1[x[0]], ro, function (v) {
          draft.ticks[x[0]] = v;
          var save = $('mr-step-save');
          if (save) save.disabled = !(draft.ticks.demographics && draft.ticks.insurance && draft.ticks.financial) || mrBusy();
        }));
      });
      panel.appendChild(group1);
      var checks = el('div', 'mr-actions');
      [['demographics', 'Check demographics'], ['eligibility', 'Check eligibility'], ['insurance', 'Replace insurance']].forEach(function (x) {
        var b = mrButton(x[1], null, function () { mrOpenDialog(x[0], 'mr-open-' + x[0]); });
        b.id = 'mr-open-' + x[0];
        checks.appendChild(b);
      });
      panel.appendChild(checks);
      if (!ro) {
        actions.appendChild(mrSaveContinue(1, t1.demographics && t1.insurance && t1.financial,
          function () { return { step: 1, ticks: Object.assign({}, draft.ticks) }; },
          function (sd) { sd.verify.approvals = Object.assign({}, draft.ticks); }));
      }
      panel.appendChild(actions);
      panel.appendChild(mrOpenInFrontRunner('The patient confirmation request and the per-field Review demographics and Review financials are in FrontRunner.'));
      return;
    }

    if (pos === 2) {
      var items = d.programs.items;
      var selected = ro ? d.programs.selected : draft.selected;
      if (ro) {
        var chosen = items.filter(function (it) { return selected.indexOf(it.code) >= 0; });
        panel.appendChild(mrKv([['Selected', chosen.map(function (it) { return it.name; }).join(', ') || 'None']]));
      } else {
        var counts = {
          qualifies: items.filter(function (it) { return it.group === 'qualifies'; }).length,
          needs_review: items.filter(function (it) { return it.group === 'needs_review'; }).length,
          all: items.length,
        };
        var filters = el('div', 'mr-filters');
        filters.setAttribute('role', 'group');
        filters.setAttribute('aria-label', 'Show programs');
        [['qualifies', 'Qualifies'], ['needs_review', 'Needs review'], ['all', 'All']].forEach(function (f) {
          var fb = mrButton(f[1] + ' ' + counts[f[0]], 'mr-filter' + (draft.filter === f[0] ? ' is-on' : ''), function () {
            draft.filter = f[0];
            mrRender();
            mrFocus('mr-s2-filter-' + f[0]);
          });
          fb.id = 'mr-s2-filter-' + f[0];
          fb.setAttribute('aria-pressed', draft.filter === f[0] ? 'true' : 'false');
          filters.appendChild(fb);
        });
        panel.appendChild(filters);
        var group2 = el('div', 'mr-ticks');
        group2.setAttribute('role', 'group');
        group2.setAttribute('aria-label', 'Programs');
        var count = el('p', 'mr-muted', draft.selected.length + ' selected');
        count.setAttribute('aria-live', 'polite');
        items.filter(function (it) { return draft.filter === 'all' || it.group === draft.filter; }).forEach(function (it) {
          group2.appendChild(mrTick('mr-s2-' + it.code, it.name + ' (' + it.code + ')', draft.selected.indexOf(it.code) >= 0, false, function (v) {
            var i = draft.selected.indexOf(it.code);
            if (v && i < 0) draft.selected.push(it.code);
            if (!v && i >= 0) draft.selected.splice(i, 1);
            count.textContent = draft.selected.length + ' selected';
            var save = $('mr-step-save');
            if (save) save.disabled = !draft.selected.length || mrBusy();
          }));
        });
        panel.appendChild(group2);
        panel.appendChild(count);
        actions.appendChild(mrSaveContinue(2, draft.selected.length > 0,
          function () { return { step: 2, programs: draft.selected.slice() }; },
          function (sd) { sd.programs.selected = draft.selected.slice(); }));
        panel.appendChild(actions);
      }
      panel.appendChild(mrOpenInFrontRunner('The full program list and plan details are in FrontRunner.'));
      return;
    }

    if (pos === 3) {
      var docs = d.documents.items;
      var rec = ro ? null : draft.received;
      var allIn = function () { return docs.every(function (it) { return rec[it.id]; }); };
      var group3 = el('div', 'mr-ticks');
      group3.setAttribute('role', 'group');
      group3.setAttribute('aria-label', 'Required documents received');
      docs.forEach(function (it) {
        group3.appendChild(mrTick('mr-s3-' + it.id, it.label + ' received', ro ? it.received : rec[it.id], ro, function (v) {
          rec[it.id] = v;
          var save = $('mr-step-save');
          if (save) save.disabled = !allIn() || mrBusy();
        }));
      });
      panel.appendChild(group3);
      if (!ro) {
        var add = el('div', 'mr-add-doc');
        add.appendChild(mrTextField('mr-s3-new', 'Add a required document', draft.newDoc, null, function (v) {
          draft.newDoc = v;
          var ab = $('mr-s3-add');
          if (ab) ab.disabled = !v.trim() || mrBusy();
        }));
        var addBtn = mrButton('Add document', null, function () {
          var label = draft.newDoc.trim();
          mrAsk({
            question: 'Add “' + label + '” to the required documents?',
            action: 'addDocument',
            payload: { label: label },
            returnFocus: 'mr-s3-new',
            apply: function (rn) {
              var id = 'added-' + (rn.case.stepDetail.documents.items.length + 1);
              rn.case.stepDetail.documents.items.push({ id: id, label: label, received: false });
              draft.received[id] = false;
              draft.newDoc = '';
            },
          });
        });
        addBtn.id = 'mr-s3-add';
        addBtn.disabled = !draft.newDoc.trim() || mrBusy();
        add.appendChild(addBtn);
        panel.appendChild(add);
        actions.appendChild(mrSaveContinue(3, allIn(),
          function () { return { step: 3, received: docs.filter(function (it) { return rec[it.id]; }).map(function (it) { return it.id; }) }; },
          function (sd) { sd.documents.items.forEach(function (it) { it.received = !!rec[it.id]; }); }));
        panel.appendChild(actions);
      }
      panel.appendChild(mrOpenInFrontRunner('Uploads, scans, electronic ID verification and other documents are in FrontRunner.'));
      return;
    }

    if (pos === 4) {
      panel.appendChild(mrKv([['Staff determination', d.workreq.determination || '—']]));
      var t4 = ro ? d.workreq : draft.ticks;
      var group4 = el('div', 'mr-ticks');
      group4.setAttribute('role', 'group');
      group4.setAttribute('aria-label', 'Work requirement checks');
      [['reviewed', 'I reviewed the work-requirement evidence'],
        ['confirmed', 'I confirmed compliance or an exemption']].forEach(function (x) {
        group4.appendChild(mrTick('mr-s4-' + x[0], x[1], t4[x[0]], ro, function (v) {
          draft.ticks[x[0]] = v;
          var save = $('mr-step-save');
          if (save) save.disabled = !(draft.ticks.reviewed && draft.ticks.confirmed) || mrBusy();
        }));
      });
      panel.appendChild(group4);
      if (!ro) {
        actions.appendChild(mrSaveContinue(4, t4.reviewed && t4.confirmed,
          function () { return { step: 4, ticks: Object.assign({}, draft.ticks) }; },
          function (sd) { sd.workreq.reviewed = true; sd.workreq.confirmed = true; }));
        panel.appendChild(actions);
      }
      panel.appendChild(mrOpenInFrontRunner('Replacing the determination, evidence documents, hours and the state submission package are in FrontRunner.'));
      return;
    }

    if (pos === 5) {
      var list = el('ul', 'mr-log');
      d.prepare.pdfs.forEach(function (pdf) {
        var li = el('li', 'mr-pdf-row');
        li.appendChild(el('span', 'mr-log-main', pdf.name));
        li.appendChild(pdf.status === 'generated'
          ? mrChip('Generated', 'mr-chip-success') : mrChip('Not generated', 'mr-chip-neutral'));
        list.appendChild(li);
      });
      panel.appendChild(list);
      if (!ro) panel.appendChild(el('p', 'mr-muted', 'This step finishes on its own when every PDF is generated.'));
      panel.appendChild(mrOpenInFrontRunner('Generate, preview, download and print the forms in FrontRunner.'));
      return;
    }

    if (pos === 6) {
      panel.appendChild(mrKv([['Attestation', d.submit.attestation || '—'], ['Packet', d.submit.packet || '—']]));
      if (ro) {
        panel.appendChild(mrKv([
          ['State case / confirmation #', d.submit.confirmation || '—'],
          ['Submission note', d.submit.note || '—'],
        ]));
      } else {
        panel.appendChild(mrTextField('mr-s6-conf', 'State case / confirmation # (optional)', draft.confirmation, null,
          function (v) { draft.confirmation = v; }));
        panel.appendChild(mrTextField('mr-s6-note', 'Submission note (optional)', draft.note, { multiline: true },
          function (v) { draft.note = v; }));
        var rec6 = mrButton('Record submission', 'btn-primary', function () {
          var conf = draft.confirmation.trim();
          var note = draft.note.trim();
          mrAsk({
            question: 'Record the submission and move to step 7?',
            action: 'recordSubmission',
            payload: { confirmation: conf, note: note },
            returnFocus: 'mr-step-panel',
            apply: function (rn) {
              rn.case.stepDetail.submit.confirmation = conf;
              rn.case.stepDetail.submit.note = note;
              mrAdvance(rn, 6);
            },
          });
        });
        rec6.id = 'mr-step-save';
        rec6.disabled = mrBusy();
        actions.appendChild(rec6);
        panel.appendChild(actions);
      }
      panel.appendChild(mrOpenInFrontRunner('Download the packet in FrontRunner. The patient signs the attestation in the portal.'));
      return;
    }

    // Step 7: nothing required; saves what is entered. The outcome and the
    // final close stay in FrontRunner.
    var saved7 = d.decision;
    var hasInput = function () {
      return draft.checks.checkedStatus !== !!saved7.checks.checkedStatus ||
        draft.checks.answeredRequests !== !!saved7.checks.answeredRequests ||
        draft.checks.reviewedServices !== !!saved7.checks.reviewedServices ||
        draft.decision !== saved7.decision || draft.note.trim() !== (saved7.note || '');
    };
    var refresh7 = function () {
      var s = $('mr-step-save');
      if (s) s.disabled = !hasInput() || mrBusy();
    };
    var group7 = el('div', 'mr-ticks');
    group7.setAttribute('role', 'group');
    group7.setAttribute('aria-label', 'Follow-up');
    [['checkedStatus', 'I checked the state case status'],
      ['answeredRequests', 'I answered the state’s information requests'],
      ['reviewedServices', 'I reviewed the available services with the patient']].forEach(function (x) {
      group7.appendChild(mrTick('mr-s7-' + x[0], x[1], draft.checks[x[0]], false, function (v) {
        draft.checks[x[0]] = v;
        refresh7();
      }));
    });
    panel.appendChild(group7);
    var fs = el('fieldset', 'mr-radios');
    fs.appendChild(el('legend', 'mr-field-label', 'State decision'));
    [['approved', 'Approved'], ['denied', 'Denied']].forEach(function (x) {
      var lab = el('label', 'mr-tick');
      lab.setAttribute('for', 'mr-s7-' + x[0]);
      var radio = el('input', 'mr-tick-box');
      radio.type = 'radio';
      radio.name = 'mr-s7-decision';
      radio.id = 'mr-s7-' + x[0];
      radio.checked = draft.decision === x[0];
      radio.addEventListener('change', function () { if (radio.checked) { draft.decision = x[0]; refresh7(); } });
      lab.appendChild(radio);
      lab.appendChild(el('span', 'mr-tick-label', x[1]));
      fs.appendChild(lab);
    });
    panel.appendChild(fs);
    panel.appendChild(mrTextField('mr-s7-note', 'Closing note', draft.note, { multiline: true }, function (v) {
      draft.note = v;
      refresh7();
    }));
    var save7 = mrButton('Save follow-up & decision', 'btn-primary', function () {
      var snap = { checks: Object.assign({}, draft.checks), decision: draft.decision, note: draft.note.trim() };
      mrAsk({
        question: 'Save the follow-up and decision?',
        action: 'followUp',
        payload: snap,
        returnFocus: 'mr-step-panel',
        apply: function (rn) { rn.case.stepDetail.decision = snap; },
      });
    });
    save7.id = 'mr-step-save';
    save7.disabled = !hasInput() || mrBusy();
    actions.appendChild(save7);
    panel.appendChild(actions);
    panel.appendChild(mrOpenInFrontRunner('The outcome and the final close are in FrontRunner.'));
  }

  // ---- Step 1 dialogs (in the sidecar) ------------------------------------------

  function mrOpenDialog(kind, returnFocus) {
    if (mrBusy()) return;
    if (mrState.save && mrState.save.scope === 'tab' && mrState.save.phase !== 'saving') mrState.save = null;
    mrState.dialog = { kind: kind, returnFocus: returnFocus, result: null, draft: { payer: '', memberId: '', group: '', effectiveDate: '' } };
    mrRender();
    var first = document.querySelector('#mr-dialog input, #mr-dialog button');
    if (first) first.focus();
  }

  function mrCloseDialog() {
    if (mrBusy()) return;
    var dlg = mrState.dialog;
    mrState.dialog = null;
    if (mrState.save && mrState.save.scope === 'dialog') mrState.save = null;
    mrRender();
    if (dlg && dlg.returnFocus) mrFocus(dlg.returnFocus);
  }

  function mrRenderDialog(root, r) {
    var dlg = mrState.dialog;
    var verify = r.case && r.case.stepDetail && r.case.stepDetail.verify;
    if (!dlg || !verify) return;
    var titles = { demographics: 'Check demographics', eligibility: 'Check eligibility', insurance: 'Replace insurance' };
    var backdrop = el('div', 'mr-dialog-backdrop');
    var box = el('div', 'mr-dialog');
    box.id = 'mr-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'mr-dialog-title');
    var bar = mrSaveBar('dialog');
    if (bar) box.appendChild(bar);
    box.appendChild(el('h3', 'mr-dialog-title', titles[dlg.kind]));
    box.lastChild.id = 'mr-dialog-title';
    var actions = el('div', 'mr-actions');

    if (dlg.kind === 'demographics' || dlg.kind === 'eligibility') {
      var check = verify.checks[dlg.kind];
      box.appendChild(el('p', 'mr-why-lead', dlg.kind === 'demographics'
        ? 'Run the vendor demographics check for this patient.'
        : 'Real-time 270/271 on the patient’s current coverage, for today.'));
      var rows = [['Source', dlg.kind === 'demographics' ? 'Vendor demographics check' : 'Real-time eligibility (270/271)']];
      if (dlg.kind === 'eligibility') rows.push(['Plan', check.plan || '—']);
      rows.push([dlg.kind === 'demographics' ? 'Last run' : 'Last check', mrFormatDate(check.lastRun) || 'Never']);
      box.appendChild(mrKv(rows));
      if (dlg.result) {
        box.appendChild(el('div', 'mr-caps', 'Sample result'));
        box.appendChild(mrKv(dlg.result.map(function (x) { return [x.label, x.value]; })));
      }
      var run = mrButton(dlg.kind === 'demographics' ? 'Run demographics check' : 'Run eligibility check', 'btn-primary', function () {
        mrAsk({
          scope: 'dialog',
          question: dlg.kind === 'demographics' ? 'Run the demographics check now?' : 'Run the eligibility check now?',
          action: dlg.kind === 'demographics' ? 'checkDemographics' : 'checkEligibility',
          payload: {},
          returnFocus: 'mr-dialog-run',
          apply: function (rn, out) {
            // A real result's fields come from the platform (a gap); only a
            // sample run shows the labelled sample result.
            if (out.simulated) dlg.result = check.result;
          },
        });
      });
      run.id = 'mr-dialog-run';
      run.disabled = mrBusy();
      actions.appendChild(run);
      var close = mrButton('Close', null, mrCloseDialog);
      close.id = 'mr-dialog-close';
      close.disabled = mrBusy();
      actions.appendChild(close);
    } else {
      var dr = dlg.draft;
      box.appendChild(el('p', 'mr-why-lead', 'The previous primary is terminated as of the new effective date, then the new coverage becomes primary as of the new effective date, then eligibility is checked on the new coverage.'));
      var ready = function () { return !!(dr.payer.trim() && /^\d{4}-\d{2}-\d{2}$/.test(dr.effectiveDate)); };
      var refresh = function () {
        var s = $('mr-dialog-run');
        if (s) s.disabled = !ready() || mrBusy();
      };
      box.appendChild(mrTextField('mr-ins-payer', 'Payer', dr.payer, { placeholder: 'Search active payers' }, function (v) { dr.payer = v; refresh(); }));
      box.appendChild(mrTextField('mr-ins-member', 'Member ID', dr.memberId, null, function (v) { dr.memberId = v; }));
      box.appendChild(mrTextField('mr-ins-group', 'Group number', dr.group, null, function (v) { dr.group = v; }));
      box.appendChild(mrTextField('mr-ins-date', 'Effective date', dr.effectiveDate, { type: 'date' }, function (v) { dr.effectiveDate = v; refresh(); }));
      if (dlg.result) {
        box.appendChild(el('div', 'mr-caps', 'Sample result'));
        box.appendChild(mrKv(dlg.result.map(function (x) { return [x.label, x.value]; })));
      }
      var saveIns = mrButton('Save and check', 'btn-primary', function () {
        var payload = { payer: dr.payer.trim(), memberId: dr.memberId.trim(), groupNumber: dr.group.trim(), effectiveDate: dr.effectiveDate };
        mrAsk({
          scope: 'dialog',
          question: 'Replace the primary insurance with ' + payload.payer + ' from ' + mrFormatDate(payload.effectiveDate) + '?',
          action: 'replaceInsurance',
          payload: payload,
          returnFocus: 'mr-dialog-run',
          apply: function (rn, out) {
            if (out.simulated) dlg.result = verify.checks.eligibility.result;
          },
        });
      });
      saveIns.id = 'mr-dialog-run';
      saveIns.disabled = !ready() || mrBusy();
      actions.appendChild(saveIns);
      var cancel = mrButton('Cancel', null, mrCloseDialog);
      cancel.id = 'mr-dialog-close';
      cancel.disabled = mrBusy();
      actions.appendChild(cancel);
    }
    box.appendChild(actions);

    // Escape closes (not while saving, and not while the confirm bar is up:
    // there Escape cancels the confirm). Tab stays inside the dialog.
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        mrCloseDialog();
        return;
      }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(box.querySelectorAll('button, input, select, textarea, [tabindex="0"]'),
        function (n) { return !n.disabled; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    backdrop.appendChild(box);
    root.appendChild(backdrop);
  }

  function mrRenderScreening(b, r) {
    var s = r.screening || { status: 'none' };
    if (mrState.screeningRetrying) {
      b.appendChild(el('p', 'mr-muted', 'Loading screening results…'));
      return;
    }
    if (s.status === 'error') {
      b.appendChild(el('p', 'mr-muted', 'Couldn’t load screening results. The rest of this tab is up to date.'));
      b.appendChild(mrButton('Try again', null, function () {
        mrState.screeningRetrying = true;
        mrLoad({ keepEnvelope: true });
      }));
      return;
    }
    if (s.status !== 'available' || !s.results || !s.results.length) {
      b.appendChild(el('p', 'mr-muted', 'No engine run on this case yet. Results appear here after staff run the engine.'));
    } else {
      b.appendChild(el('p', 'mr-muted', 'Source: engine run, ' + (mrFormatDate(s.ranAt) || 'date unknown')));
      b.appendChild(mrKv(s.results.map(function (x) { return [x.label, x.value]; })));
    }
    b.appendChild(el('p', 'mr-footnote', 'Engine results are for staff review.'));
  }

  function mrSelect(id, label, options, value, onChange) {
    var wrap = el('label', 'mr-field');
    wrap.setAttribute('for', id);
    wrap.appendChild(el('span', 'mr-field-label', label));
    var sel = el('select', 'mr-input');
    sel.id = id;
    options.forEach(function (o) {
      var opt = el('option', null, o.label);
      opt.value = o.id;
      if (o.id === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    wrap.appendChild(sel);
    return wrap;
  }

  function mrRenderComms(b, r, identity) {
    var c = mrState.comms;
    var firstName = identity.firstName || null;
    if (c.message == null) c.message = mrTemplateText(c.template, firstName, r.renewalDate);

    // The product's subtitle and intro for this panel.
    b.appendChild(el('p', 'mr-comms-sub', 'Email · SMS · portal'));
    b.appendChild(el('p', 'mr-muted', 'The same conversation as the Patient Communications inbox. A message sent here also counts as the step 7 status update.'));
    var ch = MR_CHANNELS.filter(function (x) { return x.id === c.channel; })[0] || MR_CHANNELS[0];

    b.appendChild(mrSelect('mr-channel', 'Channel', MR_CHANNELS, c.channel, function (v) {
      // Re-render so the Send button and the Email-only Subject follow.
      c.channel = v;
      mrRender();
      var again = $('mr-channel');
      if (again) again.focus();
    }));
    b.appendChild(mrSelect('mr-template', 'Template', MR_TEMPLATES, c.template, function (v) {
      c.template = v;
      c.message = mrTemplateText(v, firstName, r.renewalDate);
      mrRender();
      var again = $('mr-template');
      if (again) again.focus();
    }));
    if (ch.id === 'email') {
      // Email only, as in the product.
      var subj = el('input', 'mr-input');
      subj.type = 'text';
      subj.id = 'mr-subject';
      subj.placeholder = 'Subject';
      subj.setAttribute('aria-label', 'Subject');
      subj.value = c.subject;
      subj.addEventListener('input', function () { c.subject = subj.value; });
      b.appendChild(subj);
    }
    var msgWrap = el('label', 'mr-field');
    msgWrap.setAttribute('for', 'mr-message');
    msgWrap.appendChild(el('span', 'mr-field-label', 'Message'));
    var ta = el('textarea', 'mr-input mr-textarea');
    ta.id = 'mr-message';
    ta.rows = 4;
    ta.placeholder = 'Write a message';
    ta.value = c.message;
    msgWrap.appendChild(ta);
    b.appendChild(msgWrap);

    // "Send <channel>", the product's label. Sends after the confirm bar
    // (actionable addendum); the message joins the sent log only once the
    // send succeeds.
    var sendBtn = mrButton('Send ' + ch.label, 'btn-primary', function () {
      var msg = c.message.trim();
      var subject = ch.id === 'email' ? c.subject.trim() : '';
      var channel = ch.id;
      mrAsk({
        question: 'Send this ' + ch.label + ' message to ' + mrFirstName() + '?',
        action: 'send',
        payload: { channel: channel, subject: subject, message: msg },
        returnFocus: 'mr-send',
        apply: function (rn) {
          var o = rn.outreach && rn.outreach.status === 'ok' ? rn.outreach : { status: 'ok', attempts: [] };
          o.attempts = (o.attempts || []).concat([{
            id: 'local-' + Date.now(), channel: channel, status: 'sent',
            subject: subject || null, attemptedAt: new Date().toISOString(),
          }]);
          rn.outreach = o;
          c.subject = '';
          c.message = null;
        },
      });
    });
    sendBtn.id = 'mr-send';
    var canSend = !!r.case && c.message.trim().length > 0;
    sendBtn.disabled = !canSend || mrBusy();
    ta.addEventListener('input', function () {
      c.message = ta.value;
      sendBtn.disabled = !(r.case && ta.value.trim().length > 0) || mrBusy();
    });
    var actionsRow = el('div', 'mr-actions');
    actionsRow.appendChild(sendBtn);
    b.appendChild(actionsRow);
    if (!r.case) {
      b.appendChild(el('p', 'mr-footnote', 'Messages are logged on the case. Start a case first.'));
    }

    // Sent on this case.
    b.appendChild(el('div', 'mr-caps mr-log-head', 'Sent on this case'));
    var o = r.outreach || { status: 'no_case', attempts: [] };
    if (o.status === 'error') {
      b.appendChild(el('p', 'mr-muted', 'Couldn’t load messages sent on this case.'));
    } else if (!o.attempts || !o.attempts.length) {
      b.appendChild(el('p', 'mr-muted', 'Nothing sent yet.'));
    } else {
      var list = el('ul', 'mr-log');
      o.attempts.forEach(function (a) {
        var chLabel = (MR_CHANNELS.filter(function (x) { return x.id === a.channel; })[0] || {}).label || a.channel || 'Message';
        var li = el('li', 'mr-log-row');
        li.appendChild(el('span', 'mr-log-main', chLabel + (a.subject ? ' · ' + a.subject : '')));
        // Thread status: the product chip where the platform status maps to
        // one exactly ("failed" → "Failed"). The product's "Received" and
        // "Not yet seen in portal" have no platform status (frhc-platform
        // outreach statuses: sent / generated / failed / blocked), so other
        // statuses stay as recorded.
        var sub = el('span', 'mr-log-sub');
        if (a.status === 'failed') sub.appendChild(mrChip('Failed', 'mr-chip-destructive'));
        var subText = [a.status === 'failed' ? null : a.status, mrFormatSentAt(a.attemptedAt)].filter(Boolean).join(' · ');
        if (subText) sub.appendChild(document.createTextNode((a.status === 'failed' ? ' ' : '') + subText));
        li.appendChild(sub);
        list.appendChild(li);
      });
      b.appendChild(list);
    }
  }

  // Tab navigation (Pre Check-In / Appointment / Clearline / Medicaid Renewal)
  // layered around the existing panels. The identity header stays global (above
  // the bar); selecting a tab shows its panel and hides the others. Built + styled entirely via css()
  // (CSSOM) so the embed's strict CSP is respected — no inline styles.
  function wireTabs() {
    var profile = $('state-profile');
    var panelPre = $('tab-precheckin');
    var panelApt = $('tab-appointment');
    // Existence guard intentionally checks only the ORIGINAL two panels: it
    // exists to ensure the profile shell is in the DOM before insertBefore()
    // below. Additional panels (Clearline) are looked up generically inside
    // activate() via $(t.id), which already skips missing panels safely.
    if (!profile || !panelPre || !panelApt) return;
    if ($('tab-bar')) return; // idempotent

    var TABS = [
      { id: 'tab-precheckin', label: 'Pre Check-In' },
      { id: 'tab-appointment', label: 'Appointment' },
      // "Medicaid Renewal" (handoff 2026-10-21) replaces the one-word
      // "Medicaid". Fits on one line beside the other three at the 600px
      // panel; on a narrower panel the bar scrolls instead of wrapping.
      { id: 'tab-medicaid-renewal', label: 'Medicaid Renewal' },
    ];
    var buttons = {};

    var bar = el('div');
    bar.id = 'tab-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Patient sections');
    css(bar, {
      display: 'flex', gap: '4px', margin: '4px 0 16px',
      // The 1px baseline is an inset shadow, not a border: the active tab's
      // 2px underline paints over it inside the bar. With a border plus a -1px
      // tab margin, the bar's overflow clipped the underline to 1px.
      boxShadow: 'inset 0 -1px 0 ' + THEME.border,
      // At the 600px panel the four tabs fit on one line. On a narrower
      // panel the bar scrolls sideways; it never wraps. overflow-y is hidden
      // so no vertical scrollbar (the small up / down arrows of a classic
      // scrollbar) can appear: the bar never scrolls vertically.
      overflowX: 'auto', overflowY: 'hidden',
    });

    // Flat platform tab (style spec 2.2): no fill, no radius; the active tab
    // has a 2px green-600 bottom border. 44px tall from padding alone.
    var TAB_TEXT_ACTIVE = 'rgb(61 68 81)';
    var TAB_TEXT_INACTIVE = 'rgb(71 85 105)';
    function styleButton(btn, isActive) {
      css(btn, {
        appearance: 'none', border: 'none',
        borderBottom: '2px solid ' + (isActive ? '#16a34a' : 'transparent'),
        background: 'transparent',
        color: isActive ? TAB_TEXT_ACTIVE : TAB_TEXT_INACTIVE,
        fontWeight: isActive ? '600' : '500', fontSize: '14px', fontFamily: 'inherit',
        padding: '12px 14px', minHeight: '44px', cursor: 'pointer', lineHeight: '1.2',
        whiteSpace: 'nowrap', flex: 'none',
        borderRadius: '0',
        transition: 'border-color 0.15s ease, color 0.15s ease',
      });
    }

    function activate(targetId) {
      TABS.forEach(function (t) {
        var panel = $(t.id);
        var btn = buttons[t.id];
        var isActive = t.id === targetId;
        if (panel) panel.hidden = !isActive;
        if (btn) {
          btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          btn.tabIndex = isActive ? 0 : -1;
          styleButton(btn, isActive);
        }
      });
    }

    TABS.forEach(function (t) {
      var btn = el('button', null, t.label);
      btn.type = 'button';
      btn.id = 'tabbtn-' + t.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', t.id);
      styleButton(btn, false);
      btn.addEventListener('click', function () { activate(t.id); });
      btn.addEventListener('mouseenter', function () {
        if (btn.getAttribute('aria-selected') !== 'true') btn.style.color = TAB_TEXT_ACTIVE;
      });
      btn.addEventListener('mouseleave', function () {
        if (btn.getAttribute('aria-selected') !== 'true') btn.style.color = TAB_TEXT_INACTIVE;
      });
      buttons[t.id] = btn;
      bar.appendChild(btn);
    });

    profile.insertBefore(bar, panelPre);
    activate('tab-precheckin'); // default to Pre Check-In on load
  }

  // Collapsible "Show / Hide contact info" toggle inside the single Demographics
  // card. The contact rows are hidden by default and expand/collapse with a
  // smooth max-height + opacity transition. All styling is applied through the
  // css() (CSSOM) helper so the embed CSP (no inline styles) is respected.
  function wireContactToggle() {
    var toggle = $('contact-toggle');
    var collapse = $('contact-collapse');
    if (!toggle || !collapse) return;

    css(toggle, {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      marginTop: '12px', padding: '4px 0', background: 'none', border: 'none',
      color: THEME.teal, fontFamily: 'inherit', fontSize: '12px', fontWeight: '600',
      cursor: 'pointer', lineHeight: '1.2',
    });
    toggle.addEventListener('mouseenter', function () { toggle.style.color = THEME.navy; });
    toggle.addEventListener('mouseleave', function () { toggle.style.color = THEME.teal; });

    // Start collapsed: take it out of the `hidden` attribute (so it can animate)
    // but clamp height to 0 and fade it out.
    collapse.hidden = false;
    css(collapse, {
      overflow: 'hidden', maxHeight: '0px', opacity: '0',
      marginTop: '0px', paddingTop: '0px',
      transition: 'max-height 0.3s ease, opacity 0.3s ease, margin-top 0.3s ease, padding-top 0.3s ease',
    });

    // Padding added on expand; must be included in the animated max-height so
    // the last row (Emergency contact) is not clipped at the bottom.
    var EXPAND_PADDING_TOP = 12;

    // When expanding finishes, drop the max-height cap entirely so the section
    // can never clip its content if the layout reflows (e.g. long values wrap).
    collapse.addEventListener('transitionend', function (e) {
      if (e.propertyName === 'max-height' && expanded) {
        collapse.style.maxHeight = 'none';
      }
    });

    var expanded = false;
    toggle.addEventListener('click', function () {
      expanded = !expanded;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (expanded) {
        toggle.textContent = 'Hide contact info \u25B2';
        // Apply spacing first so scrollHeight reflects the final padded layout,
        // then add a small buffer to guarantee the Emergency line is visible.
        css(collapse, { opacity: '1', marginTop: '12px', paddingTop: EXPAND_PADDING_TOP + 'px' });
        css(collapse, { maxHeight: (collapse.scrollHeight + EXPAND_PADDING_TOP) + 'px' });
      } else {
        toggle.textContent = 'Show contact info \u25BC';
        // Re-apply a concrete max-height before collapsing so the transition has
        // a finite start value (it may currently be 'none' after expanding).
        css(collapse, { maxHeight: collapse.scrollHeight + 'px' });
        // Force reflow so the browser registers the start height before animating.
        void collapse.offsetHeight;
        css(collapse, { maxHeight: '0px', opacity: '0', marginTop: '0px', paddingTop: '0px' });
      }
    });
  }

  function wirePostData() {
    var btn = $('post-data-btn');
    if (!btn) return;
    btn.style.marginLeft = 'auto';
    btn.addEventListener('click', function () { openPostModal(); });

    // "Real-Time Verification" sits next to Post Data in the identity header.
    // Styled as a SECONDARY / outlined action to create visual hierarchy with
    // the primary "Post Data" button: transparent fill with a light outline and
    // white text (adapted for the dark navy header for readable contrast).
    // All styling goes through css() (CSSOM) so the embed CSP (no inline styles)
    // is respected.
    var rtvBtn = $('rtv-btn');
    if (rtvBtn) {
      var RTV_BORDER = 'rgba(255, 255, 255, 0.6)';
      var RTV_BORDER_HOVER = '#ffffff';
      css(rtvBtn, {
        background: 'transparent',
        borderColor: RTV_BORDER,
        color: '#ffffff',
      });
      rtvBtn.addEventListener('mouseenter', function () {
        css(rtvBtn, { background: 'rgba(255, 255, 255, 0.12)', borderColor: RTV_BORDER_HOVER });
      });
      rtvBtn.addEventListener('mouseleave', function () {
        css(rtvBtn, { background: 'transparent', borderColor: RTV_BORDER });
      });
      rtvBtn.addEventListener('click', function () { openRealTimeVerificationModal(); });
    }
  }

  function wireDemoControls() {
    var panel = $('demo-panel');
    if (panel) panel.hidden = !window.AthenaMessaging.isDemoMode;

    // Simple action buttons: data-method attribute names the API call.
    document.querySelectorAll('[data-method]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var method = btn.getAttribute('data-method');
        var fn = window.AthenaMessaging[method];
        if (typeof fn === 'function') {
          try {
            fn.call(window.AthenaMessaging, btn.getAttribute('data-arg') || undefined);
            flash(method + ' sent');
          } catch (e) {
            flash(e.message, true);
          }
        }
      });
    });

    // Resize buttons: data-width attribute.
    document.querySelectorAll('[data-width]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var width = Number(btn.getAttribute('data-width'));
        try {
          window.AthenaMessaging.appResize(width);
          flash('appResize(' + width + ') sent');
        } catch (e) {
          flash(e.message, true);
        }
      });
    });
  }

  var flashTimer = null;
  function flash(message, isError) {
    var out = $('demo-output');
    if (!out) return;
    out.textContent = message;
    out.classList.toggle('is-error', Boolean(isError));
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      out.textContent = '';
      out.classList.remove('is-error');
    }, 4000);
  }

  ready(function () {
    showState('state-waiting');
    wireDemoControls();
    wirePostData();
    wireCards();
    wireCardStatusDots();
    wireContactToggle();
    wireTabs();

    // Production tie-in (open question for athena, Friday meeting): whether
    // athenaOne actually pushes a patient-context message through the
    // Embedded App Messaging Framework in production. This listener is the
    // single entry point, so if the answer is yes, the Step-16 re-seed and
    // the 27B force-close-all-modals + context-change notice activate as-is.
    window.AthenaMessaging.onPatientContextChanged(function (context, meta) {
      if (!context.patientId) {
        // 28C: a CONTEXT-CLEARED signal (documented shape with updatedPatient
        // undefined — e.g. the user is on a non-patient page). Force-close
        // every open modal FIRST (27B registry — no modal may keep showing
        // the previous patient), NULL currentAthenaContext so any in-flight
        // fetch fails the stale-response guard below (a patient must NEVER
        // render after athena reported no context — architect finding), then
        // render the honest "waiting for patient context" state.
        // lastNonNullAthenaContext survives, so a follow-up with the SAME id
        // resumes that patient's working state; a DIFFERENT id takes the
        // full switch branch below.
        closeAllOpenModals();
        currentAthenaContext = null;
        showState('state-waiting');
        return;
      }
      // 28D: TRUE same-patient no-op — across ALL arrival-path combinations
      // (url-boot, documented athena shape, internal envelope, demo). athena
      // broadcasts patientContextChanged on EVERY patient-specific page load,
      // so launch-then-same-patient-broadcast is production's very first
      // sequence. Before 28D the guard below only skipped the RESET branch:
      // the message still re-fetched and re-rendered with the NEW context
      // object, whose raw.source is path-dependent — a source-less internal
      // envelope would strip the "Mock profile" tag and revert the header
      // from "athena Patient #N" to the mock name. Same patient while that
      // patient is ACTIVE (currentAthenaContext non-null: rendered or fetch
      // in flight) = return before ANY side effect: no force-close, no
      // notice, no re-seed, no re-render, no raw.source replacement, no
      // session-state loss. currentAthenaContext null (context-cleared or
      // failed fetch) falls through so the SAME id can resume/retry — the
      // reset branch below still skips re-seeding for it (28C semantics).
      // Ids are normalized at ONE chokepoint (normalizeContext in the
      // bridge), so this equality holds across paths and value types.
      if (currentAthenaContext && lastNonNullAthenaContext &&
          lastNonNullAthenaContext.patientId === context.patientId) {
        return;
      }
      // Step 16: a DIFFERENT patient means fresh verification state — the
      // previous patient's discovery result must not leak (their insurance was
      // found; this patient's wasn't). Same-patient refreshes keep the flag.
      // 27B: a SWITCH means a previous, different patient existed — initial
      // load enters the reset branch below too, but shows no notice and has
      // nothing to force-close.
      // 28C: switch/reset decisions compare against lastNonNullAthenaContext
      // (not currentAthenaContext, which a context-clear nulls) so returning
      // to the SAME patient after a clear resumes rather than re-seeds.
      var isPatientSwitch = !!(lastNonNullAthenaContext && lastNonNullAthenaContext.patientId !== context.patientId);
      if (!lastNonNullAthenaContext || lastNonNullAthenaContext.patientId !== context.patientId) {
        // 27B: force-close ANY open modal FIRST — before the re-seeds and the
        // re-render — so no modal ever renders against half-switched state.
        // ONE shared mechanism (the open-modal registry); each registered
        // closer clears its own timers/flags/callbacks. Same-patient
        // refreshes never reach this branch (no close, no notice).
        closeAllOpenModals();
        insuranceDiscovered = false;
        // Step 20: insurance verified-accumulator state is per-patient too —
        // a new patient starts on the pre-verification set until eligibility
        // runs for THEM (the launch auto-run may do so immediately if stale).
        insuranceAccumsVerified = false;
        insuranceVerifiedDate = null;
        // 29C (approved change #2 — cross-patient leak fix): rebuild EVERY
        // CHECKS entry from the frozen seed — dates AND results AND details AND
        // ranThisSession. The 29B dates-only reset preserved a pre-existing
        // leak where patient A's session-run outcomes (pass/warn/fail + detail
        // text) survived into patient B's view — a wrong-patient display masked
        // only by the single-profile mock. A new patient now starts on the full
        // deterministic seed (and the >30-day auto-run / >180-day re-verify
        // asks fire for THEM). The legacy views read through to the rebuilt
        // registry.
        //
        // ⚠ **CORRECTED 2026-08-12** — this comment previously ended "rtvHasRun
        // already resets below via the same fresh render." That was FALSE:
        // `rtvHasRun` had exactly one assignment in the file (`= true`) and no
        // reset ever existed (the 2026-07-21 audit confirmed it against git
        // history). It is reset explicitly below.
        //
        // (RTV History still deliberately NOT touched. ST-C5 §3 retires that
        // carve-out — history becomes platform-backed and per-patient, re-fetched
        // for the new patient from the canonical tables — but the prototype has
        // no platform-backed history to re-fetch; RTV History is still
        // session-local seed data. Implementing §3 here would mean inventing the
        // re-fetch, so it stays a V2 target rather than a half-built one.)
        CHECKS = checksFromSeed();
        // ST-C5 §1 / audit GAP-1: the RTV run flag is per-patient. With the
        // launch auto-run retired, resetting it fires NOTHING — patient B simply
        // gets a fresh staleness evaluation, which surfaces as a recommendation
        // row in the readiness header (ST-C5 §2, superseding the 07-23 AC "B's
        // eligibility auto-run fires fresh"). Zero check calls.
        rtvHasRun = false;
        // ST-C5 §1 / audit GAP-2: patient A's created estimates must never be
        // visible to patient B.
        GFE_ESTIMATES = gfeFromSeed();
        // ST-D1 §6: the manual-coverage-change signal is per-patient too, or B
        // would inherit A's "Insurance changed — run eligibility" recommendation.
        insuranceChangedManually = false;
        // Step 24D1: claims are per-patient too — a DIFFERENT patient starts
        // from the frozen seed (same-patient refreshes keep working-copy state,
        // which D3's Re-check will mutate).
        CLAIMS = claimsFromSeed();
        // Step 25B: appointments are per-patient too — a DIFFERENT patient
        // starts back on the nightly dataview (live-refresh state must not
        // leak between patients; same-patient refreshes keep the live set).
        APPOINTMENTS = appointmentsFromSeed();
        appointmentsRefreshedFromAthena = false;
        // Step 26D: posted-state is per-patient too — a DIFFERENT patient
        // starts with no posted-stamp and no athena-side reflections (the
        // previous patient's posts must not resolve THIS patient's diffs).
        ATHENA_POSTED_OVERRIDES = {};
        lastPostState = null;
        // STEP 34: Member Eligibility selection + lookup result are per-patient
        // too — the dropdown derives from THIS patient's packages, so patient
        // A's selection/result must not survive into patient B's card. (The
        // pre-34 free-text form state was never reset on switch; the derived
        // selection makes the leak patient-attributed, so the re-seed now
        // covers it.)
        memberEligSelectedRank = '';
        memberEligibilityResult = null;
        memberEligRetrievedAt = null;
        // 27B: 26D's bespoke Post-Data force-close MIGRATED into the shared
        // registry (forceClosePostModal, registered by showPostOverlay) — the
        // closeAllOpenModals() call at the top of this branch handles it; no
        // parallel mechanism remains here.
      }
      // Step 13: remember the athena context so refreshFrontRunnerData() can
      // re-invoke the FrontRunner fetch without re-resolving the launch context.
      currentAthenaContext = context;
      lastNonNullAthenaContext = context;
      showState('state-loading');
      setText('loading-patient-id', context.patientId);

      fetchPatient(context.patientId, context.encounterId)
        .then(function (payload) {
          // 27B (architect finding): STALE-RESPONSE GUARD — a rapid
          // double-switch can resolve the FIRST fetch after the second
          // context landed. currentAthenaContext is reassigned synchronously
          // per message, so reference equality identifies the latest request;
          // a stale response must produce NO side effect at all (no render,
          // no notify, no notice) — the final context always wins.
          if (currentAthenaContext !== context) return;
          warnOnRequestedPatientIdMismatch(payload, context);
          renderProfile(payload, context);
          // Rendering is NOT a patient-data change: athena's docs define
          // notifyPatientDataChange as "Triggers a reload of the main frame",
          // so sending it here would reload athenaOne after every launch and
          // context render — and a main-frame reload reboots this iframe,
          // which renders and notifies again (reload loop). The message is
          // only sent where the app actually writes data back to athena (the
          // Post Data completion path). This render log replaces it as the
          // stale-guard's observable signal (harness27b T11).
          (window.__athenaEmbedRenderLog = window.__athenaEmbedRenderLog || []).push({ patientId: context.patientId });
          // 27B: context-change notice — only on a DIFFERENT-patient switch
          // (never on initial load or same-patient refresh). The stale guard
          // above already ensures this names the LANDED patient.
          // 28C: for athena-source contexts the notice names the REAL id —
          // "now showing athena Patient #<id>" — never the mock name/MRN.
          if (isPatientSwitch && currentPatient) {
            if (isAthenaSourceContext(context)) {
              showPatientContextNotice('NextGen Patient #' + context.patientId, null);
            } else {
              showPatientContextNotice(currentPatient.name.full, bareMrn(currentPatient.mrn));
            }
          }
        })
        .catch(function (err) {
          // 27B: a STALE request's failure must not clobber the current
          // patient's view with the error state either.
          if (currentAthenaContext !== context) return;
          setText('error-message', err.message);
          showState('state-error');
          // 28D: a failed fetch leaves NO active patient — null the current
          // context so a re-broadcast of the SAME id is not swallowed by the
          // same-patient no-op guard and can retry the fetch.
          currentAthenaContext = null;
        });
    });

    // Patient context can arrive via URL parameters when the SMART on FHIR
    // launch redirects the provider here (/?practiceId=...&patientId=...).
    // When present, drive the UI from those authoritative values instead of the
    // built-in demo patient, regardless of embed state.
    var urlParams = new URLSearchParams(window.location.search);
    var urlPracticeId = urlParams.get('practiceId');
    var urlPatientId = urlParams.get('patientId');
    var urlEncounterId = urlParams.get('encounterId');
    // 28B: the server's /app SMART handoff appends source=athena to the params
    // above. Threading it into the context object switches the identity header
    // to the real-ID-first variant (real identity, mock capabilities) and the
    // bridge's capture origin to 'url-launch'. Absent the flag, this boot path
    // behaves exactly as before (explicit ?patientId= demo/testing use).
    var urlSource = urlParams.get('source') === 'athena' ? 'athena' : null;
    // Outbound postMessage target origin, threaded from the server's /app
    // handoff (environment config). The bridge validates it against the
    // athenahealth allowlist; absent (direct visits), outbound targeting
    // falls back to the bridge's inbound-capture/referrer logic.
    var urlAthenaOrigin = urlParams.get('athenaOrigin') || null;

    // 30B: capture the per-launch session handle into module state, then scrub
    // ONLY the session param from the visible URL (context params stay intact
    // so a reload still boots the same patient view — its guarded calls would
    // fail honestly with the relaunch message, which is the accepted
    // behavior). replaceState keeps history clean; no persistence anywhere.
    var urlSession = urlParams.get('session');
    if (urlSession) {
      currentSessionId = urlSession;
      try {
        urlParams.delete('session');
        var scrubbedQuery = urlParams.toString();
        var scrubbedUrl =
          window.location.pathname + (scrubbedQuery ? '?' + scrubbedQuery : '') + window.location.hash;
        window.history.replaceState(null, '', scrubbedUrl);
      } catch (e) {
        console.warn('[NextGen-embed] could not scrub session param from URL: ' + (e && e.message ? e.message : e));
      }
    }

    // STEP 35: athena-side boot layout. athenaOne supports inbound messages
    // from embedded apps; on an embedded open the app requests its landing
    // layout — a 600px iFrame (appResize, matching the app's designed width)
    // and main-window placement (appPopin). Sent ONLY when actually framed:
    // a direct browser visit has no athenaOne parent to lay out, and the
    // bridge already withholds outbound messages when no validated athenaOne
    // target origin exists (framed-but-unverified posts nothing). One send
    // per method per boot — well inside athena's 1-per-method-per-10s
    // outbound throttle.
    function requestAthenaBootLayout() {
      if (window.self === window.top) return;
      try {
        window.AthenaMessaging.appResize(600);
        window.AthenaMessaging.appPopin();
      } catch (e) {
        console.warn('[NextGen-embed] boot layout request failed: ' + (e && e.message ? e.message : e));
      }
    }

    if (urlPatientId) {
      window.currentPracticeId = urlPracticeId || null;
      window.AthenaMessaging.init({
        demo: true,
        demoDelayMs: 0,
        athenaOrigin: urlAthenaOrigin,
        demoContext: {
          patientId: urlPatientId,
          encounterId: urlEncounterId || null,
          practiceId: urlPracticeId || null,
          source: urlSource,
        },
      });
      requestAthenaBootLayout();
      return;
    }

    // When launched from athenaOne (/app redirects here with embed=athena), force
    // the same demo view a direct browser visit shows. Without this, the embedded
    // iframe would suppress demo mode and sit on the "waiting" state instead of
    // rendering the built-in test patient (Olivia Torres, MRN-100242).
    var forceDemo = urlParams.get('embed') === 'athena';

    // Initialize the bridge. Outside athenaOne this auto-enables demo mode and
    // simulates athenaOne sending Olivia Torres's patientID.
    window.AthenaMessaging.init({
      demo: forceDemo ? true : undefined,
      athenaOrigin: urlAthenaOrigin,
      demoContext: { patientId: 'P-100242', encounterId: 'E-558843' },
    });
    requestAthenaBootLayout();
  });
})();
