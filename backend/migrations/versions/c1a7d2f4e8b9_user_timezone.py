"""user timezone

users.timezone — the reader's timezone, by which the interface counts today.
Nullable with no default: `null` means "ask the browser", and that is the state of
every account already created. A copy of the organization's timezone here would be
worse than emptiness — it would look like a deliberate choice by the person and
would outlive an edit to the organization's default.

Revision ID: c1a7d2f4e8b9
Revises: b7c4e1f0a9d3
Create Date: 2026-08-15 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1a7d2f4e8b9'
down_revision: Union[str, Sequence[str], None] = 'b7c4e1f0a9d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('timezone', sa.String(length=64), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'timezone')
