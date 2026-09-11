# Plan 0: what the backend is missing — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between what the backend can do now and what the interface will need: the missing operations, row reordering with journalled shifts of the neighbours, links between tasks, the organization's member list, and clearing two known debts.

**Architecture:** Nothing new is designed. All the changes fit into existing modules: the operations into `app/mutations.py` after the pattern of the six already written, the reads into `app/api/project_routes.py`. Every operation must return its own inverse; every error must belong to one of two classes, `NotFoundInProject` or `InvalidOperation`.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, pytest. As in plan 1.

## Global Constraints

- Every operation produces its own inverse. That is optional for none of them.
- The journal stores an event with parameters rather than a ready phrase: the text is assembled at display time in the reader's language.
- A mutation's public contract is separate from its internal representation. The restoration fields (`task_id`, `category_id`, `position`) exist only in the internal models and are not accepted over the wire.
- Errors go out as machine codes in `detail`, no prose. `NotFoundInProject` → 404, `InvalidOperation` → 422.
- Access decisions are taken only by `app/access.py`. A route asks `can()` rather than comparing roles.
- Somebody else's project is indistinguishable from a non-existent one: 404, never 403.
- All changes to a project's data go through `apply_op`, inside a lock on the project's row.
- Destructive database operations run only against a database with the `_test` suffix, never the one named in `DATABASE_URL`.
- Dates are computed only through `app/calendar.py`. There is no calendar arithmetic in other modules.

---

### Task 1: Operations for editing a task's and a category's fields

**Files:**
- Modify: `backend/app/mutations.py`
- Test: `backend/tests/test_mutations.py`

**Interfaces:**
- Consumes: the existing operation registry, `MutationError`, `NotFoundInProject`, `InvalidOperation`, `_require_task`, `_require_category`.
- Produces: the internal models `SetTaskFields`, `SetCriticality`, `SetProgress`, `RenameCategory`, `SetCategoryColor` and the matching public models in the `PublicOp` registry.

Every operation carries the previous and the new value (`from` / `to`), as is already done in `move_task` and `set_duration`. The inverse operation comes out of swapping these two fields — do not write a separate branch for the inversion.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_mutations.py`:

```python
def test_set_task_fields_records_previous_and_new_values(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)
    task_id = created.op["task_id"]

    revision = apply_op(db, project, SetTaskFields(
        task_id=task_id, name="Logo redesign",
        description="Mark and wordmark", internal_note="client is picky"), actor_id=None)

    assert revision.op["from"] == {
        "name": "Logo", "description": "", "internal_note": ""}
    assert revision.op["to"] == {
        "name": "Logo redesign", "description": "Mark and wordmark",
        "internal_note": "client is picky"}
    assert revision.inverse["to"] == revision.op["from"]

    task = db.get(Task, task_id)
    assert task.name == "Logo redesign"


def test_undo_of_set_task_fields_restores_every_field(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5,
        description="old", internal_note="old note"), actor_id=None)
    task_id = created.op["task_id"]

    changed = apply_op(db, project, SetTaskFields(
        task_id=task_id, name="New", description="new", internal_note="new note"),
        actor_id=None)
    undo(db, project, changed, actor_id=None)

    task = db.get(Task, task_id)
    assert (task.name, task.description, task.internal_note) == ("Logo", "old", "old note")


def test_set_progress_rejects_a_value_outside_the_range(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, SetProgress(task_id=created.op["task_id"], progress_pct=101),
                 actor_id=None)


def test_rename_category_round_trips(db, project, category):
    revision = apply_op(db, project, RenameCategory(
        category_id=str(category.id), name="Дизайн и бренд"), actor_id=None)
    assert db.get(Category, category.id).name == "Дизайн и бренд"

    undo(db, project, revision, actor_id=None)
    assert db.get(Category, category.id).name == "Design"


def test_set_criticality_rejects_an_unknown_level(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, SetCriticality(
            task_id=created.op["task_id"], criticality="urgent"), actor_id=None)
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_mutations.py -k "set_task_fields or set_progress or rename_category or set_criticality" -v
```

Expected: `ImportError` — the new names are not in `app.mutations`.

- [ ] **Step 3: Add the internal models and the apply branches**

In `backend/app/mutations.py`, next to the existing operations. `SetTaskFields` changes three text fields at once, because the task card saves them in one action and splitting that into three revisions would mean cluttering the history:

```python
class SetTaskFields(BaseModel):
    type: Literal["set_task_fields"] = "set_task_fields"
    task_id: uuid.UUID
    name: str
    description: str
    internal_note: str


class SetCriticality(BaseModel):
    type: Literal["set_criticality"] = "set_criticality"
    task_id: uuid.UUID
    criticality: str


