"""Палитра и меры выгруженного документа.

Значения сняты числами с `frontend/src/northstar-theme.css` и
`frontend/src/gantt/gantt.css`: документ обязан читаться продолжением экрана, а
не соседним продуктом. Ссылка на источник стоит у каждой группы — когда тему
перекрасят, править надо здесь же, и найти это место должно быть легко.

Правило ленты переносится дословно: **заливка означает только статус**, а
просрочка и критичность ложатся накладками поверх (комментарий в gantt.css
объясняет, почему их нельзя смешивать в одно пятно).

Цвета хранятся строками «RRGGBB» без решётки: в этом виде их принимает
openpyxl, а ReportLab получает их через `hex()` — обратное преобразование
стоило бы одного вызова в каждой из сотен точек рисования.
"""

from reportlab.lib.colors import HexColor

# --- тема продукта (northstar-theme.css) -------------------------------------

TEXT = "172033"
TEXT_MUTED = "667085"
TEXT_FAINT = "98A2B3"
BG_SUBTLE = "FBFCFE"
SURFACE = "FFFFFF"
BORDER = "E5E9F0"
BORDER_STRONG = "D8DEE9"
ACCENT = "5367E8"
ACCENT_SOFT = "EEF0FF"
OK = "29A36A"
OK_SOFT = "E9F8F0"
WARN = "E69A2D"
WARN_SOFT = "FFF6E7"
DANGER = "D94C71"
DANGER_SOFT = "FFF0F4"
DANGER_STRONG = "BD4263"
TAG_GRAY = "F1F3F6"

#: Текст на жёлтой подложке. В теме `--warn` служит контуром и цифрой на
#: крупном кегле; на 9 pt по `--warn-soft` он не добирает контраста, поэтому
#: для текста берётся тон темнее (проверено на паре с `WARN_SOFT`).
WARN_TEXT = "B26A00"

# --- лента (gantt.css) --------------------------------------------------------

FILL_PROGRESS = "6274E7"        # --gantt-fill-progress
FILL_PROGRESS_DONE = "4358D6"   # --gantt-fill-progress-done
FILL_PLANNED = "E9EEF5"         # --gantt-fill-planned
LINE_PLANNED = "8EA0BE"         # --gantt-line-planned
TEXT_PLANNED = "40506B"         # цвет подписи на незалитой полоске
FILL_BLOCKED = "D94C71"         # --gantt-fill-blocked, светлая полоса штриховки
FILL_BLOCKED_ALT = "C83E62"     # --gantt-fill-blocked, тёмная полоса штриховки
FILL_DONE = OK
ROW_LINE = "EDF0F4"             # --gantt-row-line

#: `--nonworking` — полупрозрачный: `rgb(36 48 68 / 3.5%)`. В документе
#: прозрачности нет, поэтому берётся результат наложения на белое.
NONWORKING = "F2F4F7"

#: Призрак базового плана. Отдельным тоном от `NONWORKING`: они ложатся друг на
#: друга в выходной день, и совпадающие значения слили бы их в одно пятно.
BASELINE_GHOST = "EDF0F4"

#: Колонка сегодняшнего дня на листе Excel. На ленте PDF «сегодня» — линия, а
#: в книге линий нет, только заливка ячейки.
TODAY_CELL = "FFE4EC"

#: Стрелка связи. Светлее `BORDER_STRONG`: девятнадцать стрелок в полном
#: контрасте перечёркивают ленту и спорят с полосками за внимание.
ARROW = "C2CBDB"

#: Подложка чётной строки таблицы. Светлее `BG_SUBTLE`: чередование должно
#: только вести глаз вдоль строки, а не делить таблицу на две таблицы.
ZEBRA = "FAFBFD"

#: Заливка полоски по статусу: (заливка, контур или None, цвет подписи).
STATUS_BAR: dict[str, tuple[str, str | None, str]] = {
    "planned": (FILL_PLANNED, LINE_PLANNED, TEXT_PLANNED),
    "in_progress": (FILL_PROGRESS, None, SURFACE),
    "done": (FILL_DONE, None, SURFACE),
    "blocked": (FILL_BLOCKED, None, SURFACE),
}

#: Плашка статуса в таблице: (фон, текст). Мягкие тона темы, а не заливки
#: ленты: на строке таблицы полноцветное пятно спорит с текстом соседних ячеек.
STATUS_CHIP: dict[str, tuple[str, str]] = {
    "planned": (TAG_GRAY, TEXT_MUTED),
    "in_progress": (ACCENT_SOFT, ACCENT),
    "done": (OK_SOFT, OK),
    "blocked": (DANGER_SOFT, DANGER_STRONG),
}

#: Цвет ячейки скоркарда по состоянию метрики: (фон, текст). Ключи — значения
#: `ScorecardStatus`, все четыре. `warn` — «между целью и порогом», `risk` —
#: «хуже порога» (см. `app.scorecard.metric_status`), и путать их нельзя:
#: жёлтая неделя и красная означают разные решения.
METRIC_CELL: dict[str, tuple[str, str]] = {
    "ok": (OK_SOFT, OK),
    "warn": (WARN_SOFT, WARN_TEXT),
    "risk": (DANGER_SOFT, DANGER_STRONG),
    "no_data": (TAG_GRAY, TEXT_FAINT),
}


def metric_cell(status: str) -> tuple[str, str]:
    """Цвет ячейки скоркарда. Незнакомое состояние — как «нет данных».

    Именно функция, а не обращение по ключу: набор состояний живёт в
    `ScorecardStatus` и меняется вместе со скоркардом, а падение здесь — это
    `KeyError` посреди сборки, то есть пятисотка на весь документ из-за одной
    ячейки. Серый прочерк вместо цвета — несоразмерно меньшая беда.
    """
    return METRIC_CELL.get(status, METRIC_CELL["no_data"])


# --- шрифты -------------------------------------------------------------------

FONT = "Inter"
FONT_MEDIUM = "Inter-SemiBold"
FONT_BOLD = "Inter-Bold"

#: Имя семейства для Excel. Книгу открывают на машине получателя, где Inter
#: может не стоять вовсе, — но подставлять «Arial» заранее значило бы отдать
#: чужой шрифт и тому, у кого Inter есть. Excel сам откатится на системный.
XLSX_FONT = "Inter"


def rl(color: str) -> HexColor:
    """Цвет для ReportLab. Кэш не нужен: HexColor — разбор шести знаков."""
    return HexColor(f"#{color}")
