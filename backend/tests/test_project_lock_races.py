"""Races on the project's row lock: whoever waited on it must see the winner's state.

The lock alone was not enough. The route's dependency loads `project` before the
lock, and a bare `SELECT id ... FOR UPDATE` left that copy as it was — so the
waiter computed from a state the lock holder had just changed: two simultaneous
approvals both wrote version 1 (a unique violation and a 500), and two first
readers of the scorecard both seeded the same metrics (the same 500).

The tests work on sessions of their own with real commits: a row lock is visible
only between different transactions. Each uses its own slug and cleans up in a
finally, as in test_wave1_integrity.
"""

import threading
import uuid
from collections.abc import Callable, Iterator

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession, sessionmaker

from app.models import Organization, PlanVersion, Project, ScorecardMetric
from app.plans import approve_plan
from app.projects import lock_project
from app.scorecard import METRICS, ensure_metrics


@pytest.fixture
def committed_project(engine) -> Iterator[tuple[Callable[[], DbSession], uuid.UUID]]:
    """A committed organization and project, and a factory of independent sessions."""
    make_session = sessionmaker(bind=engine)
    marker = uuid.uuid4().hex[:8]
    setup = make_session()
    org = Organization(name="Race", slug=f"race-{marker}")
    setup.add(org)
    setup.flush()
    project = Project(org_id=org.id, name="Race", slug=f"race-{marker}")
    setup.add(project)
    setup.flush()
    org_id, project_id = org.id, project.id
    setup.commit()
    setup.close()
    try:
        yield make_session, project_id
    finally:
        cleanup = make_session()
        cleanup.delete(cleanup.get(Organization, org_id))
        cleanup.commit()
        cleanup.close()


def _race(first: DbSession, second: DbSession, action: Callable[[DbSession], object]) -> dict:
    """`action` in `second` while `first` holds the lock uncommitted; then `first` commits.

    Returns what the rival got — its result or its exception — once it is done.
    """
    outcome: dict[str, object] = {}

    def rival() -> None:
        try:
            outcome["result"] = action(second)
            second.commit()
        except Exception as error:  # the assertion is on the kind of failure
            outcome["error"] = error
            second.rollback()

    thread = threading.Thread(target=rival)
    thread.start()
    thread.join(timeout=0.5)
    assert thread.is_alive(), "the rival did not wait for the project lock"
    first.commit()
    thread.join(timeout=10)
    assert not thread.is_alive()
    return outcome


def test_two_simultaneous_approvals_get_consecutive_versions(committed_project):
    make_session, project_id = committed_project
    first, second = make_session(), make_session()
    try:
        # Both requests have loaded the project before either took the lock — the
        # way project_context loads it.
        project_one = first.get(Project, project_id)
        project_two = second.get(Project, project_id)
        assert project_one.plan_version == project_two.plan_version == 0

        assert approve_plan(first, project_one, actor_id=None).version == 1
        outcome = _race(
            first,
            second,
            lambda session: approve_plan(session, project_two, actor_id=None).version,
        )

        assert "error" not in outcome, outcome.get("error")
        assert outcome["result"] == 2
        check = make_session()
        try:
            versions = check.scalars(
                select(PlanVersion.version)
                .where(PlanVersion.project_id == project_id)
                .order_by(PlanVersion.version)
            ).all()
            assert versions == [1, 2]
            assert check.get(Project, project_id).plan_version == 2
        finally:
            check.close()
    finally:
        first.rollback()
        first.close()
        second.close()


def test_the_lock_reloads_settings_changed_by_the_previous_holder(committed_project):
    """What a mutation reads off `project` under the lock (the shift threshold, the
    calendar) is the committed state, not the copy loaded before the wait."""
    make_session, project_id = committed_project
    first, second = make_session(), make_session()
    try:
        stale = second.get(Project, project_id)
        assert stale.shift_threshold_days is None

        editor = first.get(Project, project_id)
        lock_project(first, editor)
        editor.shift_threshold_days = 9
        def lock_and_read(session: DbSession) -> int | None:
            lock_project(session, stale)
            # Read before the rival's commit: a commit expires every attribute and
            # would hide a stale copy behind a fresh load.
            return stale.shift_threshold_days

        outcome = _race(first, second, lock_and_read)

        assert outcome["result"] == 9
    finally:
        first.rollback()
        first.close()
        second.close()


def test_two_first_scorecard_readers_seed_the_metrics_once(committed_project):
    make_session, project_id = committed_project
    first, second = make_session(), make_session()
    try:
        project_one = first.get(Project, project_id)
        project_two = second.get(Project, project_id)

        # The first reader has seeded and still holds the lock, uncommitted.
        assert len(ensure_metrics(first, project_one)) == len(METRICS)
        outcome = _race(
            first, second, lambda session: len(ensure_metrics(session, project_two))
        )

        assert "error" not in outcome, outcome.get("error")
        assert outcome["result"] == len(METRICS)
        check = make_session()
        try:
            seeded = check.scalar(
                select(func.count())
                .select_from(ScorecardMetric)
                .where(ScorecardMetric.project_id == project_id)
            )
            assert seeded == len(METRICS)
        finally:
            check.close()
    finally:
        first.rollback()
        first.close()
        second.close()


def test_a_seeded_scorecard_is_read_without_the_lock(committed_project):
    """Only seeding locks: once the metrics exist, a reader must not queue behind a
    mutation holding the project's row."""
    make_session, project_id = committed_project
    setup = make_session()
    ensure_metrics(setup, setup.get(Project, project_id))
    setup.commit()
    setup.close()

    holder, reader = make_session(), make_session()
    try:
        lock_project(holder, holder.get(Project, project_id))
        done = threading.Event()

        def read() -> None:
            ensure_metrics(reader, reader.get(Project, project_id))
            done.set()

        thread = threading.Thread(target=read)
        thread.start()
        assert done.wait(timeout=5), "a plain read waited for the project lock"
        thread.join()
    finally:
        holder.rollback()
        holder.close()
        reader.rollback()
        reader.close()
