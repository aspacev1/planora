"""membership project scoped

memberships.project_scoped — whether this membership sees only the projects it was
individually invited to, regardless of the role. For the `client` role and for a
link-holding guest the role itself already decides this (see `_NEEDS_GRANT` in
app.access) — the column exists for the sake of `editor` and `viewer`: an inviter
is entitled to invite an editor or a viewer into particular projects rather than
into all of the organization's projects at once.

The server_default stays in the schema rather than being dropped after the
backfill — by the same reasoning as with projects.auto_schedule: a NOT NULL with no
default would break every INSERT around the ORM. False is the obligatory choice: an
invitation with no projects selected must not by itself narrow a role that sees the
whole organization by default.

Revision ID: c1d4a8f6e293
Revises: e3c9a5d17b42
Create Date: 2026-08-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1d4a8f6e293'
down_revision: Union[str, Sequence[str], None] = 'e3c9a5d17b42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'memberships',
        sa.Column('project_scoped', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('memberships', 'project_scoped')
