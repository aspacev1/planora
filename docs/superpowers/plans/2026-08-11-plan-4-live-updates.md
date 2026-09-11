# Plan 4: live updates and dropped connections — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close §6 "Live updates" and the first item of §12: revisions are broadcast over the project's WebSocket, while a dropped connection is visible as a "no connection, data as of 14:32" strip and blocks editing.

**Architecture:** The broadcast is held in the process's memory (§11): a hub with a room per project, a subscriber per socket, a queue per subscriber. The socket decides nothing about the domain — it subscribes and forwards whatever the mutations route put into the room. On an incoming revision the client refetches the project's state rather than replaying the operation itself: the end dates are computed by the server, and a second, "client-side" applier of operations would diverge from it on the very first holiday.

**Tech Stack:** As in plans 1–3. Not a single new dependency: WebSocket is in FastAPI and in the browser.

## Global Constraints

- **Recovery is a full refetch rather than replaying what was missed** (§12). A revision over the socket is a "the state has changed" signal rather than a patch the client has to be able to apply.
- **The internal note does not leak into the socket either.** Visibility is decided by the same `visible_op` as in the HTTP journal, and it is decided separately for every subscriber: an editor and a client sit in the same room.
- **A guest is a listener.** Not a single command is accepted from the client over the socket: the only way to change a project is `POST /mutations`, where the permission is checked.
- **What is blocked is what used to be a connection, not what never was.** While the socket has never opened (a platform without WebSocket — a serverless deployment on Vercel, for example), the interface works as before: without live updates but with editing. The strip and the block appear only after an established connection drops.
- **A database connection is not held for the whole life of the socket.** Permissions are checked by a short-lived session that is closed before the handler goes off to wait for messages; otherwise a dozen open tabs would exhaust the pool.
- Languages: `az` by default, `en`, `ru` — new keys appear in all three dictionaries at once, otherwise the completeness test fails.

---

### Task 1: The broadcast hub

**Files:**
- Create: `backend/app/live.py`
- Test: `backend/tests/test_live_hub.py`

**Interfaces:**
- Produces: `hub.subscribe(project_id)` — a context manager yielding a `Subscriber`; `await hub.publish(project_id, message)`; `Subscriber.next()`, `Subscriber.lagging`.

A separate module with not a single mention of HTTP: this is the very place §11 promises to replace with Redis in one class, should a second process be needed.

- [x] **Step 1: Write the failing tests**

A subscriber receives what was published; another room receives nothing; unsubscribing removes the room; an overflowing queue marks the subscriber as lagging and stops growing.

- [x] **Step 2: Implement**
- [x] **Step 3: Run the tests**

---

### Task 2: The project's socket

**Files:**
- Create: `backend/app/api/live_routes.py`
- Modify: `backend/app/auth.py` (extract `user_for_token`), `backend/app/projects.py` (extract `first_membership`/`project_in_scope`), `backend/app/api/project_routes.py` (reuse them), `backend/app/main.py`
- Test: `backend/tests/test_live_api.py`

**Interfaces:**
- Produces: `WS /api/projects/{id}/live`; the messages `{"type": "revision", …}` and `{"type": "heartbeat"}`.

The close codes come from the range allotted to the application: 4401 "did not introduce itself", 4404 "no such project", 4409 "fell behind". The client can tell them apart, whereas 1008 is the same for all three cases.

- [x] **Step 1: Write the failing tests**

A mutation reaches the connected client; an unauthenticated one is closed with 4401; somebody else's project gives 4404; a client (the `client` role) does not receive the note in a revision.

- [x] **Step 2: Implement**
- [x] **Step 3: Run the tests**

---

### Task 3: Publishing revisions

**Files:**
- Modify: `backend/app/api/project_routes.py`
- Test: `backend/tests/test_live_api.py`

Publishing happens in a background task rather than in the route's body: the route is synchronous and lives in a thread pool, while the subscribers' queues are in the event loop, and they must not be touched from another thread.

The commit is set explicitly in the route at that, before the task is scheduled. Verified in place rather than taken from the documentation: Starlette's background tasks run **earlier** than a dependency with `yield` is closed — that is, before `get_db` commits. On a signal the client refetches the whole project, and arriving before the commit it would not see the changes, while there would be no second signal. The order is pinned by a test: without an explicit commit it fails.

- [x] **Step 1: Write the failing test**
- [x] **Step 2: Implement**
- [x] **Step 3: Run the tests**

---

### Task 4: The connection on the client

**Files:**
- Create: `frontend/src/live/useProjectLive.ts`, `frontend/src/live/LiveProvider.tsx`
- Test: `frontend/src/live/useProjectLive.test.tsx`
- Modify: `frontend/vite.config.ts` (proxy the upgrade)

**Interfaces:**
- Produces: `useProjectLive(projectId)` → `{ status, syncedAt }`, where `status` is `connecting | online | offline | unavailable`; `useLive()` — the same object from the context.

- [x] **Step 1: Write the failing tests**

An incoming revision refetches the state; closing the socket moves it to `offline`; a reconnection refetches the whole state; a socket that never opened gives `unavailable` rather than `offline`; silence longer than the watchdog timeout counts as a drop.

- [x] **Step 2: Implement**
- [x] **Step 3: Run the tests**

---

### Task 5: The strip and the editing block

**Files:**
- Create: `frontend/src/live/OfflineBar.tsx`, `frontend/src/live/live.css`
- Modify: `frontend/src/screens/Project.tsx`, `frontend/src/project/useProjectMutation.ts`, `frontend/src/api/errors.ts`, `frontend/src/i18n/{az,en,ru}.json`, `frontend/src/i18n/dates.ts`
- Test: `frontend/src/screens/Project.live.test.tsx`, `frontend/src/project/useProjectMutation.test.tsx`

The block is placed in `useProjectMutation` rather than in every gesture: this is the only road for any change, and any new gesture will find itself blocked by itself, without a reminder.

- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Implement**
- [x] **Step 3: Run the whole suite and build**
- [x] **Step 4: Commit**

---

## What this plan does not do

- Public links and guest comments. A guest connects to the same socket (§6), but guest access itself does not exist yet — it will arrive with the public page.
- Replaying missed revisions. The specification chooses a full refetch, and that is deliberate: replaying requires a second applier of operations on the client.
- A second application process. The rooms live in memory; horizontal scaling means replacing `Hub` with an implementation on top of Redis.
- Undo and rolling back an AI batch. The mechanism exists in `mutations`, the route does not.
