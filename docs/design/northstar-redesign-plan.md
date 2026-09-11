# Frontend redesign plan for the Northstar mockup

> **Historical, executed.** This redesign plan has been fully carried out —
> the color tokens, metrics strip, and other concrete deliverables it
> specifies all match the shipped frontend. One naming note: this document
> refers throughout to the pre-redesign theme file as `broadsheet-theme.css`
> (its name at the time this was written); it shipped as
> `frontend/src/northstar-theme.css`. Kept as a design-history record.

A working plan for moving the interface onto the visual language of the
`northstar-gantt-mockup.html` mockup (the analysis is in `northstar-gantt-mockup.md`).

The source of truth for the look is the mockup's Gantt zone: the project header,
the toolbar, the task table and the timeline. The mockup's dark sidebar is not
part of that zone and is not carried over — the sidebar stays light and is simply
repainted in the new palette.

---

## 1. What exactly changes, and what does not

The work splits in two: repainting what exists, and two new blocks.

**Repainting.** The palette, shapes, sizes, spacing and typography across the
whole frontend. The set of screens and the behaviour do not change.

**Two new blocks:** the metrics bar in the project header (§5) and the tooltip on
hovering a bar (§6).

Decisions taken before the work starts, so they are not revisited along the way:

| Question | Decision |
|---|---|
| The timeline toolbar | Its contents do not change. "Category", "+ Task", the "Scale" and "View" menus stay. The Day/Week/Month segments, "Today", "‹ month ›" and "Filter" from the mockup are **not brought back** — they were removed deliberately in PR #48 |
| The task table's columns | There is one column, with the name. Owner and Status from the mockup are **not added** |
| The task panel | Stays a third column rather than an overlay: an overlay is a re-layout, not a repaint |
| The sidebar | Light, repainted. The mockup's dark sidebar is not carried over |
| The "PROJECT PLAN" eyebrow | Not added: its role is already played by the "Project plan · draft" line, which will become a Draft/Approved badge |
| Timeline responsiveness | The mockup's device — overriding the measurements in media queries — is **taken** (§4.3). Today the timeline has no responsiveness at all, and the task column grows from 220 to 300px: without media queries the canvas on a narrow screen would end up narrower than the column |
| What colours a bar | The fill is the status, and only the status. Criticality and slippage are laid over it as overlays (§4.2) |

**What this work does not include.** Points 9-11 of the analysis — the behaviour
of the resize handles, dragging a dependency with the mouse, and the rule by
which a dependency counts as violated — stay open. That is designing mechanics,
not repainting; the mockup only draws them and does not define them (§5 of the
analysis). The handles and the drag points are repainted as they are and make no
new promises.

---

## 2. The technical finding that determines the shape of the change

**The Gantt part of `broadsheet-theme.css` currently has no effect at all.**

In the built bundle `gantt.css` comes after the theme file at equal specificity,
so the later one wins. Verified against specific rules in `dist/assets/*.css`:

| Rule | Theme | `gantt.css` | Who wins |
|---|---|---|---|
| `.gantt__bar { height }` | 36px (pos. 28740) | 22px (pos. 43611) | `gantt.css` |
| `.gantt { --gantt-label }` | 320px (pos. 27116) | 220px (pos. 37066) | `gantt.css` |
| `.gantt { --gantt-row }` | 72px | 42px | `gantt.css` (and over it, the inline value from `Gantt.tsx`) |
| `.gantt__grid-day` | dashed `#dfe5ee` | solid `--border` | `gantt.css` |

About sixty lines of the theme affect nothing. The cause is the module order:
`App.tsx` imports the theme at the root of the graph (lines 7 and 10), while
`gantt.css` is pulled in deeper, from `Gantt.tsx:20`, and is therefore emitted later.

The responsive column widths in the theme's media queries (lines 430 and 467) are
dead for the same reason, and that is worth spelling out separately: a media
query adds no specificity, so the base rule `.gantt { --gantt-label: 220px }` from
the later file beats `.gantt { --gantt-label: 180px }` from a media query in the
earlier one. `gantt.css` has no `@media` of its own at all — meaning **today the
timeline is not responsive in the slightest**, even though by the theme's code it
looks responsive.

