"""verification sent and used

Two marks on an address confirmation row: when the message went out and when the
link was used.

`sent_at` separates sending from issuing the token: the pause between messages is
counted from the message, while a token is issued even when the mail server is
unreachable — without this column an undelivered message locked the "send again"
button.

`used_at` replaces deleting the row on redemption: a link from an email is followed
twice (a mail scanner, then a person), and a deleted row answered the second visit
"this link does not fit" instead of "the address is already confirmed".

Both are empty on existing rows, and that is correct: about links already issued it
is known neither when a message went out nor whether they were redeemed. An empty
`sent_at` means "there is no pause" — the worst that can happen is one extra
message to whoever registered in the minute the migration was applied.

Revision ID: e3c9a5d17b42
Revises: b8d1e5f30a72
Create Date: 2026-08-16 10:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3c9a5d17b42'
down_revision: Union[str, Sequence[str], None] = 'b8d1e5f30a72'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'email_verifications',
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'email_verifications',
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('email_verifications', 'used_at')
    op.drop_column('email_verifications', 'sent_at')
