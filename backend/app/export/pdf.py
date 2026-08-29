"""PDF-выгрузка: обложка с показателями, векторная лента, таблицы.

Лента рисуется на канве, а не таблицей: полоска, её накладки, ромб вехи и
коленчатая стрелка связи — это графика, и приблизить её таблицей значило бы
отдать документ, непохожий на экран.

Широкий проект разбивается по времени, и колонка названий повторяется на
каждой странице (`app.export.budget`). Именно это отличает документ от
обрезанного скриншота — и именно поэтому число страниц, а не читаемость,
служит мерой в правиле масштаба.
"""

import threading
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from app.export import budget, theme
from app.export.budget import Orientation, Window
from app.export.document import DocTask, ExportDocument, ExportSection

_FONTS_DIR = Path(__file__).parent / "fonts"
_FONT_FILES = {
    theme.FONT: "Inter-Regular.ttf",
    theme.FONT_MEDIUM: "Inter-SemiBold.ttf",
    theme.FONT_BOLD: "Inter-Bold.ttf",
}

_fonts_lock = threading.Lock()
_fonts_ready = False

MARGIN = 14 * mm
LABEL_W = 168.0      # колонка названий на странице ленты; та же в budget.py
ROW_H = 17.5
HEAD_H = 34.0        # две строки шапки шкалы
BAR_H = 11.0


def register_fonts() -> None:
    """Встроенные шрифты ReportLab — Latin-1, и ни один из трёх языков
    продукта, кроме английского, ими не набирается. Регистрация ленивая и под
    замком: uvicorn обслуживает запросы в нескольких потоках, а реестр шрифтов
    у ReportLab один на процесс."""
    global _fonts_ready
    if _fonts_ready:
        return
    with _fonts_lock:
        if _fonts_ready:
            return
        for name, file in _FONT_FILES.items():
            pdfmetrics.registerFont(TTFont(name, str(_FONTS_DIR / file)))
        _fonts_ready = True


def page_size(orientation: Orientation) -> tuple[float, float]:
    return landscape(A4) if orientation is Orientation.LANDSCAPE else A4


# --- примитивы ----------------------------------------------------------------


def _ellipsize(text: str, font: str, size: float, width: float) -> str:
    if pdfmetrics.stringWidth(text, font, size) <= width:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > width:
        text = text[:-1]
    return text + "…"


def _text(
    c: Canvas,
    x: float,
    y: float,
    s: str,
    font: str = theme.FONT,
    size: float = 8,
    color: str = theme.TEXT,
    width: float | None = None,
    align: str = "l",
) -> float:
    """Подпись. Возвращает свою ширину — из неё складываются ряды, где каждый
    следующий элемент встаёт за предыдущим (легенда, шапка документа)."""
    s = "" if s is None else str(s)
    c.setFont(font, size)
    c.setFillColor(theme.rl(color))
    if width is not None:
        s = _ellipsize(s, font, size, width)
    if align == "r":
        c.drawRightString(x, y, s)
    elif align == "c":
        c.drawCentredString(x, y, s)
    else:
        c.drawString(x, y, s)
    return pdfmetrics.stringWidth(s, font, size)


def _chip(
    c: Canvas,
    x: float,
    y: float,
    text: str,
    bg: str,
    fg: str,
    size: float = 7,
    pad: float = 5,
    h: float = 13,
) -> float:
    width = pdfmetrics.stringWidth(text, theme.FONT_MEDIUM, size) + pad * 2
    c.setFillColor(theme.rl(bg))
    c.roundRect(x, y, width, h, 3, stroke=0, fill=1)
    _text(c, x + pad, y + (h - size) / 2 + 0.5, text, theme.FONT_MEDIUM, size, fg)
    return width


def _rule(c: Canvas, x1: float, y: float, x2: float, color: str = theme.BORDER, w: float = 0.6):
    c.setStrokeColor(theme.rl(color))
    c.setLineWidth(w)
    c.line(x1, y, x2, y)


# --- каркас страницы ----------------------------------------------------------


class _Sheet:
    """Страница: размеры, колонтитул и счётчик. Держит `Canvas`, чтобы
    рисовальщики разделов не пересчитывали поля заново."""

    def __init__(self, doc: ExportDocument):
        self.doc = doc
        self.width, self.height = page_size(doc.layout.orientation)
        self.buffer = BytesIO()
        self.canvas = Canvas(self.buffer, pagesize=(self.width, self.height))
        self.canvas.setTitle(f"{doc.project_name} — {doc.labels('doc', 'plan')}")
        self.canvas.setAuthor("Planora")
        self.pages: list[tuple[int, int]] = []
        self.number = 0

    @property
    def content_width(self) -> float:
        return self.width - 2 * MARGIN

    def top(self) -> float:
        return self.height - MARGIN

    def footer(self, total: int) -> None:
        c, doc = self.canvas, self.doc
        y = MARGIN - 6
        _rule(c, MARGIN, y + 10, self.width - MARGIN)
        _text(c, MARGIN, y, doc.project_name, theme.FONT, 7, theme.TEXT_FAINT,
              width=self.content_width / 3)
        if doc.client_copy:
            _text(c, self.width / 2, y, doc.labels("doc", "client_copy"),
                  theme.FONT, 7, theme.TEXT_FAINT, align="c")
        _text(c, self.width - MARGIN, y,
              doc.labels("doc", "page", n=self.number, total=total),
              theme.FONT, 7, theme.TEXT_FAINT, align="r")


