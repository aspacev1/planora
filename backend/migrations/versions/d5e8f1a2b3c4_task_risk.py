"""task risk

tasks.risk — самооценка исполнителя «успеваю ли к сроку» (green | yellow |
red) и tasks.risk_note — причина одной строкой. Список значений держит CHECK
тем же приёмом, что ck_tasks_status: второй путь записи не должен уметь
положить флаг, которого слой мутаций не принял бы.

Заполнения нет: все существующие задачи — «по плану», это и есть
server_default.

Revision ID: d5e8f1a2b3c4
Revises: c4d8e2f1a9b7
Create Date: 2026-09-07 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e8f1a2b3c4'
down_revision: Union[str, Sequence[str], None] = 'c4d8e2f1a9b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # server_default отдаёт значение существующим строкам в момент ADD COLUMN
    # и остаётся в схеме: NOT NULL без значения по умолчанию ломал бы всякий
    # INSERT мимо ORM.
    op.add_column(
        'tasks',
        sa.Column('risk', sa.String(length=8), nullable=False, server_default=sa.text("'green'")),
    )
    op.add_column(
        'tasks',
        sa.Column('risk_note', sa.String(length=300), nullable=False, server_default=sa.text("''")),
    )
    op.create_check_constraint(
        'ck_tasks_risk', 'tasks', "risk IN ('green', 'yellow', 'red')"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_tasks_risk', 'tasks', type_='check')
    op.drop_column('tasks', 'risk_note')
    op.drop_column('tasks', 'risk')