class SetProgress(BaseModel):
    type: Literal["set_progress"] = "set_progress"
    task_id: uuid.UUID
    progress_pct: int


class RenameCategory(BaseModel):
    type: Literal["rename_category"] = "rename_category"
    category_id: uuid.UUID
    name: str


class SetCategoryColor(BaseModel):
    type: Literal["set_category_color"] = "set_category_color"
    category_id: uuid.UUID
    color: str
```

The apply branches. Note: the inversion is built by swapping `from` and `to`, through a single helper rather than copy-paste in every branch:

```python
_TASK_FIELDS = ("name", "description", "internal_note")


def _swap(payload: dict) -> dict:
    """The inverse operation differs from the forward one only in the places of from and to."""
    return {**payload, "from": payload["to"], "to": payload["from"]}


# inside _apply:
    if isinstance(op, SetTaskFields):
        task = _require_task(db, project, op.task_id)
        before = {field: getattr(task, field) for field in _TASK_FIELDS}
        after = {"name": op.name, "description": op.description,
                 "internal_note": op.internal_note}
        for field, value in after.items():
            setattr(task, field, value)
        db.flush()
        forward = {"type": "set_task_fields", "task_id": str(task.id),
                   "from": before, "to": after}
        return forward, _swap(forward)

    if isinstance(op, SetCriticality):
        if op.criticality not in CRITICALITY_LEVELS:
            raise InvalidOperation("unknown_criticality", f"unknown level: {op.criticality}")
        task = _require_task(db, project, op.task_id)
        forward = {"type": "set_criticality", "task_id": str(task.id),
                   "from": task.criticality, "to": op.criticality}
        task.criticality = op.criticality
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, SetProgress):
        if not 0 <= op.progress_pct <= 100:
            raise InvalidOperation("progress_out_of_range", f"percentage outside 0..100: {op.progress_pct}")
        task = _require_task(db, project, op.task_id)
        forward = {"type": "set_progress", "task_id": str(task.id),
                   "from": task.progress_pct, "to": op.progress_pct}
        task.progress_pct = op.progress_pct
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, RenameCategory):
        category = _require_category(db, project, op.category_id)
        forward = {"type": "rename_category", "category_id": str(category.id),
                   "from": category.name, "to": op.name}
        category.name = op.name
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, SetCategoryColor):
        category = _require_category(db, project, op.category_id)
        forward = {"type": "set_category_color", "category_id": str(category.id),
                   "from": category.color, "to": op.color}
        category.color = op.color
        db.flush()
        return forward, _swap(forward)
```

Define next to the criticality class:

```python
CRITICALITY_LEVELS = ("low", "normal", "high", "critical")
```

- [ ] **Step 4: Teach `_op_from_dict` to read the new entries**

All five operations store both bounds, so restoration takes `to` — exactly as is already done for `move_task` and `set_duration`. Add to the mapping:

```python
_MODELS.update({
    "set_task_fields": SetTaskFields,
    "set_criticality": SetCriticality,
    "set_progress": SetProgress,
    "rename_category": RenameCategory,
    "set_category_color": SetCategoryColor,
})
```

And extend the parsing in `_op_from_dict`: for `set_task_fields` the fields are taken from the nested `to` dictionary, for the other four the scalar `to` goes into the model's matching field. Write this as an explicit "operation type → field name" mapping rather than as an `elif` chain: a chain grows with the number of operations and stops being readable.

- [ ] **Step 5: Add the public models**

Add five mirrors with constraints to the public models block (`_Wire` with `extra="forbid"`): the field lengths from the columns (`name` 300, `description` and `internal_note` — `_MAX_TEXT_LEN`, a category's `name` 200, `color` 9), `criticality` through the enumeration, `progress_pct` in the range 0–100. The public models contain nothing beyond what a person is entitled to send.

- [ ] **Step 6: Run the tests**

```bash
cd backend && uv run pytest tests/test_mutations.py -v
```

Expected: every test in the module green, including the previous ones.

- [ ] **Step 7: Commit**

```bash
git add backend/app/mutations.py backend/tests/test_mutations.py
git commit -m "feat: operations for editing a task's and a category's fields"
```

---

### Task 2: Row reordering with a shift of the neighbours

**Files:**
- Modify: `backend/app/mutations.py`
- Test: `backend/tests/test_mutations.py`

**Interfaces:**
- Produces: the operation `ReorderTask(task_id, category_id, position)` — moves a task into the given category at the given position, pushing the neighbours apart.

This is a debt left by plan 1, and the main reason it was left: **the neighbours' shifts must reach the journal**. If the neighbours are moved silently, an undo will return the task itself while the neighbours stay shifted — the order will drift apart, and the history will not name the culprit.

The decision: one revision carries the full map of positions before and after. The inverse operation is the same map, flipped. That costs more in write volume than "move the task from A to B", but it is the only way an undo is honest.

- [ ] **Step 1: Write the failing tests**

```python
def _positions(db, project) -> dict[str, int]:
    rows = db.scalars(select(Task).where(Task.project_id == project.id)).all()
    return {str(row.id): row.position for row in rows}


