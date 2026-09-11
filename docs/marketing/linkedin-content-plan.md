# Planora on LinkedIn — content plan

A 12-week operating plan for building an audience around Planora on LinkedIn:
positioning, content pillars, a week-by-week calendar, ten ready-to-post drafts,
and the routine that makes the posting actually happen.

Everything here is drawn from what the product genuinely does today (see the
[README](../../README.md)). No claim in this document needs a feature that does
not exist.

---

## 1. The strategic constraint, stated up front

Planora runs in production for one organization — its author's. There are no
customer logos, no "10,000 teams" number, no case studies yet.

That rules out the usual B2B SaaS playbook (social proof, testimonials, ROI
calculators) and points at the one that actually works from a standing start:

> **Earn attention with opinions and engineering, not with proof you don't have.**

So the mix leans on **delivery philosophy** (reach, from people who feel the pain)
and **build-in-public engineering** (credibility, from people who recognise real
work), with product demos as the conversion layer. Social proof gets added to the
plan the moment there is any — see §12.

---

## 2. Positioning

**One-liner (primary):**
> Self-hosted Gantt planning for teams whose plan is a promise to someone outside
> the team — every edit reversible, every slip explained, clients in the loop
> without an account.

**Category framing:** not "another Asana / Jira / Monday." Planora sits where
MS Project and Smartsheet sit — committed, baselined, client-facing plans — but
self-hosted, MIT-licensed, and with no per-seat billing.

**The sentence to repeat until it's boring:** *a plan is a promise; software should
treat it like one.*

### Message hierarchy — the five things worth repeating

| # | Message | Why it lands | Feature proof |
|---|---|---|---|
| 1 | Nothing is ever silently lost | Everyone has been gaslit by a plan that changed | Revision journal: every edit stores its computed inverse; one-click undo of any change or batch |
| 2 | Slips get explained, not hidden | The universal client-work wound | Approved baselines + shift threshold (2 days default); deviation measured against the baseline, never the previous value |
| 3 | Your client sees the plan, not an invoice for a seat | Agencies pay per-seat for people who only *look* | Public read-only links, no account, internal notes and assignees stripped |
| 4 | Your data stays on your infrastructure | Regulated, integrator, and paranoid-by-default buyers | `docker compose up`, MIT licence, single-origin cookie, encrypted secrets at rest |
| 5 | The AI proposes; a human applies | AI fatigue is real in 2026; restraint is differentiation | Intake pipeline is interview → summary → draft → **apply only on a human click**, written as one journaled batch |

### Audience segments

| | Who | What they care about | Pillars that reach them |
|---|---|---|---|
| **A** | Agency / studio owners and delivery leads (10–60 people) | Client commitments, quoting, "why are we late" | P1, P3 |
| **B** | Integrators and in-house PMO in data-sensitive orgs | Self-hosting, audit trail, roles, exports | P3, P4 |
| **C** | Technical founders / CTOs weighing build-vs-buy | Open source, stack, operational cost | P2, P4 |
| **D** | Developers and OSS builders | Craft: hand-built SVG Gantt, FastAPI + React 19, tests on real Postgres | P2 |

Segment D does not buy. It amplifies — and on LinkedIn, amplification from
engineers is what carries a post into segments A–C. Budget for it accordingly.

---

## 3. Content pillars and mix

| Pillar | Share | Job | Typical post |
|---|---|---|---|
| **P1 — Delivery opinions** | 30% | Reach. Name a pain, take a side. | "Five one-day delays is not a one-day problem" |
| **P2 — Build in public** | 25% | Credibility. Show the decision, not the feature. | "We shipped a Gantt chart without a Gantt library" |
| **P3 — Show the product** | 25% | Conversion. One screen, one job. | 30-second undo of a whole dependency cascade |
| **P4 — Ownership & security** | 12% | Differentiation. | "No per-seat billing" / the security table |
| **P5 — Proof & momentum** | 8% | Trust. Releases, numbers, roadmap, asks. | "12 weeks in public: what changed" |

**Ratio rule:** in any 10 posts, at most 3 may show the product and at most 1 may
ask for anything. The other 6 have to be worth reading even if the reader never
touches Planora.

