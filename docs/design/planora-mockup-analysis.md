# Planora mockup analysis

> **Historical.** All discrepancies with the implementation that §10 of this
> document lists have since been closed (see §10's own status note). Kept
> as a design-history record, not an open task list.

A deep analysis of the "Planora" mockup — the "Website Redesign" project screen with
its Gantt chart — which two redesign passes have already gone through (`6c8ede1`,
`744a1e8`). The mockup file itself is not kept in the repository; its only description
in the code is the header of `frontend/src/broadsheet-theme.css`. This document records
the mockup as text: the screen's construction, the design system, the product mechanics
the mockup implicitly postulates, its internal contradictions — and, above all, its
divergences from the current implementation, so that a third pass does not look for them
anew.

The date in the mockup is Thursday, 13 August 2026, the "Day" view, with the
"API integration" task selected and its panel open.

---

## 1. The screen's composition

Three vertical zones, a light theme:

```
┌──────────┬────────────────────────────────────────────┬──────────────┐
│ Sidebar  │ Project header (2 tiers)                    │ Task         │
│ ~230px   ├────────────────────────────────────────────┤ inspector    │
│          │ Timeline toolbar                            │ ~360px       │
│          ├──────────────┬─────────────────────────────┤              │
│          │ Task table   │ Gantt canvas                │              │
│          │ (3 columns)  │ (a day = a column)          │              │
└──────────┴──────────────┴─────────────────────────────┴──────────────┘
                       ▲ the "Task moved to Aug 19 · Undo" toast on top, bottom centre
```

The inspector is not an overlay but a third column: the canvas shrinks, and the project
header partly goes under the panel (the "Share" and "⋯" buttons stand to its left).

## 2. The design system

**Typography.** An Inter-class grotesque. The project heading ~28–32px/700; the body
text 14–15px; metadata and captions 13px in a muted grey. The date numbers in the ruler
are large, with the weekday under them in 10–11px small caps.

**Colour.** A white background, grey-blue borders (~`#E5E9F0`), almost black text
(~`#111827`), a muted grey (~`#6B7280`). One saturated accent, blue
~`#2563EB`…`#2E5BFF`: the primary buttons, the active navigation items, the "in
progress" bars, the "today" line, the progress in the panel, the "Undo" link. Semantics:

| Role | Colour | Where |
|---|---|---|
| Blue | ~`#2563EB` | the accent, In progress, today, progress |
| Green | ~`#16A34A` on `#EAFBF1` | Done: the chip and the bar with a tick |
| Orange-amber | ~`#D97706`/`#F59E0B` | Blocked, the Draft badge |
| Grey | outlined | Planned: the chip and the "empty" bar |
| Violet-indigo | ~`#6D5AE0` | the categories' summary lines |
| Red | ~`#E11D48` | overdueness: the "+4d" marker and the vertical limiter |

Red and orange are kept apart: orange is a state (blocked, draft), red is a broken date.
Violet exists only so that a category's summary line does not read as one more task bar.

**Shapes.** Radii of 6–10px; the status chips are fully rounded pills with a tinted
background and a border in the text's tone. Shadows are almost absent — depth is set by
borders; a noticeable shadow appears only on the toast and, probably, on the dropdowns.
The avatars are round photographs of ~28px.

## 3. The sidebar

A "P" logo tile with a gradient plus the "Planora" wordmark. Navigation of five items
with icons: Home, My tasks, **Projects** (the active one — blue text on a light blue
`#EEF4FF` pill), Team, Reports. At the bottom, the current user's avatar, the name
"Taylor Smith" and a chevron for the account menu. There is no top header in the
application at all — all the global chrome lives in the rail.

## 4. The project header (two tiers)

**Tier 1.** On the left: the "Website Redesign" heading; under it the metadata line
"Aug 13 – Aug 26 · 2 categories · 6 tasks" and a separate amber **Draft** badge. On the
right: a primary "Approve plan", a secondary "+ Task", "Share" with a people icon, a "⋯"
kebab. The Draft + Approve plan pair sets the plan's life cycle: draft → approved (and,
judging by the implementation, a baseline plan for the ghost lines and the deviations).

**Tier 2 (the toolbar).** On the left: a blue primary "+ Task" (duplicating the header —
see §9), "Today", the ‹ › chevrons, the "August 2026" caption. On the right: a
**Day | Week | Month** segmented control (Day active), a "Filter" button with a funnel, a
"View" dropdown with a table icon.

## 5. The task table

Three fixed columns with the headings **Task / Owner / Status**, and beyond them the
canvas. The rows are tall (~56–64px), the grid is thin horizontal rules.

