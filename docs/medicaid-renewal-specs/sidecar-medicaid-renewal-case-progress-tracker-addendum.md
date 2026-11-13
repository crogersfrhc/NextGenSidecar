# Addendum: Case progress tracker for the built Medicaid Renewal tab

Written 2026-10-26 for Claude Code, to extend the Medicaid Renewal tab that is already built in the athena-embed prototype. Read together with `sidecar-medicaid-renewal-tab-claude-code-handoff.md` and `sidecar-medicaid-renewal-board-view-ux-spec.md`. This addendum adds one component; everything else in the tab is unchanged.

## Why

JD asked Craig to bring the Medicaid Renewal UI, including the "pizza tracker", from the latest branch into the sidecar. The tracker is the product's stage rail on the case header: a row of numbered steps showing how far the case has progressed. In the sidecar it is display only.

## What to build

A **Case progress** card in the modal body, directly under the Case and Assignee tiles and above the collapsible sections. Show it only when the patient has a case and the product supplies step data. Otherwise render nothing (no placeholder, no empty card).

Contents, top to bottom:

1. **Header row:** label "CASE PROGRESS" (left) and "5 of 7 steps done · 63%" (right). The percent is the product's percent (see Data). If the product supplies no percent, show "5 of 7 steps done" only.
2. **Rail:** seven nodes in one row, joined by a thin line.
   - Done: filled green node with a check.
   - Current: white node with a blue ring and the step number.
   - Not started: white node with a grey ring and the step number.
   - The line is grey and is filled green from the first node up to the current step.
   - Each node has a tooltip and an accessible name: "Step N of 7: <title> · <status>".
3. **Current step block:** "Step 6 of 7: Submit & record the case" with a status chip (Done / In progress / Not started) and the step's one-line description.
4. **"See all 7 steps" toggle**, collapsed by default (button, at least 44px tall). When open it lists all seven steps, each with a number or check node, the title, the description and the status chip. The toggle label changes to "Hide all steps".

Remove any progress line or bar from the Case tile; progress now lives only in this card. The Case tile shows status only.

### Steps (titles and descriptions as in the product)

| # | Title | Description |
|---|---|---|
| 1 | Verify the patient's information | Confirm the facts the renewal is based on. |
| 2 | Select the renewal programs | Choose the programs this renewal targets — the document checklist is built from them. |
| 3 | Gather the required documents | Collect the proof each selected program needs and request anything outstanding from the patient. |
| 4 | Work requirements | Review evidence and confirm the patient meets the work requirement or is exempt. |
| 5 | Prepare the application | Fill out the state application forms — electronically, through the patient portal, or on paper. |
| 6 | Submit & record the case | Submit the application to the state and record the submission on the case. |
| 7 | Follow up & record the decision | Keep the case moving while the state reviews it, then record the decision. |

Use the product's own strings if they differ from these; the product's wording wins.

### Behavior

- Display only. No clicking a node to open a step, no "Move to next step", no marking steps done, no activity checklists, no "Open" stage action, no submission packet download. Those remain in the main product. *(updated 2026-10-30: superseded by `sidecar-medicaid-renewal-actionable-addendum.md`. Nodes open a step panel, steps save and advance; the packet download and the final close stay in FrontRunner.)*
- Status for each step comes from the data: done steps are before the current step; the current step is "In progress" unless the case is closed.
- Closed or denied cases: mirror the product's wording ("Closed", "All steps done", "Denied") instead of showing a normal in-progress step. A closed case shows its real percent, never 100 (JD, 2026-10-18).
- Collapsed by default. The rest of the tab keeps its defaults (only Why this placement is open).

### Look

Follow the platform tokens and the style rules in the handoff's Style alignment section: Inter/Manrope, 12px minimum text, nodes at least 24px, 8px card radius, platform card shadow. Colours come from the platform's status tokens: done = success, current = info, not started = neutral. Check AA contrast on the chips. The rail must fit the real panel width with no horizontal scroll (the prototype fits at 400px with 24px nodes; the real width is unconfirmed, so verify at the real width and at the narrowest plausible width, about 340px).

## Data

This is the blocker. Confirm before building:

- The product's rule (JD, 2026-10-18): percent = activities satisfied divided by total activities across all stages, not stages divided by 7. It is derived in the browser by `website/client/src/features/medicaid-renewal/lib/pane/step-progress.ts` (`deriveCaseProgress`, `percentComplete`) in the Replit repo LIVE -V2 FrontRunnerHC-master (commit 78a15a5ed). The tracker itself is `components/pane/CaseProgressTracker.tsx`. Activity catalog: `PROCESS_STEP_ACTIVITIES` in `server/medicaid-redetermination-api.js`, vendored at `applications/services/action-handler/tests/contracts/fixtures/vendor/process-activities.ts`. These are reference only; do not port them into the sidecar.
- The athena-embed platform you read earlier (`stage_machine.py`) stores 8 stage statuses grouped into 4 nodes and has no 7-step or per-activity data. The tracker's 7 steps do not map onto it one to one, and the Replit board's own catalog differs by version (8 steps and about 18 activities in one repo; 7 steps and 16 activities on the board deployment Craig compared, Bob Testpatient = 63%).
- Decision (Craig): the sidecar reads progress from the product and does not compute it. Build the card against an optional typed field on the route:

  ```
  caseProgress?: {
    steps: { position: number; title: string; description?: string;
             status: "done" | "in_progress" | "not_started" }[];
    doneCount: number;       // steps done
    totalSteps: number;      // for example 7
    currentPosition: number | null;
    percentComplete?: number; // product's percent, optional
    closed?: "closed" | "denied" | null;
  }
  ```

  If the field is absent, the card is not shown. Do not derive it from the 8-stage model.
