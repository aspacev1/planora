# Planora — remediation plan from the audit findings

A road map for clearing the findings of six code audits (security, backend
core, API/realtime, frontend engineering, infrastructure, tests) and a separate
UX audit. The plan was drawn up in the `claude/project-ux-efficiency-analysis-t6hqtg`
branch; execution goes in waves, and wave 0's branch is `claude/remediation-plan-stepwise-n7cjaw`.

The tasks are grouped into **nine sequential waves**. The order is set by
dependencies, not by severity alone: first the net that catches regressions,
then whatever breaks data and access, and only after that the rest. Within a
wave the tasks are independent and parallelize.

## How to use this

- Tick `[x]` as you go. One item is usually one PR.
- Every task in waves 0-1 requires a regression test that reproduces the failure.
- Waves 0 and 1 are done sequentially and first; 2-5 parallelize well.
- **Gate after wave 0:** from here on, only through a PR with green CI.

## Notation

- Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low
- Cost: **S** — up to half a day · **M** — 1-2 days · **L** — more

---

## Wave 0 — The safety net · _before everything else_

Not a single behaviour-changing edit until there is a barrier that catches a
regression. The cheapest and the most important stage.

- [x] **0.1** 🔴 **S** — CI: GitHub Actions with a service Postgres → `pytest`,
  `vitest run`, `tsc -b`, `oxlint`, `docker compose build`. Runs on push and PR.
  _`.github/workflows/ci.yml`: three jobs — backend (pytest+Postgres), frontend
  (lint, tsc, tests, API contract freshness), docker (compose build)._
- [x] **0.2** 🔴 **S** — Migration test: `alembic upgrade head` on a clean database +
  a comparison against `create_all` (`compare_metadata`); a `downgrade` check.
  _`tests/test_migrations.py`; it immediately caught and fixed the unrunnable
  `9c584d8968ac` downgrade (a drop of an unnamed FK)._
- [x] **0.3** 🔴 **S** — Database backups: `pg_dump` on a schedule (sidecar/cron) +
  a documented restore check. Remove `docker compose down -v` from the
  README as a routine option, add a "Backups" section.
  _A `backup` service in compose + `docker/backup.sh`; the README was extended._
- [x] **0.4** 🟠 **M** — API contract: a snapshot of `app.openapi()` in the backend
  tests + frontend type generation from it (or a response-key parity test).
  _`tests/test_openapi_contract.py` → `backend/openapi.json` →
  `npm run gen:api` → `src/api/schema.d.ts`; the diff is checked in CI._
- [x] **0.5** 🟠 **S** — Coverage in CI: `pytest-cov` + `@vitest/coverage-v8`.
  Add the `exhaustive-deps` rule to oxlint.

**Gate:** CI green on the current code.

---

## Wave 1 — Data integrity

Paths that already lead to a 500 or to irreversible data loss.

- [x] **1.1** 🔴 **M** — Double-undo race: move the choice of the revision to undo
  inside `apply_op`, under the project's `SELECT … FOR UPDATE`.
  `backend/app/api/project_routes.py:309` → `mutations.py:904`
  _`mutations.undo_last`: lock → choose → apply; the route no longer picks the
  revision itself. A race test on two sessions with a real lock._
- [x] **1.2** 🔴 **S** — An upper bound on `start_date` (`Field(le=…)`) + catching
  `OverflowError` in the calendar → `CalendarError`.
  `backend/app/calendar.py:67`, `mutations.py:290-294`
  _`MAX_WIRE_DATE` (2200-12-31) on `start_date`/`baseline_start`;
  `calendar_date_out_of_range` instead of OverflowError; `count_working_days`
  now survives up to `date.max`._
- [x] **1.3** 🔴 **S** — Trim the slug to the column length in `slugify`/on insert +
  catch `DataError` alongside `IntegrityError`.
  `backend/app/text.py:44` → `models.py:150` → `slugs.py:98`
  _`SLUG_MAX_LEN=100` in `slugify`; uniqueness suffixes cut the base rather
  than themselves; `DataError` rolls back to the SAVEPOINT._