# --- обложка ------------------------------------------------------------------


def _head(sheet: _Sheet) -> float:
    """Шапка документа: имя, бейдж плана, период — и полоса из шести плиток."""
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    top = sheet.top()

    width = _text(c, MARGIN, top - 20, doc.project_name, theme.FONT_BOLD, 20, theme.TEXT,
                  width=sheet.content_width * 0.7)
    badge_bg, badge_fg = (
        (theme.OK_SOFT, theme.OK) if doc.plan_approved else (theme.TAG_GRAY, theme.TEXT_MUTED)
    )
    _chip(c, MARGIN + width + 10, top - 19, doc.plan_badge, badge_bg, badge_fg, size=7.5, h=15)

    parts = [doc.org_name, f"{t('doc', 'period')}: {_span(doc, doc.start, doc.end)}"]
    if doc.deadline:
        parts.append(f"{t('doc', 'deadline')}: {_day(doc, doc.deadline)}")
    parts.append(f"{t('doc', 'generated')}: {_day(doc, doc.generated_at)}")
    _text(c, MARGIN, top - 36, "  ·  ".join(parts), theme.FONT, 8.5, theme.TEXT_MUTED,
          width=sheet.content_width)

    kpi = doc.kpi
    tiles = [
        (t("kpi", "total"), str(kpi.total), theme.TEXT, theme.BG_SUBTLE),
        (t("kpi", "done"), str(kpi.done), theme.OK, theme.OK_SOFT),
        (t("kpi", "in_progress"), str(kpi.in_progress), theme.ACCENT, theme.ACCENT_SOFT),
        (t("kpi", "blocked"), str(kpi.blocked), theme.DANGER_STRONG, theme.DANGER_SOFT),
        (t("kpi", "late"), str(kpi.late), theme.WARN, theme.WARN_SOFT),
        (t("kpi", "progress"), f"{kpi.progress_pct}%", theme.TEXT, theme.BG_SUBTLE),
    ]
    y = top - 96
    gap = 8
    tile_w = (sheet.content_width - gap * (len(tiles) - 1)) / len(tiles)
    for i, (name, value, fg, bg) in enumerate(tiles):
        x = MARGIN + i * (tile_w + gap)
        c.setFillColor(theme.rl(bg))
        c.setStrokeColor(theme.rl(theme.BORDER))
        c.setLineWidth(0.6)
        c.roundRect(x, y, tile_w, 50, 6, stroke=1, fill=1)
        _text(c, x + 12, y + 30, value, theme.FONT_BOLD, 19, fg)
        _text(c, x + 12, y + 13, name, theme.FONT, 7.5, theme.TEXT_MUTED, width=tile_w - 20)

    # Полоска выполнения — только у последней плитки: у остальных число уже
    # само себе шкала, и вторая шкала под ним ничего не добавит.
    x = MARGIN + (len(tiles) - 1) * (tile_w + gap)
    c.setFillColor(theme.rl(theme.BORDER))
    c.rect(x + 12, y + 8, tile_w - 24, 2.5, stroke=0, fill=1)
    c.setFillColor(theme.rl(theme.ACCENT))
    c.rect(x + 12, y + 8, (tile_w - 24) * kpi.progress_pct / 100, 2.5, stroke=0, fill=1)

    return y - 22


def _day(doc: ExportDocument, value: date) -> str:
    return f"{value.day} {doc.labels.month(value.month, short=True)} {value.year}"


def _span(doc: ExportDocument, start: date, end: date) -> str:
    return f"{_day(doc, start)} — {_day(doc, end)}"


def _section(sheet: _Sheet, y: float, title: str, subtitle: str = "") -> float:
    c = sheet.canvas
    width = _text(c, MARGIN, y, title, theme.FONT_BOLD, 12, theme.TEXT)
    if subtitle:
        _text(c, MARGIN + width + 10, y, subtitle, theme.FONT, 8, theme.TEXT_MUTED)
    _rule(c, MARGIN, y - 7, sheet.width - MARGIN)
    return y - 20


# --- таблица ------------------------------------------------------------------