---

## 4. Cadence, timing, effort

- **3 posts per week** — Tuesday, Wednesday, Thursday. Not 5; a plan you abandon
  in week 3 is worse than one you sustain for a year.
- **One long-form per week** (Wednesday, the pillar post, 200–300 words), two
  shorter ones (120–180 words).
- **Timing:** pick by buyer, not by habit. Selling locally (AZ/CIS) → 08:30–09:30
  Baku. Selling to EU agencies → 09:00 CET. Selling to US → 08:00 ET. Pick one
  and hold it for 4 weeks before judging.
- **Effort budget:** ~3.5 h/week. Batch-write Sunday (2 h), capture assets as a
  by-product of development (0.5 h), engage live (20 min/post).

**Batching discipline:** write posts in pillar pairs, never one at a time — the
second one is always faster and better, because the thinking is already loaded.

---

## 5. Format playbook

| Format | Use it for | Notes |
|---|---|---|
| **Text + one screenshot** | The workhorse; ~60% of posts | Crop to one screen region. Never a full desktop screenshot. |
| **Screen recording, 20–45 s** | Anything with a gesture: drag, resize, undo, cascade | Silent, captioned, looping. The undo of a cascade is the single best thing Planora has to show. |
| **Carousel PDF, 5–8 slides** | Concept explainers (how inverses work, the baseline math) | One idea per slide. Slide 1 is the hook verbatim. |
| **Code-comment screenshot** | P2 posts | This repo's comments explain *why*; several are publishable as-is. |
| **Comparison table image** | P4 posts | Per-seat vs self-hosted; roles matrix. |
| **Poll** | Once a month, maximum | Only when the answer changes what gets built next. |

**Asset hygiene:** every screenshot uses **demo data**. Never a real client's
project name, person, or rate — not once, not cropped, not blurred.

---

## 6. The 12-week calendar

36 posts. Hooks are written to be used verbatim.

### Week 1 — The thesis

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 1 | P1 | Text + image | "A task slipped one day. Nobody had to explain it. Then it happened four more times." | Baseline-vs-actual crop |
| 2 | P3 | Text + image | "Six things happen to a plan: scope it, price it, commit to it, run it, prove it, report it. Planora keeps all six in one place." | `gantt.png` |
| 3 | P2 | Text + image | "We shipped a Gantt chart without a Gantt library. On purpose." | Gantt SVG close-up |

### Week 2 — Undo, and why it's the whole product

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 4 | P1 | Text | "Every planning tool has a history tab. Almost none of them let you undo what's in it." | — |
| 5 | P2 | Carousel | "Every edit in Planora is stored twice: the change, and how to take it back." | 6 slides |
| 6 | P3 | Video | "Watch me move an entire phase, cascade twelve successors, and put it all back with one click." | Screen recording |

### Week 3 — The client relationship

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 7 | P1 | Text | "Your client should not need an account, a licence, or a 20-minute onboarding call to see when their thing will be done." | — |
| 8 | P3 | Text + image | "One link. No login. Live plan. Rotate the token and the old link dies instantly." | `public-share.png` |
| 9 | P4 | Text | "Internal notes stay internal — stripped from API responses, exports, *and* the change journal." | — |

### Week 4 — AI, with the restraint switched on

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 10 | P1 | Text | "Planora's AI cannot write to your plan. That's a feature, and it took work." | — |
| 11 | P3 | Video | "It interviews you about the project, writes a summary you can edit, drafts the tasks — then waits." | Intake recording |
| 12 | P2 | Code screenshot | "The seven questions our AI must ask live in a 20-line YAML file, not a database. Here's why." | `config/intake_topics.yml` |

### Week 5 — Quoting

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 13 | P1 | Text | "The estimate you sent and the plan you're running should be the same document. In most agencies they diverge by week two." | — |
| 14 | P3 | Video | "Build the quote from the plan. Client agrees. Push the agreed lines back as real tasks — one batch, one undo." | Proposal recording |
| 15 | P2 | Text | "We don't store money in floats. Here's the bug that convinces everyone." | — |