- [x] **1.4** 🔴 **M** — Undoing a task deletion restores dependencies,
  assignments and comments: a snapshot of the related rows in `inverse` (or
  forbid hard deletion, as with categories).
  `backend/app/mutations.py:822-841`, `models.py:385,395,247`
  _A snapshot in `inverse` and a "best effort" restore: a vanished far end of
  a dependency or a vanished author is skipped, as a cascade would do._
- [x] **1.5** 🟠 **M** — Batch rollback: accept a `reason`; handle restoring into
  a deleted category and map desynchronization correctly
  (`KeyError`/FK → `MutationError`, not a 500).
  `backend/app/mutations.py:1044-1048`
  _`reason` on the route and in `undo_batch`; `category_not_found` /
  `positions_categories_mismatch` instead of a 500; a lock against a double rollback._
- [x] **1.6** 🟠 **M** — Reorder: store the minimal diff in the journal instead of
  a snapshot of every task in the project.
  `backend/app/mutations.py:741-775`
  _Only the rows whose position or category changed land in `op`/`inverse`._
- [x] **1.7** 🟠 **S** — Deviation threshold: separate `Δstart` and `Δduration` in
  `_guard_shift_threshold`; fix the value of the `X-Shift-Deviation-Days` header.
  `backend/app/plans.py:35-38`, `mutations.py:866`
  _`deviation_days` measures the dimension it is named after; the header names
  the number for the dimension being edited, not the max over the others._

---

## Wave 2 — Security and multi-tenancy

Access, money and leaks — everything that lets an outsider read or spend what
belongs to someone else.

- [x] **2.1** 🟠 **M** — SSRF: an allowlist for the `https` scheme, a ban on
  private/link-local ranges (resolving the host before the request),
  `allow_redirects=False`.
  `backend/app/ai/provider.py:46,74`, `ai_routes.py:57`
  _`ai/netguard.py`: a check on save and on every request; redirects are
  forbidden; `AI_ALLOW_PRIVATE_URLS` is a deliberate knob for local models._
- [x] **2.2** 🟠 **S** — AI runs in the selected organization: replace "the first
  membership by id" with `active_membership`.
  `backend/app/api/ai_routes.py:21-34`
  _Every AI route goes through `current_membership`._
- [x] **2.3** 🟠 **M** — A rate limit on sign-in and registration (by IP and by
  account); the limit store is shared (see 3.5), not process memory.
  `backend/app/api/auth_routes.py:182`
  _`app/throttle.py` on top of the `throttle_events` table in Postgres; per
  account only failures are counted._
- [x] **2.4** 🟠 **M** — An AI token budget + a rate limit; run `propose_split`
  through token accounting.
  `backend/app/api/ai_routes.py`, `ai/intake.py:343`
  _`ai/usage.py`: a daily per-organization budget (upsert), the rate through
  the same throttle; `MeteredProvider` counts every path to the model._
- [x] **2.5** 🔴 **M** — Internal/public comments: introduce a flag, filter the
  guest's public feed.
  `backend/app/api/public_routes.py:134-146`, `comments.py:92-103`
  _`comments.internal`; a guest knows nothing of the flag, neither on read nor
  on write._
- [x] **2.6** 🟠 **S** — Validate `APP_SECRET` (minimum length, no placeholder)
  and refuse to start; document that rotation is impossible.
  `backend/app/config.py:38`, `crypto.py:29-33`, `.env.example:23`
- [x] **2.7** 🟠 **S** — The cookie's `Secure` flag comes from the request scheme
  or from an explicit `COOKIE_SECURE` setting, not from `PUBLIC_BASE_URL` alone;
  `delete_cookie` uses the same attributes.
  `backend/app/api/auth_routes.py:70-89`
- [x] **2.8** 🔴 **S** — Secret links out of the logs: `LogTransport` hides the
  token, or is available only behind an explicit dev flag.
  `backend/app/mail/transports.py:174-194`, `.env.example:67`
  _`none` masks tokens; the full text is available only behind an explicit `log`._