def _table(sheet: _Sheet, y: float, columns: list, rows: list, row_h: float = 15.5) -> float:
    """Таблица с шапкой, чередованием строк и строками-группами.

    columns — (заголовок, ширина, выравнивание, ключ). Ключ — либо строка
    значения, либо функция, рисующая ячейку сама и возвращающая None.
    """
    c = sheet.canvas
    total_w = sum(col[1] for col in columns)
    head_h = 18.0

    c.setFillColor(theme.rl(theme.BG_SUBTLE))
    c.rect(MARGIN, y - head_h, total_w, head_h, stroke=0, fill=1)
    x = MARGIN
    for title, width, align, _ in columns:
        cx = x + width - 6 if align == "r" else (x + width / 2 if align == "c" else x + 6)
        _text(c, cx, y - head_h + 6, title, theme.FONT_MEDIUM, 6.8, theme.TEXT_MUTED,
              width=width - 10, align=align)
        x += width
    y -= head_h
    _rule(c, MARGIN, y, MARGIN + total_w, theme.BORDER_STRONG, 0.7)

    striped = 0
    for kind, data in rows:
        if kind == "group":
            c.setFillColor(theme.rl(theme.ACCENT_SOFT))
            c.rect(MARGIN, y - row_h, total_w, row_h, stroke=0, fill=1)
            _text(c, MARGIN + 6, y - row_h + 4.5, data.upper(), theme.FONT_BOLD, 6.6,
                  theme.ACCENT, width=total_w - 12)
            y -= row_h
            striped = 0
            continue

        if striped % 2:
            c.setFillColor(theme.rl(theme.ZEBRA))
            c.rect(MARGIN, y - row_h, total_w, row_h, stroke=0, fill=1)
        x = MARGIN
        for _, width, align, key in columns:
            value = key(sheet, data, x, y - row_h, width) if callable(key) else data.get(key)
            if value is not None:
                cx = x + width - 6 if align == "r" else (
                    x + width / 2 if align == "c" else x + 6
                )
                _text(c, cx, y - row_h + 4.5, str(value), theme.FONT, 7, theme.TEXT,
                      width=width - 10, align=align)
            x += width
        y -= row_h
        _rule(c, MARGIN, y, MARGIN + total_w, theme.ROW_LINE, 0.4)
        striped += 1

    return y


def _tasks_page(sheet: _Sheet) -> None:
    doc, t = sheet.doc, sheet.doc.labels
    y = _head(sheet)
    if not doc.has(ExportSection.TASKS):
        return
    y = _section(sheet, y, t("section", "tasks"), t("count", "tasks", n=len(doc.tasks)))

    def status_cell(sh, task: DocTask, x, y, w):
        bg, fg = theme.STATUS_CHIP[task.status]
        _chip(sh.canvas, x + 6, y + 2, task.status_label, bg, fg, size=6.2, h=11)
        return None

    def progress_cell(sh, task: DocTask, x, y, w):
        c = sh.canvas
        bar_w = w - 34
        c.setFillColor(theme.rl(theme.BORDER))
        c.rect(x + 6, y + 6, bar_w, 3, stroke=0, fill=1)
        c.setFillColor(theme.rl(theme.OK if task.progress_pct == 100 else theme.ACCENT))
        c.rect(x + 6, y + 6, bar_w * task.progress_pct / 100, 3, stroke=0, fill=1)
        _text(c, x + w - 6, y + 4.5, f"{task.progress_pct}%", theme.FONT, 6.5,
              theme.TEXT_MUTED, align="r")
        return None

    def name_cell(sh, task: DocTask, x, y, w):
        label = ("◆ " if task.milestone else "") + task.name
        _text(sh.canvas, x + 6, y + 4.5, label, theme.FONT_MEDIUM, 7, theme.TEXT,
              width=w - (20 if task.beyond_plan else 12))
        if task.beyond_plan:
            # Знак «сверх первоначального плана» — тот же «+», что на ленте.
            _text(sh.canvas, x + w - 8, y + 4.5, "+", theme.FONT_BOLD, 7, theme.ACCENT,
                  align="r")
        return None

    def crit_cell(sh, task: DocTask, x, y, w):
        if task.criticality == "critical":
            _chip(sh.canvas, x + 6, y + 2, task.criticality_label, theme.DANGER_SOFT,
                  theme.DANGER_STRONG, size=6.2, h=11)
            return None
        return task.criticality_label

    def dev_cell(sh, task: DocTask, x, y, w):
        if task.deviation_days is None:
            return "—"
        if task.deviation_days == 0:
            return "0"
        color = theme.WARN if task.deviation_days > 0 else theme.OK
        _text(sh.canvas, x + w - 6, y + 4.5, f"{task.deviation_days:+d}",
              theme.FONT_MEDIUM, 7, color, align="r")
        return None

    def short(value: date) -> str:
        # Даты без года: период целиком назван в шапке документа, а с годом не
        # остаётся ширины на колонку заметки.
        return f"{value.day} {doc.labels.month(value.month, short=True)}"

    show_people = any(task.assignees for task in doc.tasks)
    show_notes = any(task.note for task in doc.tasks)
    show_dev = not doc.client_copy and any(
        task.deviation_days is not None for task in doc.tasks
    )

    columns: list = [
        (t("col", "n"), 20, "r", lambda s, r, *a: r.number),
        (t("col", "task"), 172, "l", name_cell),
        (t("col", "status"), 66, "l", status_cell),
        (t("col", "criticality"), 54, "l", crit_cell),
        (t("col", "progress"), 72, "l", progress_cell),
        (t("col", "start"), 44, "l", lambda s, r, *a: short(r.start)),
        (t("col", "end"), 44, "l", lambda s, r, *a: short(r.end)),
        (t("col", "days"), 26, "r", lambda s, r, *a: r.duration_days),
    ]
    if show_dev:
        columns.append((t("col", "deviation"), 38, "r", dev_cell))
    columns.append((t("col", "critical"), 28, "c", lambda s, r, *a: "•" if r.critical else ""))
    if show_people:
        columns.append(
            (t("col", "assignees"), 96, "l", lambda s, r, *a: ", ".join(r.assignees) or "—")
        )
    if show_notes:
        used = sum(col[1] for col in columns)
        columns.append(
            (t("col", "note"), sheet.content_width - used, "l", lambda s, r, *a: r.note or "")
        )

    # Остаток ширины уходит колонке названия, а не последней: сумма
    # фиксированных ширин не обязана совпасть с полосой набора, и слабину надо
    # отдать той колонке, которой длины всегда не хватает. У клиентского
    # экземпляра колонок вчетверо меньше, и слабина там — половина листа.
    used = sum(col[1] for col in columns)
    title, width, align, key = columns[1]
    columns[1] = (title, width + sheet.content_width - used, align, key)

    rows: list = []
    for category in doc.categories:
        tasks = doc.tasks_of(category.id)
        if not tasks:
            continue
        rows.append(("group", category.name))
        rows += [("row", task) for task in tasks]
    _table(sheet, y, columns, rows)