### Week 6 — The scorecard

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 16 | P1 | Text + image | "There are two kinds of late. 'I told you last Tuesday' and 'I said nothing.' Most dashboards can't tell them apart." | Risk-flag crop |
| 17 | P3 | Text + image | "One screen, one question: who is on pace this week." | `scorecard.png` |
| 18 | P2 | Text | "Last week's numbers are frozen. You cannot make a bad week look better by changing this week's targets." | — |

### Week 7 — Ownership

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 19 | P4 | Text + image | "Adding a client to your project tracker should not cost $11 a month forever." | Per-seat math image |
| 20 | P4 | Carousel | "argon2id. Fernet-encrypted credentials. SSRF-guarded outbound calls. Non-root containers. Here's the whole security surface on one page." | Security table |
| 21 | P2 | Text | "Planora refuses to start if it's misconfigured. It will not serve you a half-working integration." | — |

### Week 8 — Planning craft

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 22 | P1 | Text + image | "You can plan a project before you know when it starts. 'Week 1, Day 3' is a real answer." | Relative-mode crop |
| 23 | P3 | Text + image | "Weekends, holidays, and one team's four-day week — set per organisation, overridable per project. End dates are computed server-side, always." | Calendar settings |
| 24 | P2 | Text | "The critical path is computed from total float in working days, on the server. The browser never gets a vote on your dates." | — |

### Week 9 — Teams and permissions

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 25 | P2 | Code screenshot | "Our permission model is one file: role → set of actions. A new feature can't ship until every role has an explicit answer." | `access.py` |
| 26 | P3 | Table image | "Owner, Editor, Viewer, Client, guest-with-a-link. Five roles, twelve capabilities, no ambiguity." | Roles matrix |
| 27 | P1 | Text | "An invitation should be able to say 'this project only.' Most tools make you choose between trust and paperwork." | — |

### Week 10 — Migration and exits

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 28 | P3 | Video | "Import a Jira project: issues become tasks, epics become categories. Hate it? One undo." | Jira import recording |
| 29 | P1 | Text | "A migration you can't reverse isn't a migration, it's a bet." | — |
| 30 | P4 | Text + image | "Excel and PDF are generated from the same permission-trimmed snapshot, so the two files can never disagree." | Export PDF page |

### Week 11 — Engineering culture

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 31 | P2 | Text | "Our tests run against a real PostgreSQL, not SQLite, not mocks. Constraints, JSONB queries, and migrations get exercised for real." | — |
| 32 | P2 | Text + image | "A test fails our CI if a developer writes `padding: 7px`." | Spacing-scale test |
| 33 | P5 | Text + image | "~71,000 lines. 315 source files. 126 test modules. 27 hand-written migrations. Zero charting libraries." | Numbers card |

### Week 12 — Consolidate

| # | Pillar | Format | Hook | Asset |
|---|---|---|---|---|
| 34 | P5 | Carousel | "12 weeks of building Planora in public. The three posts that worked, the one that flopped, and what I'm changing." | Recap slides |
| 35 | P1 | Text | "A plan is a promise. Software should treat it like one." — the manifesto | — |
| 36 | P5 | Text | "What I'm building next, and the one thing I need from you." | Roadmap card |

---

## 7. Ten ready-to-post drafts

Copy-paste ready. House style: hook on its own line, short paragraphs, one idea,
no emoji spray, link in the first comment.

---

### Draft 1 · Week 1, post 1 · P1

> A task slipped by one day. Nobody needed to explain it.
>
> Then it happened four more times.
>
> Now the project is a week late and there's no record of why.
>
> This is the default behaviour of almost every planning tool, and it comes from
> one small decision: they compare a date to its *previous* value. One day at a
> time, every slip looks reasonable. The story of the delay disappears into the
> diff.
>
> Planora compares against the approved baseline instead.
>
> When you approve a plan, it freezes as a numbered version — every task's start
> and duration, captured. After that, any move beyond the project's shift
> threshold (2 days by default) requires a stated reason. And the threshold is
> measured from the baseline, not from yesterday.
>
> So five one-day nudges can't quietly become an unexplained week. The fifth one
> stops and asks.
>
> One design decision, and "why is this late?" has an answer that someone wrote
> down while it was still fresh.
>
> Planora is MIT-licensed and self-hosted. Link below.

