"""task status

tasks.status — a task's stored status (planned | in_progress | done | blocked).
The list of values is held by a CHECK — by the same technique as
ck_tasks_criticality: a second write path (a restore from the journal,
hand-written SQL) must not be able to store a value the mutation layer would not
have accepted.

The backfill over the live table is derived from the progress: before this column
the status existed only as something derived from progress_pct, and the starting
value must match what a person already saw on the chart.

Revision ID: b7c4e1f0a9d3
Revises: 07266c100dff
Create Date: 2026-08-13 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c4e1f0a9d3'
down_revision: Union[str, Sequence[str], None] = '07266c100dff'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # The server_default gives 'planned' to the existing rows at the moment of ADD
    # COLUMN and stays in the schema: a NOT NULL with no default would break every
    # INSERT around the ORM.
    op.add_column(
        'tasks',
        sa.Column('status', sa.Text(), nullable=False, server_default=sa.text("'planned'")),
    )
    # The backfill comes before the CHECK: first every row gets a status derived
    # from its progress, and only then the constraint on the values.
    op.execute(
        "UPDATE tasks SET status = CASE"
        " WHEN progress_pct >= 100 THEN 'done'"
        " WHEN progress_pct > 0 THEN 'in_progress'"
        " ELSE 'planned' END"
    )
    op.create_check_constraint(
        'ck_tasks_status', 'tasks', "status IN ('planned', 'in_progress', 'done', 'blocked')"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_tasks_status', 'tasks', type_='check')
    op.drop_column('tasks', 'status')
