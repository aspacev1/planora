"""The palette and measurements of an exported document.

The values were taken as numbers from `frontend/src/northstar-theme.css` and
`frontend/src/gantt/gantt.css`: the document must read as a continuation of the
screen rather than as a neighbouring product. A reference to the source stands
next to every group — when the theme is repainted, this is where to edit, and
finding this place must be easy.

The chart's rule carries over verbatim: **a fill means status and nothing else**,
while being overdue and being critical go on as overlays on top (the comment in
gantt.css explains why they must not be blended into one patch of colour).

Colours are stored as "RRGGBB" strings without a hash: in that form openpyxl
accepts them, while ReportLab gets them through `hex()` — the reverse
conversion would cost one call at each of the hundreds of drawing points.
"""

from reportlab.lib.colors import HexColor

# --- the product's theme (northstar-theme.css) -------------------------------

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

#: Text on a yellow backing. In the theme `--warn` serves as an outline and as a
#: figure at a large size; at 9 pt over `--warn-soft` it falls short of contrast,
#: so a darker tone is used for text (verified against `WARN_SOFT`).
WARN_TEXT = "B26A00"

# --- the chart (gantt.css) ----------------------------------------------------

FILL_PROGRESS = "6274E7"        # --gantt-fill-progress
FILL_PROGRESS_DONE = "4358D6"   # --gantt-fill-progress-done
FILL_PLANNED = "E9EEF5"         # --gantt-fill-planned
LINE_PLANNED = "8EA0BE"         # --gantt-line-planned
TEXT_PLANNED = "40506B"         # the label colour on an unfilled bar
FILL_BLOCKED = "D94C71"         # --gantt-fill-blocked, the light hatching stripe
FILL_BLOCKED_ALT = "C83E62"     # --gantt-fill-blocked, the dark hatching stripe
FILL_DONE = OK
ROW_LINE = "EDF0F4"             # --gantt-row-line

#: `--nonworking` is semi-transparent: `rgb(36 48 68 / 3.5%)`. A document has no
#: transparency, so the result of compositing it over white is used.
NONWORKING = "F2F4F7"

#: The ghost of the baseline plan. A separate tone from `NONWORKING`: they lie on
#: top of each other on a non-working day, and equal values would merge them
#: into one patch.
BASELINE_GHOST = "EDF0F4"

#: The column of today's date on an Excel sheet. On the PDF chart "today" is a
#: line, but a workbook has no lines, only a cell fill.
TODAY_CELL = "FFE4EC"

#: A dependency arrow. Lighter than `BORDER_STRONG`: nineteen arrows at full
#: contrast cross the chart out and compete with the bars for attention.
ARROW = "C2CBDB"

#: The backing of an even table row. Lighter than `BG_SUBTLE`: the alternation
#: must only lead the eye along a row, not split the table into two tables.
ZEBRA = "FAFBFD"

#: The bar's fill by status: (fill, outline or None, label colour).
STATUS_BAR: dict[str, tuple[str, str | None, str]] = {
    "planned": (FILL_PLANNED, LINE_PLANNED, TEXT_PLANNED),
    "in_progress": (FILL_PROGRESS, None, SURFACE),
    "done": (FILL_DONE, None, SURFACE),
    "blocked": (FILL_BLOCKED, None, SURFACE),
}

#: The status chip in a table: (background, text). The theme's soft tones rather
#: than the chart's fills: in a table row a full-colour patch competes with the
#: text of the neighbouring cells.
STATUS_CHIP: dict[str, tuple[str, str]] = {
    "planned": (TAG_GRAY, TEXT_MUTED),
    "in_progress": (ACCENT_SOFT, ACCENT),
    "done": (OK_SOFT, OK),
    "blocked": (DANGER_SOFT, DANGER_STRONG),
}

#: The colour of a scorecard cell by the metric's state: (background, text). The
#: keys are `ScorecardStatus` values, all four. `warn` is "between the target and
#: the threshold", `risk` is "worse than the threshold" (see
#: `app.scorecard.metric_status`), and they must not be confused: a yellow week
#: and a red one mean different decisions.
METRIC_CELL: dict[str, tuple[str, str]] = {
    "ok": (OK_SOFT, OK),
    "warn": (WARN_SOFT, WARN_TEXT),
    "risk": (DANGER_SOFT, DANGER_STRONG),
    "no_data": (TAG_GRAY, TEXT_FAINT),
}


def metric_cell(status: str) -> tuple[str, str]:
    """The colour of a scorecard cell. An unknown state is treated as "no data".

    A function rather than a lookup by key: the set of states lives in
    `ScorecardStatus` and changes along with the scorecard, while a failure here
    is a `KeyError` in the middle of assembly — that is, a 500 on the whole
    document because of one cell. A grey dash instead of a colour is an
    incomparably smaller misfortune.
    """
    return METRIC_CELL.get(status, METRIC_CELL["no_data"])


# --- fonts --------------------------------------------------------------------

FONT = "Inter"
FONT_MEDIUM = "Inter-SemiBold"
FONT_BOLD = "Inter-Bold"

#: The family name for Excel. The workbook is opened on the recipient's machine,
#: where Inter may not be installed at all — but substituting "Arial" in advance
#: would mean handing a foreign font to whoever does have Inter. Excel falls back
#: to a system font by itself.
XLSX_FONT = "Inter"


def rl(color: str) -> HexColor:
    """A colour for ReportLab. No cache needed: HexColor parses six characters."""
    return HexColor(f"#{color}")