---

### Draft 2 · Week 1, post 3 · P2

> We shipped a Gantt chart without a Gantt library. On purpose.
>
> There are good commercial Gantt components. We evaluated them and built our own
> in SVG and React anyway, because of what the timeline has to do:
>
> Drag a bar to move it. Drag its edge to resize. Drag the fill to set progress.
> Drag from a handle to draw a dependency. Drag a category to move an entire
> phase. And every one of those gestures has a keyboard equivalent, because a
> plan you can only edit with a mouse is a plan half your team can't edit.
>
> Then the hard part: none of those gestures are allowed to decide a date.
> The browser sends an intent, the server recomputes the end date from start +
> duration + the project's working calendar, and answers. The chart draws what
> came back.
>
> No third-party component was going to let us put the schedule maths on the
> server where it belongs.
>
> `frontend/package.json` has no charting dependency. The Gantt is SVG, CSS, and
> about a dozen React files.
>
> Sometimes "don't build it yourself" is the wrong advice.

---

### Draft 3 · Week 2, post 4 · P1

> Every planning tool has a history tab. Almost none of them let you undo what's
> in it.
>
> Which makes it an audit log, not a safety net. You can see that someone
> flattened your Q3 phase last Thursday. You cannot get it back.
>
> In Planora, every plan edit goes through one engine that records the operation
> **and its computed inverse**. Move, resize, rename, reassign, a dependency, a
> whole Jira import, an AI-drafted set of 40 tasks — same path, same journal, same
> guarantee.
>
> The History tab reads straight from that journal, attributed and timestamped.
> Any revision or batch is one click from undone.
>
> The consequence that surprised me: people plan more bravely. When restructuring
> a phase is reversible, you restructure the phase instead of arguing about it in
> a meeting.
>
> Undo isn't a convenience feature. It's a permission slip.

---

### Draft 4 · Week 3, post 7 · P1

> Your client should not need an account, a licence, or a 20-minute onboarding
> call to find out when their thing will be done.
>
> The status quo in agency work is a weekly PDF, emailed, already stale on
> arrival. Or worse: a seat in your project tool for someone who will only ever
> look — and who will also see your internal notes, your assignee names, and the
> task called "chase invoice again."
>
> Planora has a third option. Every project can publish a read-only link:
>
> — No account. The client opens it and sees the live chart.
> — Internal notes and assignees are stripped out — from the page, the exports,
>   and the change journal.
> — They can comment, signed as a guest, rate-limited.
> — They can download the same Excel and PDF you can.
> — Rotate the token and the old link dies instantly.
> — Sharing can be switched off per organisation, or for the whole installation.
>
> Transparency and discretion are not opposites. They're a permissions problem,
> and permissions problems have solutions.

---

### Draft 5 · Week 4, post 10 · P1

> Planora's AI cannot write to your plan.
>
> Not "shouldn't." Cannot. And keeping it that way was more work than letting it.
>
> The intake flow is a fixed pipeline with four stops: **interview → summary →
> draft → apply.**
>
> The model interviews you about the project, covering seven required topics —
> goal, scope, deadline, people, constraints, what's already done, what's
> explicitly out of scope. It writes a summary. You edit it. It drafts categories
> and tasks. You edit those too.
>
> Then it stops and waits for a human to click apply. Only then does anything
> reach the project — as a single journaled batch that you can undo like any other
> edit.
>
> Same rule for "split this task into subtasks": propose, then apply.
>
> Bring your own key, point it at any OpenAI-compatible endpoint — a hosted
> provider or llama.cpp on your own box. Usage is metered per organisation with a
> request cap and a daily token budget. If the model fails, the conversation
> survives.
>
> An agent that can silently restructure a plan you've promised to a client isn't
> a productivity feature. It's a liability with good marketing.

---

### Draft 6 · Week 5, post 13 · P1