def test_reorder_shifts_neighbours_and_records_the_whole_map(db, project, category):
    ids = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=f"T{i}",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for i in range(3)]

    revision = apply_op(db, project, ReorderTask(
        task_id=ids[2], category_id=str(category.id), position=0), actor_id=None)

    after = _positions(db, project)
    assert after[ids[2]] == 0
    assert after[ids[0]] == 1
    assert after[ids[1]] == 2
    # the journal holds a map rather than a single shift
    assert set(revision.op["from"]) == set(ids)
    assert revision.op["to"][ids[0]] == 1


def test_undo_of_a_reorder_restores_every_neighbour(db, project, category):
    ids = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=f"T{i}",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for i in range(3)]
    before = _positions(db, project)

    revision = apply_op(db, project, ReorderTask(
        task_id=ids[2], category_id=str(category.id), position=0), actor_id=None)
    undo(db, project, revision, actor_id=None)

    assert _positions(db, project) == before


def test_reorder_into_another_category_moves_and_renumbers(db, project, category):
    other = db.get(Category, apply_op(db, project, CreateCategory(
        name="Development", color="#22c55e"), actor_id=None).op["category_id"])
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    apply_op(db, project, ReorderTask(
        task_id=task_id, category_id=str(other.id), position=0), actor_id=None)

    task = db.get(Task, task_id)
    assert task.category_id == other.id
    assert task.position == 0


