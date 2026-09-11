"""relative schedule mode

Separating a project's plan from calendar dates: a project gains a schedule mode
(`relative` — a preliminary plan with no dates, `calendar` — the start is assigned)
and an assigned start date.

Existing projects are marked `calendar`: their tasks already live by real dates, and
declaring them "a plan with no dates" would mean renaming the past. The
server_default meanwhile stays `relative` — that is the default mode for new
projects, which are not asked for a start date at creation.

Revision ID: e8b3d6a1c4f7
Revises: c9d2f6b8a154
Create Date: 2026-08-15 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e8b3d6a1c4f7'
down_revision: Union[str, Sequence[str], None] = 'c9d2f6b8a154'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'projects',
        sa.Column('schedule_mode', sa.Text(), server_default=sa.text("'relative'"), nullable=False),
    )
    op.add_column('projects', sa.Column('start_date', sa.Date(), nullable=True))
    # The backfill comes before the CHECK: a constraint must check rows that are
    # already correct rather than chase after them.
    op.execute("UPDATE projects SET schedule_mode = 'calendar'")
    op.create_check_constraint(
        'ck_projects_schedule_mode',
        'projects',
        "schedule_mode IN ('relative', 'calendar')",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_projects_schedule_mode', 'projects', type_='check')
    op.drop_column('projects', 'start_date')
    op.drop_column('projects', 'schedule_mode')
