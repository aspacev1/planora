# Planora — deep UI audit

An interface audit carried out on the live application rather than by reading
code: the frontend was brought up in a browser on top of an API stub with a
plausible project (12 tasks, 4 categories, dependencies, an approved plan v3, a
slip, blockers, guests in the discussion feed). Twenty addresses were checked at
three widths — 1440, 390 and the transitional 900/760 — along with hover, focus,
open dialogs and menus, three languages and both system colour schemes.

What was measured by a program rather than by eye: the contrast of every text
pair against its actual backdrop, hit-target sizes, horizontal page overflow,
the accessible names of controls, keyboard traversal order, focus retention in a
modal window, and the behaviour of invisible buttons under a finger.

The findings are sorted by what a failure costs a person, not by the number of
lines that need editing. Each one names its place in the code and how to reproduce it.

**Totals:** 2 critical, 5 high, 8 medium, 7 low. None of them is a matter of
taste — every one reproduces and measures.

---

## First, about what is done well

This is not politeness before a list of complaints: what follows is worth not
breaking while fixing the rest.

- **The dictionaries are complete.** 545 keys in `ru`, 539 in `en` and `az`; the
  difference is exactly the Russian plural forms (`few`/`many`), which the other
  two languages do not need. Not one key forgotten in translation, not one string
  copied over from Russian as is. Month names come from the dictionaries rather
  than from `Intl` — and that is right: ICU does not know the Azerbaijani months.
- **A task bar is a real button**, with an `aria-label` that includes the name
  and the dates, and it moves with the arrow keys. On the public page it honestly
  becomes a `role="img"` instead of pretending to be pressable.
- **A bar's colour means exactly one thing** — status; criticality and slippage
  are laid over it as overlays. The rule holds, and the combinations are spelled
  out explicitly.
- **`prefers-reduced-motion` is respected twice** — by a media query and by a
  class — and it turns transitions off entirely rather than "making them shorter".
- **Server errors are shown by code through the dictionary**, not as Pydantic's
  English prose.

---

## 🔴 Critical

### 1. On a phone you cannot sign out, open settings, change the language or the organization

> **Status: fixed.** `frontend/src/northstar-theme.css` no longer hides
> `.sidebar__foot`/`.org-switch` at narrow widths.

`frontend/src/northstar-theme.css:677`

```css
@media (max-width: 760px) {
  .sidebar__brand, .sidebar .org-switch, .sidebar__foot { display: none; }
}
```

`.sidebar__foot` is not a decorative footer. It holds the language switch, the
"Settings" link and the "Sign out" button. Together with `.org-switch`, at a
width of 760 and below the following disappear from the interface:

| What | 1440px | ≤760px |
|---|---|---|
| Sign out | present | `display: none` |
| Settings (organization, members, profile) | present | `display: none` |
| Language switch | present | `display: none` |
| Organization switch | present | `display: none` |

No replacement appears: no hamburger, no "more" menu, and none of these items in
the top bar. Checked programmatically at four widths — at 760 and 390 the
computed `display` is `none` and the size is `0×0`.

The consequences, each of which a person meets on their very first day: from a
phone you cannot end your session (on someone else's device that is a security
question, not a convenience one); you cannot invite a person into the
organization; you cannot change the language — meaning an Azerbaijani client who
opened the application in Russian stays in Russian; you cannot switch to another
organization. The `/settings` address does work — the screen responds and looks
normal — but there is no path to it from the interface.

**What to do.** Fold these four items into a single menu in the top bar (behind
the organization avatar or a "⋯") rather than hiding them. At 390px the top bar
holds three navigation items and has room to spare on the right — the space is there.

### 2. A tap on an empty part of a row revokes an invitation

> **Status: fixed.** `@media (hover: none)` rules now exist for the
> affected touch targets (e.g. `frontend/src/components/rows.css`,
> `frontend/src/gantt/gantt.css`).

`frontend/src/styles.css:1284`

