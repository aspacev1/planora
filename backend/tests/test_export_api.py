"""Exporting a project to Excel and PDF.

What is checked is not "a 200 rather than a 500" but the three promises the work was
undertaken for: the file opens in its own application and contains real dates and
numbers; nothing the client was not promised rides out to them through a link; and the
number of chart pages does not grow silently — the scale rule refuses before it
assembles an unmanageable document.
"""

import io
import json
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.config import get_settings
from app.db import get_db
from app.export import budget, theme
from app.export.budget import Orientation, Period, Zoom
from app.export.document import align_weeks, metric_row
from app.export.labels import available_locales, dictionary
from app.main import app

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

ALL = "include=overview&include=tasks&include=gantt&include=links&include=proposal&include=scorecard&include=comments&include=history"


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture(autouse=True)
def fresh_rate_limit(monkeypatch):
    """The export counter lives in the process's memory: without a reset one test would
    eat into the next one's window (the same technique as with guest comments)."""
    import app.api.export_routes as export_routes

    monkeypatch.setattr(export_routes, "_limiter", None)


@pytest.fixture
def authed(client):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    return client


def _mutate(authed, project_id, op):
    response = authed.post(f"/api/projects/{project_id}/mutations", json={"op": op})
    assert response.status_code in (200, 201), response.text
    return response.json()


def _make_project(authed, *, tasks=3, start=date(2026, 3, 2), duration=5, name="Redesign"):
    project_id = authed.post("/api/projects", json={"name": name}).json()["id"]
    # The start date is assigned before the tasks: in calendar mode a task is created with
    # a real date, while in relative mode it is a coordinate on the "Day N" axis, and
    # anchoring after the fact would re-lay the already created tasks across working days.
    anchored = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": start.isoformat()}
    )
    assert anchored.status_code in (200, 201), anchored.text
    category_id = _mutate(
        authed, project_id, {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}
    )["op"]["category_id"]

    task_ids = []
    for i in range(tasks):
        task_ids.append(
            _mutate(
                authed,
                project_id,
                {
                    "type": "create_task",
                    "category_id": category_id,
                    "name": f"Задача {i + 1}",
                    "start_date": (start + timedelta(days=i * duration)).isoformat(),
                    "duration_days": duration,
                },
            )["op"]["task_id"]
        )
    return project_id, category_id, task_ids


# --- the answer's shape --------------------------------------------------------


def test_both_formats_come_back_as_files_with_a_name(authed):
    project_id, _, _ = _make_project(authed)

    for fmt, mime, signature in (
        ("xlsx", XLSX_MIME, b"PK"),
        ("pdf", "application/pdf", b"%PDF-"),
    ):
        response = authed.get(f"/api/projects/{project_id}/export.{fmt}?{ALL}")
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith(mime)
        assert response.content.startswith(signature)

        # The file name twice: an ASCII placeholder and RFC 5987. Without the second,
        # Cyrillic in a project's name does not survive the header.
        disposition = response.headers["content-disposition"]
        assert disposition.startswith("attachment;")
        assert f".{fmt}" in disposition
        assert "filename*=UTF-8''" in disposition
        # The file is assembled for the caller's permissions — it must not go to a shared cache.
        assert "no-store" in response.headers["cache-control"]


def test_a_cyrillic_project_name_survives_the_header(authed):
    project_id, _, _ = _make_project(authed, name="Переезд офиса")
    response = authed.get(f"/api/projects/{project_id}/export.pdf?{ALL}")
    assert response.status_code == 200

    disposition = response.headers["content-disposition"]
    # There can be no Cyrillic in the ASCII part, but it must be there percent-encoded —
    # otherwise the browser saves the file as "____".
    assert "%D0%9F%D0%B5%D1%80%D0%B5%D0%B5%D0%B7%D0%B4" in disposition
    assert disposition.split(";")[1].strip().isascii()


# --- validity ------------------------------------------------------------------


def _cover_line(body: bytes) -> str:
    """The cover row of the "Overview" sheet — the one with the period, the export date
    and the validity."""
    return load_workbook(io.BytesIO(body))["Обзор"]["B4"].value


def _exported_on(cover_line: str) -> date:
    """The export date is taken from the document itself rather than from date.today():
    the document's "today" is computed in the project's timezone, and at a day boundary
    the test would otherwise diverge from it."""
    day, month, year = cover_line.split("Выгружено: ")[1].split()[0].split(".")
    return date(int(year), int(month), int(day))


