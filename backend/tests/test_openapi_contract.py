"""The API contract is pinned by a snapshot of `app.openapi()` in backend/openapi.json.

Any edit to routes, parameters or schemas changes the snapshot, and the test
demands that it be done deliberately: update the file and regenerate the frontend
types (frontend/src/api/schema.d.ts is built from this same snapshot,
`npm run gen:api`). That way contract drift stops being silent: it is visible in a
PR's diff and breaks CI if the frontend has not learned about the change.
"""

import json
import os
from pathlib import Path

from app.main import app

SNAPSHOT = Path(__file__).resolve().parents[1] / "openapi.json"

HOW_TO_UPDATE = (
    "the API contract has changed. If that is intended:\n"
    "  UPDATE_OPENAPI_SNAPSHOT=1 uv run pytest tests/test_openapi_contract.py\n"
    "  cd ../frontend && npm run gen:api\n"
    "and commit both files (backend/openapi.json, frontend/src/api/schema.d.ts)."
)


def _render(schema: dict) -> str:
    # sort_keys — so that the snapshot's diff does not depend on the order routes
    # were registered in; ensure_ascii=False — non-ASCII descriptions stay readable
    # in a diff.
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def test_openapi_matches_snapshot():
    current = _render(app.openapi())

    if os.environ.get("UPDATE_OPENAPI_SNAPSHOT") == "1":
        SNAPSHOT.write_text(current, encoding="utf-8")

    assert SNAPSHOT.exists(), f"there is no {SNAPSHOT} snapshot. {HOW_TO_UPDATE}"
    assert SNAPSHOT.read_text(encoding="utf-8") == current, HOW_TO_UPDATE