```css
.invite__actions button { opacity: 0; }
.invite:hover .invite__actions button,
.invite:focus-within .invite__actions button { opacity: 1; }
```

`opacity: 0` takes the button out of sight but not out from under the finger:
`pointer-events` stays `auto` and the size is preserved. A touch screen has no
hover state, and the three buttons — "New link", "Send again", **"Revoke"** —
stay invisible always and pressable always.

Reproduced programmatically at 390×844 with touch input: the "Revoke" button has
`opacity = 0` and a rectangle of `84×36`; a single tap at its centre sends the
revoke request. The person saw an empty part of the row — and the invitation died.

The same trick is in the timeline, `frontend/src/gantt/gantt.css`:

- `:605` `.gantt__handle` — the row reorder handle;
- `:663` `.gantt__add` — "+", add a task to a category;
- `:690` `.gantt__remove` — "×", **delete a category**.

Two of the five hidden controls are irreversible. There is not a single
`@media (hover: none)` in the whole project — a search across every style file
found neither `hover: none` nor `pointer: coarse`.

It is worth noting the contradiction inside the code itself: `.gantt__handle`
carries `touch-action: none` with a comment saying the row is dragged with a
finger — that is, touch input is acknowledged as a working scenario in exactly
the place where the control is invisible.

**What to do.** With one rule for the whole application:

```css
@media (hover: none) {
  .invite__actions button, .gantt__handle, .gantt__add, .gantt__remove {
    opacity: 1;
  }
}
```

That is enough to close both the lost actions and the accidental presses.
Separately, it is worth thinking about whether "Revoke" deserves a confirmation
even with a mouse: every other destructive action in the application has one.

---

## 🟠 High

### 3. The public link shows the client the baseline plan and every deviation from it

`frontend/src/screens/PublicProject.tsx:102`

The product rule is stated in this same file and in `ProjectHead`: "a client
following a link is promised dates and scope, not the approval version and the
internal discrepancies against it". The header keeps it — `showPlan` is not
passed, and a guest sees neither the plan version, nor the "changed after
approval" marks, nor the "Beyond the plan" cell in the metrics bar.

The timeline breaks the rule. `<Gantt canWrite={false} />` gets no publicity
flag, and `showBaseline` is on by default, so the guest sees:

- the ghost of the baseline plan under every bar — a dashed rectangle with the
  planned dates;
- the red notch of the task's original deadline;
- the deviation badges "+1 d.", "+2 d.", "+4 d." — that is, **the exact amount by
  which the team is behind what it approved for itself**;
- the "+" sign next to a task name — "added beyond the original plan".

All of the above is visible in the screenshot of the public page. A client
following the link learns not only "when will it be ready", but also "how far
behind your own plan you already are and what you improvised along the way" —
even though the plan version was hidden from them on purpose. Half a curtain is
worse than none: the team thinks the plan is internal, and it is not.

**What to do.** Pass `Gantt` a publicity flag and, together with `showPlan`,
extinguish the ghost, the notch, the deviation badge and the "+" sign. The
"Baseline" item in the "View" menu is then not needed on the public page either.

### 4. The reports table breaks the page horizontally on a phone

`frontend/src/screens/Reports.tsx:69`

At 390px the table takes 673px, and the whole page scrolls:
`documentElement.scrollWidth = 673` against `clientWidth = 390`. The top
navigation bar, the rule under the heading and the background stay the width of
the screen — so on a shift to the right the content travels past their edge and
hangs over white. This is the only screen in the application with horizontal
overflow: the other nineteen were checked and are clean.

Tellingly, a working example sits right next to it: the project metrics bar
(`.project-head__metrics`), with 808px of content in a 352px window, scrolls by
itself because it has `overflow-x: auto`. The reports table did not get such a
wrapper.

**What to do.** Wrap the table in a `<div class="table-scroll">` with
`overflow-x: auto` — the same trick already applied to the metrics bar.

### 5. "Inherit from organization (31)" — a bit mask in a person's face

