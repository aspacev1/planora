"""proposal task plan link

proposal_tasks.task_id — задача плана, в которую строка сметы перенесена.

Этап строки («в плане» / «переносима») не хранится, а выводится из этой
ссылки: строка в плане, пока существует задача, созданная переносом. Внешний
ключ с ON DELETE SET NULL — вся логика возврата: удаление задачи или отмена
пачки переноса стирает ссылку на стороне базы, и строка снова переносима.
Хранимый флаг пришлось бы сбрасывать в каждом из этих мест, и в одном из них
его однажды забыли бы.

Заполнять по таблице нечего: переносы до этой колонки связи не оставляли, и
их строки остаются переносимыми — как и были.

Revision ID: b7d3e9f0a1c2
Revises: a1b2c3d4e5f6
Create Date: 2026-09-06 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d3e9f0a1c2'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('proposal_tasks', sa.Column('task_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        'proposal_tasks_task_id_fkey',
        'proposal_tasks',
        'tasks',
        ['task_id'],
        ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('proposal_tasks_task_id_fkey', 'proposal_tasks', type_='foreignkey')
    op.drop_column('proposal_tasks', 'task_id')