def test_the_document_is_valid_for_the_configured_days_from_its_export_date(
    authed, monkeypatch
):
    """"Valid until" is an installation setting rather than a form field: it is computed
    on the server from the export date (which is also the date it is sent to the orderer),
    and both formats name one and the same day."""
    monkeypatch.setenv("EXPORT_VALIDITY_DAYS", "10")
    get_settings.cache_clear()
    try:
        project_id, _, _ = _make_project(authed)
        xlsx = authed.get(f"/api/projects/{project_id}/export.xlsx?{ALL}&locale=ru").content
        pdf = authed.get(f"/api/projects/{project_id}/export.pdf?{ALL}&locale=ru").content
    finally:
        get_settings.cache_clear()

    line = _cover_line(xlsx)
    expected = _exported_on(line) + timedelta(days=10)
    assert f"Действительно до: {expected:%d.%m.%Y}" in line

    month = dictionary("ru")["month_short"][str(expected.month)]
    assert f"Действительно до: {expected.day} {month} {expected.year}" in _pdf_text(pdf)


def test_thirty_days_is_the_default_validity(authed):
    project_id, _, _ = _make_project(authed)
    line = _cover_line(
        authed.get(f"/api/projects/{project_id}/export.xlsx?{ALL}&locale=ru").content
    )
    assert f"Действительно до: {_exported_on(line) + timedelta(days=30):%d.%m.%Y}" in line


# --- the Excel workbook --------------------------------------------------------


def test_the_workbook_carries_real_dates_and_numbers_not_strings(authed):
    """Dates as strings would turn the workbook into a picture of a table: Excel neither
    sorts nor filters by them."""
    project_id, _, task_ids = _make_project(authed, start=date(2026, 3, 2))
    _mutate(
        authed, project_id, {"type": "set_progress", "task_id": task_ids[0], "progress_pct": 40}
    )
    body = authed.get(f"/api/projects/{project_id}/export.xlsx?{ALL}&locale=ru").content

    wb = load_workbook(io.BytesIO(body))
    sheet = wb["Задачи"]
    header = [cell.value for cell in sheet[1]]
    start_column = header.index("Начало") + 1
    progress_column = header.index("Прогресс") + 1

    # The first data row is the category's heading; the task follows.
    row = 3
    # Excel stores a date as a number with a time; openpyxl returns it as a datetime — and
    # that is a real date rather than a string that cannot be sorted by.
    assert sheet.cell(row=row, column=start_column).value.date() == date(2026, 3, 2)
    assert sheet.cell(row=row, column=start_column).number_format == "DD.MM.YYYY"

    # The progress is a fraction with a percentage format rather than the text "40%":
    # otherwise neither a filter nor an average can be built on the column.
    assert sheet.cell(row=row, column=progress_column).value == pytest.approx(0.4)
    assert sheet.cell(row=row, column=progress_column).number_format == "0%"


def test_the_workbook_has_exactly_the_requested_sheets(authed):
    project_id, _, _ = _make_project(authed)

    body = authed.get(
        f"/api/projects/{project_id}/export.xlsx?include=tasks&include=gantt&locale=ru"
    ).content
    assert [ws.title for ws in load_workbook(io.BytesIO(body)).worksheets] == [
        "Задачи",
        "Диаграмма Ганта",
    ]


def test_an_empty_section_does_not_produce_an_empty_sheet(authed):
    """A sheet of nothing but headings reads as a broken export rather than as "there is
    nothing here"."""
    project_id, _, _ = _make_project(authed)
    body = authed.get(
        f"/api/projects/{project_id}/export.xlsx?include=tasks&include=comments&locale=ru"
    ).content
    assert [ws.title for ws in load_workbook(io.BytesIO(body)).worksheets] == ["Задачи"]


def test_the_status_cell_is_painted_by_the_same_palette_as_the_chart(authed):
    project_id, _, task_ids = _make_project(authed)
    _mutate(authed, project_id, {"type": "set_status", "task_id": task_ids[0], "status": "done"})

    body = authed.get(f"/api/projects/{project_id}/export.xlsx?include=tasks&locale=ru").content
    sheet = load_workbook(io.BytesIO(body))["Задачи"]
    header = [cell.value for cell in sheet[1]]
    status_column = header.index("Статус") + 1

    cell = sheet.cell(row=3, column=status_column)
    assert cell.value == "Готово"
    assert cell.fill.fgColor.rgb.endswith("E9F8F0")  # theme.OK_SOFT


