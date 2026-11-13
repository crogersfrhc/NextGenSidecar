# NextGen Sidecar prototype: UX spec

**Status:** working prototype, mocked data. 2026-11-13.
**Repo:** `crogersfrhc/NextGenSidecar`. A copy of the athena prototype (`athena-embed/`), changed for NextGen.
**Owner:** Craig.

## 1. What this is

This is a clickable prototype of the FrontRunner Sidecar launched from NextGen Enterprise. It keeps the athena Sidecar's look and feel and changes only what NextGen requires. It is a **UX artifact**, not a build: all data is invented, and nothing calls NextGen, Orion or Hasura.

It is a requirements input for the NextGen epic (FR-3157, stories S0 to S5). It does not describe anything that ships today.

### Sources

| Source | Used for |
|---|---|
| NextGen Sidecar PRD (project doc) | Requirements SC-LCH, SC-DAT, SC-WRT, SC-ACC; §13 states; §18 decisions |
| NextGen App Launcher guides (Enterprise API v1.4, FHIR v1.2) | Launch context, token, embedded browser |
| NextGen Q&A, 2026-10-19 | Write credential, no idempotency key, locked encounters |
| `frhc-platform` `features/athena-embed`, `features/ehr-embed`, Orion NextGen adapter | What the platform athena embed does; what Orion can read for NextGen |
| `athena-embed/` prototype | Starting point for this copy |

## 2. Decisions behind this prototype (Craig, 2026-11-13)

