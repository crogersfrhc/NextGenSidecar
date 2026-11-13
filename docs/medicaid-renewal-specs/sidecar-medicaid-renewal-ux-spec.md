# Sidecar Medicaid Renewal Tab: Column Modal (UX Spec)

**Updated:** 2026-10-21; repo copy updated 2026-10-26 to match the built tab (changes marked *(updated 2026-10-26)*, listed in `README.md`). *(updated 2026-10-30: Craig's 2026-10-30 version makes the tab actionable; its "Actionable tab" section is added at the end and supersedes every earlier "display only" statement here.)* **Chosen design** for the sidecar Medicaid Renewal tab (Craig, 2026-10-21). The earlier case-workspace alternative was dropped and deleted. The master PRDs live in SharePoint; this note is not a PRD.

**Idea:** the Medicaid tab shows ONE modal for the open patient. The modal takes the header name and colour of the Board column the patient is in, and the patient's renewal information sits inside it. The sidecar displays the placement; it does not change it. *(updated 2026-10-30: staff can confirm the placement from the sidecar.)* If the patient is in another column, the modal is that column (name, colour, notice).

## Sidecar format (compared to the current sidecar prototype, Medicaid tab)

The current sidecar is a narrow panel (600px: the app asks athenaOne for 600px at launch and athenaOne Preview reports `width: 600`; users can resize it *(updated 2026-10-26)*): navy patient header (name, Active chip, MRN, action buttons), pill tabs (Pre Check-In, Appointment, Clearline, Medicaid), white cards in small type (10-12px), stat tiles (Household size, Annual income, FPL), a green/yellow notice strip, and collapsible grey section rows with caps labels (STATE MEDICAID PLANS, STATE ASSISTANCE PROGRAMS, ACA / MARKETPLACE PLANS). This design follows that: same header, same tabs, tiles instead of wide grids, notice strip, and collapsible sections. *(updated 2026-10-26: that description is the sidecar before the sidecar-wide style pass, which has since moved it to the platform look: flat tabs, 12px minimum text, platform cards and chips.)*

The first round of prototypes was desktop width (about 1200px), which did not match this format. This design is built at sidecar width.

Tab name: the tab is renamed "Medicaid Renewal" (Craig, 2026-10-21).

Note: today's Medicaid tab is labelled "Medicaid Redetermination" and shows simulated demo data (fixed Arizona / AHCCCS scenario, household, income, FPL). This design replaces that content with the Board-based renewal state.

## The modal

- **Column header band** in the column colour, showing only the actual column name (for example "Medicaid Eligible") plus the placement chip (Predicted or Staff confirmed). Colours follow the platform board's own column colours, mapped by column name: Unknown / Needs Screening = stone, Medicaid Eligible = teal, ACA / Marketplace Eligible = violet, No Longer Eligible = pink; Predicted chip = lime, Staff confirmed chip = sky (Craig decided 2026-10-21, from the Replit repo's `population-vocab.ts`). *(updated 2026-10-26)*
- **Body** tinted to the column: patient name, case badge (No case or Case open + status), discount chip, program chip; stat tiles for Renewal due (with a "Renewal passed" / "Due soon" chip: red for overdue, amber for due soon; product wording, updated 2026-10-26), FPL, Next appointment; a notice strip whose text depends on the column; the member ID warning at the very top of the body when the patient has a member ID to fix (urgent items first); display-only tiles for Case and Assignee; under them, the Case progress card when the product supplies step data. *(updated 2026-10-26: the Case tile shows status only.)*
- **Collapsible sections** (sidecar style): Why this placement (explanation only: result and income band); Patient communication; Screening results (read-only).

## Member ID warning

No Member ID section. Any patient the product flags as having a member ID to fix, for any reason, gets a red warning at the very top of the modal body (urgent items first; see Decisions) *(updated 2026-10-26: this line previously said "under the notice strip")*:

- Title: "Member ID to fix: <id>".
- Body: the product's own error message when one exists (prototype examples: "Member ID must be the letter A followed by eight digits." and "Member ID not found at the payer."), otherwise the generic "This member ID failed validation."
- Closing line: "Correct it in the insurance record."

Patients with no flagged ID show nothing. The sidecar does not decide validity itself: it shows what the product flagged, so the AHCCCS format rule (the letter A plus eight digits) is one possible message, not a sidecar check. Display only: the sidecar does not edit the ID (a change would update the patient's insurance and post through Orion, which needs its own story). *(updated 2026-10-30, Craig: superseded. Staff can correct the ID in the sidecar (a field in the warning, saved after a confirm). It must validate against the product's rule and update the insurance record; the platform write is a contract gap.)*