> The estimate you sent and the plan you're running should be the same document.
>
> In most agencies they diverge by week two. The quote lives in a spreadsheet
> someone built at 11pm. The plan lives in a project tool. Nobody reconciles them,
> so nobody can answer "are we still profitable on this?" without an afternoon of
> archaeology.
>
> Planora makes them one artefact.
>
> **Build from plan** seeds the quote from the Gantt — role, effort in days or
> hours, rate, tax, totals in decimal-safe arithmetic. It moves through draft →
> sent → agreed.
>
> Then **push to plan** turns the agreed line items into real tasks, as one
> undo-able batch. Each line remembers which task it created, so pushing twice
> doesn't duplicate anything.
>
> The whole thing exports as a client-ready PDF, and every line item has its own
> comment thread — so the argument about whether QA is 3 days or 5 lives next to
> the number, not in a reply-all.
>
> One document. Priced, agreed, and running.

---

### Draft 7 · Week 6, post 16 · P1

> There are two kinds of late.
>
> "I flagged this last Tuesday and here's why."
>
> And silence until the deadline.
>
> They are completely different management problems and most dashboards cannot
> tell them apart. Both show up red on Friday.
>
> So in Planora, the person doing the work owns a risk flag on their own task —
> green, amber, red, with a one-line reason. And that flag is journaled, with a
> timestamp, like every other change.
>
> Which means the weekly scorecard can distinguish "warned ahead" from "missed
> silently." The owner-only assessment signal says which one it saw: *"2 missed,
> no warning."* *"Blocked for 3 working days."*
>
> The point isn't to catch people. It's the opposite. Raising your hand early has
> to be visibly, recorded-in-the-system better than hoping. Otherwise your team
> learns that silence is cheaper — and by the time you find out, so is your
> deadline.
>
> Measure the warning, not just the miss.

---

### Draft 8 · Week 7, post 19 · P4

> Adding a client to your project tracker shouldn't cost you a seat licence
> forever.
>
> Do this arithmetic for your own agency: your headcount, plus every client
> contact who needs to see a plan, times whatever your tool charges per user per
> month, times twelve. Then ask what share of that number is people who
> exclusively *look at things*.
>
> Mine was uncomfortable enough to build an alternative.
>
> Planora is MIT-licensed and self-hosted. The whole install is:
>
>     git clone …
>     cp .env.example .env
>     docker compose up --build
>
> Five containers: Caddy for TLS and static files, a FastAPI app, PostgreSQL 16, a
> one-shot migration runner, and a backup sidecar doing a daily `pg_dump` with
> 14-day retention. No message broker. No Redis. No external SaaS dependency.
>
> It also runs on Vercel with a managed Postgres if you'd rather not own a server
> (you lose live WebSocket updates; the UI notices and adapts).
>
> Your cost is a VPS. Your seat count is "everyone." Your data is on your
> infrastructure, behind your domain.
>
> I'm not against paying for software. I'm against paying per person for the
> privilege of showing a client a chart.

---

### Draft 9 · Week 8, post 22 · P1

> You can plan a project before you know when it starts.
>
> Obvious to anyone who's quoted agency work. Impossible in most planning tools,
> which demand a calendar date before they'll draw you a single bar.
>
> But the contract isn't signed. The kickoff is "sometime after the legal review."
> And you still need a plan, because the plan *is* the pitch.
>
> Planora starts every project in relative mode. Tasks sit on Month 1 / Week 2 /
> Day 3. Dependencies work. The critical path computes. The proposal prices it.
> You can send the whole thing to a client without inventing a fake start date.
>
> Then the date arrives, you set it, and the plan converts to real dates — re-laid
> on the project's working calendar, with weekends and holidays respected.
>
> Nothing gets re-entered. The shape of the plan was always the real content; the
> dates were just one projection of it.

---

### Draft 10 · Week 11, post 32 · P2

