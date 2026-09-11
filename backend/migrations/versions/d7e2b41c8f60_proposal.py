"""proposal

A project's commercial proposal: the budget's settings, sections, rows and remarks
on rows. A budget lives before the plan and without the plan — in tables of its own
rather than in task fields: a draft of a deal must not be visible on the chart.

Revision ID: d7e2b41c8f60
Revises: a3f9c25e71b0
Create Date: 2026-08-16 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd7e2b41c8f60'
down_revision: Union[str, Sequence[str], None] = 'a3f9c25e71b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('proposals',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('effort_unit', sa.Text(), server_default=sa.text("'days'"), nullable=False),
    sa.Column('hours_per_day', sa.Integer(), server_default=sa.text('8'), nullable=False),
    sa.Column('tax_rate_pct', sa.Numeric(precision=5, scale=2), server_default=sa.text('0'), nullable=False),
    sa.Column('currency', sa.String(length=3), server_default=sa.text("'USD'"), nullable=False),
    sa.CheckConstraint("effort_unit IN ('days', 'hours')", name='ck_proposals_effort_unit'),
    sa.CheckConstraint('hours_per_day >= 1', name='ck_proposals_hours_per_day'),
    sa.CheckConstraint('tax_rate_pct >= 0', name='ck_proposals_tax_rate_pct'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id')
    )
    op.create_table('proposal_categories',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('proposal_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['proposal_id'], ['proposals.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_proposal_categories_proposal_id'), 'proposal_categories', ['proposal_id'], unique=False)
    op.create_table('proposal_tasks',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('proposal_id', sa.UUID(), nullable=False),
    sa.Column('category_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('details', sa.Text(), nullable=False),
    sa.Column('role', sa.String(length=120), nullable=False),
    sa.Column('effort', sa.Numeric(precision=8, scale=2), server_default=sa.text('0'), nullable=False),
    sa.Column('rate', sa.Numeric(precision=12, scale=2), server_default=sa.text('0'), nullable=False),
    sa.Column('notes', sa.Text(), nullable=False),
    sa.Column('risks', sa.Text(), nullable=False),
    sa.Column('assumptions', sa.Text(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.CheckConstraint('effort >= 0', name='ck_proposal_tasks_effort'),
    sa.CheckConstraint('rate >= 0', name='ck_proposal_tasks_rate'),
    sa.ForeignKeyConstraint(['category_id'], ['proposal_categories.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['proposal_id'], ['proposals.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_proposal_tasks_category_id'), 'proposal_tasks', ['category_id'], unique=False)
    op.create_index(op.f('ix_proposal_tasks_proposal_id'), 'proposal_tasks', ['proposal_id'], unique=False)
    op.create_table('proposal_comments',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('proposal_task_id', sa.UUID(), nullable=False),
    sa.Column('author_user_id', sa.UUID(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('clock_timestamp()'), nullable=False),
    sa.ForeignKeyConstraint(['author_user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['proposal_task_id'], ['proposal_tasks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_proposal_comments_proposal_task_id'), 'proposal_comments', ['proposal_task_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_proposal_comments_proposal_task_id'), table_name='proposal_comments')
    op.drop_table('proposal_comments')
    op.drop_index(op.f('ix_proposal_tasks_proposal_id'), table_name='proposal_tasks')
    op.drop_index(op.f('ix_proposal_tasks_category_id'), table_name='proposal_tasks')
    op.drop_table('proposal_tasks')
    op.drop_index(op.f('ix_proposal_categories_proposal_id'), table_name='proposal_categories')
    op.drop_table('proposal_categories')
    op.drop_table('proposals')