1. **Tabs:** Pre Check-In (default), Appointment, Medicaid Renewal. Clearline is removed.
2. **Appointment tab:** Good Faith Estimates only. There is no appointment list, because NextGen gives the Sidecar no appointment reads (Orion's NextGen read serves summary, demographics and coverage only).
3. **Medicaid Renewal:** required.
4. **Demographics:** the PRD set (name, DOB, sex, address, phones, email) plus athena's extras: preferred name, marital status, race, ethnicity, employer (display-only) and SSN (masked, display-only).
5. **Real-Time Verification:** all four checks: Demographics, Insurance Discovery, Eligibility, and Credit (display-only).
6. **User linking:** include the email-code pairing screen, shown only on an unpaired launch.
7. **Data:** all mocked, with a demo switcher for every §13 state, and one data seam so live NextGen reads can be swapped in later.
8. **Removed without a separate ruling:** Financial Clearance and Member Eligibility (TPA) cards. Neither was chosen. Restore either if wanted.

## 3. Screen by screen: keep, remove, modify

### Header

| Element | athena | NextGen | Why |
|---|---|---|---|
| Patient name + status badge | Keep | **Keep** | |
| MRN | Keep | **Keep** | |
| Enterprise, Practice | none | **Add** | SC-LCH-04: header shows the active enterprise and practice |
| Encounter | none (removed 2026-10-26) | **Add** | NextGen launch passes `encounterId`; the locked-encounter rule depends on it |
| Post Data, Real-Time Verification buttons | Keep | **Keep** | |

### Tabs

| Tab | NextGen | Notes |
|---|---|---|
| Pre Check-In | **Keep** (default) | |
| Appointment | **Modify** | Good Faith Estimates only; appointment list removed |
| Clearline | **Remove** | Rate Search and Claim Validation are out of scope (claims are a 2027 non-goal) |
| Medicaid Renewal | **Keep** | Unchanged from athena |

### Pre Check-In

| Card | NextGen | Notes |
|---|---|---|
| Patient Readiness | **Keep** | PRD §18 suggests it for v1 at P1 |
| Demographics | **Keep** | Field set per decision 4 |
| Insurance | **Modify** | N-level coverage: Primary, Secondary, **Tertiary**, ranked by NextGen `defaultCob` |
| Real-Time Verification | **Keep** | Four checks; Insurance Discovery result lists all three coverages |
| Financial Clearance | **Remove** | Not chosen |
| Member Eligibility (TPA) | **Remove** | Not chosen |

### Post Data modal

| Element | NextGen | Notes |
|---|---|---|
| Side-by-side compare, "FrontRunner / NextGen / Custom" columns | **Keep**, relabelled | SC-DAT-03 |
| Demographic, Primary, Secondary tabs | **Keep** | |
| Tertiary Insurance tab | **Add** | Only when a third coverage exists (SC-WRT-05) |
| Appointments tab | **Remove** | No appointment reads or writes in NextGen |
| "Changes appear in NextGen after a manual refresh" | **Keep**, reworded | SC-WRT-10; NextGen has no refresh-after-write message (SC-WRT-12 is P2) |
| Per-field outcomes (posted, skipped, failed, uncertain) | **Keep** | SC-WRT-07, SC-WRT-14; outcome copy is athena's, reworded for NextGen |

### Removed athena-only machinery

- athenaOne messaging (resize, popin, badge, `notifyPatientDataChange`). NextGen's App Launcher has no equivalent. The demo panel's messaging buttons are replaced by the §13 state switcher.
- MRF rate lookup (`lib/mrf-rates.js`).

## 4. Experience states (PRD §13)

Every state is reachable from the demo panel's **Show state** menu, or by URL: `/?state=<key>`.

| State | Key | Kind | Message | Next step |
|---|---|---|---|---|
| Loading | `loading` | window | "Loading Olivia Torres…" | Wait |
| No findings | `no-findings` | banner | "Everything we checked matches NextGen" + when | Re-run checks |
| Findings to review | `findings` | banner | "4 differences from NextGen" | Review in Post Data |
| Practice not connected | `practice-not-connected` | window | "This practice isn't connected to FrontRunner" | Contact practice NextGen admin |
| FrontRunner not enabled | `not-enabled` | window | "FrontRunner isn't turned on for this practice" | Contact FrontRunner support |
| No permission | `no-permission` | Post Data result | "Your NextGen access doesn't allow this change" | Ask NextGen admin |
| Required field missing | `required-field` | Post Data result | The field to fill | Fill the field / Cancel change |
| Locked encounter | `locked-encounter` | banner | Which changes can't attach, and why | Continue with person-level changes |
| Likely duplicate insurance | `duplicate` | Post Data result | The existing coverage it matches | Update existing / Add as second coverage |
| Write failed | `write-failed` | Post Data result | NextGen's reason in plain words ("Invalid Payor Priorities…") | Fix and retry / Dismiss |
| Write uncertain | `write-uncertain` | Post Data result | "We couldn't confirm this saved" while re-reading | None until re-read finishes |
| Session expired | `session-expired` | window | "Please reopen FrontRunner from the patient's record" | Relaunch |
| NextGen or FrontRunner unavailable | `unavailable` | window | "FrontRunner can't reach NextGen right now" | Try again / Status page |
| Account not linked | `not-linked` | window | "Account not paired": email + 6-digit code | Verify code / Contact support |

Kinds: a **window** replaces the whole Sidecar. A **banner** sits above the tabs and leaves the patient view usable. A **Post Data result** is a banner labelled as the outcome of a write.

## 5. Data

- Mock patient: Olivia Torres, MRN 100242, Enterprise 00123, Practice 001, Encounter E-558843.
- Coverage: BCBS of Texas (Primary), Aetna (Secondary), Texas Medicaid STAR (Tertiary).
- The mock profile is served by `GET /api/patient/:patientId` in `server.js`.

## 6. Not built yet

- **Data seam:** mock data still lives inline in `server.js` (`MOCK_PATIENT`) and `app.js` (insurance enrichment, RTV results). It still needs to move into one `lib/nextgen-data.js` module with a `mode: mock | live` switch.
- **Coverage order control in Post Data** (SC-WRT-05): the Tertiary tab exists, but the user can't yet re-rank a coverage. The "Invalid Payor Priorities" message appears only as a demo state.
- **Discovered-coverage payer entry:** not changed from athena.
- **Credit display-only:** not yet checked or enforced. Credit is kept from athena unchanged. It must show a result but never feed Post Data or readiness.
- **Internal identifiers:** about 340 `athena*` names remain in code and comments. Only on-screen text was changed.
- **Launch flow:** SMART/OIDC routes are still athena's. Nothing models the NextGen Enterprise API launch (`personId`, `encounterId`, `GET /users/me/login-defaults`).

## 7. Where the prototype goes beyond the PRD

The PRD has not ruled on these. Record them in the PRD or reverse them here.

| Prototype has | PRD says |
|---|---|
| Medicaid Renewal tab | v1 lists "redetermination" findings (§2, SC-DAT-03), but nothing describes a Medicaid Renewal screen |
| Good Faith Estimates | Open in §18 ("Which athena capabilities come to the Sidecar") |
| Credit check | Open: "Which FrontRunner findings appear in v1: eligibility, discovery, redetermination, credit?" |
| Patient Readiness rollup | §18 *suggests* v1 at P1; not decided |
| Email-code pairing | §18 open: automatic linking vs email code |

## 8. Open questions

1. **Pairing email.** Does NextGen give us the user's email at launch (`/users/me/login-defaults`)? If yes, the pairing screen can pre-fill it and skip the email field.
2. **Automatic vs email-code linking** (§18). If automatic linking is chosen, the pairing screen is never shown.
3. **Locked encounter.** Does NextGen block person-level insurance changes too? The banner assumes it does not.
4. **Multi-practice users.** The header shows one practice; switching is done in NextGen and needs a relaunch (SC-ACC-04).
5. **Launch surface sizes.** The design is 600 px wide (athena). Check it in a NextGen tab and in the template's floating, resizable window.
6. **Embedded browser.** Pop-ups, downloads and printing in CEFSharp affect the GFE PDF and Medicaid Renewal documents (TDS testing).

## 9. Run it

```
npm install
ATHENA_EMBED_PORT=8100 node server.js
# open http://localhost:8100/       (patient view)
# open http://localhost:8100/?state=not-linked   (any §13 state)
```
