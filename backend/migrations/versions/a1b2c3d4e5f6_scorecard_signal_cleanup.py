"""scorecard signal cleanup

Скоркард переезжает с 8 метрик на 7. Убираются три: avg_overdue_days (второй
ракурс просрочки — вкатан в overdue_tasks), daily_health (модуля дейли не
существует, метрика всегда была no_data) и unassigned_tasks (те же задачи уже
роняли data_quality — двойной сигнал об одной беде; «нет исполнителя» остаётся
причиной в чек-листе качества). На их место встают finish_drift и scope_growth.

Схема не меняется — metric_key это обычный String(40). Миграция чисто по
данным:

- Конфиги снятых метрик удаляются: иначе ensure_metrics прятал бы их вечно как
  мёртвый груз, а их position коллизила бы с новыми метриками.
- Открытые события снятых метрик закрываются (resolved_at = now()): их бы не
  закрыл никто — _update_alerts ходит только по текущим конфигам. Не удаляются:
  события — тоже летопись.
- Позиции оставшихся конфигов перенумеровываются под новый порядок METRICS,
  чтобы finish_drift/scope_growth встали между overdue и date_shifts, а не в
  хвост.

Снимки (scorecard_snapshots) снятых метрик намеренно не трогаются: это
неизменяемая летопись, и ничто их больше не читает (сборка состояния ходит
только по текущим конфигам). Пусть лежат как история, а не переписываются.

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

#: Новый порядок метрик — зеркало METRICS в app/scorecard.py.
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
    # Позиции — под новый порядок. ensure_metrics досеет finish_drift и
    # scope_growth уже на их места при первом же открытии скоркарда.
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

    Ничего не восстанавливается: старый код через ensure_metrics лениво пересеет
    снятые конфиги дефолтами при первом открытии, а закрытые события остаются
    закрытыми — летопись не переписывается назад. Позиции старый код тоже
    выровняет сам под свой порядок METRICS.
    """
    pass
