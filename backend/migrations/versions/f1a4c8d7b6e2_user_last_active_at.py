"""user last active at

users.last_active_at — the moment of this person's last activity: of the last
request with a valid session of theirs. A separate field rather than something
derived from Session.last_used_at: session rows are swept away (sign-out, expiry, a
week of idleness with no requests — see app.auth), and an aggregate over them goes
blind precisely when activity is asked about after a long break. It feeds the
installation owner's panel (/api/admin/users): who is registered and when they last
used the product.

Nullable with no default: accounts already created that have made no request since
the migration show no activity yet — the same state a freshly created account is
born in.

Revision ID: f1a4c8d7b6e2
Revises: c1d4a8f6e293
Create Date: 2026-08-18 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a4c8d7b6e2'
down_revision: Union[str, Sequence[str], None] = 'c1d4a8f6e293'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('last_active_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'last_active_at')