> A test fails our CI if a developer writes `padding: 7px`.
>
> Planora's spacing comes from a scale in one CSS file — a 4px step, plus 2 and 6
> for the tight cases. Every padding, margin, and gap has to be a variable from
> that scale. A test walks the stylesheets and fails the build on a bare pixel
> literal.
>
> Sounds petty. It isn't. Unenforced design systems don't survive contact with a
> deadline. Someone nudges one card by 3px at 1am because it looked off, and eight
> months later the UI is 40 slightly different rhythms and nobody can say which
> one is correct.
>
> There's an escape hatch, because absolutism is its own bug: a geometric
> exception — compensating for a border, matching a chevron's width — is allowed
> if the line is marked `off-scale`. Now the exception is a deliberate, reviewable
> decision instead of a guess.
>
> The general principle, which has done more for this codebase than any amount of
> documentation:
>
> **If a convention matters, make CI hold the line. If it doesn't matter enough to
> automate, stop writing it down.**

---

## 8. Hook bank

Openers to draft against when the calendar runs dry. Each is a real, defensible
Planora claim.

1. "Your project plan has a history tab. Try undoing something in it."
2. "Nobody has ever asked for a status report. They've asked whether you'll be late."
3. "The most expensive seat in your project tool belongs to someone who only looks."
4. "We store every edit twice."
5. "If your AI can edit the plan, it can break a promise."
6. "'On track' is not a status. It's a hope with formatting."
7. "The plan and the quote should be one document."
8. "An estimate becomes a commitment the moment you send it."
9. "Five one-day delays is not a one-day problem."
10. "Re-approving a plan erases the record of every delay so far. So only an owner can do it."
11. "Our permission matrix is one file, and a new feature can't ship until every role has an answer."
12. "The app refuses to boot rather than serve a half-configured integration."
13. "Deleting a project takes the undo history with it. That's why it's owner-only."
14. "We don't return error messages. We return codes, and the client translates them."
15. "Azerbaijani, English, Russian — including the generated PDFs."
16. "Exports can't be revoked. Public links can. Those are different permissions."
17. "Auto-scheduling only pushes forward. Your deliberate slack survives."
18. "A whole dependency cascade is one journal entry and one undo."
19. "Working-day masks, per organisation, overridable per project."
20. "Migration you can't reverse is a bet, not a migration."

---

## 9. Asset checklist

**Already in the repo** (`docs/screenshots/`) — use immediately:

| File | Best used for |
|---|---|
| `gantt.png` | Posts 2, 3, 23 |
| `history.png` | Posts 4, 5 |
| `scorecard.png` | Posts 16, 17, 18 |
| `proposal.png` | Posts 13, 14 |
| `task-card.png` | Posts 9, 16 |
| `projects.png` | Portfolio / "the list is the status report" |
| `public-share.png` | Posts 7, 8 |
| `docs/brand/planora-logo*.svg` | Carousel covers, page branding |

**To capture** (each is ~10 minutes, all from demo data):

1. **The undo recording** — move a phase, cascade successors, one-click undo. This
   is the highest-value asset in the whole plan. Make it first.
2. Intake pipeline recording — interview → summary → draft → apply.
3. Proposal recording — build from plan → agreed → push to plan.
4. Jira import recording.
5. Relative-mode crop ("Week 1 / Day 3" axis).
6. Baseline-vs-actual crop with a shift reason visible.
7. Roles matrix as a clean table image (source: README).
8. Security surface as a carousel (source: README security table).
9. "By the numbers" card: 71k lines · 315 files · 126 test modules · 27
   migrations · 0 charting libraries.
10. Per-seat vs self-hosted cost comparison image.

**Repurposing note:** the README is already the strongest long-form asset this
project has. Each subsection under *Capabilities* maps to one post, and several
code comments in `backend/app/access.py` and `backend/app/mutations.py` are
publishable verbatim as P2 posts — they explain *why*, which is exactly what the
format rewards.

---

## 10. Profile and page setup (do this before post 1)

**Personal profile** — this carries the content; a company page with 40 followers
does not.

- **Headline:** what you do for whom, not a job title. *"Building Planora —
  self-hosted project planning for teams that answer to clients."*
- **Banner:** the Gantt screenshot with the one-liner over it.
- **Featured section:** pin the GitHub repo, a live demo link if one exists, and
  the best post once there is one.
- **About:** the six-step lifecycle from the README (scope → price → commit → run
  → prove → report), then one line about why self-hosted.

**Company page** — create it, post to it, but expect ~5% of the personal
profile's reach. Its job is to exist when someone checks whether Planora is real.