Hence the rule for the whole change: **the timeline's styling goes into
`gantt.css`, and only the tokens and the chrome of the other screens go into the
theme file**. It has to be phrased exactly that way and not as "`gantt.css` is the
last word in the cascade": the emission order here is not a law but a consequence
of the current import graph. Lazy-loading the project route will send `gantt.css`
into a separate chunk and the order will change silently — no test would catch
that. Once the theme is cleaned up the order will stop deciding anything at all,
and that is the goal: **one selector does not live in two files**. The rule does
not touch tokens — custom properties are resolved when the value is computed, not
where they are declared, and `var(--border)` in `gantt.css` works regardless of
who is emitted first.

The theme is renamed to `northstar-theme.css` (its only import is `App.tsx:10`;
the comment there naming the theme Broadsheet must be rewritten too). The rename
goes as **a separate commit with no content edits**: otherwise the 488-line
repaint diff will be unusable.

---

## 3. Tokens

The palette and the measurements are taken from the mockup's `:root` wholesale.

| Role | Value |
|---|---|
| Application background | `#f5f7fb` |
| Surface | `#ffffff` |
| Ink | `#172033` |
| Muted text | `#667085` |
| Quieter still (small caps, captions) | `#98a2b3` |
| Lines | `#e5e9f0`, strong `#d8dee9` |
| Accent | `#5367e8`, dark `#3f51cf`, soft `#eef0ff` |
| Done | `#29a36a` on `#e9f8f0` |
| Warning (draft, slip) | `#e69a2d` on `#fff6e7` |
| Danger (blocked, missed deadline) | `#d94c71` on `#fff0f4` |
| Danger dark (metric figures, criticality) | `#bd4263` |
| Weekends | `rgba(36, 48, 68, .035)` |
| Shadow | `0 12px 36px rgba(16, 24, 40, .13)` |

Corner radii 5 / 7 / 8 / 10, and 20 on pills. Control height 36px. The font is
Inter 14px/1.45; it is already in the build (`@fontsource-variable/inter`), only
the size needs changing: the theme currently sets 15px.

The theme stays light-only, as it is now.

---

## 4. The timeline

### 4.1. Measurements

From the mockup; four of the numbers live in `gantt/scale.ts` rather than in the
styles and are changed there: the row height and the three day widths.

| Value | Was | Becomes | Where |
|---|---|---|---|
| Row height | 42px | 48px | `ROW_HEIGHT` |
| Day width, "Day" | 42px | 52px | `DAY_WIDTH.day` |
| Day width, "Week" | 27px | 30px | `DAY_WIDTH.week` |
| Day width, "Month" | 14px | 18px | `DAY_WIDTH.month` |
| Timeline header | 80px | 68px = month 27 + days 41 | `gantt.css` |
| Task column | 220px | 300px | `--gantt-label` |
| Task indent inside a category | — | 28px | `gantt.css` |
| Bar | 22px | 28px, radius 7 | `gantt.css` |

The day widths for week and month are **not proportional** to the day one. A
proportion would give 33.43 and 17.33: a fractional day width pulls apart the
grid, which is drawn by a gradient repeating at that value, and the bars, which
are computed through `scale.xOf` — the divergence accumulates towards the right
edge of the timeline. That is exactly the defect the analysis criticises the
mockup for (§3.1). The whole numbers are taken from the mockup itself: its scale
buttons switch `--day` between 52, 30 and 18.

The timeline header is not one variable. The month strip is hard-coded as a
literal in two places (`gantt.css:160` `height: 26px` and `gantt.css:165`
`calc(var(--gantt-head) - 26px)`); on the move to 68 = 27 + 41 both literals
change to 27, otherwise the days get 42 instead of 41.

Changing `ROW_HEIGHT` and `DAY_WIDTH` is safe for the tests: they refer to the
constants by name, not to pixel literals (`Gantt.test.tsx:70,78,110`).

