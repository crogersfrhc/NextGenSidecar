# Sidecar Style-Alignment Spec (v2)

**Goal:** Align the athena sidecar prototype's look and feel with the platform (Replit "LIVE -V2 FrontRunnerHC-master" / frhc-platform-master), the UI baseline going forward (decided 2026-10-20).
**Date:** 2026-10-21 (v2 edits 2026-10-21, marked "v2"). Repo copy updated 2026-10-26 for the Medicaid Renewal items only (marked *(updated 2026-10-26)*, listed in `README.md`); the sidecar-wide pass itself is recorded in `.agents/memory/athena-embed-sidecar-style-alignment.md`.
**Method:** Computed styles and `:root` variables read from both running apps (sidecar Pre Check-In and Medicaid tabs; platform Patient Hub and Medicaid Renewal pages), plus screenshots. Platform values are the source of truth. **v2:** the platform repo is readable, so confirm every token against the platform code (theme and token files under `website/client`) and use the code values when they differ from the computed styles listed here.

## 1. Already aligned (no change)

| Token | Value |
|---|---|
| Primary | `#284776` |
| Primary light | `#2d6a94` |
| Accent | `#3a7ca5` |
| Surface | `#f6fafc` |
| Muted | `#e8f0f5` |
| Border (brand) | `#d7e6ee` |
| Header gradient | 100deg, `#233f6a` → `#284776` → `#2d5a8a` |
| Page gradient | `#f6fafc` → `#ffffff` → `#eef4f8` |
| Base radius | `0.5rem` |
| Status: success | bg `152 76% 90%`, fg `163 94% 24%`, border `149 80% 84%` |
| Status: warning | bg `48 96% 89%`, fg `26 90% 37%`, border `48 97% 77%` |
| Status: danger (platform "destructive") | bg `0 93% 94%`, fg `0 74% 42%`, border `0 96% 89%` |
| Status: info | bg `214 95% 93%`, fg `224 76% 48%`, border `213 97% 87%` |

## 2. Changes required

### 2.1 Typography
- Body font: `Inter, Manrope, sans-serif` (sidecar currently uses the system stack).
- Headings (page title, card and section titles): `Manrope, Inter, sans-serif`, weight 600. Platform sizes: page title 20px, section/card titles 14px. Scale the page title down for the narrow panel (about 16–18px).
- Body text color: `hsl(220 14% 28%)` (sidecar uses `#0f172a`). Reserve near-black for nothing; use the slate for headings too.
- Muted text: `hsl(215.4 16.3% 43%)`. Stronger muted: `hsl(215.3 19.3% 34.5%)`.
- **v2: minimum text size is 12px everywhere** (buttons, chips, labels, section rows). The sidecar's 9–11px text, including the Medicaid tab prototype's 11px, is raised to 12px. Controls stay at least 44px tall.

### 2.2 Tabs
- Replace the filled navy pill tab with a flat tab: no fill, no radius.
- Active tab: 2px bottom border `#16a34a`, text `rgb(61 68 81)`.
- Inactive tab: transparent border, text `rgb(71 85 105)`, 14px.
- **v2 note:** the Medicaid tab is being renamed "Medicaid Renewal" (longer label). Four tabs (Pre Check-In, Appointment, Clearline, Medicaid Renewal) at 14px may not fit on one line at the real panel width. Decide before building: shorter label, horizontal scroll, or wrapping. Tab restyling is a sidecar-wide change handled in the style pass, not inside the Medicaid Renewal tab work. *(updated 2026-10-26: resolved. The full "Medicaid Renewal" label is kept; the flat tabs are 44px tall (padding only, 14px text) and fit on one line from about 520px up, including the 600px panel; narrower, the tab strip scrolls sideways and never wraps.)*

### 2.3 Cards and surfaces
- Card: white, 8px radius, 1px border `rgba(215 230 238 / 0.2)`, platform's soft shadow (`0 10px 15px -3px rgba(0 0 0 / .1)`, `0 4px 6px -2px rgba(0 0 0 / .05)`, plus 1px `rgba(0 0 0 / .05)` ring). Sidecar's `shadow-card` (0 1px 2px) is lighter than the platform.
- Filter and well areas: light blue-gray well (`#e8f0f5` family) behind white controls, as on the Renewal board.
- Selected row: use the platform's `--selected-row-bg` and `--selected-row-edge` tokens when the sidecar adds selectable rows.

### 2.4 Buttons and controls
- Radius 8px (platform default); 4px only on dense header controls.
- Primary action: solid `#284776`, white text. Secondary: white with a navy outline, as now.
- Search and select controls: white fill, 8px radius, muted placeholder.

### 2.5 Page banner (replaces the small uppercase accordion header on first-level sections)
- Rounded banner with the header gradient and the layered texture overlay (`--header-texture-image`: two translucent white sheen gradients).
- Contents: icon tile on the left (green tile for Medicaid Renewal), title in Manrope 600, and a small title chip ("Renewals").
- In the narrow sidecar, use a compact version (smaller padding, no subtitle) and keep the patient header as is.
- **v2 scope (Craig, 2026-10-21):** the banner applies to page-level or first-level headers only. Do not turn collapsible sections inside a card or modal into banners. In the Medicaid Renewal tab, Why this placement, Patient communication and Screening results stay as plain collapsible rows; the column-coloured modal header is the only banner-style element.

### 2.6 Chips and status pills
- Tinted pill: background, text and border from the matching status token, with a leading icon where the platform has one (for example, the warning triangle on "Demographics reverification overdue").
- Allow two-line chips. Minimum text size 12px.
- Add the platform tones the sidecar lacks:

