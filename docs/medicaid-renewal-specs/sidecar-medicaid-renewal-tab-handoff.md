# Handoff: Medicaid Renewal tab in the athena sidecar

Audience: Claude Code, building this tab in the sidecar app repo. Written 2026-10-21 by Craig (PM, leads UI/UX) with Claude.

> **Repo copy, updated 2026-10-26** to match the built tab and Craig's later decisions (through the Case progress tracker, PR #93). Changed passages are marked *(updated 2026-10-26)*; `README.md` in this folder lists every change.

## Goal

Replace the sidecar's current Medicaid tab (labelled "Medicaid Redetermination", showing simulated demo data) with a **Medicaid Renewal** tab. It shows ONE modal for the open patient. The modal takes the header name and colour of the Medicaid Renewal Board column that patient is in. The tab is display-only except Patient communication.

## Sources of truth

- Clickable prototype (private artifact): "Sidecar Medicaid Renewal Board View (Patient)", https://claude.ai/artifact/LJZqGWabuTq9hubvQVyHiL. Source file `Main.dc.html`. Prototype data is sample data.
- UX spec: project doc `claude/sidecar-medicaid-renewal-board-view-ux-spec.md` in the "athena sidecar" project. This handoff summarizes it; the spec has the decisions and the open questions.
- UI base going forward: the Replit app "frhc-platform-master" (LIVE -V2 FrontRunnerHC-master), Medicaid Renewal board at `/medicaid-renewal`. Its board and case logic are the product reference. Match the product's numbers and wording, not the prototype's.
- Engine doc (Replit repo): `docs/replit-tasks/2026-10/medicaid-redetermination-processing-engine.md`, plus `ADR-PROPOSED-medicaid-redetermination-engine.md` (proposed, not final).

Do not copy the prototype's HTML. It is a design reference built in a prototyping format. Rebuild with the sidecar repo's own components and styles.

## Before building

1. Read the sidecar repo: how tabs are registered, how the existing Medicaid tab, Pre Check-In, Appointment and Clearline tabs are built, what styling and component library it uses, and how it gets patient data (athena APIs real-time; posting goes through Orion).
2. Find the real sidecar panel width. The prototype uses 400px as a trial; 340px was an estimate and 600px was Craig's belief. Build responsive within the real panel; do not hard-code 400px. *(updated 2026-10-26)* Finding: the app asks athenaOne for 600px at launch (`appResize(600)`), and athenaOne Preview reported `width: 600` back (captures of 2026-09-23 and 2026-09-29). Users can resize the panel by hand, so the tab is built fluid and checked at 600px and 340px.
3. Reuse existing sidecar patterns (header, tabs, stat tiles, notice strip, collapsible grey caps-label section rows) rather than the prototype's inline styles. *(updated 2026-10-26: the sidecar-wide style pass replaced the pill tabs with flat platform tabs.)*
4. Confirm what the repo already has for Medicaid data, then list gaps before inventing anything (see Data and contracts).

## What to build

### Tab
- Name: **Medicaid Renewal** (replaces "Medicaid"). Must stay on one line with the other tabs (Pre Check-In, Appointment, Clearline) at the real width.

### The modal (one per open patient)
Header band, in the column colour, shows ONLY the column name (for example "Medicaid Eligible") plus a placement chip: **Predicted** (placed by income band only) or **Staff confirmed**. No other caption.

Colours: **use the platform board's own column colours** (Craig decided 2026-10-21), mapped by column name exactly as the board does: Unknown / Needs Screening = stone, Medicaid Eligible = teal, ACA / Marketplace Eligible = violet, No Longer Eligible = pink. The placement chips are Predicted = lime and Staff confirmed = sky. Source: `website/client/src/features/medicaid-renewal/lib/population-vocab.ts` (see "Column colours" under Style alignment). Take the header colour and a matching light body tint from the platform's category tokens. Keep them in one token map. *(updated 2026-10-26: this paragraph previously said slate / emerald / blue / red, which came from a different codebase.)*

Check white header text for contrast (WCAG AA). Do not rely on colour alone: the column name is always shown. An icon per column is recommended.