def test_the_proposal_totals_are_formulas_so_a_rate_can_be_edited(authed):
    project_id, _, _ = _make_project(authed)
    category_id = authed.post(
        f"/api/projects/{project_id}/proposal/categories", json={"name": "Работы"}
    ).json()["id"]
    authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": "Вёрстка", "role": "Дизайнер", "effort": 4, "rate": 100},
    )

    body = authed.get(f"/api/projects/{project_id}/export.xlsx?include=proposal&locale=ru").content
    sheet = load_workbook(io.BytesIO(body))["Предложение"]
    formulas = [
        cell.value
        for row in sheet.iter_rows()
        for cell in row
        if isinstance(cell.value, str) and cell.value.startswith("=")
    ]
    assert any("*" in formula for formula in formulas), "a row's price is a formula"
    assert any("+" in formula for formula in formulas), "the total is a formula"


# --- the PDF document ----------------------------------------------------------


def _pdf_text(body: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(body))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _pdf_pages(body: bytes) -> int:
    from pypdf import PdfReader

    return len(PdfReader(io.BytesIO(body)).pages)


def test_the_pdf_names_the_project_and_its_tasks(authed):
    project_id, _, _ = _make_project(authed, name="Переезд офиса")
    body = authed.get(f"/api/projects/{project_id}/export.pdf?{ALL}&locale=ru").content

    text = _pdf_text(body)
    assert "Переезд офиса" in text
    assert "Задача 1" in text


@pytest.mark.parametrize("locale,word", [("az", "Tapşırıqlar"), ("en", "Tasks"), ("ru", "Задачи")])
def test_the_pdf_speaks_the_asked_language(authed, locale, word):
    """That is what Inter is embedded for: ReportLab's built-in fonts have neither
    Cyrillic nor `ə`."""
    project_id, _, _ = _make_project(authed)
    body = authed.get(
        f"/api/projects/{project_id}/export.pdf?include=tasks&locale={locale}"
    ).content
    assert word in _pdf_text(body)


def test_a_wide_project_is_split_by_time_not_cropped(authed):
    """A project wider than a page becomes several chart pages — and the name column
    repeats on every one of them."""
    project_id, _, _ = _make_project(authed, tasks=12, duration=20)
    body = authed.get(
        f"/api/projects/{project_id}/export.pdf?include=gantt&zoom=day&locale=ru"
    ).content

    assert _pdf_pages(body) > 1
    # The first task's label stands on every chart page rather than only where its bar lies.
    from pypdf import PdfReader

    pages = [page.extract_text() or "" for page in PdfReader(io.BytesIO(body)).pages]
    assert all("Задача 1" in page for page in pages)


# --- the client copy ------------------------------------------------------------


@pytest.fixture
def shared(authed):
    """A project with an internal note, an internal remark and a public link."""
    project_id, category_id, task_ids = _make_project(authed, name="Публичный")
    _mutate(
        authed,
        project_id,
        {
            "type": "set_task_fields",
            "task_id": task_ids[0],
            "name": "Задача 1",
            "description": "",
            "internal_note": "СЕКРЕТ-ЗАМЕТКА",
        },
    )
    authed.post(
        f"/api/projects/{project_id}/comments",
        json={"body": "СЕКРЕТ-РЕПЛИКА", "internal": True},
    )
    authed.post(f"/api/projects/{project_id}/comments", json={"body": "Общая реплика"})
    link = authed.post(f"/api/projects/{project_id}/share").json()
    return project_id, link


def _link_parts(link: dict) -> tuple[str, str, str]:
    """The slugs and the query string from a public link.

    The token parameter's name is taken from the link itself rather than written here by
    hand: `app.sharing.TOKEN_PARAM` knows it, and a test that repeated that knowledge would
    diverge from it silently.
    """
    from urllib.parse import urlparse

    parsed = urlparse(link["url"])
    org_slug, project_slug = parsed.path.split("/p/")[-1].split("/")[:2]
    return org_slug, project_slug, parsed.query