| Token | Background | Text | Border |
|---|---|---|---|
| Caution | `34 100% 92%` | `21 90% 42%` | `32 98% 83%` |
| Neutral | `210 40% 96%` | `215 25% 27%` | `214 32% 91%` |
| Special | `226 100% 94%` | `244 58% 51%` | `228 96% 89%` |

### 2.7 Category and data colors
- Copy the platform's category tokens: sky, violet, lime, fuchsia, cyan, pink, stone, each with bg, fg and border. Examples: violet `251 91% 95%` / `263 70% 50%` / `251 95% 92%`; pink `326 78% 95%` / `335 78% 42%` / `326 85% 90%`.
- Copy the data tokens: money (`203 48% 44%`), negative and overdue (destructive text), due soon (warning text), ID chip (neutral), delta up (success text).
- Use them in the Medicaid Renewal tab: overdue renewal dates in the overdue color, MRN as an ID chip, FPL and income values in the money color.

## 3. Medicaid Renewal tab: applying the platform's language (v2)

**Design (decided 2026-10-21):** the tab is one modal for the open patient. Its header band takes the name and colour of the platform's Medicaid Renewal board column the patient is in. It is not a recreation of the whole board. Full details are in the project's UX spec (`sidecar-medicaid-renewal-board-view-ux-spec.md`) and handoff (`sidecar-medicaid-renewal-tab-claude-code-handoff.md`).

| Platform element | Sidecar Medicaid Renewal tab |
|---|---|
| Outcome columns (Unknown / Needs Screening, Medicaid Eligible, ACA / Marketplace Eligible, No Longer Eligible) | The modal's header band shows ONLY the column name, in that column's colour, with the body tinted to match. Colours come from the platform's own column tokens, mapped by column name: stone, teal, violet, pink *(updated 2026-10-26; see the open item below)*. A patient on the renewal list with no staff outcome is in Unknown / Needs Screening; a patient missing from the list gets the "No Medicaid data" state |
| "Predicted placement" vs "Staff confirmed" labels | Chip in the header band: "Staff confirmed" (sky) when a staff outcome is recorded, "Predicted placement" (lime) only when placed by income band, no chip otherwise *(colours and label updated 2026-10-26)* |
| Renewal date with "Renewal passed" in red | "Renewal passed" / "Due soon" chip beside the date on the "Renewal due" tile, using the overdue and due-soon data colours *(product wording, updated 2026-10-26)* |
| "Case open / In progress" ribbon | Case badge on the patient; the Case tile shows status only *(updated 2026-10-26)* |
| Case header stage rail ("pizza tracker", "5 of 7 steps done · 63%") *(added 2026-10-26)* | A Case progress card under the Case and Assignee tiles: header with steps done and the product's percent, a seven-node rail (done = success, current = info, not started = neutral), the current step, and a "See all 7 steps" toggle. Read from the product; not shown until the platform serves step data. See `sidecar-medicaid-renewal-case-progress-tracker-addendum.md` |
| FPL line under the renewal date | FPL stat tile, in the money color |
| "Member ids to fix" list | A per-patient warning at the top of the modal body when the product flags the patient's member ID (product's message, else "This member ID failed validation."); display only |
| Case status, assignee, Confirm placement, Run engine, Open patient record | Not in the sidecar: case status and assignee are display-only; the other controls are removed |

Collapsible sections (plain rows, no banners): Why this placement (open by default, explanation only), Patient communication (channels Email, SMS, Portal; send stubbed *(updated 2026-10-26: was Email, SMS, Letter)*), Screening results (read-only).

The existing demo-data disclaimers stay, in the neutral or caution tone, anywhere sample data is still shown.

## 4. Implementation approach
1. Add a theme layer in the sidecar that mirrors the platform's brand pack: `--brand-pack-*` (primary, primary-light, accent, surface, muted, border, ink), plus `--status-*`, `--category-*` and `--data-*`.
2. Use HSL channel values for the shadcn-style tokens (`--primary`, `--foreground`, `--muted-foreground`, `--accent`, `--ring`, `--radius`) so Tailwind-style `hsl(var(--x))` usage matches the platform.
3. Load Inter and Manrope from the same source the platform uses.
4. Update components in this order: typography, tabs, cards, buttons, banners, chips.
5. Re-compare screenshots of Pre Check-In, Appointment, Clearline and Medicaid Renewal against the platform after each step.

## 5. Open items
- ~~**Outcome colours (v2, blocking for the header)**~~ *(updated 2026-10-26: resolved.)* Craig confirmed in the platform code (Replit repo `website/client/src/features/medicaid-renewal/lib/population-vocab.ts`, lines 39-42): stone, teal, violet and pink; the Predicted chip is lime and Staff confirmed is sky. The emerald / blue / red / slate reading came from a different codebase. Stone, teal, lime and sky use the Tailwind 700 / 100 / 200 shades that violet and pink match in 2.7; they have not been checked against the Replit token file.
- ~~The platform code exists only inside Replit~~ **(v2: resolved)** The platform repo can be read through its Replit shell. Take tokens from the code and re-verify if the platform theme changes.
- The platform's dark mode exists (user menu has "Dark Mode"); decide whether the sidecar needs it.
- **Panel width (v2):** the sidecar runs inside an athenaOne frame. *(updated 2026-10-26: the embed's code asks athenaOne for 600px at launch, and athenaOne Preview reported `width: 600` back; users can resize the panel, so layouts stay fluid and are checked at 600px and 340px.)*
- ~~**Tab fit (v2)**~~ *(updated 2026-10-26: resolved, see 2.2.)*