### 4.2. What colours a bar

The analysis (§2) counted five states, four representations and three different
sets in the mockup, and demanded they be reduced to one source. In the code there
are in fact more states than in the mockup: besides the status, the bar is
coloured by `data-criticality` (`gantt.css:622`), which has its own chip in the
legend (`Gantt.tsx:334`), and by the `is-late` flag. Today all three write into
the same background and the last one in file order wins — that is, the bar's
colour is determined by the stylesheet rather than by meaning.

The rule that closes this: **the fill means the status and only the status;
criticality and slippage are laid over it as overlays.** It also removes the
contradiction with §5, where a slip is declared a flag on top of the status
rather than a sixth status.

The fill is four mutually exclusive `status` values:

| Status | Fill |
|---|---|
| `in_progress` | `#6274e7`, progress fill `#4358d6` (the existing `.gantt__progress`) |
| `planned` | `#e9eef5`, dashed border `#8ea0be`, text `#40506b` |
| `done` | `#29a36a` with a tick (the existing `.gantt__check`) |
| `blocked` | diagonal hatching `#d94c71` / `#c83e62` |

The overlays go over any fill, and over both at once too:

| Flag | Overlay |
|---|---|
| slip (`is-late`) | a 1.5px outline `#e69a2d` — the "warning" token, as written down in §3 |
| `criticality === "critical"` | a 3px left edge `#bd4263` |

The colour `#df9130` is gone from here: it was not in the token table, and the
"slip" role is already taken by a token. The overlays are composed with a single
`box-shadow` (`inset 0 0 0 1.5px …, inset 3px 0 0 …`) — the rule for the
combination is written explicitly rather than left to the cascade. The other
three criticality levels (`low`, `normal`, `high`) still do not colour the bar.

One consequence is worth accepting deliberately: the current rule that "a
finished blocker holds nobody up" (`gantt.css:628`) disappears along with the
fight between fills. A finished critical task will get a green fill and a red
edge — that is, it will say both "done" and "this was a bottleneck". The old rule
said only the first, because otherwise the colours fought over the background;
now there is no fight.

The legend (`Gantt.tsx:323-347`) is the only place where the states are listed
out, and after this change it lists not one thing but two: four fills and two
overlays. The overlay chips show exactly the outline and the edge over a neutral
fill rather than a solid colour, otherwise the legend promises a fifth and a
sixth status again.

### 4.3. Responsiveness

The media queries move from the theme into `gantt.css`, along with the rest of
the timeline's styling (§2). The breakpoints are the same as the rest of the application's:

| Screen width | `--gantt-label` | Task indent |
|---|---|---|
| base | 300px | 28px |
| ≤ 900px | 240px | 28px |
| ≤ 520px | 180px | 18px |

Without this the change makes worse what it is fixing: the column grows from 220
to 300px, and on a 520px screen the name gets 300px against 220px of canvas.

### 4.4. The rest

The deadline notch and the deviation badge, which already exist in the code
(`.gantt__mark`, `.gantt__deviation`), map one to one onto the mockup's
`.deadline` and `.slip-label`: a red vertical with a diamond on top and a pink
`#fff0f4` pill with an `#f4b7c8` border. They need no new markup.

The day grid becomes solid `--line` lines instead of the current dashes; the task
column header is `#f9fafc` with 10px small caps; today's date is white in a 22px
blue circle; the "today" line is 2px `rgba(83,103,232,.68)` with a dot on top;
the selected row is `#eef0ff` with an `inset 3px 0` accent stripe, and hover is
`#f5f7ff`. Dependency arrows are `#7d879c` 1.5px, a violated one a 2px red dash
with a "!" circle.

---

## 5. The metrics bar

Seven cells in the project header. In the model the status is a single field with
four values (`planned`, `in_progress`, `done`, `blocked`), so two of the metrics
are derived from other fields:

| Cell | Computation |
|---|---|
| Total tasks | the number of tasks |
| In progress | `status === "in_progress"` |
| Blocked | `status === "blocked"` |
| Overdue | `end_date > deadline` — the same computation the timeline already uses to place the "!" (`Gantt.tsx:123`) |
| Not started | `status === "planned"` |
| Not planned | `isBeyondPlan(state, task)` — the task was added after the plan was approved and has no baseline; the timeline already marks it with a plus |
| Completed | `status === "done"` |

The arithmetic comes out coherent — unlike in the mockup itself, where the
metrics do not add up (see §4.1 of the analysis): the four statuses do not
overlap and sum to Total, while Overdue and Not planned are flags on top of the
status and are not part of the sum.

From "a flag on top of the status" follows something worth saying out loud, or
the figure will be read as an error: **a completed task also counts as Overdue**
if it ended after the deadline. Completed and Overdue overlap, and that is not a
counting bug but two different questions — "is it done" and "was it on time".

The second thing to name explicitly: **Overdue is measured against the project's
deadline, not the task's.** In the model there is one deadline per project
(`state.deadline`), whereas the mockup counts a slip as a deviation from the
task's own baseline. Reusing the existing computation is right — otherwise one
screen would carry two different "overdue"s — but right next to it in the same
timeline lives the `+2 d.` badge, which measures exactly the deviation from the
baseline. The cell's caption must tell them apart: "Past the project deadline",
not simply "Overdue".

Only Blocked and Overdue are set in red (`#bd4263`, as in the mockup). "Beyond
the plan" is not typeset as an alarm: adding work is normal — what is alarming is
a hidden shift of dates, and the deviation badge already says that.

The shape from the mockup: an `#e5e9f0` border, radius 10, background `#fbfcfe`,
cells from 120px with separators, the figure at 15px, the caption at 11px in
muted; on a narrow screen the bar scrolls sideways.

It lives in `project/ProjectHead.tsx`, meaning it is shown on the public page
behind a link too — except for the "Not planned" cell: the plan version and the
discrepancies against it are deliberately not exposed there (`showPlan`), and
that rule is not broken.

New translation keys: `project.metrics.*` — seven captions plus the bar's name
for screen readers, in `ru`, `en` and `az`.

---

## 6. The bar tooltip

A dark `#202838` card, 235px wide, radius 8, shadow `0 12px 36px`, text at 11px:
the name in 12px semibold, and under it a `72px 1fr` grid — muted `#929db0` on
the left, light semibold `#d5dae5` on the right. Four values:

1. the status (with a "⚠" on a blocked one),
2. the dates "12 Aug → 14 Aug",
3. the assignees,
4. the completion percentage.

The assignees line is not "the assignee's name": in the model this is
`assignee_ids: string[]` (`api/projects.ts:63`), not a single field as the mockup
draws it. The rule: one person is named, several are "the first + N more", none
means no line at all. A 235px-wide card will not survive an enumeration, and "+2"
answers the question "is this one person's work" no worse than three names.

It follows the cursor with a 14px offset and flips at the screen edges. It also
appears on keyboard focus — and then stands next to the bar itself rather than
next to the cursor. It is switched off along with every other transition under
`prefers-reduced-motion`.

**There is no tooltip while dragging.** A bar is dragged with the mouse
(`useDragDates`), and a card following the cursor would cover exactly the day
grid the person is aiming at; on top of that the shift-reason window
(`ShiftReason`) appears. It is dismissed on `pointerdown` and does not come back
until the button is released and the pointer enters the bar again.

Four decisions about how it is built:

**The native `title` is removed from the bar.** Otherwise a second, browser one
would pop up over the tooltip a second later. `aria-label` is left untouched — so
both screen reading and the tests (bars are found by `aria-label`, not by `title`)
work as they did. The tooltip itself is marked `aria-hidden`: it duplicates what
is already named.