- [x] **2.9** 🟡 **M** — Security headers in Caddy (CSP, HSTS, `nosniff`,
  `frame-ancestors`, `Referrer-Policy`); `trusted_proxies` + scrubbing the
  incoming `X-Forwarded-For`; a section on TLS/domain.
  `Caddyfile`
  _`X-Forwarded-For` is rewritten with the client's real address; the README
  gained a "Custom domain and TLS" section._
- [x] **2.10** 🟡 **M** — WebSocket: check `Origin` at the handshake;
  re-authorize on the socket (re-check the permission periodically / on broadcast).
  `backend/app/api/live_routes.py:132-149`
  _Origin comes before the session; the permission is re-checked at least once
  a minute._
- [x] **2.11** 🟡 **S** — CSRF in depth: middleware checking `Origin`/`Referer`
  for writing requests (on top of `SameSite=Lax`).
  `backend/app/main.py`
- [x] **2.12** ⚪ **M** — Session management: an idle timeout, "sign out
  everywhere", cleanup of expired rows, password change.
  `backend/app/auth.py:18,102-145`
  _`last_used_at` + a 7-day idle timeout; `POST /api/auth/password`,
  `POST /api/auth/sessions/close-others`; expired rows are cleaned on sign-in._

---

## Wave 3 — Service availability and operations

So that the service survives a deploy, a database failure and growing load, and
so that an incident can be diagnosed.

- [x] **3.1** 🔴 **S** — Graceful shutdown: a separate entrypoint with
  `exec uvicorn`, `init: true`, `stop_grace_period`, closing WebSockets on a
  signal.
  `docker-compose.yml:53`, `docker-compose.dev.yml:34`
  _The api command is uvicorn itself (PID 1 receives SIGTERM and closes the
  sockets), `init: true`, `stop_grace_period: 30s`._
- [x] **3.2** 🟠 **M** — Migrations out of the start command: a separate job/step
  with an advisory lock in `env.py`; replicas do not apply them in parallel.
  `docker-compose.yml:53`, `backend/migrations/env.py:61-73`
  _A `migrate` service (+ `service_completed_successfully` on api);
  `pg_advisory_lock` in env.py._
- [x] **3.3** 🟠 **S** — Containers do not run as root: `USER`, `cap_drop: [ALL]`,
  `no-new-privileges`, and `read_only` where possible.
  `backend/Dockerfile`, `frontend/Dockerfile`
  _`USER app`/`USER web` in the images; `cap_drop`/`no-new-privileges` in
  compose (except db — the Postgres image needs capabilities to change user)._
- [x] **3.4** 🟠 **L** — The live hub on every writing route (undo, rollback,
  settings, plan, comments). For several workers — pub/sub through Postgres
  `LISTEN/NOTIFY` or Redis; or an explicit restriction to one worker with a
  check at startup.
  `backend/app/live.py:50,93`, `api/project_routes.py:428`
  _The "one worker with a check at startup" option was chosen (it refuses when
  WEB_CONCURRENCY>1); publication from undo, rollback, settings, plan and
  comments (the `comment` event carries no text — the body is read back over
  HTTP, where the internal-reply filter applies)._
- [x] **3.5** 🟠 **L** — Move external calls (LLM, SMTP, mail API) out of the
  synchronous path: `async`+`httpx` or a background queue; mail must not be in
  the body of `register`.
  `backend/app/ai/provider.py:74`, `mail/transports.py:93`
  _The registration email moved into BackgroundTasks after the response. LLM
  calls deliberately stay synchronous in the threadpool: the model's answer is
  the request's answer, they do not hold the event loop, and timeouts are set;
  a queue without external services would mean polling, which the product
  avoids._
- [x] **3.6** 🟡 **M** — Observability: configure logging (`dictConfig`, respect
  `LOG_LEVEL`), request-id middleware, structured logs; a health check that
  goes to the database (liveness/readiness separately).
  `backend/app/main.py:15-30`, `config.py:62`
  _`configure_logging()` + a request id on every line and in `X-Request-ID`;
  `/api/health` is liveness without the database, `/api/health/ready` runs
  `SELECT 1`._
- [x] **3.7** 🟡 **S** — Compose: resource limits, log rotation, pinning images
  by digest.
  `docker-compose.yml`
  _`mem_limit`, json-file 10m×3, digest pins for postgres/python/node/caddy._
