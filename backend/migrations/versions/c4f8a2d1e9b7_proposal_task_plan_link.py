"""proposal task plan link

Одна колонка: `proposal_tasks.plan_task_id` — задача плана, из которой строка
сметы собрана («Собрать из плана») или в которую перенесена («Добавить в
план»). Пока ссылка жива, перенос строку пропускает: иначе смета, собранная
из плана, первым же переносом удвоила бы каждую его задачу.

SET NULL при удалении задачи, а не CASCADE: строка сметы — свой черновик и
переживает удаление задачи, в том числе отмену переноса. Ссылка гаснет, и
следующий перенос заводит задачу заново. Индекс — ради самого SET NULL: без
него каждое удаление задачи перебирало бы все строки всех смет.

Revision ID: c4f8a2d1e9b7
Revises: a1b2c3d4e5f6
Create Date: 2026-09-05 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4f8a2d1e9b7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('proposal_tasks', sa.Column('plan_task_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        'proposal_tasks_plan_task_id_fkey',
        'proposal_tasks',
        'tasks',
        ['plan_task_id'],
        ['id'],
        ondelete='SET NULL',
    )
    op.create_index(
        op.f('ix_proposal_tasks_plan_task_id'), 'proposal_tasks', ['plan_task_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_proposal_tasks_plan_task_id'), table_name='proposal_tasks')
    op.drop_constraint(
        'proposal_tasks_plan_task_id_fkey', 'proposal_tasks', type_='foreignkey'
    )
    op.drop_column('proposal_tasks', 'plan_task_id')