def test_reorder_rejects_a_category_from_another_project(db, project, category, other_project_category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(NotFoundInProject):
        apply_op(db, project, ReorderTask(
            task_id=task_id, category_id=str(other_project_category.id), position=0),
            actor_id=None)
```

Add the `other_project_category` fixture next to the existing ones: a second organization, its project, its category.

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_mutations.py -k reorder -v
```

Expected: `ImportError: cannot import name 'ReorderTask'`.

- [ ] **Step 3: Implement the operation**

```python
class ReorderTask(BaseModel):
    type: Literal["reorder_task"] = "reorder_task"
    task_id: uuid.UUID
    category_id: uuid.UUID
    position: int


class ApplyPositions(BaseModel):
    """An internal operation: set the positions from a ready map.

    Exists only as the inverse of reorder_task. It is not accepted over the wire —
    it is not in the public registry.
    """
    type: Literal["apply_positions"] = "apply_positions"
    positions: dict[uuid.UUID, int]
    categories: dict[uuid.UUID, uuid.UUID]
```

The apply branch:

```python
    if isinstance(op, ReorderTask):
        if op.position < 0:
            raise InvalidOperation("negative_position", "a position cannot be negative")
        task = _require_task(db, project, op.task_id)
        _require_category(db, project, op.category_id)

        rows = db.scalars(
            select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
        ).all()
        before_pos = {str(row.id): row.position for row in rows}
        before_cat = {str(row.id): str(row.category_id) for row in rows}

        siblings = [row for row in rows
                    if row.category_id == op.category_id and row.id != task.id]
        index = min(op.position, len(siblings))
        ordered = siblings[:index] + [task] + siblings[index:]

        task.category_id = op.category_id
        for slot, row in enumerate(ordered):
            row.position = slot
        db.flush()

        after_pos = {str(row.id): row.position for row in rows}
        after_cat = {str(row.id): str(row.category_id) for row in rows}
        forward = {"type": "reorder_task", "task_id": str(task.id),
                   "from": before_pos, "to": after_pos,
                   "categories_from": before_cat, "categories_to": after_cat}
        inverse = {"type": "apply_positions",
                   "positions": before_pos, "categories": before_cat}
        return forward, inverse

    if isinstance(op, ApplyPositions):
        before_pos, before_cat = {}, {}
        for raw_id, position in op.positions.items():
            row = _require_task(db, project, raw_id)
            before_pos[str(row.id)] = row.position
            before_cat[str(row.id)] = str(row.category_id)
            row.position = position
            row.category_id = op.categories[raw_id]
        db.flush()
        forward = {"type": "apply_positions",
                   "positions": {k: v for k, v in op.positions.items()},
                   "categories": {k: v for k, v in op.categories.items()}}
        inverse = {"type": "apply_positions",
                   "positions": before_pos, "categories": before_cat}
        return forward, inverse
```

Register both in `_MODELS`; add **only** `ReorderTask` to the public registry.

- [ ] **Step 4: Run the tests**

```bash
cd backend && uv run pytest tests/test_mutations.py -k reorder -v
```

Expected: 4 passed.

- [ ] **Step 5: Run the whole suite — reordering touches positions that other tests check**

```bash
cd backend && uv run pytest -q
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/mutations.py backend/tests/test_mutations.py
git commit -m "feat: row reordering with the neighbours' shifts in the journal"
```

---

### Task 3: Links between tasks

**Files:**
- Modify: `backend/app/mutations.py`
- Test: `backend/tests/test_mutations.py`

**Interfaces:**
- Produces: `AddDependency(from_task_id, to_task_id)`, `RemoveDependency(from_task_id, to_task_id)`.

By the spec, links are arrows in a picture rather than a calculation rule: dates are not recomputed along them. But junk must not be allowed into them.

- [ ] **Step 1: Write the failing tests**

```python
def test_dependency_round_trips(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]

    added = apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 1

    undo(db, project, added, actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 0


def test_a_task_cannot_depend_on_itself(db, project, category):
    a = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AddDependency(from_task_id=a, to_task_id=a), actor_id=None)


def test_the_same_dependency_cannot_be_added_twice(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]
    apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)


def test_removing_a_dependency_that_does_not_exist_is_refused(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]

    with pytest.raises(NotFoundInProject):
        apply_op(db, project, RemoveDependency(from_task_id=a, to_task_id=b), actor_id=None)
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_mutations.py -k dependency -v
```

- [ ] **Step 3: Implement**

Both tasks are checked through `_require_task`, so a link to somebody else's task is cut off by the same mechanism as everything else. The inverse of `add_dependency` is `remove_dependency` with the same ends, and vice versa.

- [ ] **Step 4: Run the tests and commit**

```bash
cd backend && uv run pytest tests/test_mutations.py -k dependency -v
git add backend/app/mutations.py backend/tests/test_mutations.py
git commit -m "feat: links between tasks as visual arrows"
```

---

### Task 4: Assigning owners and the member list

**Files:**
- Modify: `backend/app/mutations.py`
- Modify: `backend/app/api/project_routes.py`
- Create: `backend/app/api/org_routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_mutations.py`, `backend/tests/test_org_api.py`

**Interfaces:**
- Produces: the operations `AssignUser(task_id, user_id)`, `UnassignUser(task_id, user_id)`; the route `GET /api/org/members`.

The interface needs a list of the people who can be assigned. Plan 5 will need the same for invitations.

- [ ] **Step 1: Write the failing tests**

```python
def test_assigning_a_user_from_another_organization_is_refused(db, project, category, outsider):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AssignUser(task_id=task_id, user_id=str(outsider.id)),
                 actor_id=None)
```

```python
def test_members_lists_only_this_organization(authed, db):
    from app.auth import register
    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    response = authed.get("/api/org/members")
    assert response.status_code == 200
    emails = [m["email"] for m in response.json()]
    assert "stranger@example.com" not in emails


def test_members_requires_authentication(client):
    assert client.get("/api/org/members").status_code == 401
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_org_api.py tests/test_mutations.py -k "assign or members" -v
```

- [ ] **Step 3: Implement the operations**

Assignment checks that the user belongs to the same organization as the project: otherwise a task could be hung on an outsider and the fact of their existence would leak. The check is a query against `Membership` by the project's `org_id`.

The inverse of `assign_user` is `unassign_user` with the same arguments. Assigning the same person twice is rejected as an `InvalidOperation`, unassigning someone who is not assigned as a `NotFoundInProject`.

- [ ] **Step 4: Implement the members route**

Create `backend/app/api/org_routes.py` with a single route `GET /api/org/members`, returning the `id`, `name`, `email` and role of the members of the current user's organization. Access goes through `access.can(..., Action.PROJECT_READ)`; the `client` role does not get the member list at all (by the spec it does not see the organization's roster), so for it the route answers with a 403.

Wire the router into `app/main.py`.

- [ ] **Step 5: Run the tests and commit**

```bash
cd backend && uv run pytest -q
git add backend/app/mutations.py backend/app/api/ backend/app/main.py backend/tests/
git commit -m "feat: assigning owners and the organization's member list"
```

---

### Task 5: The project's full state for the interface

**Files:**
- Modify: `backend/app/api/project_routes.py`
- Test: `backend/tests/test_project_api.py`

