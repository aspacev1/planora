"""jira push due date

One column: `jira_task_links.pushed_due_date`. `NULL` means Jira drives the
task's dates, as before. A filled-in value means the task has been declared in
Planora as the source of truth on dates (the "Push to Jira" button, see
app/jira/sync.py:push_project), and an ordinary sync no longer pulls its start
and duration from Jira.

Revision ID: 12c30f757a97
Revises: 342f2b35de69
Create Date: 2026-08-20 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '12c30f757a97'
down_revision: Union[str, Sequence[str], None] = '342f2b35de69'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('jira_task_links', sa.Column('pushed_due_date', sa.Date(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('jira_task_links', 'pushed_due_date')
