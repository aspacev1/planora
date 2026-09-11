"""A race between two carry-acrosses of a budget into a plan.

A carry-across must not double the plan even on two simultaneous presses from two
tabs. The lock on the project's row that apply_op holds does not give that by
itself: if the budget's rows are read before the lock, both sides see empty
references to tasks, both pass the "already in the plan" check, and the second, once
it has waited for the lock, creates every task a second time. So push_to_plan takes
the lock before reading the rows, and this test holds the lock with an uncommitted
first carry-across and checks that the second waits, and that once it has waited it
finds nothing to carry.

It works on sessions of its own with real commits: a row lock is visible only
between different transactions. The slug is unique in the database, so it uses its
own, and the cleanup is in a finally so as not to leave litter for the neighbours
(the same technique as the test of two simultaneous undos in
test_wave1_integrity.py).
"""

import threading
import uuid
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.models import (
    Category,
    Organization,
    Project,
    Proposal,
    ProposalCategory,
    ProposalTask,
    Task,
)
from app.proposals import ProposalError, push_to_plan


def test_two_simultaneous_pushes_do_not_double_the_plan(engine):
    make_session = sessionmaker(bind=engine)
    marker = uuid.uuid4().hex[:8]
    setup = make_session()
    org = Organization(name="Race", slug=f"push-race-{marker}")
    setup.add(org)
    setup.flush()
    project = Project(org_id=org.id, name="Race", slug=f"push-race-{marker}")
    setup.add(project)
    setup.flush()
    proposal = Proposal(project_id=project.id)
    setup.add(proposal)
    setup.flush()
    section = ProposalCategory(proposal_id=proposal.id, name="Дизайн", position=0)
    setup.add(section)
    setup.flush()
    for position, name in enumerate(("Логотип", "Макет")):
        setup.add(
            ProposalTask(
                proposal_id=proposal.id,
                category_id=section.id,
                name=name,
                effort=Decimal(2),
                position=position,
            )
        )
    org_id, project_id = org.id, project.id
    setup.commit()
    setup.close()

    first = make_session()
    second = make_session()
    try:
        # The first carry-across: the lock is taken, the transaction is open — as if
        # the request were still running.
        done = push_to_plan(first, first.get(Project, project_id), None, locale="ru")
        assert done["created_tasks"] == 2

        outcome: dict[str, object] = {}

        def concurrent_push():
            try:
                outcome["result"] = push_to_plan(
                    second, second.get(Project, project_id), None, locale="ru"
                )
            except ProposalError as error:
                outcome["refused"] = error.code
            finally:
                second.commit()

        rival = threading.Thread(target=concurrent_push)
        rival.start()
        # The rival must stand at the lock until the first transaction is closed.
        rival.join(timeout=0.5)
        assert rival.is_alive(), "the second push did not wait for the project lock"

        first.commit()
        rival.join(timeout=10)
        assert not rival.is_alive()

        # Having waited for the lock, the second carry-across sees the first one's
        # references: there is nothing to carry, and it refuses with a code rather
        # than creating the tasks a second time.
        assert outcome == {"refused": "proposal_nothing_to_push"}

        check = make_session()
        try:
            tasks = check.scalar(
                select(func.count()).select_from(Task).where(Task.project_id == project_id)
            )
            categories = check.scalar(
                select(func.count())
                .select_from(Category)
                .where(Category.project_id == project_id)
            )
            linked = check.scalars(
                select(ProposalTask.plan_task_id).where(ProposalTask.plan_task_id.is_not(None))
            ).all()
        finally:
            check.close()
        assert (tasks, categories) == (2, 1)
        assert len(linked) == 2 and len(set(linked)) == 2
    finally:
        first.close()
        second.close()
        cleanup = make_session()
        cleanup.delete(cleanup.get(Organization, org_id))
        cleanup.commit()
        cleanup.close()