`frontend/src/screens/ProjectSettings.tsx:198`

```tsx
inherited={String(orgSettings?.working_days ?? "")}
```

The string is substituted into the dictionary phrase
`"Inherit from organization ({value})"`, and in the project settings a person
reads **"Inherit from organization (31)"**. Thirty-one is `0b0011111`,
Monday-Friday. The number means nothing to anyone but the model's author.

The two neighbouring overrides on the same screen show human values —
`(Asia/Baku)` and `(2)` — and against them "31" reads not as a code but as a data
error. Meanwhile the organization screen already knows how to draw the same mask
properly: `WorkingDaysField` unfolds it into seven checkboxes, Mon … Sun.

**What to do.** Unfold the mask into a list of short day names — "Mon, Tue, Wed,
Thu, Fri" — using the same numbering (`(day + 1) % 7`) as `WorkingDaysField`.

### 6. The modal window does not hold focus

> **Status: still open.** `Modal.tsx` still only sets initial focus and
> restores it on close — no Tab-cycling focus trap yet.

`frontend/src/components/Modal.tsx`

The window is declared as `role="dialog" aria-modal="true"`, closes on Esc, puts
focus on the first field and returns it to whoever opened it — four rules out of
five. The fifth is missing: focus leaves the window. Checked by pressing Tab with
the "New task" form open — on the twentieth press focus went to `BODY`, and past
that the page under the window begins, which is neither `inert` nor `aria-hidden`.

For a keyboard user this means: having gone round the form, they land in the
chart behind the window and keep walking its buttons without seeing where the
focus is — the window blocks the view. They will get back into the window only
after going through the whole page.

**What to do.** Close Tab and Shift+Tab at the window's edges (intercept
`keydown` on the first and last focusable element), or move the window to a
native `<dialog showModal>`, which does that itself along with `inert` for the
background.

### 7. Contrast below AA in six system roles

Measured programmatically: the text colour against the actually computed
backdrop, accounting for transparency, for every text node on each of the 20 screens.

| Role | Colours | Contrast | Required | Where it shows |
|---|---|---|---|---|
| `--warn` on white | `#e69a2d` / `#fff` | **2.33** | 4.5 | the blocked count in "Reports" (`.report__warn`) |
| `--danger` on white | `#d94c71` / `#fff` | **4.02** | 4.5 | overdue dates in "My tasks", the "!" sign in the timeline |
| `--accent` on `--accent-soft` | `#5367e8` / `#eef0ff` | **4.15** | 4.5 | the current section in the column, the icons in the history feed, the selected weekdays |
| `--danger` on `--danger-soft` | `#d94c71` / `#fff0f4` | **3.64** | 4.5 | the error text in an invitation |
| `--accent` on `--bg` | `#5367e8` / `#f5f7fb` | **4.38** | 4.5 | the selected "Chart" tab, the "Sat" caption in the timeline header |
| `--text-muted` on `--tag-gray` | `#667085` / `#f1f3f6` | **4.48** | 4.5 | the "Planned" chip, the language switch |

The first two are not borderline cases but misses by a factor of two and of one
and a half. `--warn` especially: 2.33 at 14px is "you can see there is something
orange there", not "read".

A separate inconsistency: in "Reports" the blocked count is set in amber
(`.report__warn`), whereas everywhere else in the application blocked is red
(`.status-chip[data-status="blocked"]`, the timeline bar, the metrics bar cell)
and amber means a slip. So one and the same screen is at once the hardest to read
and the one speaking about the same thing in a different colour.

**What to do.** For text take the dark variants — `--danger-strong` (`#bd4263`,
5.3:1) is already in the theme for exactly this; introduce a `--warn-strong` to
match (around `#9a6410`); in "Reports" move the blocked count to red, as
everywhere else. For the "accent on soft accent" pairs, raise the accent to
`#4256d8` or darken the backdrop.

---

## 🟡 Medium