def test_the_guest_copy_hides_notes_people_and_the_baseline(authed, shared, client):
    project_id, link = shared
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    org_slug, project_slug, query = _link_parts(link)

    response = client.get(
        f"/api/public/{org_slug}/{project_slug}/export.xlsx?{ALL}&locale=ru&{query}"
    )
    assert response.status_code == 200, response.text
    wb = load_workbook(io.BytesIO(response.content))

    # An export shows no more than the page it was called from shows: the public page hands
    # a guest neither the budget with its rates, nor the scorecard, nor the edit journal.
    assert "История правок" not in wb.sheetnames
    assert "Предложение" not in wb.sheetnames
    assert "Скоркард" not in wb.sheetnames

    header = [cell.value for cell in wb["Задачи"][1]]
    assert "Заметка" not in header
    assert "Исполнители" not in header
    assert "База: начало" not in header

    dump = json.dumps(
        [[cell.value for cell in row] for ws in wb.worksheets for row in ws.iter_rows()],
        ensure_ascii=False,
        default=str,
    )
    assert "СЕКРЕТ-ЗАМЕТКА" not in dump
    assert "СЕКРЕТ-РЕПЛИКА" not in dump


def test_the_member_copy_still_carries_what_the_guest_may_not_see(authed, shared):
    """The flip side of the previous test: without it that one would pass on an export
    that had lost the notes for everyone."""
    project_id, _ = shared
    category_id = authed.post(
        f"/api/projects/{project_id}/proposal/categories", json={"name": "Работы"}
    ).json()["id"]
    authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": "Вёрстка", "role": "Дизайнер", "effort": 4, "rate": 100},
    )

    body = authed.get(f"/api/projects/{project_id}/export.xlsx?{ALL}&locale=ru").content
    wb = load_workbook(io.BytesIO(body))

    assert "История правок" in wb.sheetnames
    assert "Предложение" in wb.sheetnames
    dump = json.dumps(
        [[cell.value for cell in row] for ws in wb.worksheets for row in ws.iter_rows()],
        ensure_ascii=False,
        default=str,
    )
    assert "СЕКРЕТ-ЗАМЕТКА" in dump
    assert "СЕКРЕТ-РЕПЛИКА" in dump


# --- the document for the client ------------------------------------------------
#
# The commercial proposal as a single PDF: only what the client is entitled to read.
# What is checked is not the layout but the promise: the names of the works, the total and
# the notes are in the file, while roles, risks, notes and discussion are not, by
# construction.


def _demote_own_membership(authed, db, role: str) -> None:
    """Changes a registered user's role directly in the membership row — by the same
    technique as in tests/test_project_api.py."""
    from sqlalchemy import select

    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def _grant_project_access(authed, db, project_id: str) -> None:
    import uuid

    from app.models import ProjectAccess

    user_id = authed.get("/api/auth/me").json()["id"]
    db.add(ProjectAccess(project_id=uuid.UUID(project_id), user_id=uuid.UUID(user_id)))
    db.flush()


@pytest.fixture
def quoted(authed):
    """A project with a proposal whose row has everything filled in — both the
    client-facing and the internal parts — and with a discussion remark."""
    project_id, _, _ = _make_project(authed, name="Переезд офиса")
    authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"tax_rate_pct": 18, "currency": "eur", "notes": "Оценки по объёму.\nСтавки без лицензий."},
    )
    design = authed.post(
        f"/api/projects/{project_id}/proposal/categories",
        json={"name": "Дизайн", "description": "Понять и нарисовать"},
    ).json()["id"]
    build = authed.post(
        f"/api/projects/{project_id}/proposal/categories", json={"name": "Разработка"}
    ).json()["id"]
    logo = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{design}/tasks",
        json={"name": "Логотип"},
    ).json()["id"]
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={
            "description": "Знак и начертание",
            "details": "СЕКРЕТ-ПОДРОБНОСТИ",
            "role": "СЕКРЕТ-РОЛЬ",
            "effort": 2,
            "rate": 100,
            "notes": "СЕКРЕТ-ЗАМЕТКА",
            "risks": "СЕКРЕТ-РИСК",
            "assumptions": "СЕКРЕТ-ДОПУЩЕНИЕ",
        },
    )
    authed.post(
        f"/api/projects/{project_id}/proposal/tasks/{logo}/comments",
        json={"body": "СЕКРЕТ-РЕПЛИКА"},
    )
    layout = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{build}/tasks",
        json={"name": "Вёрстка"},
    ).json()["id"]
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{layout}", json={"effort": 3, "rate": 200}
    )
    return project_id