**The member roster does not go fetch data — the names arrive as a prop.** The
query was removed in PR #48 along with the filter, and bringing it back inside
`Gantt` is a temptation not to give in to: the timeline would again become a
place that decides for itself who to ask for what. The screen asks, and `Gantt`
receives ready names. The reason is not purity: **`Gantt` has no "this is the
public page" flag and there is no point in introducing one.** The only thing it
has is `canWrite` (`Gantt.tsx:41-48`), and a gate on that would be wrong twice:
for a reader role inside the organization, which is authenticated and does see
the roster, and offline, where `Project.tsx:86` computes
`editable = canWrite && !offline`. `Project.tsx` requests the roster (read-only,
`staleTime: Infinity`) and passes it down; `PublicProject.tsx` passes nothing and
goes nowhere — the server does not serve the roster to a guest anyway. If there
are no names, the assignees line is not drawn and the tooltip stays.

**The reason for a block is not reproduced.** In the mockup a blocked task has
the text "Waiting for design system" in the fourth cell, but there is no "block
reason" field in the model, and inventing text on the timeline is not allowed. A
blocked task will have the percentage there, like the rest.

The implementation goes through context (`BarTipProvider` in `Gantt`, the
consumer in `Row`), the way toasts, `ShiftReason` and `DependencyNudge` are
already built: otherwise five new props would have to be threaded through the
row. The member names are the only thing that enters `Gantt` as a prop: they are
data rather than hover state, and there is one set of them for the whole
timeline. There is one tooltip node for the whole timeline rather than one per
bar — with a hundred tasks that would be a hundred hidden nodes for nothing.

From the translations only one key is needed — "N more" for the second and
subsequent assignees, with a count form; the status comes from `task.status.*`,
the dates from `formatDate`, and the percentage is a number.

---

## 7. The other screens

Buttons, fields, menus, modal windows, the toast, the project lists, the member
roster, the settings and sign-in move onto the same tokens, shapes and sizes, so
that nothing looks foreign next to the timeline. The toast is fitted to the
mockup's snackbar: `#202838`, height 48, radius 9, action `#b8c2ff`. The task
card: 404px wide, field captions 11px/700 in muted, fields 36px with radius 7,
and the progress block in an `#e5e9f0` border on `#fafbfc`.

---

## 8. Where the plan deliberately diverges from the mockup

**Category rows stay 48 tall, like tasks, not 44.** That very mismatch is what
pushes the mockup's arrows off by 20 and 64 pixels (§3.2 of the analysis). In the
code the row height is a single `ROW_HEIGHT` constant, and the arrows are
computed from it; a second height must not be introduced here.

**A category's summary bar keeps the category's colour.** The mockup paints every
category in one grey, but the category colour is an existing feature with a
palette in the creation form. What is taken from the mockup is the shape: 7px
with arrow notches at the ends.

**The word "Today" in the day header stays in the markup, hidden from the
narrator.** Visually its role is played by the circle around the number, as in
the mockup, but throwing away the accessible name for that is not worth it.

---

## 9. The order of the work, and verification

0. Renaming the theme to `northstar-theme.css` — as a separate commit, without a
   single content edit (§2).
1. The tokens and the theme file; the dead Gantt block is cleared out of it at the
   same time — `--gantt-label`, `--gantt-row`, `--gantt-head`,
   `--gantt-today-chip`, the bar rules and both media queries.
2. The timeline: `gantt.css` (media queries included, §4.3) + four numbers in `scale.ts`.
3. The metrics bar: `ProjectHead.tsx` + translations.
4. The tooltip: `gantt/BarTip.tsx`, wiring it into `Gantt.tsx` and `Row.tsx`; the
   member roster as a prop from `Project.tsx`.
5. The other screens and the task card.

**Steps 1 and 2 ride in one commit.** Between them the timeline would be left on
the old measurements with the new tokens — a state `main` must not be shown in.

Verification: the existing tests (262) must stay green — there are no pixel
literals in them, the measurements are taken from `DAY_WIDTH` by name, so
changing them does not touch the tests. The new blocks get tests of their own:
for the count of the seven metrics, including the overlap of Completed and
Overdue, for "the first + N more" in the tooltip, and for the public page not
going after the member roster. After that `npm run build` and `oxlint`, and a
visual check — the project screen on the test fixtures in Chromium, at the three
widths from §4.3.