- [x] **3.8** 🟠 **M** — Untangle the Vercel environments (a separate preview
  database); validate/warn on `PUBLIC_BASE_URL`; check `requirements.txt` ↔
  `uv.lock` in CI; tell the client that WS is unavailable through `/api/config`.
  `README.md:212-214`, `config.py:14,40`
  _The README names the price of a shared preview database outright; a warning
  about the default PUBLIC_BASE_URL at startup; a requirements ↔ uv.lock parity
  test (runs in CI); `live_enabled` in `/api/config` (false automatically on
  Vercel)._

---

## Wave 4 — Data model and API design

Schema and contract debt: indexes, constraints, idempotency, pagination,
versioning.

- [x] **4.1** 🟡 **S** — Indexes: `dependencies.project_id`/`to_task_id`,
  `task_assignees.user_id`, `comments.task_id`, `tasks.category_id`,
  `sessions.user_id`; a GIN index on `revisions.op`. A new migration.
  `backend/app/models.py:334,394,396,386,247,107`
  _The migration: six indexes + a GIN index on `revisions.op`._
- [x] **4.2** 🟡 **S** — FKs to `users.id`: `ondelete=SET NULL` for
  `revisions.actor_user_id`, `plan_versions.approved_by`,
  `ai_sessions.created_by`.
  `backend/app/models.py:460,371,439`
  _`ondelete=SET NULL`; the journal and the chronicle survive an account
  deletion._
- [x] **4.3** 🟡 **M** — A single position model (within a category) + a unique
  `(category_id, position)` constraint; a stable ordering.
  `backend/app/mutations.py:522-530,756-757`
  _Numbering within the category (renumbered by a migration), a unique
  constraint that is DEFERRABLE INITIALLY DEFERRED._
- [x] **4.4** 🟡 **M** — Project settings that move dates go under a lock and get
  written down (or go through the journal/threshold).
  `backend/app/api/project_routes.py:252-287`
  _FOR UPDATE on the project row + writing the changes into the application
  journal (the revision journal is the plan's history, not the settings')._
- [x] **4.5** 🟡 **M** — Plan approval is reversible: a rollback to a version from
  `PlanVersion.snapshot`.
  `backend/app/plans.py:74-79`
  _`POST /plan/approvals/{version}/restore`: the baseline from the snapshot, a
  new version in the chronicle; tasks outside the snapshot are "beyond the plan"._
- [x] **4.6** 🟡 **M** — Idempotency: an idempotency key for mutations and
  comments; split `POST /share` into "create" and "re-issue".
  `backend/app/api/project_routes.py:396`, `share_routes.py:73-84`
  _An Idempotency-Key header on mutations and comments (the response is saved
  and a repeat replays it); POST /share only creates (409 on a repeat), the
  re-issue is POST /share/rotate._
- [x] **4.7** 🟡 **M** — Pagination: comments (limit + cursor) on both routes; a
  cursor for the revision journal (`before_seq`).
  `backend/app/comments.py:92-103`, `project_routes.py:156`
  _limit+before (the created_at, id pair) on both feeds; before_seq in the
  revision journal._
- [x] **4.8** 🟡 **S** — Input limits: middleware on the body size; ceilings on
  the AI steps (theses/draft/parts) and on `description` in the AI path on a par
  with HTTP.
  `backend/app/api/ai_routes.py:211-332`, `ai/schemas.py:101`
  _Middleware on Content-Length (413); ceilings on the draft's theses/tasks/
  categories; description in the AI path uses the same MAX_TEXT_LEN as HTTP._
- [x] **4.9** 🟡 **M** — Compute end dates arithmetically/cache them instead of a
  loop over days on every `GET`; fix the AI split (working days, not calendar
  days).
  `backend/app/api/serialization.py:78-87`, `ai/intake.py:378`
  _Weekly arithmetic + one-off exceptions (a binary search for the end); the AI
  split lays the parts out along the project calendar._
