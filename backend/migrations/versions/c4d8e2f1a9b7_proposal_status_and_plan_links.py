"""proposal status and plan links

Этап предложения (черновик → отправлено → согласовано) с отметками времени и
ссылка строки сметы на задачу плана: по ней перенос пропускает уже
перенесённое и больше не удваивает план. created_at у строки — для подсказок
ролей по свежести.

Revision ID: c4d8e2f1a9b7
Revises: a1b2c3d4e5f6
Create Date: 2026-09-03 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c4d8e2f1a9b7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # server_default закрывает уже существующие строки: колонка NOT NULL без
    # значения по умолчанию не добавляется к непустой таблице вовсе.
    op.add_column(
        'proposals',
        sa.Column('status', sa.Text(), server_default=sa.text("'draft'"), nullable=False),
    )
    op.add_column('proposals', sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('proposals', sa.Column('agreed_at', sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        'ck_proposals_status', 'proposals', "status IN ('draft', 'sent', 'agreed')"
    )
    op.add_column('proposal_tasks', sa.Column('plan_task_id', sa.UUID(), nullable=True))
    # clock_timestamp(), а не now(): строки одной транзакции обязаны
    # различаться по времени (см. ProposalTask.created_at).
    op.add_column(
        'proposal_tasks',
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('clock_timestamp()'),
            nullable=False,
        ),
    )
    op.create_foreign_key(
        'proposal_tasks_plan_task_id_fkey',
        'proposal_tasks',
        'tasks',
        ['plan_task_id'],
        ['id'],
        ondelete='SET NULL',
    )
    op.create_index(
        op.f('ix_proposal_tasks_plan_task_id'), 'proposal_tasks', ['plan_task_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_proposal_tasks_plan_task_id'), table_name='proposal_tasks')
    op.drop_constraint('proposal_tasks_plan_task_id_fkey', 'proposal_tasks', type_='foreignkey')
    op.drop_column('proposal_tasks', 'created_at')
    op.drop_column('proposal_tasks', 'plan_task_id')
    op.drop_constraint('ck_proposals_status', 'proposals', type_='check')
    op.drop_column('proposals', 'agreed_at')
    op.drop_column('proposals', 'sent_at')
    op.drop_column('proposals', 'status')