Body, top to bottom:
1. **Member ID warning** (only when the product flags the patient's member ID as needing a fix). Red. Title "Member ID to fix: <id>". Body: the product's own error message if there is one, otherwise "This member ID failed validation." Closing line: "Correct it in the insurance record." Urgent items go first, so this sits at the very top of the body. Show it for any patient flagged, for any reason. Do NOT hard-code the AHCCCS rule (letter A plus eight digits); that rule likely applies only to AHCCCS members and is just one possible product message. No editing in the sidecar.
2. Patient name; case badge ("No case" or "Case open: <status>"); discount chip (for example "75% Discount") and program chip (for example "AHCCCS-CHIP-9222") when present.
3. Three stat tiles: **Renewal due** (date, with a "Renewal passed" chip in red when overdue or a "Due soon" chip in amber when applicable *(updated 2026-10-26, product wording; was "Renews" / "Overdue")*), **FPL** ("Unknown" when income is unknown), **Next appt** ("None" when none).
4. Notice strip, text and colour by column:
   - Unknown / Needs Screening: "Income unknown. Screening is needed before a program can be chosen."
   - Medicaid Eligible: "Likely qualifies for Medicaid. Renew coverage before the deadline."
   - ACA / Marketplace Eligible: "Over the Medicaid income limit. Marketplace coverage with a subsidy may fit."
   - No Longer Eligible: "No longer eligible. Review the reason with the patient."
5. Two display-only tiles: **Case** (status only) and **Assignee**. *(updated 2026-10-26)* Case progress is no longer in the Case tile: it lives in its own **Case progress** card directly under these tiles and above the collapsible sections (the product's "pizza tracker": "5 of 7 steps done · 63%", a seven-step rail, the current step, and a "See all 7 steps" toggle). Full spec: `sidecar-medicaid-renewal-case-progress-tracker-addendum.md`. **Decision (Craig, 2026-10-21 and 2026-10-26): the sidecar reads the progress from the product; it does not compute it.** The card is built against an optional typed field on the server route (`case.caseProgress`: steps with status, done count, total steps, current position, optional percent, closed/denied). When the field is absent, or there is no case, the card is not shown (no placeholder, nothing derived from stage counts). The platform does not serve this field today (the Replit website derives it in the browser), so a platform change is needed; it is logged in the contract as a gap, and the card appears when the field exists. Do not port the derivation into the sidecar.

**Progress source of truth (Replit platform repo "LIVE -V2 FrontRunnerHC-master", commit 78a15a5ed, read 2026-10-21; key lines only, verify in the files):**
- Rule (JD, 2026-10-18, `docs/replit-tasks/2026-10/medicaid-renewal-rail-percent-tasks.md`): percent = activities satisfied divided by total activities across ALL stages (manual and auto), not stages divided by 7. A closed case shows its real percent, never 100.
- Code: `website/client/src/features/medicaid-renewal/lib/pane/step-progress.ts`. `deriveCaseProgress` sums each step's `doneCount` into `doneActivities` and each step's `requiredCount` into `totalActivities`; `percentComplete(done, total)` = `Math.round((Math.min(done, total) / total) * 100)`. It also returns `doneCount` (steps done) and `currentPosition` (current step). The header tracker (`components/pane/CaseProgressTracker.tsx`) prints "Step N of M · X of M done · P%".
- Catalog: `PROCESS_STEP_ACTIVITIES` in `server/medicaid-redetermination-api.js` (the server validates each activity toggle and decides when a step is complete), mirrored for the client; a vendored copy is at `applications/services/action-handler/tests/contracts/fixtures/vendor/process-activities.ts`.
- This is the reference for what the product should serve (for the contract). Do not port it into the sidecar.
- Findings and caveats:
  - The percentage is derived in the browser in the Replit repo. I found no server field that serves it, but I did not search the server code exhaustively. The per-activity completion data does exist on the server.
  - The Replit repo's catalog has 8 steps and roughly 18 activities (count unverified; optional alternatives may be excluded from the required count). The Replit board deployment I compared against showed 7 steps and 16 activities (Bob Testpatient = 63%, 10 of 16). I have not confirmed which version is older. The percentage depends on the catalog version.
  - The athena-embed platform (`stage_machine.py`) stores 8 stage statuses grouped into 4 nodes and has no per-activity data, so it cannot produce this number today.
- **Contract gap to log** *(updated 2026-10-26, addendum wording)*: "Serve case progress per case (steps with status, done count, total steps, current position, percent, closed/denied). Today only the Replit board derives it in the browser; the athena-embed platform has an 8-stage / 4-node model. Needs a server-side field and a decision on which step and activity catalog it uses."

6. Collapsible sections (sidecar style: grey caps-label rows, 44px tap height). Collapsed by default except Why this placement:
   - **WHY THIS PLACEMENT** (open by default): explanation only. It opens with the product's placement sentence ("Predicted from the recorded screening (income, household, age); not a recorded outcome." or, when staff confirmed, "Recorded by staff."), then "Result" (for example "Meets income", "Staff confirmed", "Over medicaid income") and "Income band" in the product's casing (for example "Under 100% FPL", "138–250% FPL", "Income unknown"). No confirm or move-column control. *(updated 2026-10-26, product wording)*
   - **PATIENT COMMUNICATION**: see below.
   - **SCREENING RESULTS**: read-only, see below.

### Patient communication (the only interactive part)
*(updated 2026-10-26, product wording; replaces Email / SMS / Letter and "Review & send")* Subtitle "Email · SMS · portal" and the product's intro line; Channel (Email, SMS, Portal, as in the product; there is no Letter channel); Template (sidecar sample templates: Confirm your information, Documents needed, Renewal reminder; the product's template names are "Appointment reminder (demo)" and "Medicaid renewal reminder (email)", bodies not confirmed); a "Subject" field for Email only; an editable message ("Write a message") prefilled from the template with the patient's first name (the reminder includes the renewal date); a **Send <channel>** button ("Send Email", "Send SMS", "Send Portal"; stubbed); and a "Sent on this case" log (empty state "Nothing sent yet."). Messages are logged on the case. JD wants patient communication added to the sidecar, starting with this tab.

Prototype wording (placeholder, needs approval):
- Confirm: "Hello <first>, your Medicaid renewal is due. Please confirm your information in the patient portal."
- Documents: "Hello <first>, we still need documents for your Medicaid renewal. Please upload them in the patient portal or bring them to your next visit."
- Reminder: "Hello <first>, a reminder that your Medicaid renewal is due <renewal date>. Contact us if you need help."

The prototype's send is fake. Real sending is undecided (see Open questions). Do not wire a real send until the channel, consent and confirmation decisions are made; build the UI with a clearly stubbed send behind a flag. *(updated 2026-10-30: superseded by the actionable addendum. The send now goes out after a confirm, and a successful send joins the log.)*

### Screening results (read-only)
Shows the latest Medicaid processing engine results for the patient, with a source line ("Source: engine run, <date>"): Insurance verification, Insurance discovery, Credit check, FPL screening, Qualifies for. If no run exists: "No engine run on this case yet. Results appear here after staff run the engine." No Run engine button: the engine is a staff batch tool (270/271 verification, insurance discovery only if no coverage, credit check, FPL screening; it fills empty fields, never overwrites staff values, never advances the stage or selects programs), and each run includes a credit check. Footer note: "Engine results are for staff review."

## Style alignment (follow the platform; spec: `sidecar-style-alignment-spec.md`)

Visual rules for this tab. The style spec was read from the running platform app; platform values win on visuals, this handoff wins on content and behavior.

- **Tokens and fonts:** use the platform's theme tokens (brand pack, status, category, data). Fonts: Inter for body, Manrope (weight 600) for headings. Body text `hsl(220 14% 28%)`, muted `hsl(215.4 16.3% 43%)`.
- **Minimum text size: 12px** (replaces the 11px used in the prototype). Keep controls at least 44px tall.
- **Cards and controls:** 8px radius, the platform card shadow, primary buttons solid `#284776` with white text, secondary white with a navy outline.
- **Chips:** tinted pills with a leading icon where the platform has one, two-line chips allowed, text at least 12px, AA contrast. Use the caution, neutral and special tones where they fit.
- **Data colours:** past-due renewal dates in the overdue colour; MRN as an ID chip; FPL and income in the money colour.
- **Section headers:** keep the three inner sections (Why this placement, Patient communication, Screening results) as plain collapsible rows. Do NOT turn them into gradient banners (Craig decided, 2026-10-21). The column-coloured modal header is the only banner-style element.
- **Tabs:** the platform's flat tab (2px green underline, 14px) is a sidecar-wide style change handled in the separate style-alignment pass, not in this tab. In that pass, make the tab buttons at least 44px tall (tap target) using padding, with no change to the visible 14px text. Do not restyle the tab row here, but make sure "Medicaid Renewal" fits on one line. *(updated 2026-10-26: done in the style pass. The four flat 44px tabs fit on one line from about 520px up, including the 600px panel; on a narrower panel the tab strip scrolls sideways on its own and never wraps.)*
- **Column colours (decided 2026-10-21, verified in code):** the platform's source of truth is `website/client/src/features/medicaid-renewal/lib/population-vocab.ts` (Replit repo LIVE -V2 FrontRunnerHC-master, lines 39-42): Unknown / Needs Screening = stone, Medicaid Eligible = teal, ACA / Marketplace Eligible = violet, No Longer Eligible = pink. Use the platform's category tokens for those hues (header band and body tint). The same file says the Predicted marker is lime and the Staff confirmed marker is sky: use those hues for the placement chip. Ignore the emerald / blue / red / slate colours found elsewhere; they came from a different codebase.
- **Open:** whether dark mode is needed. *(updated 2026-10-26: the available width is 600px as requested at launch and reported by athenaOne Preview; users can resize it, so the tab stays fluid.)*

## Removed on purpose (do not add back)
Open patient record; Renewal case work (seven-step list, Start renewal case); case status and assignee dropdowns; Confirm placement and move-column; Run engine; Member ID editing and the Member ID section; the Board's filters, saved views, density toggle, Intake, column counts, other patients' cards and the 12-patient "Member ids to fix" list.

## States to build (prototype only shows the happy path)
Placement rule: the platform's `bucketForRow` never returns "no column". Any patient on the renewal list with no staff outcome is in Unknown / Needs Screening. A patient missing from the renewal list is the "No Medicaid data" state. There is no separate "Not placed yet" state.

| State | Where | Copy |
|---|---|---|
| Loading | Modal body, header band greyed | "Loading Medicaid renewal info…" (skeleton in the tile and section shapes) |
| No Medicaid data (patient not on the renewal list) | Whole tab, in place of the modal | Title "No Medicaid renewal info for this patient". Body "This patient isn't tracked for renewal yet." |
| Load error | Whole tab | Title "Couldn't load Medicaid renewal info". Body "Check your connection and try again." Button "Try again" |
| Screening results error | Inside the Screening results section only | "Couldn't load screening results. The rest of this tab is up to date." Button "Try again" |
| No case | Case tile | "No case"; no Case progress card |
| Case progress field absent *(added 2026-10-26)* | Case progress card | Card not shown (no placeholder) |
| No screening run | Screening results section | "No engine run on this case yet. Results appear here after staff run the engine." |
| Empty sent log | Patient communication section | "Nothing sent yet." |

Only the two error states get a Try again button. No technical words (API, error codes) in the UI.

## Data and contracts (gaps to resolve, do not invent)
The prototype uses sample data (Bob, Carol, Alice, Gita Testpatients). The real fields and sources are not defined. Needed per patient, each with source and freshness:
- Board column and placement (Predicted vs Staff confirmed); whether engine results equal the Board's "Predicted" placement is unconfirmed.
- Case status, assignee, and case progress: steps with status, done count, total steps, current position, percent, closed/denied (platform to serve it; today it exists only as a browser-side derivation in `step-progress.ts`). *(updated 2026-10-26)*
- Renewal date and overdue/due-soon flag; FPL and income band; next appointment; program; discount.
- Member ID flag and the product's error message (which field carries it; whether every flag has one).
- Engine results fields and freshness.
- Sent-message log, and the send action itself (this posts through Orion).
Where these come from for an athena patient (athena APIs vs FrontRunner/Orion data) is an open question. If the sidecar repo lacks a contract, draft one as a product-level contract for the Orion team rather than guessing endpoints. Product-level language belongs in the story; endpoint design belongs to Development.

## Open questions (Craig to decide)
- Real sidecar panel width. *(updated 2026-10-26: 600px as requested and reported in athenaOne Preview; user-resizable.)*
- Where staff change placement, case status, assignee and member ID now that the sidecar only displays them (the FrontRunner product / insurance record).
- Patient communication: whether the send needs a confirmation step, consent and opt-out handling (SMS especially), template wording. *(updated 2026-10-26: channels decided — Email, SMS, Portal.)*
- Screening results: fields, freshness, and what a patient with no run should show.
- Member ID flag: which field carries the message.
- Whether the engine ADR and its schema change are approved.

## Recommended UI items
*(updated 2026-10-26)* Applied: a tooltip for Predicted placement / Staff confirmed (now the product's own sentences, see "Product wording"); an icon per column; a preview on "Send <channel>" (it says "Sending is turned off in this build. Nothing was sent." while the send is stubbed, so there is no "Sent" state yet). The Case progress card's current-step block ("Step 6 of 7: …") replaces the "Next: <step>" hint.

## Acceptance checks
- The tab reads "Medicaid Renewal" and the four tabs fit on one line at the real width.
- Header shows only the column name in that column's colour, with the right placement chip, for all four columns.
- A flagged member ID shows the warning at the top with the product's message, or the generic message; unflagged patients show nothing.
- Case progress matches the product's board card for the same patient, once the platform serves it. *(updated 2026-10-26: until then the card shows only with Bob's review sample, 5 of 7 steps done, step 6 in progress, 63%.)*
- Nothing in the tab changes placement, case status, assignee or member ID.
- Only "Why this placement" is open on first load; text is at least 12px *(updated 2026-10-26, per the style alignment)*; controls are at least 44px tall.
- No real message is sent until the send decisions are made.
- Patient data in the tab is real, not simulated, and every state above is handled.

## Working agreements
Craig prefers concise, action-oriented updates and brief direct feedback. Use plain language in the UI. Master PRDs live in SharePoint; this handoff is not a PRD. Mark anything unverified in the repo as unverified in your summary instead of assuming.

## Product wording (verified 2026-10-26 in the Replit preview, wf=9002; the product's wording wins)

*(added 2026-10-26 from Craig's updated spec; applied to the built tab the same day.)*

Board and header: "Qualification: Medicaid Eligible"; "Placement: Predicted placement" (or "Staff confirmed"); tile label "RENEWAL DUE" with the date and "Renewal passed" when overdue; income bands use an en dash ("138–250% FPL") and "Under 100% FPL".

Placement explanation: the product has no section for it, only a tooltip: "Predicted from the recorded screening (income, household, age); not a recorded outcome." The sidecar keeps its collapsible "Why this placement" and opens it with that sentence (staff-confirmed: "Recorded by staff."), then Result and Income band.

Patient communication:
- Title "Patient communication", subtitle "Email · SMS · portal".
- Intro: "The same conversation as the Patient Communications inbox. A message sent here also counts as the step 7 status update."
- Channels: Email, SMS, Portal. Not Letter.
- Controls: "Template" menu ("Templates for Email"), "Subject" and "Write a message" placeholders, send button "Send Email" / "Send SMS" / "Send Portal" (stubbed in the sidecar).
- Message status chips in the thread: "Received", "Not yet seen in portal", "Failed".
- Not-set-up notes: "Email sending isn't set up for this platform yet. Contact FrontRunnerHC to enable it." and "Attachments aren't set up for this platform yet. Contact FrontRunnerHC to enable them."
- Product template names: "Appointment reminder (demo)", "Medicaid renewal reminder (email)". Template bodies are not confirmed; the sidecar's three sample templates stay as sample data.
- Not brought over: Attach, Quick reply.

Still sidecar-authored (no product source): notice strips under the tiles, "Nothing sent yet.", NEXT APPT tile, sample template bodies. Closed/denied wording comes from product source, not a rendered page.

**As built (2026-10-26):** applied as above, except: the "Templates for Email" menu label and the two not-set-up notes are not shown (the menu stays "Template" with the sample templates; the send is stubbed); the thread shows the "Failed" chip only, because the platform's outreach statuses are sent / generated / failed / blocked and none maps to "Received" or "Not yet seen in portal"; a patient with no placement chip gets no explanation sentence (the product has none for that case).