**Linking convention:** link in the **first comment**, not the post body. Then
edit the post to add "link in comments" only after it's live.

---

## 11. The 48-hour distribution routine

Reach on LinkedIn is decided in the first 90 minutes. The routine matters as much
as the writing.

**Before posting (day before):**
- Draft reviewed for one idea, one CTA, a hook that works with no context.
- First-comment link written and ready to paste.

**T+0 to T+90 min:**
- Post. Paste the link comment immediately.
- Reply to every comment with a question, not a thank-you. Threads beat likes.
- Send the post to 3–5 people who genuinely care. Never a mass DM.

**T+2 h to T+24 h:**
- Comment substantively on 5 other posts in the PM / agency / self-hosting space.
  Thoughtful comments on bigger accounts out-reach your own posts for the first
  few months.

**T+24 to T+48 h:**
- Any comment worth expanding becomes the next post. This is the cheapest content
  source that exists.

**Hashtags:** 3–5, at the end. `#projectmanagement` `#selfhosted` `#opensource`
plus one audience tag (`#agencylife`, `#pmo`) and one stack tag (`#fastapi`,
`#react`) on P2 posts. They're a minor signal now — engagement velocity is the
real lever.

---

## 12. Metrics and the review loop

Track weekly, in a sheet, five numbers only:

| Metric | What it tells you | Early target |
|---|---|---|
| Impressions per post | Whether hooks work | Trend, not absolute |
| Engagement rate (reactions + comments ÷ impressions) | Whether the *idea* landed | >4% is healthy at small scale |
| Comments from segments A–C | Whether you're reaching buyers, not just peers | ≥2 per post by week 6 |
| Profile views per week | Whether posts drive curiosity | Up week over week |
| Repo stars / demo visits per post | The only conversion signal available yet | Attribute by post |

**Monthly review, 30 minutes, three questions:**
1. Which two posts outperformed? What did they have in common — pillar, format,
   or hook shape? Write two more of those.
2. Which pillar is underperforming? Cut its share by half next month.
3. Did anyone in segments A–C reply? What words did *they* use? Steal their
   phrasing for the next batch.

**Plan amendment trigger:** the first time a real team outside the authoring
organisation runs Planora, add a sixth pillar — customer proof — at 15%, taken
from P1 and P2. Social proof out-converts opinion the moment it exists.

---

## 13. Language strategy

- **English is the default for everything.** Best reach, and it's the language
  segment D (developers, amplifiers) reads.
- **Russian** for the CIS market: re-post the 6–8 strongest posts, rewritten
  rather than translated. Two-week lag behind the English version so the calendar
  stays simple.
- **Azerbaijani** for local market moments — hiring, local events, local
  partnerships. Personal profile only.
- **Never** post the same text in two languages in one post. It halves reach in
  both.

The product itself ships in all three (UI *and* generated documents), which is a
credible post in its own right for anyone selling into multilingual markets —
see hook #15.

---

## 14. Guardrails

- **Demo data only** in every screenshot and recording. No real client name,
  person, rate, or project title. Not cropped, not blurred.
- **No invented metrics.** No "trusted by teams," no fabricated user counts, no
  made-up time savings. The whole credibility strategy collapses on the first
  number someone can't verify. This includes competitor pricing: if a post does
  cost arithmetic (post 19), either use your own real numbers or make the reader
  do theirs — never quote a vendor's price from memory.
- **Security posture is publishable; security incidents are not.** The README's
  security table is public by design — post it freely. An unpatched issue, an
  `.env` value, a real hostname, or a screenshot with a live token in the URL
  never goes out.
- **Don't punch at named competitors.** Criticise *patterns* — per-seat pricing
  for viewers, history you can't undo, AI that writes without asking. Naming
  vendors reads as insecurity and invites a fight you can't win at this size.
- **Ship the post, not the perfect post.** Three adequate posts a week beats one
  brilliant one a month, and the archive compounds.

---

*Sources: [README.md](../../README.md) for every product claim; repo stats as of
this document's commit (71k lines across 315 source files, 126 test modules, 27
migrations).*