- Add to the contract doc as a platform gap: "Serve case progress per case (steps with status, done count, total steps, current position, percent, closed/denied). Today only the Replit board derives it in the browser; the athena-embed platform has an 8-stage / 4-node model. Needs a server-side field and a decision on which step and activity catalog it uses."
- For design review before the field exists, use the existing sample-data mode (off by default, clearly labelled "Sample data") with Bob Testpatient: 5 of 7 done, step 6 in progress, 63%. Never ship sample data on.

## States

- Loading: covered by the tab's loading state; the card does not need its own spinner.
- No case, or the field absent: card not shown.
- Closed / Denied: header and current step use the product's closed wording; rail shows done steps as done.
- Error reading progress only: do not show the card and do not block the rest of the tab. No new error copy needed unless the tab's other sections show one for their own failures; in that case reuse the same pattern ("Couldn't load case progress." with a "Try again" button inside the card area).

## Acceptance checks

- With Bob's sample data: header "5 of 7 steps done · 63%", five green checks, node 6 blue and current, node 7 grey, line filled to node 6, current step block reads "Step 6 of 7: Submit & record the case" with an "In progress" chip.
- "See all 7 steps" is collapsed on first load, opens to seven rows, and toggles its label.
- A patient with no case shows no card. A patient whose route returns no `caseProgress` shows no card.
- Nothing in the card is clickable except the toggle. Each node has an accessible name with step number, title and status. Keyboard: the toggle is focusable and works with Enter and Space.
- Text at least 12px, toggle at least 44px tall, AA contrast on chips, no horizontal scroll at the real width and at 340px.
- Case tile no longer shows a progress line or bar.
- The percent matches the Replit board card for the same patient where the data allows it (Bob Testpatient = 63% on the board deployment compared, 10 of 16 activities).

## Reference

- Prototype (private artifact): "Sidecar Medicaid Renewal Board View (Patient)", https://claude.ai/artifact/LJZqGWabuTq9hubvQVyHiL. It shows the card with sample data; use it for layout only, and rebuild with this repo's components.
- Product visual: the case header on the Replit Medicaid Renewal board (the "5 of 7 steps done · 63%" rail).
- Open question for JD: which branch is "latest" for the Medicaid Renewal UI. *(answered 2026-10-26, Craig: the Replit dev preview at `https://5781574c-dc80-4c3a-ba1b-802fe9366325-00-2ftiyn830h3bt.worf.replit.dev/medicaid-renewal?wf=9002`. Wording comes from that product.)* The reference above came from the Replit preview Craig was using and the LIVE -V2 repo at commit 78a15a5ed.

## As built (added 2026-10-26, PR #93)

- **Field location:** the route carries it as `renewal.case.caseProgress` (inside the case, so "no case" also means no card), with exactly the shape above. A shape check (`normalizeCaseProgress` in `athena-embed/lib/medicaid-renewal.js`) drops a malformed value and derives nothing.
- **Data today:** the field is absent for every live patient. Verified at `frhc-platform` `development` `23739ef8` (2026-10-26): the platform has only the 8-stage `process_activities` (4 UI nodes), no 7-step catalog, no per-activity data and no percent. The vendored catalog path named above (`applications/services/action-handler/tests/contracts/fixtures/vendor/process-activities.ts`) is not on `development` or `replit/main`.
- **Closed / denied wording used:** header "All steps done · P%" (closed with every step done), "Closed · N of 7 steps done · P%" (closed early), "Denied · N of 7 steps done · P%"; the current step block shows "All steps done", "Closed" or "Denied" with a matching chip. Not yet checked against the product's exact strings. *(updated 2026-10-30, Craig: superseded; matches the product's CaseStepper. The summary is always "N of 7 steps done · P%". A denied case shows "Denied" with a cross on the last step only, and a closed case adds no wording, with plain, non-interactive nodes.)*
- **Error reading progress only:** not applicable yet. Progress arrives in the tab's single read, so there is no separate progress read to fail; a failed tab read uses the tab's load-error state.
- **Step titles and descriptions:** taken from the table above; not yet checked against the product's strings.
- **Review sample:** Bob Testpatient, 5 of 7 done, step 6 in progress, 63% (sample data off by default).