**Interfaces:**
- Produces: an extended `GET /api/projects/{id}` response — tasks with their assignees, the links, the project's settings resolved from the organization's.

Right now the response contains neither assignees, nor links, nor a calendar — while the interface needs to draw the weekends and fill in the non-working days before the first click.

- [ ] **Step 1: Write the failing tests**

```python
def test_project_state_carries_assignees_dependencies_and_calendar(authed, db):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_category", "name": "Design", "color": "#3b82f6"}}).json()["op"]["category_id"]
    first = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "A",
        "start_date": "2026-03-04", "duration_days": 2}}).json()["op"]["task_id"]
    second = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "B",
        "start_date": "2026-03-10", "duration_days": 2}}).json()["op"]["task_id"]
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "add_dependency", "from_task_id": first, "to_task_id": second}})

    me = authed.get("/api/auth/me").json()
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "assign_user", "task_id": first, "user_id": me["id"]}})

    state = authed.get(f"/api/projects/{project_id}").json()

    assert state["dependencies"] == [{"from_task_id": first, "to_task_id": second}]
    task = next(t for t in state["tasks"] if t["id"] == first)
    assert task["assignee_ids"] == [me["id"]]
    assert state["calendar"]["working_days"] == 31        # Mon–Fri
    assert state["calendar"]["holidays"] == []
    assert state["settings"]["shift_threshold_days"] == 2


def test_project_state_reports_the_deadline_and_project_end(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["deadline"] is None
    assert state["project_end"] is None
```

- [ ] **Step 2: Run the tests and make sure they fail**

- [ ] **Step 3: Extend the serialization**

Add to the response: `assignee_ids` on every task (in one query for the whole project rather than per task — otherwise a hundred tasks give a hundred queries), the `dependencies` list, a `calendar` block with the resolved working-day mask and the lists of non-working and working exceptions, a `settings` block with the resolved threshold and time zone, `deadline` and the computed `project_end` — the maximum over the tasks' end dates, or `null` if there are no tasks.

The internal note still goes through `access` rather than an inline check.

- [ ] **Step 4: Run the tests and commit**

```bash
cd backend && uv run pytest tests/test_project_api.py -v
git add backend/app/api/project_routes.py backend/tests/test_project_api.py
git commit -m "feat: the project's full state for the interface"
```

---

### Task 6: Two debts from plan 1

**Files:**
- Modify: `backend/app/calendar.py`
- Modify: `backend/app/api/project_routes.py`
- Test: `backend/tests/test_calendar.py`, `backend/tests/test_project_api.py`

**Interfaces:**
- The behaviour on a degenerate calendar changes: a comprehensible refusal instead of a 500.

Plan 1's final review left this as an observation: `end_date` raises a bare `ValueError`, and a project with a zero working-day mask answers a read with a 500. The setting comes from a person, which means a person can bring the server down.

- [ ] **Step 1: Write the failing tests**

```python
def test_reading_a_project_with_no_working_days_explains_itself(authed, db):
    project_id = authed.post("/api/projects", json={"name": "Broken"}).json()["id"]
    category_id = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_category", "name": "Design", "color": "#3b82f6"}}).json()["op"]["category_id"]
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "A",
        "start_date": "2026-03-04", "duration_days": 2}})

    project = db.get(Project, uuid.UUID(project_id))
    project.working_days = 0
    db.flush()

    response = authed.get(f"/api/projects/{project_id}")
    assert response.status_code == 422
    assert response.json()["detail"] == "calendar_has_no_working_days"
```

- [ ] **Step 2: Run the test and make sure it fails with a 500**

```bash
cd backend && uv run pytest tests/test_project_api.py -k no_working_days -v
```

Expected: a 500 instead of a 422 — exactly the behaviour being fixed.

- [ ] **Step 3: Introduce a separate calendar error class**

In `app/calendar.py` define `CalendarError(ValueError)` with a `code` field and raise it instead of a bare `ValueError` at both points. The route catches it and answers with a 422 carrying a machine code — the same shape as the other refusals.

- [ ] **Step 4: Run the whole suite**

```bash
cd backend && uv run pytest -q
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/calendar.py backend/app/api/project_routes.py backend/tests/
git commit -m "fix: a degenerate calendar explains itself instead of a 500"
```

---

## What this plan does not do

- Plan approval, the baseline and the threshold with a reason — plan 3 of the original decomposition, after the frontend.
- WebSocket, public links, comments, invitations, AI — plans 4–6.
- The undo endpoint. The `undo` mechanism is implemented and covered by tests but not exposed: its first consumer will be rolling back an AI batch, and it is more convenient to design the route once that scenario is known.