# --- лента --------------------------------------------------------------------


def _gantt_page(sheet: _Sheet, window: Window, index: int, total: int) -> None:
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    y = sheet.top() - 18
    _text(c, MARGIN, y - 10, doc.project_name, theme.FONT_BOLD, 13, theme.TEXT,
          width=sheet.content_width * 0.5)
    caption = f"{t('section', 'gantt')} · {_span(doc, window.start, window.end)}"
    if total > 1:
        caption += f"  ({index + 1}/{total})"
    _text(c, sheet.width - MARGIN, y - 10, caption, theme.FONT, 8.5, theme.TEXT_MUTED,
          align="r")

    bottom = _gantt(sheet, window, y - 26)
    _legend(sheet, bottom - 20)


def _gantt(sheet: _Sheet, window: Window, top: float) -> float:
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    days = window.days
    chart_x = MARGIN + LABEL_W

    # Ширина дня постоянна на всех страницах ленты, а не «растянуть окно по
    # ширине»: последний срез почти всегда короче полного, и подгонка под
    # ширину дала бы на нём полоски втрое толще, чем на предыдущей странице.
    # Берётся из того же правила, что считало число страниц.
    #
    # Единственный срез — исключение: сравнивать его не с чем, а лента, не
    # добравшая трети ширины, читается как обрезанная.
    available = sheet.content_width - LABEL_W
    if len(doc.layout.slices) == 1:
        day_w = available / max(days, 1)
    else:
        day_w = available / budget.days_per_page(doc.layout.zoom, doc.layout.orientation)
    chart_w = days * day_w

    def x_of(day: date) -> float:
        return chart_x + (day - window.start).days * day_w

    rows: list[tuple[str, object]] = []
    for category in doc.categories:
        tasks = doc.tasks_of(category.id)
        if not tasks:
            continue
        rows.append(("category", category))
        rows += [("task", task) for task in tasks]

    # --- шапка шкалы ---------------------------------------------------------
    c.setFillColor(theme.rl(theme.BG_SUBTLE))
    c.rect(MARGIN, top - HEAD_H, LABEL_W + chart_w, HEAD_H, stroke=0, fill=1)
    _text(c, MARGIN + 8, top - 22, t("col", "task"), theme.FONT_MEDIUM, 8, theme.TEXT_MUTED)

    day = window.start
    while day <= window.end:
        last = min(_month_end(day), window.end)
        x0, x1 = x_of(day), x_of(last) + day_w
        c.setStrokeColor(theme.rl(theme.BORDER))
        c.setLineWidth(0.5)
        c.line(x0, top - HEAD_H, x0, top)
        if x1 - x0 > 40:
            _text(c, (x0 + x1) / 2, top - 13, f"{doc.labels.month(day.month)} {day.year}",
                  theme.FONT_MEDIUM, 7.5, theme.TEXT, align="c")
        day = last + timedelta(days=1)

    step = max(1, int(round(14 / day_w)))
    day = window.start
    while day <= window.end:
        if day.day == 1 or day.day % step == 0:
            _text(c, x_of(day) + day_w / 2, top - HEAD_H + 6, str(day.day),
                  theme.FONT, 5.6, theme.TEXT_FAINT, align="c")
        day += timedelta(days=1)

    body_top = top - HEAD_H
    body_h = len(rows) * ROW_H

    # --- нерабочие дни на всю высоту ----------------------------------------
    # Ниже четырёх пунктов на день заливка выходных перестаёт читаться как
    # ритм недели и превращается в шум поперёк ленты — на крупном масштабе её
    # просто нет.
    if day_w >= 4:
        day = window.start
        while day <= window.end:
            if day.weekday() >= 5:
                c.setFillColor(theme.rl(theme.NONWORKING))
                c.rect(x_of(day), body_top - body_h, day_w, body_h, stroke=0, fill=1)
            day += timedelta(days=1)

    # --- строки --------------------------------------------------------------
    centers: dict[int, float] = {}
    for i, (kind, item) in enumerate(rows):
        y = body_top - (i + 1) * ROW_H
        _rule(c, MARGIN, y, chart_x + chart_w, theme.ROW_LINE, 0.4)

        if kind == "category":
            c.setFillColor(theme.rl(theme.BG_SUBTLE))
            c.rect(MARGIN, y, LABEL_W, ROW_H, stroke=0, fill=1)
            c.setFillColor(theme.rl(item.color.lstrip("#").upper()))
            c.rect(MARGIN + 8, y + ROW_H / 2 - 3.5, 3, 7, stroke=0, fill=1)
            _text(c, MARGIN + 16, y + 5.5, item.name.upper(), theme.FONT_BOLD, 6.8,
                  theme.TEXT_MUTED, width=LABEL_W - 26)
            continue

        task: DocTask = item
        centers[task.number] = y + ROW_H / 2
        label = ("◆ " if task.milestone else "") + task.name
        _text(c, MARGIN + 22, y + 5.5, label, theme.FONT, 7.2, theme.TEXT, width=LABEL_W - 34)

        if task.baseline_start and task.baseline_end and not task.milestone:
            start = max(task.baseline_start, window.start)
            end = min(task.baseline_end, window.end)
            if start <= end:
                c.setStrokeColor(theme.rl(theme.BORDER_STRONG))
                c.setLineWidth(0.5)
                c.setDash(1.5, 1.5)
                c.rect(x_of(start), y + 2, (end - start).days * day_w + day_w, 3.5,
                       stroke=1, fill=0)
                c.setDash()

        start = max(task.start, window.start)
        end = min(task.end, window.end)
        if start <= end:
            _bar(c, x_of(start), y + ROW_H - BAR_H - 3.5,
                 (end - start).days * day_w + day_w, task)

    c.setStrokeColor(theme.rl(theme.BORDER))
    c.setLineWidth(0.7)
    c.line(chart_x, body_top - body_h, chart_x, top)
    c.rect(MARGIN, body_top - body_h, LABEL_W + chart_w, HEAD_H + body_h, stroke=1, fill=0)

    _arrows(sheet, window, x_of, day_w, centers)

    if doc.dated and window.start <= doc.today <= window.end:
        x = x_of(doc.today) + day_w / 2
        c.setStrokeColor(theme.rl(theme.DANGER))
        c.setLineWidth(1)
        c.setDash(3, 2)
        c.line(x, body_top - body_h, x, top)
        c.setDash()
        # Метка — над рамкой, а не внутри шапки: внутри она села бы поверх
        # чисел месяца и закрыла бы ровно те дни, на которые указывает.
        _chip(c, x - 16, top + 3, t("legend", "today"), theme.DANGER_SOFT,
              theme.DANGER_STRONG, size=6)

    return body_top - body_h