- **Task** — the name; the categories ("Product design", "Development") have a collapse
  chevron and a semi-bold weight.
- **Owner** — one round photo avatar; the categories have an "—" dash.
- **Status** — a chip of four states: `Done` (green), `In progress` (blue), `Planned`
  (grey outline), `Blocked` (orange). The categories have a **readiness percentage**
  (67%, 50%) instead of a chip: a reduction over the child tasks.

Under the last category are the "+ Add task" and "+ Add category" affordance rows. The
selected row (API integration) is highlighted in light blue across the full width,
including the canvas.

## 6. The Gantt canvas

**The ruler.** An "AUGUST 2026" top band, under it the day cells 12–26 with the weekday.
Today (13 THU) is blue, with a **TODAY** pill under the cell and a blue vertical line
across the whole canvas. The weekends (15–16, 22–23) are slightly darkened columns.

**The bars.** ~24–28px tall, a radius of ~6px:

| State | Rendering |
|---|---|
| Done | a green `#EAFBF1` fill, a green border, a **white tick in a green circle** at the left edge |
| In progress | a blue fill over the progress share, the remainder pale blue; "Design prototype" has a caption to the right of the bar: "Design prototype · 60%" |
| Planned | an outlined "empty" bar |
| Blocked | an orange pill with a warning triangle and the word "Blocked" right on the bar |

**The overdueness forecast.** To the right of "Design prototype"'s bar there is a dashed
outline of a continuation and a red vertical rule with a **"+4d"** marker: the remaining
work goes past the date by 4 days. This is a static diagnosis (baseline/deadline against
fact) rather than a drag preview — the move toast is about a different task.

**Dependencies.** L-shaped connectors with arrows, in light blue: Design prototype →
User testing; Database schema → API integration → QA & launch. An arrow leaves the
predecessor's end and enters the successor's start. Exactly these links are duplicated in
the panel ("Depends on" / "Blocks") — the graph is editable rather than merely drawn.

**The categories' summary lines.** A thin (~3px) violet line from min(start) to max(end)
of the child tasks.

## 7. The task inspector

The "API integration" heading plus a "×". The form's fields:

- **Status** — "• In progress", a dropdown ⇒ in this model the status is an *assigned
  field* rather than one computed from the progress and the dates.
- **Owner** — an avatar plus "Alex Morgan", a dropdown ⇒ there is a single owner.
- **Start date / Due date** — "Aug 18, 2026" / "Aug 23, 2026", with calendar icons ⇒
  both dates are editable.
- **Progress** — "60%" and a blue progress bar.
- **Depends on** → a "Database schema" chip link; **Blocks** → "QA & launch"; both have a
  link icon (managing links from the panel).
- **Description** — a paragraph of text.
- **Comments** — replies with a photo avatar, a name and an "Aug 12, 2026 10:24 AM"
  stamp; at the bottom an "Add a comment…" field with a send button and the author's avatar.

## 8. The toast

Bottom centre — a dark (~`#1F2937`) pill with a tick in a circle: **"Task moved to Aug
19"** and a blue **Undo** link. The canonical pattern: a bar was dragged → the operation
applied at once → an easy way back is at hand. The mockup assumes no confirmation modals
for a move.

## 9. The mockup's contradictions and conventions

1. **The panel against the canvas and the toast.** The toast says "moved to Aug 19", the
   "API integration" bar starts around the 19th, while the panel's Start date is "Aug 18".
   An artistic licence of "the moment right after a drag"; in the implementation the panel
   must update in step with the bar.
2. **Two "+ Task"s.** The button is both in the header and as a primary in the toolbar.
   One is enough in the implementation; the second is a candidate for removal (we
   currently have one, in the toolbar).
3. **The `67%` on Product design** does not agree with its children (Done + 60% + 0% ≈ 53%
   unweighted) — either it is weighted by duration or the numbers are notional. The
   reduction rule has to be chosen explicitly.
4. **The semantics of "+4d"** are ambiguous: a drag preview or an overdueness forecast. By
   the toast's position (about a different task) and the red colour — a forecast; our
   "baseline ghost + deviation badge" pair matches it but is drawn differently.
5. **Blocked — a status or a consequence?** In the mockup it is a chip on a par with
   Planned, while QA & launch stands last in the dependency chain — being blocked could be
   derived from an unfinished predecessor. The mockup's model (the status is assigned by
   hand) is simpler and, apparently, deliberate.

## 10. Divergences from the current implementation

