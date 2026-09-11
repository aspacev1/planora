"""scorecard signal cleanup

The scorecard moves from 8 metrics to 7. Three are removed: avg_overdue_days (a
second view of overdue — rolled into overdue_tasks), daily_health (there is no
daily module, and the metric was always no_data) and unassigned_tasks (those same
tasks were already dragging data_quality down — a double signal about one trouble;
"no assignee" stays as a reason in the quality checklist). finish_drift and
scope_growth take their place.

The schema does not change — metric_key is an ordinary String(40). The migration
is purely about data:

- The configs of the removed metrics are deleted: otherwise ensure_metrics would
  keep them forever as dead weight, and their position would collide with the new
  metrics.
- Open events of the removed metrics are closed (resolved_at = now()): nobody
  would close them — _update_alerts walks only the current configs. They are not
  deleted: events are a chronicle too.
- The positions of the remaining configs are renumbered for the new METRICS order,
  so that finish_drift/scope_growth stand between overdue and date_shifts rather
  than at the tail.

The snapshots (scorecard_snapshots) of the removed metrics are deliberately left
alone: they are an immutable chronicle, and nothing reads them anymore (assembling
the state walks only the current configs). Let them lie as history rather than be
rewritten.

Revision ID: a1b2c3d4e5f6
Revises: 12c30f757a97
Create Date: 2026-08-29 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '12c30f757a97'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_REMOVED = ("avg_overdue_days", "daily_health", "unassigned_tasks")

#: The new order of metrics — a mirror of METRICS in app/scorecard.py.
_POSITIONS = {
    "overdue_tasks": 0,
    "finish_drift": 1,
    "scope_growth": 2,
    "date_shifts": 3,
    "close_rate": 4,
    "stale_in_progress": 5,
    "data_quality": 6,
}


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        UPDATE scorecard_alerts
        SET resolved_at = now()
        WHERE resolved_at IS NULL
          AND metric_key IN ('avg_overdue_days', 'daily_health', 'unassigned_tasks')
        """
    )
    op.execute(
        """
        DELETE FROM scorecard_metrics
        WHERE metric_key IN ('avg_overdue_days', 'daily_health', 'unassigned_tasks')
        """
    )
    # Positions for the new order. ensure_metrics will seed finish_drift and
    # scope_growth straight into their places the first time the scorecard is opened.
    case = " ".join(
        f"WHEN '{key}' THEN {position}" for key, position in _POSITIONS.items()
    )
    op.execute(
        f"""
        UPDATE scorecard_metrics
        SET position = CASE metric_key {case} ELSE position END
        WHERE metric_key IN ({", ".join(f"'{k}'" for k in _POSITIONS)})
        """
    )


def downgrade() -> None:
    """Downgrade schema.

    Nothing is restored: through ensure_metrics the old code will lazily re-seed
    the removed configs with defaults the first time the scorecard is opened, while
    the closed events stay closed — a chronicle is not rewritten backwards. The old
    code will also realign the positions itself to its own METRICS order.
    """
    pass