### 8. There is nowhere to read a truncated task name

`frontend/src/gantt/Row.tsx:246`, `frontend/src/gantt/gantt.css:509`

`.gantt__label-name` is truncated with an ellipsis and has no `title`. At 1440px
that is already noticeable — "Visual language: colour, typogr…", "Migrating the
content from the o…" — and at 390px the left column shrinks to 180px, leaving
"Interview with the sa…" of the name.

There are two ways to read it in full, and both are unreliable: hover over the
**bar** (not the name), which pops up a card with the full title; or open the task
card. For tasks whose bar is not visible in the current scroll (see finding 13),
the first does not work either.

**What to do.** `title={task.name}` on the name — one line, and it also fixes the
scrolled-timeline case.

### 9. Hit targets smaller than 24 pixels

Measured on the live page:

| Control | Size | Where |
|---|---|---|
| `.gantt__chevron` — collapse a category | **13×36** | every category row |
| `.gantt__add` — "+" | **20×20** | every category row |
| `.gantt__remove` — "×" | **20×20** | an empty category |
| settings checkboxes | **16×16** | organization and project settings, the "View" menu |

WCAG 2.2 (2.5.8, level AA) requires 24×24 CSS pixels. The chevron's width of 13
is half the requirement; on a touch screen people miss it, and next to it stands
the category name, where a miss does nothing.

**What to do.** Bring them up to 24×24 — not necessarily by redrawing: an
enlarged hit area is enough (`padding` or a `::before` pseudo-element with
`inset: -6px`), and the drawing stays as it is.

### 10. The "Shift threshold" field has no accessible name

`frontend/src/screens/ProjectSettings.tsx:183`

`<input id="project-threshold" type="number">` has neither a `<label for>`, nor
an `aria-label`, nor an `aria-labelledby`. A check of accessible names across
every screen found exactly one such field. There is a caption next to it, but it
belongs to another control — the "Inherit from organization" checkbox.

Tellingly, the intent was there: `Override` renders
`<span className="settings__override-label" id={`${id}-label`}>`, so the
caption's identifier was prepared — but `aria-labelledby` was never put on the
field. To a screen reader the field is called "spin button", and what is in it is
anybody's guess.

**What to do.** `aria-labelledby={`${id}-label`}` on the field inside `render`.

### 11. There is no "skip to content" link

The keyboard traversal order on any protected screen: the logo → the organization
switch → three navigation items → three language buttons → "Settings" → "Sign
out" → and only on the eleventh press, the page's first action. The column is the
same on every screen, and a keyboard user walks it again on every transition.
This is WCAG 2.4.1 (Bypass Blocks, level A).

**What to do.** A "Skip to content" link, hidden until focused, as the first
element of `<body>`, pointing at `#main`; `.app__main` gets an `id` and `tabindex="-1"`.

### 12. The metrics bar scrolls without saying so

`.project-head__metrics` at 390px holds 808px in a 352px window. Scrolling works
and the content is reachable — but there is not a single sign of it: the last
visible cell is cut off mid-letter ("**1** Bl…"), and that reads as a layout bug
rather than "there is more here". There is no edge shadow, no gradient, no arrows.

**What to do.** A fade gradient at the right edge while `scrollLeft` has not
reached the end — a cheap and unambiguous device.

### 13. Rows without a single bar look like tasks without dates

`frontend/src/gantt/Gantt.tsx:145` — on opening, the timeline scrolls to "today
minus three days". Everything that ended earlier stays off the left edge.

In the demo project two July tasks ("Interview with the sales department",
"Analytics of the current site") produce empty rows: there is a name, there is no
bar. Nothing on the screen says the bar exists and lies further left — no arrow
at the edge, no counter, no scrollbar highlight. A task without a bar and a task
scrolled off the edge look identical.

**What to do.** A marker at the timeline's edge when a row's bar lies outside the
visible window ("◀ 27 Jul"), or a "Show the whole project" button in the toolbar
next to the scale.

