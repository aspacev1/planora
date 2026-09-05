"""Документ для клиента: коммерческое предложение одним PDF.

Не ещё один раздел общей выгрузки, а отдельный документ с отдельным составом.
Общая выгрузка — снимок проекта для того, кто в нём работает; этот файл уходит
за порог организации, и всё, что в нём есть, клиент вправе прочитать: имя
работы, короткое описание, объём, ставка и сумма, итоги и примечания ко всему
предложению. Роли, подробностей, заметок, рисков, допущений строки и
обсуждения здесь нет **по построению**: у строк документа (`_Line`) для них
нет полей, и попасть в файл им неоткуда.

Рисуется platypus'ом, а не канвой с помощниками из `app.export.pdf`: у тех
`_table` не переносит строки на следующую страницу и режет длинную ячейку
многоточием, а клиентский документ обязан переносить и то и другое — описание
работы в предложении дочитывают до конца. Шрифты, палитра и колонтитул — те
же, что у общей выгрузки: документ читается продолжением экрана.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy.orm import Session as DbSession

from app.export import theme
from app.export.errors import ExportError
from app.export.labels import Labels
from app.export.pdf import MARGIN, _rule, _text, register_fonts
from app.models import Organization, Project
from app.proposals import proposal_state

#: Сколько дней предложение действительно с даты выпуска. Тридцать — обычный
#: срок оферты; отдельной настройки нет, пока о ней не попросили.
VALIDITY_DAYS = 30

PAGE_W, PAGE_H = A4
CONTENT_W = PAGE_W - 2 * MARGIN


# --- строки документа ---------------------------------------------------------


@dataclass(frozen=True)
class _Line:
    """Строка сметы в том виде, в каком её видит клиент. Полей для роли,
    заметок, рисков и допущений здесь нет намеренно — см. модуль."""

    number: int
    name: str
    description: str
    effort: Decimal
    rate: Decimal

    @property
    def amount(self) -> Decimal:
        return self.effort * self.rate


@dataclass(frozen=True)
class _Group:
    name: str
    description: str
    lines: list[_Line]

    @property
    def amount(self) -> Decimal:
        return sum((line.amount for line in self.lines), Decimal(0))


@dataclass(frozen=True)
class ProposalDocument:
    labels: Labels
    org_name: str
    project_name: str
    #: Номер предложения — для ссылки в переписке. Выводится из проекта, а не
    #: из даты: одно и то же предложение, скачанное дважды, обязано носить
    #: один номер.
    number: str
    issued: date
    valid_until: date
    currency: str
    effort_unit: str
    tax_rate_pct: Decimal
    notes: str
    groups: list[_Group]

    @property
    def subtotal(self) -> Decimal:
        return sum((group.amount for group in self.groups), Decimal(0))

    @property
    def tax(self) -> Decimal:
        return self.subtotal * self.tax_rate_pct / 100

    @property
    def total(self) -> Decimal:
        return self.subtotal + self.tax

    def file_stem(self) -> str:
        """Имя файла без расширения — с именем проекта, как просят, и датой
        в ISO, чтобы файлы сортировались в папке получателя."""
        safe = "".join(
            ch if ch.isalnum() or ch in " -_()" else "-" for ch in self.project_name
        ).strip()
        return f"{self.labels('proposal_doc', 'title')} - {safe} - {self.issued.isoformat()}"


# --- сборка -------------------------------------------------------------------


def build_document(
    db: DbSession, project: Project, org: Organization, *, locale: str, issued: date
) -> ProposalDocument:
    """Снимок предложения под клиентский документ.

    `issued` — дата документа; сегодня по таймзоне проекта, пока у предложения
    нет собственной даты отправки. Приходит параметром, а не берётся здесь:
    когда у предложения появится дата отправки, поменяется вызывающий, а не
    сборка.

    Пустое предложение — отказ, а не документ из одних заголовков: такой файл
    читается как поломка, а не как «работ пока нет».
    """
    state = proposal_state(db, project)
    groups: list[_Group] = []
    number = 0
    for category in state["categories"]:
        lines: list[_Line] = []
        for raw in category["tasks"]:
            number += 1
            lines.append(
                _Line(
                    number=number,
                    name=raw["name"],
                    description=raw["description"],
                    # Decimal из строки, а не из float: 0.1 обязан остаться 0.1.
                    effort=Decimal(str(raw["effort"])),
                    rate=Decimal(str(raw["rate"])),
                )
            )
        if lines:
            groups.append(
                _Group(name=category["name"], description=category["description"], lines=lines)
            )
    if not groups:
        raise ExportError("proposal_empty", "в предложении нет ни одной строки")

    return ProposalDocument(
        labels=Labels(locale),
        org_name=org.name,
        project_name=project.name,
        number=project.id.hex[:8].upper(),
        issued=issued,
        valid_until=issued + timedelta(days=VALIDITY_DAYS),
        currency=state["currency"],
        effort_unit=state["effort_unit"],
        tax_rate_pct=Decimal(str(state["tax_rate_pct"])),
        notes=state["notes"],
        groups=groups,
    )


# --- рисование ----------------------------------------------------------------


def _money(value: Decimal) -> str:
    """Сумма с разрядами через пробел и копейками только там, где они есть:
    «12 000» читается быстрее «12 000.00», а «12 000.50» терять нельзя."""
    rounded = value.quantize(Decimal("0.01"))
    if rounded == rounded.to_integral_value():
        text = f"{int(rounded):,}"
    else:
        text = f"{rounded:,.2f}"
    return text.replace(",", " ")


def _plain(value: Decimal) -> str:
    text = f"{value:f}".rstrip("0").rstrip(".") if "." in f"{value:f}" else f"{value:f}"
    return text or "0"


def _day(doc: ProposalDocument, value: date) -> str:
    return f"{value.day} {doc.labels.month(value.month, short=True)} {value.year}"


def _markup(text: str) -> str:
    """Текст пользователя в разметку Paragraph: экранирован и с переносами
    строк — иначе «&» в имени работы уронил бы разборщик разметки."""
    return escape(text).replace("\n", "<br/>")


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle(
        "base", fontName=theme.FONT, fontSize=8.5, leading=11.5, textColor=theme.rl(theme.TEXT)
    )
    return {
        "org": ParagraphStyle("org", base, fontName=theme.FONT_BOLD, fontSize=13, leading=16),
        "meta": ParagraphStyle(
            "meta", base, fontSize=8.5, leading=12, textColor=theme.rl(theme.TEXT_MUTED)
        ),
        "meta_right": ParagraphStyle(
            "meta_right", base, fontSize=8.5, leading=12, alignment=TA_RIGHT,
            textColor=theme.rl(theme.TEXT_MUTED),
        ),
        "title": ParagraphStyle(
            "title", base, fontName=theme.FONT_BOLD, fontSize=20, leading=24
        ),
        "subtitle": ParagraphStyle(
            "subtitle", base, fontSize=10, leading=13, textColor=theme.rl(theme.TEXT_MUTED)
        ),
        "section": ParagraphStyle(
            "section", base, fontName=theme.FONT_BOLD, fontSize=12, leading=15
        ),
        "head": ParagraphStyle(
            "head", base, fontName=theme.FONT_MEDIUM, fontSize=6.8, leading=9,
            textColor=theme.rl(theme.TEXT_MUTED),
        ),
        "head_right": ParagraphStyle(
            "head_right", base, fontName=theme.FONT_MEDIUM, fontSize=6.8, leading=9,
            alignment=TA_RIGHT, textColor=theme.rl(theme.TEXT_MUTED),
        ),
        "cell": ParagraphStyle("cell", base, fontSize=8, leading=10.5),
        "cell_right": ParagraphStyle(
            "cell_right", base, fontSize=8, leading=10.5, alignment=TA_RIGHT
        ),
        "name": ParagraphStyle(
            "name", base, fontName=theme.FONT_MEDIUM, fontSize=8, leading=10.5
        ),
        "desc": ParagraphStyle(
            "desc", base, fontSize=7.2, leading=9.5, textColor=theme.rl(theme.TEXT_MUTED)
        ),
        "group": ParagraphStyle(
            "group", base, fontName=theme.FONT_BOLD, fontSize=8, leading=10.5,
            textColor=theme.rl(theme.ACCENT),
        ),
        "group_desc": ParagraphStyle(
            "group_desc", base, fontSize=7.2, leading=9.5, textColor=theme.rl(theme.TEXT_MUTED)
        ),
        "group_amount": ParagraphStyle(
            "group_amount", base, fontName=theme.FONT_BOLD, fontSize=8, leading=10.5,
            alignment=TA_RIGHT, textColor=theme.rl(theme.ACCENT),
        ),
        "total_label": ParagraphStyle(
            "total_label", base, alignment=TA_RIGHT, textColor=theme.rl(theme.TEXT_MUTED)
        ),
        "total_value": ParagraphStyle("total_value", base, alignment=TA_RIGHT),
        "grand_label": ParagraphStyle(
            "grand_label", base, fontName=theme.FONT_BOLD, fontSize=9.5, leading=13,
            alignment=TA_RIGHT,
        ),
        "grand_value": ParagraphStyle(
            "grand_value", base, fontName=theme.FONT_BOLD, fontSize=11, leading=13,
            alignment=TA_RIGHT,
        ),
        "note": ParagraphStyle(
            "note", base, fontSize=8.5, leading=12, leftIndent=12, bulletIndent=2,
            textColor=theme.rl(theme.TEXT_MUTED),
        ),
    }


def _letterhead(doc: ProposalDocument, st: dict[str, ParagraphStyle]) -> list:
    t = doc.labels
    left = [
        Paragraph(_markup(doc.org_name), st["org"]),
        Paragraph(t("proposal_doc", "prepared_by"), st["meta"]),
    ]
    right = [
        Paragraph(t("proposal_doc", "number", n=doc.number), st["meta_right"]),
        Paragraph(
            f"{t('proposal_doc', 'issued')}: {_day(doc, doc.issued)}", st["meta_right"]
        ),
        Paragraph(
            f"{t('proposal_doc', 'valid_until')}: {_day(doc, doc.valid_until)}",
            st["meta_right"],
        ),
    ]
    head = Table([[left, right]], colWidths=[CONTENT_W * 0.6, CONTENT_W * 0.4])
    head.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, theme.rl(theme.BORDER)),
            ]
        )
    )
    return [
        head,
        Spacer(1, 16),
        Paragraph(t("proposal_doc", "title"), st["title"]),
        Spacer(1, 4),
        Paragraph(
            f"{t('proposal_doc', 'project')}: {_markup(doc.project_name)}", st["subtitle"]
        ),
        Spacer(1, 18),
    ]


def _scope_table(doc: ProposalDocument, st: dict[str, ParagraphStyle]) -> Table:
    """Таблица работ по разделам. Шапка повторяется на каждой странице
    (`repeatRows`), длинная строка переносится по словам."""
    t = doc.labels
    hours = doc.effort_unit == "hours"
    # Колонка номера вмещает три знака без переноса: «100» в две строки —
    # не номер, а загадка.
    widths = [30.0, 0.0, 58.0, 78.0, 78.0]
    widths[1] = CONTENT_W - sum(widths)

    rows: list[list] = [
        [
            Paragraph(t("proposal_doc", "col_n"), st["head"]),
            Paragraph(t("proposal_doc", "col_work"), st["head"]),
            Paragraph(
                t("proposal_doc", "col_effort_hours" if hours else "col_effort_days"),
                st["head_right"],
            ),
            Paragraph(
                t("proposal_doc", "col_rate_hours" if hours else "col_rate_days", c=doc.currency),
                st["head_right"],
            ),
            Paragraph(t("proposal_doc", "col_amount", c=doc.currency), st["head_right"]),
        ]
    ]
    style: list = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), theme.rl(theme.BG_SUBTLE)),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, theme.rl(theme.BORDER_STRONG)),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, theme.rl(theme.ROW_LINE)),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]

    striped = 0
    for group in doc.groups:
        index = len(rows)
        cell = [Paragraph(_markup(group.name), st["group"])]
        if group.description.strip():
            cell.append(Paragraph(_markup(group.description), st["group_desc"]))
        rows.append([cell, "", "", "", Paragraph(_money(group.amount), st["group_amount"])])
        style += [
            ("SPAN", (0, index), (1, index)),
            ("BACKGROUND", (0, index), (-1, index), theme.rl(theme.ACCENT_SOFT)),
        ]
        striped = 0
        for line in group.lines:
            index = len(rows)
            work = [Paragraph(_markup(line.name), st["name"])]
            if line.description.strip():
                work.append(Paragraph(_markup(line.description), st["desc"]))
            rows.append(
                [
                    Paragraph(str(line.number), st["cell"]),
                    work,
                    Paragraph(_plain(line.effort), st["cell_right"]),
                    Paragraph(_money(line.rate), st["cell_right"]),
                    Paragraph(_money(line.amount), st["cell_right"]),
                ]
            )
            if striped % 2:
                style.append(("BACKGROUND", (0, index), (-1, index), theme.rl(theme.ZEBRA)))
            striped += 1

    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle(style))
    return table


def _totals(doc: ProposalDocument, st: dict[str, ParagraphStyle]) -> Table:
    t = doc.labels
    rows = [
        [
            Paragraph(t("total", "subtotal"), st["total_label"]),
            Paragraph(f"{_money(doc.subtotal)} {doc.currency}", st["total_value"]),
        ]
    ]
    # Нулевой налог в клиентском документе — строка ни о чём: «Налог 0%: 0».
    if doc.tax_rate_pct:
        rows.append(
            [
                Paragraph(t("total", "tax", p=_plain(doc.tax_rate_pct)), st["total_label"]),
                Paragraph(f"{_money(doc.tax)} {doc.currency}", st["total_value"]),
            ]
        )
    rows.append(
        [
            Paragraph(t("total", "total"), st["grand_label"]),
            Paragraph(f"{_money(doc.total)} {doc.currency}", st["grand_value"]),
        ]
    )
    table = Table(rows, colWidths=[130, 110], hAlign="RIGHT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("LINEABOVE", (0, -1), (-1, -1), 0.7, theme.rl(theme.BORDER_STRONG)),
                ("TOPPADDING", (0, -1), (-1, -1), 6),
            ]
        )
    )
    return table


def _notes(doc: ProposalDocument, st: dict[str, ParagraphStyle]) -> list:
    """Примечания — по пункту на строку, как их и пишут."""
    items = [line.strip() for line in doc.notes.split("\n") if line.strip()]
    if not items:
        return []
    out: list = [
        Spacer(1, 22),
        Paragraph(doc.labels("proposal_doc", "notes"), st["section"]),
        Spacer(1, 6),
    ]
    out += [Paragraph(_markup(item), st["note"], bulletText="•") for item in items]
    return out


class _NumberedCanvas(Canvas):
    """Канва, знающая общее число страниц.

    Platypus рисует страницы по очереди и общего числа не знает; здесь каждая
    страница откладывается, а колонтитул со «стр. N из M» дорисовывается при
    сохранении, когда M уже известно. Иначе честного номера страницы не
    получить без второго прохода сборки.
    """

    def __init__(self, doc: ProposalDocument, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Не `_doc`: так у канвы ReportLab называется её собственный документ.
        self._proposal = doc
        self._states: list[dict] = []

    def showPage(self) -> None:  # noqa: N802 — имя задано ReportLab
        self._states.append(dict(self.__dict__))
        self._startPage()

    def save(self) -> None:
        total = len(self._states)
        for state in self._states:
            self.__dict__.update(state)
            self._footer(total)
            super().showPage()
        super().save()

    def _footer(self, total: int) -> None:
        doc = self._proposal
        y = MARGIN - 6
        _rule(self, MARGIN, y + 10, PAGE_W - MARGIN)
        _text(self, MARGIN, y, f"{doc.org_name} · {doc.project_name}", theme.FONT, 7,
              theme.TEXT_FAINT, width=CONTENT_W * 0.6)
        _text(self, PAGE_W - MARGIN, y,
              doc.labels("doc", "page", n=self._pageNumber, total=total),
              theme.FONT, 7, theme.TEXT_FAINT, align="r")


def render(doc: ProposalDocument) -> bytes:
    register_fonts()
    st = _styles()
    buffer = BytesIO()
    template = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN + 14,
        title=f"{doc.labels('proposal_doc', 'title')} — {doc.project_name}",
        author=doc.org_name,
        creator="Planora",
    )
    story: list = [
        *_letterhead(doc, st),
        Paragraph(doc.labels("proposal_doc", "scope"), st["section"]),
        Spacer(1, 8),
        _scope_table(doc, st),
        Spacer(1, 12),
        # Итоги не отрываются от таблицы страницей: сумма без своей таблицы
        # читается как сумма неизвестно чего.
        KeepTogether([_totals(doc, st)]),
        *_notes(doc, st),
    ]
    template.build(
        story, canvasmaker=lambda *args, **kwargs: _NumberedCanvas(doc, *args, **kwargs)
    )
    return buffer.getvalue()
