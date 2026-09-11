"""proposal notes and category description

Two fields the budget was missing per the mockup: the proposal's notes as a whole
("estimates for the current scope", "rates exclude licence costs") and a
description line for a section, standing on its row in the table next to the
summary of its works.

As a separate revision rather than an edit to d7e2b41c8f60: that one is already
applied — amending an applied migration means leaving an installation without the
new columns forever, because alembic considers its revision passed and does not run
it a second time.

Revision ID: b8d1e5f30a72
Revises: d7e2b41c8f60
Create Date: 2026-08-16 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b8d1e5f30a72'
down_revision: Union[str, Sequence[str], None] = 'd7e2b41c8f60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # The server_default covers the rows that already exist: a NOT NULL column with
    # no default is not added to a non-empty table at all.
    op.add_column(
        'proposals',
        sa.Column('notes', sa.Text(), server_default=sa.text("''"), nullable=False),
    )
    op.add_column(
        'proposal_categories',
        sa.Column('description', sa.Text(), server_default=sa.text("''"), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('proposal_categories', 'description')
    op.drop_column('proposals', 'notes')
