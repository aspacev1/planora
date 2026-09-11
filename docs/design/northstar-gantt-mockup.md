# The "Northstar" mockup analysis

> **Historical reference.** A structural analysis of a static mockup file
> (unchanged, so still accurate as a description of that file). Its
> implementation recommendations fed into `northstar-redesign-plan.md`,
> which has since been executed — read that file for current status, this
> one for design rationale.

A structural analysis of `northstar-gantt-mockup.html` — the second mockup of a
project screen with a Gantt chart. The first is analysed in
`planora-mockup-analysis.md`; that one is not kept in the repository and exists
only as text, so here the file itself lies next to the analysis.

The mockup is one self-contained HTML: ~250 lines of CSS, ~145 lines of markup,
~85 lines of JS, not a single external dependency. This is a clickable prototype
rather than a starting point for code: almost all the geometry is literals in a
`style` attribute.

The state on screen: Thursday 13 August 2026, the "Day" scale, the "Create
wireframes" task selected with its panel open, and a "Task moved to Aug 13" toast at the bottom.

---

## 1. The frame

```
body (overflow:hidden)
└ .app                      grid: 228px | 1fr
  ├ aside.sidebar           dark (#182032), the only dark zone
  └ main.main               flex-column
    ├ .topbar               52px — breadcrumbs, search, notifications
    ├ header.project-head   the heading + the actions + 5 metrics
    └ section.gantt-shell   flex:1, position:relative — the coordinate system
      ├ .gantt-toolbar      sticky, z-25
      ├ #ganttScroll        overflow:auto — the strip's only scroller
      │ └ .gantt-stage      min-width: 410px + 1092px
      │   ├ .gantt-head     68px, sticky top   ┐ grid: 410px | 1fr
      │   └ .gantt-body     min-height 620px   ┘ grid: 410px | 1fr
      ├ .legend             absolute, bottom left
      ├ #drawer             absolute, on the right, a transform slide
      ├ #snackbar           absolute, bottom centre
      └ #tooltip            position:fixed — the only fixed element
```

The key device: **a two-axis freeze on one scroller**. The strip's header
(`.gantt-head`) sticks by `top`, the task column (`.task-head`, `.task-list`) by
`left`; their intersection (`.task-head`) is frozen on both axes and gets a
z-index above both. There is no second scroller and no synchronization through JS
— this is where the mockup compares favourably with typical Gantt implementations.

The layer ladder is built carefully and without conflicts:

| z | Layer |
|---|---|
| 200 | tooltip |
| 100 | snackbar |
| 80 | popover |
| 55 | drawer |
| 40 | sidebar |
| 25 / 24 | toolbar / legend, `.task-head` |
| 20 | `.gantt-head` |
| 15 | `.task-list` |
| 6–10 | the links layer, the deadlines, the connectors |
| 4–5 | the "today" line, the bars |

The task panel is **an overlay on top of the strip** (`position:absolute` inside
`.gantt-shell`) rather than a third column. This is a deliberate divergence from
the first mockup, where the inspector squeezed the canvas. The consequence: with
the panel open the strip's right edge is covered, and a horizontal scroll does not move it.

---

## 2. The design system

24 variables in `:root`: 15 colour ones, 5 geometric ones (`--row: 48px`,
`--group-row: 44px`, `--day: 52px`, `--task-pane: 410px`, `--drawer: 404px`),
and a shadow. `--cyan` is declared and used nowhere.

The accent is an indigo `#5367e8` (in the first mockup it was `#2563EB`), the
colour semantics are the same and are kept apart just as strictly: green
`#29a36a` — done, amber `#e69a2d` — draft and overdue, pink-red `#d94c71` — a
broken date and being blocked, grey `#8d97ab` — the categories' summary lines.
Every semantic colour has a `-soft` version for the chips' backgrounds.

The font: `font: 14px/1.45 Inter, …` — Inter is declared but wired up nowhere
(no `@font-face`, no `<link>`), so what is actually seen is the system font.
Exactly the same mistake recorded as item 12 of the first mockup's analysis.

**A task's status is drawn in four parallel ways** — and that is the main
structural feature of the mockup's design system:

| | planned | progress | done | blocked | overdue |
|---|---|---|---|---|---|
| `.state-icon` (the icon in the list) | base | ✓ | ✓ | ✓ | — |
| `.pill` (the chip in the list) | base | ✓ | ✓ | ✓ | ✓ |
| `.bar` (the bar) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `.legend-swatch` | ✓ | base | ✓ | ✓ (shared with blocked) | — |

The icon layer is incomplete: `overdue` has no icon, so the overdue "API
integration" is shown with an "in progress" icon and an "Overdue" chip at the same
time. The legend glues blocked and overdue into a single swatch. Five states, four
representations, three different sets — when this is carried into code it has to be
reduced to one source.

Shapes: radii of 5–10px, the chips are full pills, the shadows are soft and
noticeable (`--shadow: 0 12px 36px rgba(16,24,40,.13)`) — unlike the first mockup,
where depth was barely used.

---

## 3. The strip's geometry — and its main defect

The unit is a day = `--day: 52px`, 21 days (10–30 August), a total of **1092px**.
This number is hard-wired in five places: `.gantt-stage`, `.timeline-head`,
`.timeline-body`, and the links layer's `width` and `viewBox`. The height is 620px,
hard-wired in `.gantt-body` and in the same `viewBox`.

Vertically: 3 category rows of 44px + 8 tasks of 48px = **516px** of actual
content against the declared 620px.

### 3.1. Two sources of truth horizontally

Part of the markup computes coordinates through `calc()` from `--day`, part does not:

| Element | How it is set | Survives a scale change |
|---|---|---|
| The header's `.days` columns | `repeat(21, var(--day))` | yes |
| The grid's hatching | a `repeating-linear-gradient` from `--day` | yes |
| The `.weekends` | `calc(5 * var(--day))` and onwards | yes |
| The "today" line | `calc(3 * var(--day) + var(--day)/2)` | yes |
| **The bars, the deadline, the slip marker** | **`left`/`width` literals in px** | **no** |
| **The links layer (SVG)** | **absolute path coordinates** | **no** |
| **The strip's `min-width`** | **1092px** | **no** |

The scale buttons change `--day` (52 → 30 → 18px). After the very first press the
grid, the weekends and the "today" line shrink, while the bars, the arrows and the
canvas's width stay put: the header takes a third of the width and the bars hang
over emptiness. This is not cosmetics — it is a sign that **the mockup does not set
the calculation rules, only one frozen picture**. For the implementation there is a
single conclusion to draw: the coordinates must be computed from the scale, as is
already done in `gantt/timescale.ts` and `gantt/Arrows.tsx`.

### 3.2. The arrows are drawn against a different row model

The SVG paths are laid out on a row grid that diverges from the DOM: the links
layer treats the "Design" category row as 24px tall instead of 44, and the
"Development" row as zero.

| Task | The bar's centre in the DOM | Y in the SVG | Divergence |
|---|---|---|---|
| Define project scope | 116 | 116 | 0 |
| Create wireframes | 208 | 188 | −20 |
| Design system | 256 | 236 | −20 |
| Interactive prototype | 304 | 284 | −20 |
| API integration | 444 | 380 | −64 |
| QA & launch | 492 | 428 | −64 |

That is, as rendered the arrows in the chart's lower half miss the bars by 20 and
64 pixels. "Frontend implementation" has no links at all, although by meaning it is
the prototype's successor.

### 3.3. The bars' pixels are not derived from the dates

The dates live only in the `tips` object for the tooltips, the positions in `style`
attributes. A comparison diverges by up to a day and a half:

| Task | The tooltip | What it actually occupies |
|---|---|---|
| User research | 10 → 12 Aug | 10.5 → 13.0 |
| Define project scope | 12 → 14 Aug | 12.2 → 14.9 |
| Create wireframes | 13 → 18 Aug | 13.5 → 18.3 |
| API integration | 23 → 28 Aug | **22.5** → 28.0 |
| QA & launch | 28 → 30 Aug | 27.8 → 30.5 |

