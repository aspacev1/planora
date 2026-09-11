"""password reset tokens

The table of single-use password recovery links — by the same technique as
email_verifications: the plain token goes outward while its hash lies here. A
separate table rather than one shared with address confirmation: a recovery link
opens an account, its lifetime is noticeably shorter, and these two kinds of key
must not be confused even at the level of the schema.

ondelete=CASCADE — deleting a user carries away their unused links; the index on
user_id is needed by redemption and by the protection against resending, both of
which look up by owner.

Revision ID: c9d2f6b8a154
Revises: c1a7d2f4e8b9
Create Date: 2026-08-15 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d2f6b8a154'
down_revision: Union[str, Sequence[str], None] = 'c1a7d2f4e8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('password_resets',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('token_hash', sa.String(length=128), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index(op.f('ix_password_resets_user_id'), 'password_resets', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_password_resets_user_id'), table_name='password_resets')
    op.drop_table('password_resets')
