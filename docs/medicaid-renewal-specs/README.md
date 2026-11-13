# Medicaid Renewal tab specs

These are Craig's (PM) specs for the sidecar's Medicaid Renewal tab. They are
requirements input for this prototype. They do not describe what the platform
ships.

They were copied verbatim on 2026-10-21 (the addendum on 2026-10-26). On
2026-10-26 the repo copies were **updated to match the built tab and Craig's
later decisions**, through the Case progress tracker (PR #93). Every changed
passage is marked *(updated 2026-10-26)* or *(added 2026-10-26)* in the file,
so Craig's originals can be compared.

| File | What it covers |
|---|---|
| `sidecar-medicaid-renewal-tab-handoff.md` | Build handoff: what to build, the states, the data gaps and the acceptance checks |
| `sidecar-medicaid-renewal-ux-spec.md` | UX spec: the chosen column-modal design and its decisions |
| `sidecar-style-alignment-spec.md` | Style alignment (v2): the platform look and feel. Its tab, banner and theme-layer items were done in the separate sidecar-wide pass |
| `sidecar-medicaid-renewal-case-progress-tracker-addendum.md` | Addendum (2026-10-26): the Case progress card (the product's "pizza tracker"), display only, built against the optional `case.caseProgress` field. Ends with an "As built" section |
| `sidecar-medicaid-renewal-actionable-addendum.md` | Addendum (2026-10-30), verbatim: makes the tab actionable. The step panel, the save pattern, the case controls, Send, the step 1 dialogs and the write contract gaps. **It wins over every earlier "display only" rule** |

The specs refer to each other by other file names:
- `sidecar-medicaid-renewal-board-view-ux-spec.md` is the UX spec.
- `sidecar-medicaid-renewal-tab-claude-code-handoff.md` is the handoff.

## What the 2026-10-26 update changed

- **Case progress** (handoff, UX spec, style spec): moved out of the Case tile into the Case progress card, per the addendum. The Case tile shows status only; the card is not shown without a case or without the product's step data. The contract-gap wording is the addendum's.
- **Column colours** (handoff "The modal", UX spec, style spec open item): stone / teal / violet / pink, with lime (Predicted) and sky (Staff confirmed) chips (Craig, 2026-10-21, from the Replit repo's `population-vocab.ts`). This removes the handoff's earlier slate / emerald / blue / red paragraph.
- **Channels** (UX spec): Email, SMS and Portal, as in the product; no Letter (Craig, 2026-10-26, replacing his 2026-10-21 Email / SMS / Letter decision). The send stays stubbed.
- **Send** (UX spec behaviours): the product's "Send <channel>" button; the stub shows a preview and "Nothing was sent", and adds nothing to the sent log.
- **Product wording** (handoff, UX spec, style spec; Craig, 2026-10-26, read from the Replit preview `/medicaid-renewal?wf=9002`): "Predicted placement" chip, "Renewal due" tile with "Renewal passed", sentence-case en-dash income bands, the placement sentence leading "Why this placement", and Patient communication's subtitle, intro, Subject / "Write a message" placeholders and "Failed" chip. Both specs gain Craig's "Product wording" section with an "As built" note listing what was not applied.
- **Panel width** (all three): 600px, as the app requests at launch and athenaOne Preview reports back; users can resize it, so the tab stays fluid and is checked at 600px and 340px.
- **Tabs** (handoff, UX spec, style spec): the sidecar-wide style pass made them flat, 44px tall, 14px text. They fit on one line from about 520px up; narrower, the tab strip scrolls sideways and never wraps.
- **Minimum text size** (handoff acceptance check, UX spec decisions): 12px, per the style alignment (it had said 11px).
- **Member ID warning position** (UX spec): at the top of the modal body, matching the handoff and the UX spec's own decision (one line had said "under the notice strip").
- **Recommended UI items** (handoff): records which are applied.

## What the 2026-10-30 update changed

- **Actionable addendum** added verbatim.
- **UX spec:** Craig's 2026-10-30 "Actionable tab" section is appended verbatim. His 2026-10-30 file was based on his own pre-2026-10-26 text, so the rest of the repo copy keeps the 2026-10-26 corrections above. The display-only passages it supersedes are marked *(updated 2026-10-30)*.
- **Handoff and tracker addendum:** their display-only and stubbed-send lines are marked as superseded.

**As built (2026-10-30).** Writes go through `POST /api/medicaid-renewal/:patientId/actions/:action` (`lib/medicaid-renewal-actions.js`).
- **Live platform writes:** case status, step 1 and step 4 saves, add document, record submission, step 7 follow-up and decision, and Send email / SMS.
- **Contract gaps** (each fails with the error state): assign, start case, confirm placement, step 2 and step 3 saves, member ID, Portal send, and the three step 1 dialogs. See the contract doc, rows W1–W17 and R1–R3.
- **Not wired for live patients:** the step panel needs per-step detail, which only the samples carry today.
- **Sample patients:** saves are simulated and say so. `?medicaidSimulateFailure=1` makes them fail, so the error state can be reviewed.
- **Wording the addendum does not give** (sidecar-authored): "Run the demographics check now?", "Run the eligibility check now?", "Replace the primary insurance with X from DATE?", "Save the follow-up and decision?", the gap line "This action isn't connected to FrontRunner yet.", and the sample saved line.

## Decisions recorded here only

- **Panel width (Craig, 2026-10-30):** the sidecar panel is **600px**. This settles the open item in the actionable addendum and the "unconfirmed" note in the UX spec. 600px is the width the tab is designed and accepted at; 340px is no longer a target. The earlier 340px measurements are history: the rail step buttons were 34px wide there, but they are 71px at 600px.

- **Sample-data label:** neutral tone, because the caution tone fails AA at 12px.
- **Card shadow (superseded 2026-10-21, sidecar-wide style pass):** cards, including the tab's modal and the Case progress card, use the style spec 2.3 shadow: `tailwind.config.ts` `shadow-card` from the reachable `frhc-platform` code plus the spec's 1px ring. The platform `Card` primitive itself uses `shadow-sm`.
- **Sidecar-wide style pass (2026-10-21):** done. Where the reachable `frhc-platform` code (development `b3809e46`) and the spec differ, the record is in `.agents/memory/athena-embed-sidecar-style-alignment.md`.

## Still unverified

- Stone, teal, lime and sky token values: they use the Tailwind 700 / 100 / 200 shades that violet and pink match in the style spec, but they were not read from the Replit code.
- The Case progress card's step titles and descriptions, against the product's exact strings. (Its closed / denied wording now follows the product's CaseStepper, as Craig decided on 2026-10-30.)
- The product's own message for an invalid member ID: none found in the reachable code (the V2 board's "Member ids to check" list has only AHCCCS-specific list copy). The warning keeps "This member ID failed validation." as its fallback.
- A Portal channel on the platform: `frhc-platform`'s `medicaidOutreachSend` takes email / sms / letter only (contract row 15).
- **Latest Medicaid Renewal UI (Craig, 2026-10-26):** the Replit dev preview at `https://5781574c-dc80-4c3a-ba1b-802fe9366325-00-2ftiyn830h3bt.worf.replit.dev/medicaid-renewal?wf=9002`. **Wording must come from that product.** It is behind Replit's login gate, so it could not be read from the build session; the case progress card's step titles and descriptions and its closed / denied wording still need checking against it.

Where these decisions are also recorded:
- `.agents/memory/athena-embed-medicaid-renewal-tab.md`
- `../CONTRACT-medicaid-renewal-sidecar-2026-10-21.md`
- `../REPLIT-STARTUP.md` (how to view the sample states)
