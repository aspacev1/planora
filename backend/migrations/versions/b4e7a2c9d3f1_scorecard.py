"""scorecard

A project's scorecard: a weekly health panel. Three tables and two timestamps on
the task.

tasks.done_at / tasks.in_progress_since — when a task became "done" and when it was
taken up. They are set and cleared by the mutation layer on a status transition;
the scorecard needs "closed this week" and "hanging in progress for N days", while
the revision journal answers those questions only by a full walk over a task's
entries. They are backfilled from the journal where possible: for tasks currently
standing in done or in_progress, the latest revision that brought them into that
status is used (set_status, or set_progress with the status coupling). Tasks whose
status was set at creation and never changed in the journal get no timestamps —
that is an accepted incompleteness of the backfill, and from there on the mutation
layer drives them.

scorecard_metrics — a metric's config per project (owner, target, enabled state);
created lazily by the first opening of the scorecard, with no organization-level
settings. scorecard_snapshots — weekly snapshots of values and statuses; past weeks
are immutable, and the current week's row is overwritten and serves as the cache of
the live computation. The target and the direction are copied into the snapshot:
editing a target today must not repaint past weeks.
scorecard_alerts — the events of the "Needs attention" panel: the current week's
risk metrics and the traces of the "red two weeks running" rule having fired.
Closed events are marked resolved_at rather than deleted: they are what suppresses
a repeat of the rule within one streak.

Revision ID: b4e7a2c9d3f1
Revises: f1a4c8d7b6e2
Create Date: 2026-08-19 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b4e7a2c9d3f1'
down_revision: Union[str, Sequence[str], None] = 'f1a4c8d7b6e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _backfill_stamp(column: str, status: str) -> str:
    # The latest revision that brought a task into a status: set_status writes the
    # status into `to`, set_progress into `status_to` (the "progress carried through
    # — done" coupling). DISTINCT ON with a descending date sort gives the freshest
    # entry per task.
    return f"""
        UPDATE tasks SET {column} = latest.at
        FROM (
            SELECT DISTINCT ON (op->>'task_id') op->>'task_id' AS task_id,
                   created_at AS at
            FROM revisions
            WHERE (op->>'type' = 'set_status' AND op->>'to' = '{status}')
               OR (op->>'type' = 'set_progress' AND op->>'status_to' = '{status}')
            ORDER BY op->>'task_id', created_at DESC
        ) AS latest
        WHERE tasks.status = '{status}' AND tasks.id::text = latest.task_id
    """


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('tasks', sa.Column('done_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        'tasks', sa.Column('in_progress_since', sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(_backfill_stamp('done_at', 'done'))
    op.execute(_backfill_stamp('in_progress_since', 'in_progress'))

    op.create_table(
        'scorecard_metrics',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('metric_key', sa.String(length=40), nullable=False),
        sa.Column('owner_user_id', sa.UUID(), nullable=True),
        sa.Column('target_value', sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column('direction', sa.String(length=3), nullable=False),
        sa.Column('warn_value', sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column('enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "direction IN ('lte', 'gte')", name='ck_scorecard_metrics_direction'
        ),
        sa.ForeignKeyConstraint(['owner_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'metric_key'),
    )
    op.create_index(
        op.f('ix_scorecard_metrics_project_id'), 'scorecard_metrics', ['project_id'],
        unique=False,
    )

    op.create_table(
        'scorecard_snapshots',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('metric_key', sa.String(length=40), nullable=False),
        sa.Column('week_start', sa.Date(), nullable=False),
        sa.Column('value', sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column('target_value', sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column('direction', sa.String(length=3), nullable=False),
        sa.Column('status', sa.String(length=8), nullable=False),
        sa.Column(
            'computed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column('computed_by', sa.UUID(), nullable=True),
        sa.Column('details', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "direction IN ('lte', 'gte')", name='ck_scorecard_snapshots_direction'
        ),
        sa.CheckConstraint(
            "status IN ('ok', 'warn', 'risk', 'no_data')",
            name='ck_scorecard_snapshots_status',
        ),
        sa.ForeignKeyConstraint(['computed_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'metric_key', 'week_start'),
    )
    op.create_index(
        op.f('ix_scorecard_snapshots_project_id'), 'scorecard_snapshots', ['project_id'],
        unique=False,
    )
    op.create_index(
        'ix_scorecard_snapshots_project_week', 'scorecard_snapshots',
        ['project_id', 'week_start'], unique=False,
    )

    op.create_table(
        'scorecard_alerts',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('metric_key', sa.String(length=40), nullable=False),
        sa.Column('week_start', sa.Date(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('rule_triggered', 'metric_risk')", name='ck_scorecard_alerts_kind'
        ),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_scorecard_alerts_project_id'), 'scorecard_alerts', ['project_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_scorecard_alerts_project_id'), table_name='scorecard_alerts')
    op.drop_table('scorecard_alerts')
    op.drop_index('ix_scorecard_snapshots_project_week', table_name='scorecard_snapshots')
    op.drop_index(op.f('ix_scorecard_snapshots_project_id'), table_name='scorecard_snapshots')
    op.drop_table('scorecard_snapshots')
    op.drop_index(op.f('ix_scorecard_metrics_project_id'), table_name='scorecard_metrics')
    op.drop_table('scorecard_metrics')
    op.drop_column('tasks', 'in_progress_since')
    op.drop_column('tasks', 'done_at')