The convention about the bounds floats too: for some bars the start is the middle
of a day, for some the end is the middle and for others the start of the last day.

### 3.4. The "＋ Task" row breaks the columns' alignment

`#inlineAdd` (48px) is inserted **between** "Interactive prototype" and the
"Development" category inside `.task-list`, and it has no paired row in
`.timeline-body`. While it is hidden everything lines up; after "＋ Task" is pressed
the whole bottom of the table travels 48px relative to its bars. `.add-category`
(46px) suffers from the same thing but stands last and is therefore harmless.

---

## 4. The product model built into the mockup

The hierarchy is exactly two levels: project → category → task. Deeper nesting is
not provided for — the chevron folds one level, and the indent is set by a single
`padding-left: 28px` literal.

**A task:** a name, a single owner (avatar plus name), a status, start and end
dates, a readiness percentage, a description, dependencies in both directions
("Depends on" / "Blocks"), a key of the form `DES-104` (numbered within the category).

**A category** aggregates: the owner, the status, a "2 / 2 done" counter, a summary
band with arrow notches.

**A project:** the status Draft → Approved (that is, a plan approval cycle is built
in), five metrics, "Edited 4 min ago", sharing, export to PDF, archiving, deleting.

Separately worth noting is **the deadline as an entity independent of the end
date**: "API integration" has a vertical limiter on 26 August, the bar ends on the
28th, and between them there is a "+2d" marker and an "Original deadline / Current
finish" tooltip. This is a baseline model: the plan is fixed at approval and
compared against the fact from then on.

The links are finish-to-start only (all the paths run from a right edge to a left
one), with a "violated" state (a red dashed line plus a "!" circle). The rule by
which a link becomes violated cannot be derived from the mockup: the marked
prototype → api link runs from 628px to 650px, that is, without an overlap. The
marker was placed by meaning ("the predecessor is blocked") rather than by geometry.

### 4.1. Contradictions in the figures

- The "Design" category is captioned **"1 / 3 done"**, but among its tasks
  (wireframes — in progress, system — planned, prototype — blocked) there are no
  finished ones. It should be 0 / 3.
- The metrics in the header do not add up: 3 in progress + 2 done + 1 blocked +
  1 overdue = 7 against the declared 8 tasks, while two more tasks in the Planned
  status are counted nowhere. This only adds up if "Overdue" is counted as **a flag
  on top of a status** rather than as a status: then "API integration" falls into
  both "in progress" and "overdue". But the chip and the legend draw overdue
  precisely as a status.
- The "Development" category has the status **"At risk"** — a sixth value that is
  neither in the legend nor in the `<select>` list in the panel (there are only
  four there: In progress / Planned / Done / Blocked, without Overdue and At risk).

These are not nitpicks about the mockup but an unresolved product question that
will have to be closed before implementation: **is the status one field from an
enumeration, or a field plus computed flags (overdue / at risk)?** The mockup
silently assumes the second while drawing the first.

---

## 5. The behaviour layer

85 lines with no framework and no state model — every change is made by editing
the DOM directly.

| Mechanic | What it does | What it does not do |
|---|---|---|
| Generating the days | The only real computation: 21 cells, weekends by `i % 7`, "today" by the date | — |
| `popover()` | Click toggling, closing on the document | no keyboard and no `aria-expanded` |
| `selectTask(id)` | Ties the panels together by `data-id`: highlighting the row on the left, the row and the bar on the right, opening the panel | carries **only the name** into the panel; the status, the owner, the dates, the 62%, the description and the links stay from wireframes |
| Hover highlighting | A `mouseenter` on any `[data-id]` highlights both halves of the row | — |
| Folding a category | `hidden` on `[data-group]` in both panes | does not update the counters; the links layer keeps its former geometry and points into emptiness |
| Inline adding | Showing the row, Esc/Enter, a toast | does not create a row |
| The toast | A shared `showSnack()`, a 5.2s timer | "Undo" shows a different toast |
| Approve | Changes the badge and disables the button | — |
| "Today" | `scrollTo({left: 125})` | a magic number, correct only at `--day: 52px` |
| The scale | Changes `--day` and the period caption | recomputes nothing from item 3.1 |
| The tooltips | A dictionary of 9 entries, following the cursor and flipping at the screen's edges | — |
| Dragging a bar | `pointerdown/move/up` with pointer capture, editing `style.left`, a toast on an actual shift | no snapping to the day grid, no date recomputation, no redrawing of the links, no limit on the right |