Open: what field carries the product's error message, and whether every flag has one (needs an Orion/Dev contract). The Replit Board's "Member ids to fix" list only flags the problem and says to open the patient to correct it.

## Case progress *(updated 2026-10-26)*

Case progress has its own **Case progress** card, directly under the Case and Assignee tiles and above the collapsible sections. It is the product's case progress tracker (the "pizza tracker"), requested by JD. Full spec: `sidecar-medicaid-renewal-case-progress-tracker-addendum.md`.

- Header: "CASE PROGRESS" and "5 of 7 steps done · 63%" (the percent only when the product supplies one).
- Rail: seven nodes joined by a line filled up to the current step. Done = green check, current = blue ringed number, not started = grey number. Each node has a tooltip and accessible name "Step N of 7: <title> · <status>".
- Current step block: "Step 6 of 7: Submit & record the case" with a status chip and the step's description.
- "See all 7 steps" toggle, collapsed by default, listing every step; the label changes to "Hide all steps".
- Closed or denied cases use the closed wording ("All steps done", "Closed", "Denied") and keep their real percent, never 100. *(updated 2026-10-30, Craig: superseded; matches the product's CaseStepper. The summary is always "N of 7 steps done · P%". A denied case shows "Denied" with a cross on the last step only, and a closed case adds no wording, with plain, non-interactive nodes.)*
- Display only: nothing in the card is clickable except the toggle. *(updated 2026-10-30: superseded. Rail nodes and "See all" rows open a step panel; see "Actionable tab".)*

The percentage counts activities across all the steps, not completed steps (JD, 2026-10-18: 5 of 7 steps done is 63%, 10 of 16 activities, not 71%). The sidecar reads the steps and the percent from the product and does not compute them. Patients with no case, and patients whose data carries no case progress, show no card.

Open: the platform does not serve case progress yet (contract gap: steps with status, done count, total steps, current position, percent, closed/denied, and which step and activity catalog it uses). Until it does, the card appears only with Bob Testpatient's review sample (5 of 7 done, step 6 in progress, 63%).

## Patient communication (from the earlier case-workspace design)

Same panel as the case-workspace design's Patient communication, in a collapsible section: Channel (Email, SMS, Portal, as in the product; no Letter *(updated 2026-10-26)*), Template (sidecar sample templates: Confirm your information, Documents needed, Renewal reminder) that fills an editable message ("Write a message") with the patient's first name (the reminder includes the renewal date), a "Subject" field for Email only, "Send <channel>" (stubbed), and a "Sent on this case" log. See "Product wording" for the subtitle, intro and status chips. Messages are logged on the case. JD wants patient communication added to the sidecar, starting with this tab.

## Decisions (Craig, 2026-10-21)

- Urgent items first: member ID warning moved to the top of the modal body; Overdue / Due soon shown as a coloured chip.
- Text and tap sizes: smallest labels raised to 12px (style alignment; first 11px); section toggles and controls at least 44px tall; the four tabs on one line at the panel width (they fit from about 520px up, and the 44px flat tabs came with the sidecar-wide style pass). *(updated 2026-10-26)*
- Sections collapsed by default except Why this placement (explanation), so the top of the tab stays scannable.
- Sidecar width: 600px, the width the app requests at launch and athenaOne Preview reports back; users can resize the panel, so the tab is fluid and checked at 600px and 340px. *(updated 2026-10-26; the prototype was at 400px.)*
- Header colours: use the platform board's column colours (stone / teal / violet / pink; chips lime / sky), not the prototype's.
- Style alignment: follow the platform tokens and 12px minimum text; keep the inner sections as plain collapsible rows (no banners); tab restyle is a separate sidecar-wide pass. See the handoff.
- Tab renamed "Medicaid Renewal".
- This column modal is the design we are using. Option A (case workspace) is dropped.
- Removed: "Open patient record" button; the "Renewal case work" section (seven-stage list, Start renewal case).
- Header shows only the actual column name (no caption, no income band line).
- Case and Assignee are display-only (not dropdowns).
- Why this placement keeps its explanation; the ability to move the patient to a column and Confirm placement is removed from the sidecar. Placement is changed elsewhere (not in the sidecar).
- Patient communication added from the case-workspace design.
- Engine runs replaced by read-only Screening results; no Run engine in the sidecar.
- Case progress: first added to the Case tile; moved into its own Case progress card (the product's tracker, JD's request, addendum 2026-10-26). The sidecar reads it from the product and does not compute it; the card is not shown until the platform serves the value (contract gap). *(updated 2026-10-26)*
- Patient communication channels: Email, SMS and Portal, as in the product; no Letter (Craig, 2026-10-26, replacing the 2026-10-21 Email / SMS / Letter decision). The send stays stubbed.
- Member ID section replaced by a warning; no editing in the sidecar.
- Member ID warning shows for every patient with a member ID to fix, whatever the reason: the product's specific message if there is one, otherwise a generic message. The AHCCCS format rule likely applies only to AHCCCS members, so the sidecar does not hard-code it.

## Behaviors

- The column, colour, chip and notice come from the patient's current placement.
- The member ID warning appears only when the product flags the ID, and shows the product's message or the generic one.
- Screening results are display only.
- "Send <channel>" shows a preview of the message. While the send is stubbed it says "Sending is turned off in this build. Nothing was sent." and adds nothing to the sent log, so a pretend send never looks like a real one. *(updated 2026-10-26: the prototype added a fake log entry.)* *(updated 2026-10-30: superseded by the actionable addendum. The send now goes out after a confirm, and a successful send joins the log.)*
- The Case progress card appears only with a case and the product's step data; it is display only apart from its "See all 7 steps" toggle. *(added 2026-10-26)* *(updated 2026-10-30: superseded; the card is actionable per the actionable addendum.)*

## Dropped from the Replit Board

All filters, saved views, density toggle, Intake, Run engine, other patients' cards, column counts, the 12-patient "Member ids to fix" list (replaced by the per-patient warning).

## Open questions

- Where staff change a placement, case status, assignee or member ID now that the sidecar only displays them (the FrontRunner product / insurance record, per the decisions above).
- Where department, FPL and income come from for an athena patient (athena APIs vs FrontRunner data).
- Screening results: fields, freshness, and whether a patient with no run should show anything beyond the empty message (Orion/Dev contract).
- Member ID flag: which field carries the product's message, and whether every flag has one.
- Patient communication: whether the send needs a confirmation step, consent and opt-out handling, and the template wording (placeholder text in the prototype). *(updated 2026-10-26: channels decided — Email, SMS, Portal.)*
- Case progress: which step and activity catalog the platform serves (the Replit repo has 8 steps and about 18 activities; the board Craig compared showed 7 steps and 16), and the product's exact closed / denied wording. *(added 2026-10-26)*
- Prototype sample patients are the Replit test patients (Bob, Carol, Alice, Gita). Bob and Gita show a product message, Carol shows the generic message, Alice shows no warning.

## Prototype

Artifact "Sidecar Medicaid Renewal Board View (Patient)" (private), titled "Medicaid tab, column modal".

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

## Actionable tab (2026-10-30, Craig; supersedes display-only)

Full detail is in `sidecar-medicaid-renewal-actionable-addendum.md`; this section is the UX summary.

- **Save pattern:** every write asks first ("Save step N and move to step N+1?"), then shows "Saving to FrontRunner…", then "Saved to FrontRunner." On failure: "Couldn't save to FrontRunner. Nothing was changed." with Try again. Edits inside a step are drafts until the step is saved. A confirm bar sits at the top of the modal (and inside any open dialog).
- **Case progress rail:** each node and each row in "See all 7 steps" opens that step in a panel below. Current step editable; finished steps read-only; later steps locked. Percent shows only while it matches what the product supplied.
- **Step panel (all seven steps):** 1 Verify (three approvals; Check demographics, Check eligibility and Replace insurance open sidecar dialogs); 2 Programs (filter and tick); 3 Documents (mark received, add a required document); 4 Work requirements (determination shown; two confirmations); 5 Application (status only, finishes on its own); 6 Submit (Record submission with optional confirmation # and note); 7 Follow up (three ticks, Approved or Denied, closing note). Save & Continue saves the step and auto-advances.
- **Case controls:** Case status select (New, In progress, Waiting, Submitted), Start case, Assignee select, Confirm placement section, member ID fix.
- **Patient communication:** channels Email, SMS, Portal; Subject for Email only; "Send Email / SMS / Portal" after a confirm.
- **Stays in FrontRunner behind "Open in FrontRunner":** uploads and scans, form generation and download, packet download, replacing a work-requirement determination, per-field demographics and financial edits, the outcome and the final case close.
- **Open:** role limits; which real fields the platform returns for checks; product options for the determination and outcome; platform write endpoints (listed in the addendum's contract gaps).