def test_the_client_document_reads_as_a_commercial_proposal(authed, quoted):
    response = authed.get(f"/api/projects/{quoted}/proposal/export.pdf?locale=ru")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.content.startswith(b"%PDF-")
    assert "no-store" in response.headers["cache-control"]

    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    # The project's name is in the file's name, in Cyrillic through RFC 5987.
    assert "%D0%9F%D0%B5%D1%80%D0%B5%D0%B5%D0%B7%D0%B4" in disposition

    text = _pdf_text(response.content)
    assert "Коммерческое предложение" in text
    assert "Acme" in text
    assert "Переезд офиса" in text
    # Sections with a description, works with a description.
    assert "Дизайн" in text and "Понять и нарисовать" in text
    assert "Логотип" in text and "Знак и начертание" in text
    assert "Вёрстка" in text
    # 2 x 100 + 3 x 200 = 800; 18% tax is 144; 944 in total.
    assert "800 EUR" in text
    assert "Налог 18%" in text and "144 EUR" in text
    assert "944 EUR" in text
    # The notes — one item per line.
    assert "Оценки по объёму." in text
    assert "Ставки без лицензий." in text
    # Valid for thirty days from the document's date.
    assert "Действительно до" in text


def test_the_client_document_carries_nothing_marked_internal(authed, quoted):
    """The role, details, notes, risks, a row's assumptions and the discussion are the
    internal kitchen; the document's rows have no fields for them."""
    text = _pdf_text(
        authed.get(f"/api/projects/{quoted}/proposal/export.pdf?locale=ru").content
    )
    assert "СЕКРЕТ" not in text


@pytest.mark.parametrize(
    "locale,title",
    [("az", "Kommersiya təklifi"), ("en", "Commercial proposal"), ("ru", "Коммерческое предложение")],
)
def test_the_client_document_speaks_the_asked_language(authed, quoted, locale, title):
    body = authed.get(f"/api/projects/{quoted}/proposal/export.pdf?locale={locale}").content
    assert title in _pdf_text(body)


def test_the_client_document_is_refused_to_a_client(authed, quoted, db):
    """A client was promised deadlines and scope, not rates: the document for them is
    prepared by the contractor. They see the project (the grant is there) but the document
    is a 403, not a 404."""
    _demote_own_membership(authed, db, "client")
    _grant_project_access(authed, db, quoted)

    assert authed.get(f"/api/projects/{quoted}").status_code == 200
    response = authed.get(f"/api/projects/{quoted}/proposal/export.pdf")
    assert response.status_code == 403
    assert response.json()["detail"] == "forbidden"


def test_a_viewer_still_gets_the_client_document(authed, quoted, db):
    """The flip side: the right to read a proposal belongs to every member rather than to
    the writing ones alone — a viewer sends the document just the same."""
    _demote_own_membership(authed, db, "viewer")
    assert authed.get(f"/api/projects/{quoted}/proposal/export.pdf").status_code == 200


def test_an_empty_proposal_is_refused_rather_than_rendered_blank(authed):
    project_id, _, _ = _make_project(authed)
    response = authed.get(f"/api/projects/{project_id}/proposal/export.pdf")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_empty"


def test_the_client_document_counts_against_the_export_limit(authed, quoted, monkeypatch):
    """One counter for every export: for the server this is the same kind of PDF assembly."""
    from app.api import export_routes

    monkeypatch.setattr(export_routes, "EXPORTS_PER_MINUTE", 1)
    assert authed.get(f"/api/projects/{quoted}/export.pdf?include=tasks").status_code == 200
    refused = authed.get(f"/api/projects/{quoted}/proposal/export.pdf")
    assert refused.status_code == 429
    assert refused.json()["detail"] == "rate_limited"