### 14. In a long form the main action goes below the fold

The "New task" window holds nine fields, from the name to the list of
dependencies. With a browser window of 1440×900 the "Create" button is below the
visible area: `.modal` scrolls inside itself (`max-height: 100%; overflow: auto`),
which is better than clipping, but the person sees a form that simply ends at
"Depends on". On a laptop 768 tall, part of the fields ends up below the fold too.

**What to do.** Pin `.modal__actions` to the window's bottom edge
(`position: sticky; bottom: 0` with a backdrop) — then "Create" and "Cancel" are
always visible and only the form scrolls.

### 15. Dates in fields are typeset in the browser's locale, not the interface's

Four places with `<input type="date">`: `ProjectSettings.tsx:140`,
`TaskForm.tsx:225`, `TaskPanel.tsx:320`, `AiIntake.tsx:274`. The native date
field draws the value in the browser's language, not the page's. In testing, the
Russian interface showed `09/30/2026` and `08/12/2026` — the American month/day
order, in which "08/12" reads as 8 December with exactly the same confidence as
12 August.

That is the more noticeable because the rest of the application takes dates
seriously: month names are taken from the dictionaries precisely because `Intl`
lets you down on `az`.

**What to do.** Either write the format next to the field ("DD.MM.YYYY"), or
build the date field yourself on top of the same dictionary as the rest of the
dates. The first is cheaper and closes the main confusion.

---

## ⚪ Low

16. **A dead dark theme.** `styles.css:97-137` describes a full set of dark
    tokens, but `northstar-theme.css` is linked later and overrides `:root`
    wholesale, `color-scheme: light` included. Checked in a browser with a dark
    system theme: `--bg` stays `#f5f7fb`. The decision is deliberate (it is
    stated in `App.tsx`), but forty lines that colour nothing will one day be
    taken for working ones.

17. **"Approve the plan" on an empty project.** A project with no tasks offers to
    approve the plan and shows a metrics bar of two zeros. There is nothing to
    approve: the snapshot will be empty.

18. **Three of the four criticality levels are invisible in the timeline.** Only
    `critical` colours the bar (`gantt.css:857`); `low`, `normal` and `high` are
    indistinguishable. In the task card the field offers four values — three of
    them change the data and change nothing to the eye.

19. **There is no "forgot password" at sign-in.** The `/login` screen offers only
    signing in and registering.

20. **A member's role cannot be changed and a member cannot be removed.** The
    list row shows the name, the email and the role without a single action. This
    is not a layout oversight: the server has no routes for it either
    (`org_routes.py` knows only `GET /members`). Noted as a product gap — an
    organization's owner cannot revoke access except through the database.

21. **The time zone is a free-form string.** `Asia/Baku` is typed by hand; a typo
    lands in the project calendar.

22. **`/settings` and `/settings/organization` are the same screen.** The index
    route draws the same thing as the "Organization" tab, and that tab is marked
    as current. Two addresses for one page.

---

## Appendix: how this was checked

The API stub answers according to the `src/api/*.ts` contract, the WebSocket
handshake included — otherwise the project screen would show the "no connection"
strip and lock editing, and the audit would be looking at an emergency state
instead of a working one.

The data was chosen to hit the edges: a 60-character project name, a category
whose name is longer than the column, tasks in all four statuses and all four
criticality levels, tasks outside the baseline plan, a slip against the project
deadline, an empty project, a project without a deadline, a guest in the
discussion feed, an Azerbaijani organization name in the Russian interface.

A discrepancy found along the way that is **not** a defect: the revision journal
stores operations in the form `{from, to}` (`backend/app/mutations.py:747`), and
the history feed reads exactly that. The stub's first version served
`{start_date}`, and the feed honestly complained to the console about the missing
dictionary keys — that is, it behaved correctly on incorrect data.

Screenshots (20 addresses × 3 widths plus the states of windows, menus, the task
card and hover) were taken in Chromium 1194 and are attached to the work separately.
