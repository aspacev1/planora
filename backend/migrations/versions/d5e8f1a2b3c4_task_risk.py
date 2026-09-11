"""task risk

tasks.risk — the assignee's own assessment of "am I going to make the deadline"
(green | yellow | red), and tasks.risk_note — a one-line reason. The list of values
is held by a CHECK by the same technique as ck_tasks_status: a second write path
must not be able to store a flag the mutation layer would not have accepted.

There is no backfill: every existing task is "on plan", and that is exactly the
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
    # The server_default gives the value to the existing rows at the moment of ADD
    # COLUMN and stays in the schema: a NOT NULL with no default would break every
    # INSERT around the ORM.
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