def _month_end(day: date) -> date:
    first_next = date(day.year + day.month // 12, day.month % 12 + 1, 1)
    return first_next - timedelta(days=1)


def _bar(c: Canvas, x: float, y: float, w: float, task: DocTask) -> None:
    """Полоска задачи: заливка по статусу, накладки поверх.

    Заливка означает только статус. Просрочка — контур цветом внимания,
    критичность — левая грань цветом тревоги; обе ложатся поверх любой заливки
    и обе сразу выписаны явно, а не оставлены каскаду.
    """
    fill, stroke, label_color = theme.STATUS_BAR[task.status]
    w = max(w, 3)

    if task.milestone:
        cx, cy, r = x + w / 2, y + BAR_H / 2, BAR_H / 2 + 1
        c.setFillColor(theme.rl(theme.FILL_DONE if task.status == "done" else theme.TEXT))
        path = c.beginPath()
        path.moveTo(cx, cy + r)
        path.lineTo(cx + r, cy)
        path.lineTo(cx, cy - r)
        path.lineTo(cx - r, cy)
        path.close()
        c.drawPath(path, stroke=0, fill=1)
        return

    c.setFillColor(theme.rl(fill))
    if stroke is not None:
        c.setStrokeColor(theme.rl(stroke))
        c.setLineWidth(0.7)
        c.setDash(2, 2)
        c.roundRect(x, y, w, BAR_H, 2.5, stroke=1, fill=1)
        c.setDash()
    else:
        c.roundRect(x, y, w, BAR_H, 2.5, stroke=0, fill=1)

    if task.status == "blocked":
        # Штриховка: состояние назначил человек, и полоска называет его и
        # рисунком, и словом.
        c.saveState()
        path = c.beginPath()
        path.roundRect(x, y, w, BAR_H, 2.5)
        c.clipPath(path, stroke=0)
        c.setStrokeColor(theme.rl(theme.FILL_BLOCKED_ALT))
        c.setLineWidth(3)
        offset = -BAR_H
        while offset < w + BAR_H:
            c.line(x + offset, y, x + offset + BAR_H, y + BAR_H)
            offset += 7
        c.restoreState()

    if task.status == "in_progress" and task.progress_pct:
        # Заливка прогресса — часть полоски «в работе», а не вторая полоска.
        c.saveState()
        path = c.beginPath()
        path.roundRect(x, y, w, BAR_H, 2.5)
        c.clipPath(path, stroke=0)
        c.setFillColor(theme.rl(theme.FILL_PROGRESS_DONE))
        c.rect(x, y, w * task.progress_pct / 100, BAR_H, stroke=0, fill=1)
        c.restoreState()

    if task.late:
        c.setStrokeColor(theme.rl(theme.WARN))
        c.setLineWidth(1.1)
        c.roundRect(x + 0.55, y + 0.55, w - 1.1, BAR_H - 1.1, 2.5, stroke=1, fill=0)
    if task.criticality == "critical":
        c.setFillColor(theme.rl(theme.DANGER_STRONG))
        c.rect(x, y, 2.5, BAR_H, stroke=0, fill=1)

    if w > 34:
        _text(c, x + 6, y + 3.2, task.name, theme.FONT_MEDIUM, 6.5, label_color, width=w - 12)


def _arrows(sheet: _Sheet, window: Window, x_of, day_w: float, centers: dict) -> None:
    """Связи — коленчатой прокладкой, как на ленте (`gantt/Arrows.tsx`).

    Рисуются только те, у которых оба конца попали в это окно: стрелка,
    уходящая за край страницы, обещает связь, которой на этой странице не
    видно.
    """
    doc = sheet.doc
    if not doc.has(ExportSection.LINKS):
        return
    c = sheet.canvas
    by_id = {task.id: task for task in doc.tasks}
    c.setStrokeColor(theme.rl(theme.ARROW))
    c.setLineWidth(0.5)

    for link in doc.links:
        source, target = by_id.get(link.from_id), by_id.get(link.to_id)
        if source is None or target is None:
            continue
        if source.number not in centers or target.number not in centers:
            continue
        if not (window.start <= link.from_end <= window.end):
            continue
        if not (window.start <= link.to_start <= window.end):
            continue

        x1, y1 = x_of(link.from_end) + day_w, centers[source.number]
        x2, y2 = x_of(link.to_start), centers[target.number]
        elbow = x1 + 4
        path = c.beginPath()
        path.moveTo(x1, y1)
        path.lineTo(elbow, y1)
        path.lineTo(elbow, y2)
        path.lineTo(x2 - 3, y2)
        c.drawPath(path, stroke=1, fill=0)

        c.setFillColor(theme.rl(theme.ARROW))
        head = c.beginPath()
        head.moveTo(x2, y2)
        head.lineTo(x2 - 3.4, y2 + 2)
        head.lineTo(x2 - 3.4, y2 - 2)
        head.close()
        c.drawPath(head, stroke=0, fill=1)


def _legend(sheet: _Sheet, y: float) -> None:
    """Легенда цветов: документ обязан объясняться сам.

    Каждый пункт — «образец, отступ, подпись, зазор»; ширину подписи возвращает
    `_text`. Складывается вручную, зато ни один пункт не наезжает на соседний
    при смене языка.
    """
    c, t = sheet.canvas, sheet.doc.labels
    SW, GAP, PAD = 20.0, 20.0, 5.0
    x = MARGIN
    x += _text(c, x, y, t("legend", "title"), theme.FONT_MEDIUM, 7.5, theme.TEXT_MUTED) + GAP

    def item(draw, text: str) -> None:
        nonlocal x
        draw(x)
        x += SW + PAD
        x += _text(c, x, y, text, theme.FONT, 7, theme.TEXT_MUTED) + GAP

    for status in ("planned", "in_progress", "done", "blocked"):
        fill, stroke, _ = theme.STATUS_BAR[status]

        def swatch(sx: float, fill=fill, stroke=stroke, status=status) -> None:
            c.setFillColor(theme.rl(fill))
            if stroke:
                c.setStrokeColor(theme.rl(stroke))
                c.setLineWidth(0.6)
                c.setDash(2, 2)
                c.roundRect(sx, y - 2, SW, 8, 2, stroke=1, fill=1)
                c.setDash()
            else:
                c.roundRect(sx, y - 2, SW, 8, 2, stroke=0, fill=1)
            if status == "blocked":
                c.saveState()
                path = c.beginPath()
                path.roundRect(sx, y - 2, SW, 8, 2)
                c.clipPath(path, stroke=0)
                c.setStrokeColor(theme.rl(theme.FILL_BLOCKED_ALT))
                c.setLineWidth(2.4)
                for offset in range(-8, int(SW) + 8, 6):
                    c.line(sx + offset, y - 2, sx + offset + 8, y + 6)
                c.restoreState()

        item(swatch, t("status", status))

    def late(sx: float) -> None:
        c.setStrokeColor(theme.rl(theme.WARN))
        c.setLineWidth(1.2)
        c.roundRect(sx, y - 2, SW, 8, 2, stroke=1, fill=0)

    def critical(sx: float) -> None:
        c.setFillColor(theme.rl(theme.FILL_PLANNED))
        c.roundRect(sx, y - 2, SW, 8, 2, stroke=0, fill=1)
        c.setFillColor(theme.rl(theme.DANGER_STRONG))
        c.rect(sx, y - 2, 2.5, 8, stroke=0, fill=1)

    def milestone(sx: float) -> None:
        c.setFillColor(theme.rl(theme.TEXT))
        cx, cy, r = sx + SW / 2, y + 2, 5
        path = c.beginPath()
        path.moveTo(cx, cy + r)
        path.lineTo(cx + r, cy)
        path.lineTo(cx, cy - r)
        path.lineTo(cx - r, cy)
        path.close()
        c.drawPath(path, stroke=0, fill=1)

    def baseline(sx: float) -> None:
        c.setStrokeColor(theme.rl(theme.BORDER_STRONG))
        c.setLineWidth(0.5)
        c.setDash(1.5, 1.5)
        c.rect(sx, y, SW, 3.5, stroke=1, fill=0)
        c.setDash()

    item(late, t("legend", "late"))
    item(critical, t("legend", "critical"))
    item(milestone, t("legend", "milestone"))
    if not sheet.doc.client_copy:
        item(baseline, t("legend", "baseline"))


# --- смета, скоркард, разговор -------------------------------------------------


def _money_page(sheet: _Sheet) -> None:
    doc = sheet.doc
    half = sheet.width / 2 - MARGIN - 10
    y_bottom = sheet.top() - 14

    if doc.proposal:
        y_bottom = min(y_bottom, _proposal_block(sheet, sheet.top() - 14, half))
    if doc.scorecard:
        _scorecard_block(sheet, sheet.top() - 14)

    talk_top = min(y_bottom - 26, sheet.height / 2 - 10)
    if doc.comments:
        _comments_block(sheet, talk_top, half)
    if doc.history:
        _history_block(sheet, talk_top)


def _proposal_block(sheet: _Sheet, y: float, half: float) -> float:
    doc, t = sheet.doc, sheet.doc.labels
    proposal = doc.proposal
    y = _section(sheet, y, t("section", "proposal"), proposal.currency)

    def money(value) -> str:
        return f"{value:,.0f}".replace(",", " ")

    rows: list = []
    for group in proposal.groups:
        if not group.lines:
            continue
        rows.append(("group", group.name))
        rows += [
            ("row", {
                "name": line.name,
                "role": line.role,
                "effort": _plain(line.effort),
                "rate": _plain(line.rate),
                "sum": money(line.amount),
            })
            for line in group.lines
        ]

    columns = [
        (t("col", "task"), half * 0.40, "l", "name"),
        (t("col", "role"), half * 0.26, "l", "role"),
        (t("col", "effort"), half * 0.12, "r", "effort"),
        (t("col", "rate"), half * 0.10, "r", "rate"),
        (t("col", "sum"), half * 0.12, "r", "sum"),
    ]
    y = _table(sheet, y, columns, rows, row_h=14)

    c = sheet.canvas
    totals = [
        (t("total", "subtotal"), proposal.subtotal, False),
        (t("total", "tax", p=_plain(proposal.tax_rate_pct)), proposal.tax, False),
        (t("total", "total"), proposal.total, True),
    ]
    for i, (name, value, bold) in enumerate(totals):
        line_y = y - 16 - i * 15
        font = theme.FONT_BOLD if bold else theme.FONT
        _text(c, MARGIN + half * 0.78, line_y, name, font, 8,
              theme.TEXT if bold else theme.TEXT_MUTED, align="r")
        _text(c, MARGIN + half, line_y, f"{money(value)} {proposal.currency}",
              font, 8.5 if bold else 8, theme.TEXT, align="r")
    return y - 16 - len(totals) * 15


def _scorecard_block(sheet: _Sheet, y: float) -> None:
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    card = doc.scorecard
    left = sheet.width / 2 + 6
    right = sheet.width - MARGIN

    width = _text(c, left, y, t("section", "scorecard"), theme.FONT_BOLD, 12, theme.TEXT)
    _text(c, left + width + 10, y, t("count", "weeks", n=len(card.weeks)), theme.FONT, 8,
          theme.TEXT_MUTED)
    _rule(c, left, y - 7, right)
    y -= 20

    col_w = min(30.0, (right - left - 120) / max(len(card.weeks), 1))
    name_w = right - left - col_w * len(card.weeks) - 52

    c.setFillColor(theme.rl(theme.BG_SUBTLE))
    c.rect(left, y - 18, right - left, 18, stroke=0, fill=1)
    _text(c, left + 6, y - 12, t("col", "metric"), theme.FONT_MEDIUM, 6.8, theme.TEXT_MUTED,
          width=name_w)
    _text(c, left + name_w + 26, y - 12, t("col", "target"), theme.FONT_MEDIUM, 6.8,
          theme.TEXT_MUTED, align="r")
    for i, week in enumerate(card.weeks):
        _text(c, left + name_w + 52 + i * col_w + col_w / 2, y - 12, f"{week:%d.%m}",
              theme.FONT, 6.2, theme.TEXT_MUTED, align="c")
    y -= 18

    for metric in card.metrics:
        _text(c, left + 6, y - 11, metric.label, theme.FONT, 7, theme.TEXT, width=name_w)
        _text(c, left + name_w + 26, y - 11, _plain(metric.target), theme.FONT, 7,
              theme.TEXT_MUTED, align="r")
        for i, (value, status) in enumerate(zip(metric.values, metric.statuses)):
            x = left + name_w + 52 + i * col_w
            bg, fg = theme.METRIC_CELL[status]
            if value is None:
                _text(c, x + col_w / 2, y - 11, "—", theme.FONT, 7, theme.TEXT_FAINT,
                      align="c")
                continue
            c.setFillColor(theme.rl(bg))
            c.roundRect(x + 2, y - 15, col_w - 4, 13, 3, stroke=0, fill=1)
            _text(c, x + col_w / 2, y - 11, _plain(value), theme.FONT_MEDIUM, 6.8, fg,
                  align="c")
        y -= 16
        _rule(c, left, y, right, theme.ROW_LINE, 0.4)


def _comments_block(sheet: _Sheet, y: float, half: float) -> None:
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    y = _section(sheet, y, t("section", "comments"),
                 t("count", "comments", n=len(doc.comments)))

    for comment in doc.comments:
        if y < MARGIN + 60:
            break
        c.setFillColor(theme.rl(theme.WARN_SOFT if comment.internal else theme.BG_SUBTLE))
        c.setStrokeColor(theme.rl(theme.BORDER))
        c.setLineWidth(0.5)
        c.roundRect(MARGIN, y - 34, half, 34, 5, stroke=1, fill=1)

        width = _text(c, MARGIN + 10, y - 14, comment.author, theme.FONT_MEDIUM, 7.5,
                      theme.TEXT, width=half * 0.4)
        x = MARGIN + 16 + width
        x += _text(c, x, y - 14, _day(doc, comment.created_at), theme.FONT, 6.8,
                   theme.TEXT_FAINT) + 8
        if comment.internal:
            _chip(c, x, y - 17, t("comment", "internal"), theme.WARN_SOFT,
                  theme.WARN_TEXT, size=6)
        if comment.task_name:
            _text(c, MARGIN + half - 10, y - 14, comment.task_name, theme.FONT, 6.5,
                  theme.TEXT_FAINT, width=half * 0.3, align="r")
        _text(c, MARGIN + 10, y - 27, comment.body, theme.FONT, 7, theme.TEXT_MUTED,
              width=half - 20)
        y -= 40


def _history_block(sheet: _Sheet, y: float) -> None:
    c, doc, t = sheet.canvas, sheet.doc, sheet.doc.labels
    left = sheet.width / 2 + 6
    right = sheet.width - MARGIN

    _text(c, left, y, t("section", "history"), theme.FONT_BOLD, 12, theme.TEXT)
    _rule(c, left, y - 7, right)
    y -= 22

    for event in doc.history:
        if y < MARGIN + 20:
            break
        c.setFillColor(theme.rl(theme.ACCENT))
        c.circle(left + 4, y + 2.5, 2.2, stroke=0, fill=1)
        _text(c, left + 14, y, _day(doc, event.at), theme.FONT_MEDIUM, 7, theme.TEXT_MUTED)
        _text(c, left + 76, y, event.actor or "—", theme.FONT_MEDIUM, 7, theme.TEXT, width=76)
        _text(c, left + 158, y, f"{event.event} · {event.subject}".rstrip(" ·"),
              theme.FONT, 7, theme.TEXT_MUTED, width=right - left - 164)
        y -= 17
        _rule(c, left + 14, y + 6, right, theme.ROW_LINE, 0.4)


def _plain(value) -> str:
    text = f"{float(value):f}".rstrip("0").rstrip(".")
    return text or "0"


# --- сборка -------------------------------------------------------------------


def render(doc: ExportDocument) -> bytes:
    """Страницы объявляются списком, а рисуются потом — поэтому «стр. N из M»
    честна с первой же страницы, а не задним числом."""
    register_fonts()
    sheet = _Sheet(doc)

    pages: list = []
    if doc.has(ExportSection.OVERVIEW) or doc.has(ExportSection.TASKS):
        pages.append(lambda: _tasks_page(sheet))
    if doc.has(ExportSection.GANTT) and doc.tasks:
        slices = doc.layout.slices
        for i, window in enumerate(slices):
            pages.append(
                lambda w=window, i=i: _gantt_page(sheet, w, i, len(slices))
            )
    if doc.proposal or doc.scorecard or doc.comments or doc.history:
        pages.append(lambda: _money_page(sheet))

    if not pages:
        pages.append(lambda: _head(sheet))

    for draw in pages:
        sheet.number += 1
        draw()
        sheet.footer(len(pages))
        sheet.canvas.showPage()

    sheet.canvas.save()
    return sheet.buffer.getvalue()
