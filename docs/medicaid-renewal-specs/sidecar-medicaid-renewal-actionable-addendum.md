# Addendum: make the Medicaid Renewal tab actionable

Written 2026-10-30 for Claude Code. Extends the built tab (display only, plus Patient communication) so staff can work the case from the sidecar. Read with the handoff, the UX spec and the case progress tracker addendum. Where this addendum conflicts with their "display only" rules, this addendum wins. Prototype: "Sidecar Medicaid Renewal Board View (Patient)", https://claude.ai/artifact/LJZqGWabuTq9hubvQVyHiL (layout and behaviour only; rebuild with the repo's components).

## Decisions (Craig, 2026-10-30)
- Actions: move case steps, confirm placement, case status and assignee, record submission, fix member ID, send patient messages.
- Step detail: key decisions inline; heavy parts (forms, uploads, packet, replacing a determination) open in FrontRunner.
- All seven steps are actionable. A step saves with "Save & Continue" and the case auto-advances to the next step.
- Every write shows a confirm step first.
- Saves go to FrontRunner. The prototype shows the saving, saved and error states; the platform write endpoints are contract gaps (below). Real data reads come later; the prototype uses sample patients with the real step structure.
- Send behaves for real, behind a confirm. Channels: Email, SMS, Portal.
- Closing the case stays in FrontRunner. The sidecar records the decision and note.

## Save pattern (all writes)
1. Staff changes a control or taps the action. A bar appears at the top of the modal: the question, "Confirm" and "Cancel".
2. Confirm: "Saving to FrontRunner…", then "Saved to FrontRunner." with Dismiss.
3. Failure: "Couldn't save to FrontRunner. Nothing was changed." with "Try again" and "Dismiss". Nothing changes on screen until the save succeeds.
Confirm questions: "Save step N and move to step N+1?", "Record the submission and move to step 7?", "Change the case status to X?", "Assign this case to X?", "Confirm placement in <column>?", "Save member ID X to the insurance record?", "Send this <channel> message to <first name>?", "Start a Medicaid renewal case for <first name>?", "Add “<name>” to the required documents?".
Edits inside a step (ticks, selections, typing) are drafts on screen until the step is saved.

## Step panel (under the case progress rail)
Tap a rail node or a row in "See all 7 steps" to open a step. The current step is editable; finished steps are read-only ("This step is done. To change it, open the case in FrontRunner."); later steps are locked ("Finish step N first. Later steps open once the one before is saved."). Percent shows only while the done count matches what the product supplied; after a save it is hidden until the product returns the new value.

| Step | In the sidecar | Save rule | Stays in FrontRunner |
|---|---|---|---|
| 1 Verify | Name, member ID, plan, last check results, income facts; three ticks "I approved the demographics / insurance / financial information"; buttons **Check demographics**, **Check eligibility** and **Replace insurance**, each opening a modal in the sidecar | All three ticked | Patient confirmation request, per-field demographics and financial edits (Review demographics, Review financials) |
| 2 Programs | Filter (Qualifies 7, Needs review 17, All 50); tick programs; count selected | At least one selected | Full program list, plan details |
| 3 Documents | Tick each required document received; add a required document | Every document received | Upload, scan, electronic ID verification, other documents |
| 4 Work requirements | Staff determination (read-only); ticks "I reviewed the work-requirement evidence" and "I confirmed compliance or an exemption" | Both ticked | Replace determination, evidence documents, hours, state submission package |
| 5 Application | Status of each application PDF | Finishes on its own when every PDF is generated | Generate, preview, download, print |
| 6 Submit | Attestation status (read-only), packet status, optional "State case / confirmation #" and "Submission note", "Record submission" | Record submission completes the step and moves to 7 | Download packet, patient signs attestation in the portal |
| 7 Follow up | Ticks "I checked the state case status", "I answered the state's information requests", "I reviewed the available services with the patient"; State decision Approved / Denied; closing note; "Save follow-up & decision" | None required; saves what is entered | Outcome, final close with confirmation and the "close anyway" acknowledgement |

## Step 1 modals (in the sidecar, not FrontRunner)
Each opens over the tab with its own copy of the confirm / saving / saved / error bar. Available whenever step 1 is viewed, including after it is done.
- **Check demographics:** "Run the vendor demographics check for this patient." Shows source (Vendor demographics check) and last run; button runs the check after a confirm.
- **Check eligibility:** "Real-time 270/271 on the patient's current coverage, for today." Shows source, plan and last check; button runs it after a confirm.
- **Replace insurance:** explanation "The previous primary is terminated as of the new effective date, then the new coverage becomes primary as of the new effective date, then eligibility is checked on the new coverage." Fields Payer ("Search active payers"), Member ID, Group number, Effective date; buttons "Save and check" and "Cancel". Prototype requires Payer and Effective date; confirm the product's required fields.
- Check results in the prototype are labelled "Sample result"; the real result fields come from the platform.
- Not brought over: the per-field Review demographics and Review financials dialogs (approve or edit each field). Ask JD whether they are wanted.

## Other actions
- **Case status:** select with New, In progress, Waiting, Submitted (read from the product). "Start case" when the patient has no case.
- **Assignee:** select. Prototype options are sample ("Dev Admin", "Staff member (sample)"); read the real staff list from the platform.
- **Confirm placement:** collapsible section; choose the board column, confirm. Sets "Staff confirmed" and the column colour.
- **Member ID:** the warning gains a field; accepts the letter A followed by eight digits ("Enter the letter A followed by eight digits." otherwise).
- **Patient communication:** as the product wording; "Send Email / SMS / Portal" now sends after a confirm and adds the message to the sent log. Subject shows for Email only.

## Contract gaps (add to the contract doc)
Write endpoints are needed for: start case; change case status; assign case; confirm placement; save step 1 approvals; save program selection; mark documents received and add a required document; save step 4 confirmations; record submission (confirmation #, note); save step 7 checks and decision (decision, closing note); correct member ID; send message (portal channel). Also needed: read the case's current step and per-step state, the staff list for assignee, and the percent after each save. Per action: who may do it, what happens on failure, and whether it is idempotent. The platform send accepts email, SMS and letter today, not portal.

## Open items
- Check results and the Replace insurance required fields are sample; read the real result shape and rules.
- Real saves and real reads are not built; the prototype simulates them.
- Role limits were not specified; ask JD whether any action is restricted.
- Product options not read: step 4 determination choices and step 7 outcome list (both stay in FrontRunner for now).
- Step 5 and Step 3 sample data in the product are inconsistent with their Done status (generated PDFs and received documents); the prototype uses consistent sample data.
- Product's own save rules for steps 3 and 6 were inferred from its wording ("All required documents received", "Submission recorded"); confirm with JD.
- The real panel width is still unconfirmed; check the step panel at 340px.