> **Status.** All fourteen items were closed in the same branch as this document (see the
> history of the `claude/mockup-analysis-1nka8f` branch): the status became a stored field
> with a migration and the `set_status`/`add_dependency`/`remove_dependency` operations,
> the "Owner" and "Status" columns appeared, a toast with an undo, five navigation
> sections with the "Home", "My tasks" and "Reports" screens, the "Filter"/"View"/kebab
> menus, avatars and timestamps in the comments, Inter in the build and a red danger
> colour. The layers hidden by the theme (item 14) were either cut out of the DOM (the
> pills, the category dot, the name on the bar) or turned on through "View" (the legend,
> the summary, the footnote). The table below is kept as history: what exactly diverged at
> f5dd96d.

A comparison with `frontend/src` (the state of `main`, f5dd96d). A great deal already
matches: the rail navigation, the two-tier header, the period·counters, the amber plan
pill, Approve plan, Share, Today/the chevrons/the month caption, the Day|Week|Month
segment, the "today" line with its chip, blue bars with a progress fill, green done bars,
dependency arrows, a drag that pins the dates, a ~388px right panel, the comments. The
substantial divergences:

| # | Mockup | Implementation | Where |
|---|---|---|---|
| 1 | 5 navigation items (Home, My tasks, Projects, Team, Reports) | 2 items: Projects, Members | `components/Header.tsx` |
| 2 | Owner and Status columns in the table | Neither avatars nor chips; the status is expressed only by the bar's colour | `gantt/Row.tsx` |
| 3 | The status is a field with 4 values, there is a Blocked | The status is computed (done/planned/active from the progress and the dates); there is no "Blocked" — there is an orthogonal criticality, where `critical` is drawn as an orange "blocker" | `gantt/Row.tsx:176`, `api/projects.ts` |
| 4 | Owner — a single one, with an avatar, in the list and the panel | A multi-select of "Assignees" as chips, only in the panel and without avatars; not shown in the list | `task/TaskPanel.tsx` |
| 5 | The panel: a Status field, a progress bar, an editable Due date | There is no status; the progress is a numeric input without a bar; the end date is read-only (the server computes it from the duration) | `task/TaskPanel.tsx:254` |
| 6 | Depends on / Blocks are edited from the panel | The dependencies are read-only across the whole frontend: the `Op` union has no `add/remove_dependency`, although the backend can do them | `api/projects.ts:120` |
| 7 | A "Task moved … · Undo" toast after a drag | The toast is there, as in the mockup; there is no permanent "Undo: …" button in the header — the undo lives only in the toast after a move plus the shift-reason modal | `gantt/useDragDates.ts:104` |
| 8 | Filter and a View dropdown in the toolbar | Absent | `gantt/Gantt.tsx` |
| 9 | A "⋯" kebab in the header | Absent (there is not a single dropdown menu) | `project/ProjectHead.tsx` |
| 10 | A tick on the done bars; a readiness % on the categories | The bar is green but without a tick; a category has a task counter (hidden by the theme at that), there are no percentages | `broadsheet-theme.css:122`, `gantt/Row.tsx:18` |
| 11 | Comments with avatars and a full timestamp | The name as text plus a short date, no avatars | `comments/CommentThread.tsx` |
| 12 | Inter as the interface font | Declared in `--font` but wired up nowhere — we fall back to the system font | `broadsheet-theme.css`, `index.html` |
| 13 | An accent of ~`#2563EB`; red only for overdueness | The accent is `#2459F5` (close); danger is a pink `#EF3B7D`, a legacy of the previous theme | `broadsheet-theme.css` |
| 14 | — | The theme hides what is already built: the legend, the deadline summary, the caption, the blocker/waits/slip pills, the categories' dots and counters (`display: none`) | `broadsheet-theme.css:96,113–114` |

## 11. What to do first

If the mockup and the code are to be brought together further, the order by
"visibility/cost" ratio:

1. **The Owner + Status columns** in the table (items 2–3) — the most conspicuous
   difference; requires a decision on the status model (stored vs computed).
2. **The task panel**: a progress bar, a status field, avatars (items 4–5).
3. **Editing the dependencies** from the panel (item 6) — the backend is already ready,
   only the frontend operations are missing.
4. **A toast with an Undo** after a drag (item 7) — the undo is currently almost invisible.
5. **Wire up Inter** and replace the pink danger with a red one (items 12–13) — an hour's
   work, and the typography and the colour's semantics fall into place.
6. Filter/View/the kebab (items 8–9) — to be drawn only together with real functionality;
   empty controls are worse than missing ones.

Item 14 is a separate decision: the legend and the pills hidden by the theme either come
back in a new visual language or are cut out of the DOM, but they must not live as
"invisibles".