def test_a_long_proposal_spans_pages_without_losing_a_row(authed):
    """The table carries over to the next page rather than being cut off: the last work is
    in the file, and the table's header repeats on every page."""
    project_id, _, _ = _make_project(authed)
    category_id = authed.post(
        f"/api/projects/{project_id}/proposal/categories", json={"name": "Работы"}
    ).json()["id"]
    for i in range(70):
        task_id = authed.post(
            f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
            json={"name": f"Работа {i + 1}"},
        ).json()["id"]
        authed.patch(
            f"/api/projects/{project_id}/proposal/tasks/{task_id}",
            json={"effort": 1, "rate": 10, "description": "Описание строки"},
        )

    body = authed.get(f"/api/projects/{project_id}/proposal/export.pdf?locale=ru").content
    from pypdf import PdfReader

    pages = [page.extract_text() or "" for page in PdfReader(io.BytesIO(body)).pages]
    assert len(pages) > 1
    assert any("Работа 70" in page for page in pages)
    assert all("Сумма" in page for page in pages)
    assert "700 USD" in pages[-1]


# --- refusals ------------------------------------------------------------------


def test_an_unknown_section_is_refused_by_the_schema(authed):
    project_id, _, _ = _make_project(authed)
    response = authed.get(f"/api/projects/{project_id}/export.pdf?include=payroll")
    assert response.status_code == 422


def test_an_empty_selection_is_refused_rather_than_silently_meaning_everything(authed):
    project_id, _, _ = _make_project(authed)
    response = authed.get(f"/api/projects/{project_id}/export.pdf")
    assert response.status_code == 422
    assert response.json()["detail"] == "export_empty_selection"


def test_a_project_beyond_the_task_ceiling_is_refused_before_the_work_starts(
    authed, monkeypatch
):
    from app.api import export_routes

    monkeypatch.setattr(export_routes, "MAX_TASKS", 1)
    project_id, _, _ = _make_project(authed, tasks=3)
    response = authed.get(f"/api/projects/{project_id}/export.pdf?include=tasks")
    assert response.status_code == 422
    assert response.json()["detail"] == "export_too_large"


# --- the scale rule -------------------------------------------------------------


@pytest.mark.parametrize(
    "months,expected",
    [(3, Zoom.DAY), (6, Zoom.WEEK), (12, Zoom.WEEK), (24, Zoom.MONTH)],
)
def test_the_default_zoom_is_the_most_detailed_that_still_fits(months, expected):
    days = months * 30
    assert budget.default_zoom(days, Orientation.LANDSCAPE) is expected
    assert budget.page_count(days, expected, Orientation.LANDSCAPE) <= budget.COMFORTABLE_PAGES


def test_the_server_picks_a_zoom_when_the_dialog_did_not(authed):
    """The route is called from outside the dialog too — by a bookmark, a script, a public link."""
    project_id, _, _ = _make_project(authed, tasks=4, duration=30)
    response = authed.get(f"/api/projects/{project_id}/export.pdf?include=gantt")
    assert response.status_code == 200
    assert _pdf_pages(response.content) <= budget.COMFORTABLE_PAGES