Separately: the `.handle` (resize grips) and the `.connector-dot` (the link-drag
dot) are drawn and appear on hover, but the `pointerdown` handler deliberately
returns if the press landed on them. That is, **stretching dates and creating links
with the mouse are declared visually in the mockup but do not work** — their
behaviour will have to be designed from scratch.

The progress is hard-wired twice and identically: `.bar.progress::before { width:
62% }` and `.progress-track span { width: 62% }`. So "Frontend · 35%" and "API
integration · 60%" still have a 62% fill — the caption and the picture contradict
each other.

---

## 6. Responsiveness

Three states, and all three are obtained by overriding the variables in `:root`
inside media queries — a tidy device, thanks to which all the squeezing fits into a
few rules.

**≤1180px:** the sidebar 228 → 70px (the captions, the badges and the workspace
switcher are hidden, the icons remain); `--task-pane` 410 → 340; `--drawer` 404 →
390; **the "Status" column disappears** — both in the header and in the rows the
grid is redefined to two columns and the third child is suppressed.

**≤850px:** the sidebar collapses to zero; the project header folds into a column
and the actions move under the heading; the metrics and the toolbar get a
horizontal scroll of their own; `--task-pane` → 300px; the task panel →
`min(92vw, 404px)`; the legend is hidden.

The strip's canvas stays 1092px at that, so on a phone the horizontal scroll is
enormous — apparently deliberately.

---

## 7. Accessibility

What is there: `aria-label` on the landmarks and all the icon buttons, `role`
markup through semantic tags (`aside`, `main`, `header`, `nav`), correct handling of
`[hidden]`, a visible `:focus-visible` with a thick outline.

What is not: the rows are `div`s with a click handler, with no `role`, no `tabindex`
and no keyboard; the chevron has no `aria-expanded`; the task panel is not a dialog
and does not trap the focus; the tooltip is not tied to its element through
`aria-describedby`; the scale switcher is not a `radiogroup`; there is no
`prefers-reduced-motion`.

A separate oddity: `lang="ru"`, all the visible text is English, and the
`aria-label`s are Russian. A screen reader will read the English captions with
Russian pronunciation.

---

## 8. What follows from this for the implementation

The mockup is useful as **a description of the composition and the design system**
and harmful as a source of geometry. The dividing line runs exactly along "laid out
with variables / hammered in as literals".

Take as is:

1. The two-axis freeze on one scroller scheme — it works and is better than what is
   usually written by hand.
2. The z-index ladder — there are no conflicts in it.
3. The device of overriding `:root` in media queries, including the Status column
   disappearing on medium screens.
4. The task panel as an overlay — but this is a deliberate change of decision
   relative to the first mockup, and it is worth confirming explicitly.
5. The deadline as an entity separate from the end date (the "+2d" marker) — the
   only genuinely new product idea in this mockup.

Do not take:

6. Any pixel coordinates. The code already has the right approach:
   `gantt/Arrows.tsx` explicitly computes the coordinates from the scale and
   `ROW_HEIGHT` rather than measuring the DOM — the comment there describes exactly
   the defect the mockup suffers from (item 3.2).
7. The 62% literal for the progress.

To decide before the code:

8. **The status: an enumeration or a field plus flags?** (item 4.1) The chip, the
   icon, the legend, the metrics and the `<select>` in the panel all depend on it.
9. The behaviour of the resize grips and the link dragging — they are not in the mockup (item 5).
10. The rule by which a link counts as violated (item 4).
11. Snapping a drag to the day grid and recomputing the dates.

Small things that are cheaper to fix straight away: wire up Inter, remove `--cyan`,
correct the "1 / 3 done" counter, align `lang` with the `aria-label`s' language,
give `#inlineAdd` a paired row in the strip (item 3.4).
