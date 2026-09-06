"""Гонка двух переносов сметы в план.

Перенос обязан не удваивать план и при двух одновременных нажатиях из двух
вкладок. Замок строки проекта, который держит apply_op, сам по себе этого не
даёт: если строки сметы прочитаны до замка, обе стороны видят пустые ссылки
на задачи, обе проходят проверку «уже в плане», и вторая, дождавшись замка,
заводит каждую задачу второй раз. Поэтому push_to_plan берёт замок до чтения
строк, а этот тест держит замок незакоммиченным первым переносом и проверяет,
что второй ждёт, а дождавшись — не находит, что переносить.

Работает на собственных сессиях с настоящими коммитами: замок строки виден
только между разными транзакциями. Слаг уникален в базе, поэтому свой, а
уборка — в finally, чтобы не оставить мусор соседям (тот же приём, что у
теста двух одновременных отмен в test_wave1_integrity.py).
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
        # Первый перенос: замок взят, транзакция открыта — как будто запрос
        # ещё выполняется.
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
        # Соперник обязан стоять на замке, пока первая транзакция не закрыта.
        rival.join(timeout=0.5)
        assert rival.is_alive(), "второй перенос не ждал замок проекта"

        first.commit()
        rival.join(timeout=10)
        assert not rival.is_alive()

        # Дождавшись замка, второй перенос видит ссылки первого: переносить
        # нечего, и он отказывает кодом, а не заводит задачи второй раз.
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