- [x] **4.10** 🟡 **M** — API versioning (`/v1`) + `response_model` on the routes
  + one `extra="forbid"` policy; open OpenAPI in production.
  `backend/app/main.py:15`, `vercel.json:12-15`
  _/api/v1/* is an alias over /api/* (middleware); /api/docs and
  /api/openapi.json are reachable behind the static fallback. Blanket
  response_model was left to the contracts wave — the OpenAPI snapshot already
  catches drift._
- [x] **4.11** ⚪ **S** — Internal validation of `CreateTask`
  (criticality/progress) + `CHECK` constraints; a cycle detector in the
  dependencies; read `MAX_TEXT_LEN` at call time.
  `backend/app/mutations.py:531-545,263`

---

## Wave 5 — Frontend engineering quality

Correctness of state, types and the build. Part of it hinges on `strict` — turn
that on at the start of the wave.

  _criticality/progress in CreateTask, three CHECKs on tasks, a dependency
  cycle detector, MAX_TEXT_LEN read at call time._
- [ ] **5.1** 🔴 **M** — Turn on TS `strict` in `tsconfig.app.json` and fix
  whatever surfaces.
  `frontend/tsconfig.app.json:2-24`
- [ ] **5.2** 🟠 **S** — Mutation rollback: `invalidateQueries` in `catch`; a
  counter of active mutations against optimistic updates overwriting each other.
  `frontend/src/project/useProjectMutation.ts:83,122`
- [ ] **5.3** 🟠 **S** — Delete `SharePanel`, keeping `ShareDialog` (or reduce
  both to a shared hook): that fixes the wrong "not published", the ignored
  `allowed`, and the empty dialog.
  `frontend/src/project/SharePanel.tsx:33,37,49`
- [ ] **5.4** 🟠 **S** — AuthProvider: tell a network error from a 401 (do not
  sign the user out, retry); stable `useMemo` dependencies (`mutateAsync`).
  `frontend/src/auth/AuthProvider.tsx:34-51,76-84`
- [ ] **5.5** 🟠 **S** — An `ErrorBoundary` around the routes + a "Retry" button
  on query errors.
  `frontend/src/App.tsx`, `main.tsx`
- [ ] **5.6** 🟡 **S** — `AbortController`: thread `signal` through `request()`
  into every `queryFn`.
  `frontend/src/api/client.ts:72-99`
- [ ] **5.7** 🟡 **M** — Narrow the invalidation keys (the journal under its own
  subkey; `share`/`comments` as separate roots); debounce the live refetch; skip
  the echo of one's own revision.
  `frontend/src/project/useProjectMutation.ts:113`, `live/useProjectLive.ts:132`
- [ ] **5.8** 🟡 **S** — `useDragDates`: a fallback `pointerup` on `window` + a
  reset of the dragging flag; an optimistic `set_duration` moves the
  `end_date`/the width.
  `frontend/src/gantt/useDragDates.ts:71-113`, `project/optimistic.ts:12-17`
- [ ] **5.9** 🟡 **M** — The Vite build: `sourcemap`, an explicit `target`,
  `manualChunks`; `React.lazy` per route; a dynamic import of the dictionaries
  by locale.
  `frontend/vite.config.ts`, `src/AppRoutes.tsx`, `i18n/index.ts`
- [ ] **5.10** 🟡 **S** — The refusal-code dictionary: a parity test against
  OpenAPI, add the missing ones (dependencies), remove the duplicate;
  `console.warn` once per key and only in DEV; `Headers` in `request()`;
  `ORG_QUERY_KEY → ["org","current"]`.
  `frontend/src/api/errors.ts:8-106`, `i18n/index.ts:88`, `api/org.ts:3`
- [ ] **5.11** ⚪ **S** — Extend the `Op` type with the delete/dependency/rename
  operations (paired with 6.3 and the dependency panel).
  `frontend/src/api/projects.ts:119-145`

---

## Wave 6 — UX: dead-end scenarios

The things that get a user stuck or make them leave.

- [x] **6.1** 🔴 **M** — Password recovery: routes + screens + the email;
  password change in the profile.
  `frontend/src/api/auth.ts:33-80`, `screens/Login.tsx:73`
  <!-- Done: backend/app/password_reset.py, POST /password/forgot + /password/reset
       in backend/app/api/auth_routes.py, frontend/src/screens/ForgotPassword.tsx +
       ResetPassword.tsx wired into AppRoutes.tsx. -->
- [ ] **6.2** 🔴 **S** — Resending the confirmation email for "it never arrived"
  (without a token) + a banner about an unconfirmed address in the header/profile.
  `frontend/src/screens/VerifyEmail.tsx:39,51-77`
- [x] **6.3** 🔴 **S** — Deleting tasks and categories in the UI (the server can
  already do it) — paired with 5.11.
  `frontend/src/api/projects.ts:120-145`
  <!-- Done: delete-with-confirmation flows in frontend/src/gantt/Row.tsx and
       frontend/src/task/TaskPanel.tsx. -->
- [ ] **6.4** 🔴 **S** — Date/number fields commit on `onBlur`/Enter; do not
  overwrite a focused field on a refetch.
  `frontend/src/task/fields.tsx:65,111,121-127`
- [ ] **6.5** 🔴 **M** — Gantt: a date tooltip at the cursor while dragging + auto
  scrolling of the timeline at the edge.
  `frontend/src/gantt/useDragDates.ts:80-89`, `Row.tsx:237-247`
- [ ] **6.6** 🔴 **M** — Timeline scale: day/week/month/quarter.
  `frontend/src/gantt/scale.ts:10`
- [ ] **6.7** 🔴 **M** — Touch: `releasePointerCapture` for reordering; show the
  hover actions on touch devices.
  `frontend/src/gantt/useReorder.ts:103-116`, `gantt.css:285-297`
- [ ] **6.8** 🔴 **M** — Responsiveness of the chart and the card: media queries;
  the card moves to the bottom on a narrow screen; a collapsible name column.
  `frontend/src/gantt/gantt.css:11`, `task/panel.css:22`, `styles.css:542-551`
- [ ] **6.9** 🔴 **S** — The author in `undoable`: undo only one's own, or name
  the author of someone else's action explicitly.
  `frontend/src/gantt/useDragDates.ts:60`, `api/projects.ts:95`
- [ ] **6.10** 🟠 **M** — Keep the deep link across sign-in (`state.from`); the
  open task's address in the URL (which opens the way to breadcrumbs).
  `frontend/src/auth/RequireAuth.tsx:25`, `screens/Project.tsx:49`

---

## Wave 7 — UX: feedback, accessibility, navigation

The medium UX findings.

### Feedback and confirmations

- [ ] **7.1** 🟡 — A "saved" indication when settings autosave.
  `ProjectSettings.tsx:91`, `OrgSettings.tsx:83`, `Profile.tsx:52`
- [ ] **7.2** 🟡 — A message in words when a drag is refused.
  `gantt/useDragDates.ts:59-64`
- [ ] **7.3** 🟡 — Skeletons/loading indicators instead of a bare "Loading…".
- [ ] **7.4** 🟡 — Confirmation of destructive actions (re-issuing/revoking a
  link, revoking an invitation); a warning when the slug changes.
  `ShareDialog.tsx:130-145`, `Members.tsx:258-268`, `ProjectSettings.tsx:98`
- [ ] **7.5** 🟡 — Protect the window with issued invitations from closing on
  Esc/a click outside.
  `Members.tsx:110-121`, `components/Modal.tsx:46-55`
- [x] **7.6** 🟡 — Atomic creation of a task with assignees.
  _Dropped along with the form: a task is created by a single operation right
  in the timeline — a name and Enter — and assignees are set in the card, each
  by its own operation. The "create, then fill in" chain, which could fail
  halfway, is gone (`gantt/NewTaskRow.tsx`, `gantt/useQuickTask.ts`)._
- [ ] **7.7** 🟡 — The AI interview: saving the session + indicators for long
  calls + showing the error when saving the theses fails.
  `screens/AiIntake.tsx:30,66,100-203`

### Accessibility and navigation

- [ ] **7.8** 🟡 — A focus trap in `Modal` + `inert` on the background; separate
  the Esc layers.
  `components/Modal.tsx:30-44`, `task/TaskPanel.tsx:66-74`
- [ ] **7.9** 🟡 — A keyboard alternative to reordering; scrolling the timeline
  from the keyboard; announcing Shift+←/→.
  `gantt/Row.tsx:144-166`, `Gantt.tsx:127`, `useDragDates.ts:115-125`
  _The announcing is done: `aria-keyshortcuts` on the bar and a line of
  shortcuts in the hover card; along with it a global Ctrl/⌘+Z and an Esc that
  aborts a drag in progress (`components/hotkeys.ts`, `project/UndoHotkey.tsx`).
  Row reordering and scrolling the timeline from the keyboard remain._
- [ ] **7.10** 🟡 — Fix the sticky scale header on vertical scroll.
  `gantt/gantt.css:53-75`
- [ ] **7.11** 🟡 — "Projects / Project / Task" breadcrumbs (after 6.10).
- [ ] **7.12** 🟡 — A task's dependencies as a list in the card + adding/removing
  them from the UI.
  `task/TaskPanel.tsx:125-302`, `gantt/Arrows.tsx:64`
- [ ] **7.13** 🟡 — Realtime conflict detection (an expected revision).
  `api/projects.ts:176-181`
- [ ] **7.14** 🟡 — Touch: `touch-action: pan-y` instead of `none`; hit areas up
  to 24-44px; the contrast of small text; a theme switch.
  `gantt/gantt.css:96,276,336,426`, `styles.css:31,818`
- [x] **7.15** 🟡 — Two "Projects" screens: signing in led to `/projects`, while
  the item in the column led to `/` — a different screen with the same heading.
  There is one canonical project list (`/projects`), and both the column item
  and the root lead there; the portfolio got its own name, its own `/portfolio`
  address and its own item; the "Projects" section stays highlighted inside a
  project too.
  `components/Header.tsx`, `AppRoutes.tsx`, `screens/Portfolio.tsx`

---

## Wave 8 — Polish

Small things, each one a small PR.

- [ ] **8.1** ⚪ — A "not found" screen instead of a silent redirect to `/projects`.
  `AppRoutes.tsx:60`
- [ ] **8.2** ⚪ — Highlight the active section for "Settings"/"Profile".
  `components/Header.tsx:79,85`
- [ ] **8.3** ⚪ — Loading and empty states for the organization's membership.
  `screens/Members.tsx:314-328`
- [ ] **8.4** ⚪ — One style for equivalent actions (button vs link).
  `screens/Projects.tsx:43-48`
- [ ] **8.5** ⚪ — History/comments: tell an error from "empty".
  `task/History.tsx:27`, `Comments.tsx:39`
- [ ] **8.6** ⚪ — `index.html` without a hard-coded `lang="az"`; `meta description`/
  `theme-color`.
  `frontend/index.html:2`
- [ ] **8.7** ⚪ — Project settings reachable for a reader (read-only mode is
  already written).
  `screens/Project.tsx:168-170`, `ProjectSettings.tsx:67`
- [ ] **8.8** ⚪ — A "skip to content" link before the navigation.
  `auth/RequireAuth.tsx:33-38`

---

## Effort summary

| Wave | Focus | Tasks | Estimate |
|---|---|---|---|
| 0 | The safety net | 5 | 2-3 days |
| 1 | Data integrity | 7 | 4-6 days |
| 2 | Security | 12 | 1.5-2 weeks |
| 3 | Availability and operations | 8 | 1.5-2 weeks |
| 4 | Data model and API | 11 | 2 weeks |
| 5 | Frontend engineering | 11 | 1-1.5 weeks |
| 6 | UX — dead ends | 10 | 2 weeks |
| 7 | UX medium | 14 | 1.5-2 weeks |
| 8 | Polish | 8 | 3-5 days |

The estimates are for one engineer, roughly. Waves 2-5 parallelize well across
people; waves 0-1 are better done sequentially and first.

---

_Source: six code audits (security, backend core, API/realtime, frontend
engineering, infrastructure, tests) and a UX audit, branch `main`, August
2026. Severity and path:line come from the audits; the order of the waves is
set by dependencies._
