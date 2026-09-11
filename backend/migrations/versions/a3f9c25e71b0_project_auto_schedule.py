"""project auto schedule

projects.auto_schedule — automatic shifting along dependencies: a successor does
not start before its predecessor has finished (see app/cascade.py).

Off by default, and that is not caution for caution's sake: before this column a
dependency moved nothing at all — it was a picture, and the only behaviour derived
from dependencies was a suggestion to move a task by hand. Enabling automatic
shifting changes the meaning of every dependency in the project at once, and that
must happen by a person's decision rather than when a migration is applied.

A property of the project rather than of the organization: in one project the plan
is driven by the chain and in the next one by hand, and a shared setting would
force one choice on everyone.

Revision ID: a3f9c25e71b0
Revises: f2a71c9d4b3e
Create Date: 2026-08-16 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f9c25e71b0'
down_revision: Union[str, Sequence[str], None] = 'f2a71c9d4b3e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # The server_default stays in the schema rather than being dropped after the
    # backfill: a NOT NULL with no default would break every INSERT around the ORM —
    # by the same reasoning as with tasks.status.
    op.add_column(
        'projects',
        sa.Column('auto_schedule', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('projects', 'auto_schedule')
