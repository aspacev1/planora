"""Сколько ленты влезает на страницу — и какой масштаб выбрать, чтобы влезло.

Полоски в выгрузке не сжимаются ни при каком масштабе: вместо этого лента
режется по времени и колонка названий повторяется на каждой странице. Значит
цена подробности измеряется не читаемостью, а числом страниц — и ограничивать
надо именно его.

Модуль спрашивают трое: рисовальщик PDF (сколько окон резать), рисовальщик
XLSX (сколько колонок городить) и маршрут (не отказать ли до начала работы).
Поэтому правило живёт здесь, а не внутри одного из них.

Тот же расчёт повторён на клиенте (`frontend/src/export/pageBudget.ts`) —
намеренно, а не по недосмотру: окно обязано написать на кнопке масштаба то
самое число страниц, которое вернёт сервер, и спрашивать его запросом на
каждое нажатие значило бы моргающие кнопки. Тесты по обе стороны сверяют одну
таблицу ожиданий.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum

from app.export.errors import ExportError

# Ничего из `app.models` / `app.schedule` здесь не импортируется намеренно:
# те тянут за собой `app.db`, а он поднимает движок и требует настроенного
# окружения ещё на импорте (так задумано, см. app/config.py). Модуль с самой
# густой арифметикой во всей выгрузке должен проверяться без Postgres.


class Zoom(StrEnum):
    """Единица колонки шкалы. Те же три значения, что у ленты на экране."""

    DAY = "day"
    WEEK = "week"
    MONTH = "month"


class Period(StrEnum):
    """Окно ленты. Три последних привязаны к «сегодня»."""

    ALL = "all"
    NEXT_4W = "next_4w"
    NEXT_3M = "next_3m"
    FROM_TODAY = "from_today"


class Orientation(StrEnum):
    LANDSCAPE = "landscape"
    PORTRAIT = "portrait"


ZOOMS: tuple[Zoom, ...] = (Zoom.DAY, Zoom.WEEK, Zoom.MONTH)

#: Периоды, у которых нет смысла без настоящих дат: у относительного плана ось
#: — «День N», и «сегодня» на ней не определено.
DATED_PERIODS: frozenset[Period] = frozenset(
    {Period.NEXT_4W, Period.NEXT_3M, Period.FROM_TODAY}
)

#: Дней в единице колонки. «Месяц» здесь ровно 30 дней, а не календарный:
#: ёмкость страницы — оценка, а не разметка, и календарная арифметика в ней
#: дала бы разное число страниц у проекта, сдвинутого на неделю.
DAYS_PER_UNIT: dict[Zoom, int] = {Zoom.DAY: 1, Zoom.WEEK: 7, Zoom.MONTH: 30}

#: Ширина колонки в пунктах — минимум, при котором подпись шкалы читается.
#: Меньше нельзя: день перестанет нести число, месяц — название.
UNIT_WIDTH_PT: dict[Zoom, float] = {Zoom.DAY: 8.0, Zoom.WEEK: 20.0, Zoom.MONTH: 40.0}

#: Ширина страницы за вычетом полей, в пунктах (A4, поля 14 мм с каждой
#: стороны). Значения зашиты, а не считаются из reportlab.lib.pagesizes,
#: чтобы модуль оставался пригодным для клиента как эталон.
PAGE_WIDTH_PT: dict[Orientation, float] = {
    Orientation.LANDSCAPE: 841.89,
    Orientation.PORTRAIT: 595.28,
}
MARGIN_PT = 39.69  # 14 мм
LABEL_COLUMN_PT = 168.0

#: Сколько страниц ленты считается приличным умолчанием. Самый подробный
#: масштаб, укладывающийся в это число, и становится выбором по умолчанию.
COMFORTABLE_PAGES = 2

#: Потолок. Сверх него масштаб не предлагается и не принимается: файл на
#: полтора десятка страниц ленты никто не читает, а собирается он долго.
MAX_PAGES = 6

#: Потолок листа Excel в колонках. Лист ленты на страницы не режется — он одна
#: широкая полоса, и предел ставится по числу колонок: дальше по нему
#: невозможно двигаться.
MAX_XLSX_COLUMNS = 400


def units_per_page(zoom: Zoom, orientation: Orientation) -> int:
    """Сколько колонок шкалы влезает на страницу."""
    chart = PAGE_WIDTH_PT[orientation] - 2 * MARGIN_PT - LABEL_COLUMN_PT
    return max(1, int(chart // UNIT_WIDTH_PT[zoom]))


def days_per_page(zoom: Zoom, orientation: Orientation) -> int:
    return units_per_page(zoom, orientation) * DAYS_PER_UNIT[zoom]


def page_count(days: int, zoom: Zoom, orientation: Orientation) -> int:
    """Число страниц ленты для окна такой длины. Пустой проект — одна страница
    с шапкой, а не ноль: страницу всё равно надо чем-то занять."""
    if days <= 0:
        return 1
    per_page = days_per_page(zoom, orientation)
    return -(-days // per_page)  # деление вверх


def columns_for(days: int, zoom: Zoom) -> int:
    """Число колонок листа Excel для окна такой длины."""
    if days <= 0:
        return 1
    return -(-days // DAYS_PER_UNIT[zoom])


@dataclass(frozen=True)
class ZoomOption:
    """Один масштаб с его ценой — ровно то, что окно пишет на кнопке."""

    zoom: Zoom
    pages: int
    #: Доступен ли. Недоступный не отказ, а объяснённая невозможность: окно
    #: показывает и его, с числом страниц, чтобы человек понял, чего стоит
    #: подробность, а не гадал, куда делась кнопка.
    allowed: bool


def allowed(zoom: Zoom, days: int, orientation: Orientation) -> bool:
    """Укладывается ли масштаб в потолок.

    Самый крупный масштаб разрешён всегда, сколько бы страниц ни вышло:
    потолок существует, чтобы человек не выбрал ненужную подробность, а у
    месяца менее подробного соседа нет. Отказать на нём значило бы, что
    десятилетний портфель не выгружается вовсе — а это уже не защита от
    неподъёмного файла, а отсутствие возможности.
    """
    if zoom is ZOOMS[-1]:
        return True
    return page_count(days, zoom, orientation) <= MAX_PAGES


def zoom_options(days: int, orientation: Orientation) -> list[ZoomOption]:
    return [
        ZoomOption(zoom, page_count(days, zoom, orientation), allowed(zoom, days, orientation))
        for zoom in ZOOMS
    ]


def default_zoom(days: int, orientation: Orientation) -> Zoom:
    """Самый подробный масштаб, укладывающийся в приличное число страниц.

    Если не укладывается ни один — самый крупный: месяц на любом мыслимом
    проекте даёт единицы страниц, и отдать вместо файла отказ было бы
    неуважением к тому, кто просто нажал «Скачать».
    """
    for zoom in ZOOMS:
        if page_count(days, zoom, orientation) <= COMFORTABLE_PAGES:
            return zoom
    return ZOOMS[-1]


def default_zoom_for_xlsx(days: int) -> Zoom:
    """То же для книги, где предел — колонки, а не страницы."""
    for zoom in ZOOMS:
        if columns_for(days, zoom) <= MAX_XLSX_COLUMNS:
            return zoom
    return ZOOMS[-1]


@dataclass(frozen=True)
class Window:
    """Окно ленты: границы и сколько в нём дней."""

    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def project_window(starts: list[date], ends: list[date], *, fallback: date) -> Window:
    """Границы всего проекта.

    `fallback` — начало оси у проекта без задач: рисовать нечего, но шкала
    обязана существовать, иначе делить будет не на что. Значение передаёт
    вызывающий (`RELATIVE_EPOCH` или назначенный старт), а не берёт этот
    модуль: за ним пришлось бы тянуть сюда `app.schedule` со всей базой.
    """
    if not starts or not ends:
        return Window(fallback, fallback)
    return Window(min(starts), max(ends))


def resolve_window(period: Period, whole: Window, today: date, *, dated: bool) -> Window:
    """Окно по выбранному периоду.

    `dated=False` — относительный план: «сегодня» на его оси не существует, и
    три привязанных к сегодня периода здесь не отказ по вкусу, а отсутствие
    величины, от которой их считать.
    """
    if period in DATED_PERIODS and not dated:
        raise ExportError(
            "export_period_undated",
            f"период {period} требует дат, а план проекта относительный",
        )

    if period is Period.ALL:
        return whole

    start = max(today, whole.start)
    if period is Period.FROM_TODAY:
        end = whole.end
    elif period is Period.NEXT_4W:
        end = start + timedelta(days=27)
    else:
        end = start + timedelta(days=89)

    # Окно не выходит за пределы проекта: пустой хвост шкалы за последней
    # задачей — это страница, на которой ничего нет.
    end = min(end, whole.end)
    if end < start:
        # Проект целиком в прошлом: показываем его конец, а не пустоту.
        return Window(whole.end, whole.end)
    return Window(start, end)


def slice_window(window: Window, zoom: Zoom, orientation: Orientation) -> list[Window]:
    """Разбиение окна на страницы по времени."""
    step = days_per_page(zoom, orientation)
    out: list[Window] = []
    cursor = window.start
    while cursor <= window.end:
        last = min(cursor + timedelta(days=step - 1), window.end)
        out.append(Window(cursor, last))
        cursor = last + timedelta(days=1)
    return out or [window]


def require_within_budget(window: Window, zoom: Zoom, orientation: Orientation) -> None:
    """Отказ до начала работы, а не файл на сорок страниц после неё.

    Проверка повторяет ту, что делает окно. Повтор здесь не избыточность:
    маршрут зовут и мимо окна — закладкой, скриптом, публичной ссылкой.
    """
    if not allowed(zoom, window.days, orientation):
        pages = page_count(window.days, zoom, orientation)
        raise ExportError(
            "export_scale_too_wide",
            f"масштаб {zoom} на окне в {window.days} дн. даёт {pages} страниц ленты",
        )


def require_within_xlsx_budget(window: Window, zoom: Zoom) -> None:
    columns = columns_for(window.days, zoom)
    if columns > MAX_XLSX_COLUMNS:
        raise ExportError(
            "export_scale_too_wide",
            f"масштаб {zoom} на окне в {window.days} дн. даёт {columns} колонок",
        )