def test_a_scale_beyond_the_ceiling_is_refused_instead_of_forty_pages(authed):
    project_id, _, _ = _make_project(authed, tasks=20, duration=60)
    response = authed.get(
        f"/api/projects/{project_id}/export.pdf?include=gantt&zoom=day"
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "export_scale_too_wide"


def test_narrowing_the_period_brings_the_detailed_scale_back(authed):
    """That very exit: the day scale is unavailable across the whole project but available on a window."""
    project_id, _, _ = _make_project(
        authed, tasks=20, duration=60, start=date.today() - timedelta(days=30)
    )
    response = authed.get(
        f"/api/projects/{project_id}/export.pdf?include=gantt&zoom=day&period=next_4w"
    )
    assert response.status_code == 200
    assert _pdf_pages(response.content) == 1


def test_a_relative_plan_has_no_today_and_says_so(authed):
    """A plan with no dates has a "Day N" axis, and the window "the next 4 weeks" is
    undefined on it. That is the absence of a quantity rather than a refusal out of taste."""
    project_id = authed.post("/api/projects", json={"name": "Черновик"}).json()["id"]
    category_id = _mutate(
        authed, project_id, {"type": "create_category", "name": "Этап", "color": "#3b82f6"}
    )["op"]["category_id"]
    _mutate(
        authed,
        project_id,
        {
            "type": "create_task",
            "category_id": category_id,
            "name": "Задача",
            "start_date": "2001-01-01",
            "duration_days": 4,
        },
    )

    refused = authed.get(
        f"/api/projects/{project_id}/export.pdf?include=gantt&period=next_4w"
    )
    assert refused.status_code == 422
    assert refused.json()["detail"] == "export_period_undated"

    # "The whole project" works on the same axis: the refusal concerns only windows counted
    # from today.
    assert authed.get(
        f"/api/projects/{project_id}/export.pdf?include=gantt&period=all"
    ).status_code == 200


def test_portrait_needs_more_pages_than_landscape_at_the_same_scale():
    """A page's capacity is computed by a formula from the width rather than by a table of numbers."""
    days = 365
    for zoom in budget.ZOOMS:
        assert budget.page_count(days, zoom, Orientation.PORTRAIT) >= budget.page_count(
            days, zoom, Orientation.LANDSCAPE
        )
    assert budget.page_count(days, Zoom.DAY, Orientation.PORTRAIT) > budget.page_count(
        days, Zoom.DAY, Orientation.LANDSCAPE
    )


def test_the_default_zoom_is_never_forbidden_to_itself():
    """On a ten-year portfolio even the month scale goes past the ceiling — and it is
    allowed anyway: it has no less detailed neighbour, and a refusal there would mean the
    project cannot be exported at all, which is no longer protection from an unmanageable file."""
    for days in (30, 365, 1095, 5000, 20000):
        zoom = budget.default_zoom(days, Orientation.LANDSCAPE)
        assert budget.allowed(zoom, days, Orientation.LANDSCAPE)

    assert budget.page_count(5000, Zoom.MONTH, Orientation.LANDSCAPE) > budget.MAX_PAGES
    assert budget.allowed(Zoom.MONTH, 5000, Orientation.LANDSCAPE)


def test_a_decade_long_project_still_exports(authed):
    """The flip side: the rule is checked not only by arithmetic but by the route as well —
    otherwise the ceiling would one day move into it as a separate line."""
    project_id, _, _ = _make_project(authed, tasks=30, duration=180)
    response = authed.get(f"/api/projects/{project_id}/export.pdf?include=gantt")
    assert response.status_code == 200, response.text


def test_the_gantt_sheet_never_outgrows_the_column_ceiling():
    """The chart sheet is not cut into pages — it is one wide strip, and its limit is set by
    the number of columns."""
    for days in (30, 365, 1095, 5000):
        zoom = budget.default_zoom_for_xlsx(days)
        assert budget.columns_for(days, zoom) <= budget.MAX_XLSX_COLUMNS


def test_the_window_of_a_period_never_leaves_the_project(authed):
    whole = budget.Window(date(2026, 1, 1), date(2026, 12, 31))
    today = date(2026, 6, 1)
    for period in Period:
        window = budget.resolve_window(period, whole, today, dated=True)
        assert whole.start <= window.start <= window.end <= whole.end


def test_a_project_entirely_in_the_past_still_gets_a_window(authed):
    """An empty scale is a page with nothing on it; better to show the project's end than
    emptiness."""
    whole = budget.Window(date(2024, 1, 1), date(2024, 3, 1))
    window = budget.resolve_window(Period.NEXT_4W, whole, date(2026, 6, 1), dated=True)
    assert window.start == window.end == whole.end


# --- the scorecard: metrics with different histories -----------------------------
#
# Metrics appear and are removed (see the scorecard_signal_cleanup migration), while
# snapshots of past weeks are immutable: a metric created in August has no July snapshots
# and never will. That means the set of weeks differs between metrics, and the table must
# survive that.


def _metric(key: str, history: list[tuple[str, float]], value=0.0, status="ok") -> dict:
    return {
        "key": key,
        "value": value,
        "status": status,
        "history": [
            {"week_start": week, "value": point, "status": "ok"} for week, point in history
        ],
    }


def test_the_week_columns_are_the_union_across_metrics():
    """Otherwise a younger metric would cut everyone else's history short."""
    old = _metric("overdue_tasks", [("2026-08-03", 1), ("2026-08-10", 2)])
    young = _metric("finish_drift", [("2026-08-10", 3)])

    weeks = align_weeks([old, young], date(2026, 8, 17))

    assert weeks == [date(2026, 8, 3), date(2026, 8, 10), date(2026, 8, 17)]


def test_a_metric_without_a_snapshot_gets_a_gap_not_a_shift():
    """A dash in its own place rather than a shift of the neighbouring values to the left: a
    shifted row is a silently wrong document, and it would not be noticed right away."""
    old = _metric("overdue_tasks", [("2026-08-03", 1), ("2026-08-10", 2)], value=5)
    young = _metric("finish_drift", [("2026-08-10", 3)], value=7)
    weeks = align_weeks([old, young], date(2026, 8, 17))

    assert metric_row(old, weeks) == ([1, 2, 5], ["ok", "ok", "ok"])
    # A young metric's first column is empty, and its single snapshot stands under its own
    # week — the second, not the first.
    values, statuses = metric_row(young, weeks)
    assert values == [None, 3, 7]
    assert statuses == ["no_data", "ok", "ok"]


def test_a_first_metric_without_history_does_not_collapse_the_table():
    """That very case, which does not arise today only because of the order of the metrics in
    the migration: the weeks used to be taken from the first metric, and a young one at
    position zero would have collapsed the table into a single column."""
    young = _metric("finish_drift", [])
    old = _metric("overdue_tasks", [("2026-08-03", 1), ("2026-08-10", 2)])

    weeks = align_weeks([young, old], date(2026, 8, 17))

    assert len(weeks) == 3
    assert metric_row(young, weeks) == ([None, None, 0.0], ["no_data", "no_data", "ok"])


def test_the_current_week_is_always_the_last_column():
    """Its value is live and is not taken from history — there may be no snapshot for it at all yet."""
    metric = _metric("overdue_tasks", [("2026-08-03", 1)], value=9, status="risk")
    weeks = align_weeks([metric], date(2026, 8, 17))

    assert weeks[-1] == date(2026, 8, 17)
    assert metric_row(metric, weeks) == ([1, 9], ["ok", "risk"])


def test_a_snapshot_for_the_current_week_does_not_double_the_column():
    """The current week's snapshot already exists (lazy committing when the scorecard is
    opened) — there is still one column, and it holds the live value."""
    metric = _metric("overdue_tasks", [("2026-08-17", 4)], value=6)
    weeks = align_weeks([metric], date(2026, 8, 17))

    assert weeks == [date(2026, 8, 17)]
    assert metric_row(metric, weeks) == ([6], ["ok"])


def test_an_unknown_metric_status_does_not_cost_the_whole_document():
    """The set of states lives in ScorecardStatus and changes along with the scorecard. A
    failure on an unknown one is a 500 on the whole file because of one cell."""
    assert theme.metric_cell("risk") == theme.METRIC_CELL["risk"]
    assert theme.metric_cell("brand_new") == theme.METRIC_CELL["no_data"]


# --- the dictionaries ------------------------------------------------------------


def test_every_language_has_every_label():
    """Dictionary completeness is checked here rather than by eye: a desync accumulates
    unnoticed and is discovered in an already exported file."""
    locales = available_locales()
    assert set(locales) >= {"az", "en", "ru"}

    reference = {(group, key) for group, keys in dictionary("az").items() for key in keys}
    for locale in locales:
        actual = {
            (group, key) for group, keys in dictionary(locale).items() for key in keys
        }
        assert actual == reference, f"the {locale} dictionary has drifted: {reference ^ actual}"


def test_every_mutation_has_a_name_in_the_history_dictionary():
    """The edit journal labels operations by name. A new operation with no label must not
    bring the document down — but there is no reason for it to turn silently into "Plan
    edit" while it is remembered here."""
    import re

    source = Path(__file__).resolve().parents[1] / "app" / "mutations.py"
    declared = set(re.findall(r'type: Literal\["([a-z_]+)"\]', source.read_text()))
    assert declared, "could not read the list of operations out of mutations.py"

    named = set(dictionary("ru")["event"]) - {"unknown"}
    assert declared <= named, f"no label for the operations: {sorted(declared - named)}"


def test_the_embedded_font_covers_all_three_languages():
    """ReportLab's built-in fonts are Latin-1: without an embedded Inter the document would
    be left with no letters in two of the three languages."""
    from reportlab.pdfbase.ttfonts import TTFont

    fonts = Path(__file__).resolve().parents[1] / "app" / "export" / "fonts"
    for file in ("Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf"):
        face = TTFont("probe", str(fonts / file)).face
        missing = [ch for ch in "АБВЯабвяəğşıİçöüÇÖÜ0123456789№◆·—" if ord(ch) not in face.charToGlyph]
        assert missing == [], f"{file} does not cover {missing}"
