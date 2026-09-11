"""task milestone

tasks.milestone — the milestone flag: a point on the scale instead of a segment. A
stage handover, a sign-off, a contractor's deadline — something that happens on a
day rather than lasting.

No separate table is created: a milestone has the same name, category, status,
assignees, comments and dependencies as a task, and a second entity would mean a
second set of operations, a second journal and a second undo for the sake of one
difference in rendering.

A milestone's duration stays stored and equal to one day — that is held by a CHECK.
The finish-date computation, the plan snapshots and the shift threshold all ask
every task for its duration alike, and a nullable column would add an "and what if
it is a milestone" branch to each of them.

No live milestones existed before this column, so there is nothing to backfill over
the table: server_default false gives the value to the existing rows at the moment
of ADD COLUMN, and the constraint holds on them trivially.

Revision ID: f2a71c9d4b3e
Revises: e8b3d6a1c4f7
Create Date: 2026-08-15 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2a71c9d4b3e'
down_revision: Union[str, Sequence[str], None] = 'e8b3d6a1c4f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # The server_default stays in the schema rather than being dropped after the
    # backfill: a NOT NULL with no default would break every INSERT around the ORM —
    # by the same reasoning as with tasks.status.
    op.add_column(
        'tasks',
        sa.Column('milestone', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )
    op.create_check_constraint(
        'ck_tasks_milestone_duration', 'tasks', 'NOT milestone OR duration_days = 1'
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_tasks_milestone_duration', 'tasks', type_='check')
    op.drop_column('tasks', 'milestone')
