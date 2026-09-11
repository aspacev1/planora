"""Wave 3 regression tests: the service's availability and its operation.

What is checked here broke not for a user in a browser but for whoever deploys and
maintains an installation: a live-feed broadcast that went around half of the
writing routes, a registration hung on SMTP, a requirements.txt that had drifted
from uv.lock, a health check that stays green with a dead database.
"""

import re
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


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


# --- 3.4: the live feed covers every writing route -----------------------------


def test_every_writing_route_publishes_into_the_hub(authed, monkeypatch):
    """An undo, a batch rollback, settings, the plan and a comment — an event into the room.

    Until wave 3 only the mutation route published: neighbouring tabs learned about
    an undo and new settings only through a reload.
    """
    from app.api import project_routes

    published: list[dict] = []
    monkeypatch.setattr(
        project_routes.hub, "publish", lambda project_id, event: published.append(event)
    )
    # A commit inside _publish would close the test session's transaction — and the
    # test lives inside it. The publishing is unaffected: it is the next line.
    monkeypatch.setattr(project_routes, "_publish",
        lambda background, db, project_id, event: published.append(event))

    project_id = authed.post("/api/projects", json={"name": "Редизайн"}).json()["id"]
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    )
    authed.post(f"/api/projects/{project_id}/undo", json={})
    authed.patch(f"/api/projects/{project_id}", json={"shift_threshold_days": 5})
    authed.post(f"/api/projects/{project_id}/plan/approvals")
    authed.post(f"/api/projects/{project_id}/comments", json={"body": "Реплика"})

    kinds = [event["type"] for event in published]
    # A mutation publishes its own, old way — the four new ones are counted here.
    assert kinds.count("revision") >= 3  # the undo, the settings, the plan
    assert "comment" in kinds


def test_the_comment_event_carries_no_text(authed, monkeypatch):
    """A client sits in the room too: an event about a remark must not carry a body —
    an internal remark is filtered by the HTTP route, not by the socket."""
    from app.api import project_routes

    published: list[dict] = []
    monkeypatch.setattr(project_routes, "_publish",
        lambda background, db, project_id, event: published.append(event))

    project_id = authed.post("/api/projects", json={"name": "Редизайн"}).json()["id"]
    authed.post(
        f"/api/projects/{project_id}/comments",
        json={"body": "Бюджет трещит", "internal": True},
    )

    comment_events = [e for e in published if e["type"] == "comment"]
    assert comment_events == [{"type": "comment"}]


# --- 3.6: observability --------------------------------------------------------


def test_responses_carry_a_request_id(client):
    response = client.get("/api/health")
    assert response.headers.get("x-request-id")


def test_a_supplied_request_id_is_echoed_but_sanitised(client):
    response = client.get("/api/health", headers={"X-Request-ID": "abc-123"})
    assert response.headers["x-request-id"] == "abc-123"

    hostile = client.get("/api/health", headers={"X-Request-ID": "a\tb<evil>" + "x" * 200})
    echoed = hostile.headers["x-request-id"]
    assert len(echoed) <= 64
    assert re.fullmatch(r"[A-Za-z0-9_\-]+", echoed)


def test_readiness_asks_the_database(client, monkeypatch):
    assert client.get("/api/health/ready").json() == {"status": "ready"}

    import app.db as db_module

    class _DeadEngine:
        def connect(self):
            raise ConnectionError("the database is down")

    monkeypatch.setattr(db_module, "engine", _DeadEngine())
    assert client.get("/api/health/ready").status_code == 503
    # Liveness stays green meanwhile: a dead database is no reason to restart the
    # process.
    assert client.get("/api/health").status_code == 200


# --- 3.8: requirements.txt does not drift from uv.lock -------------------------


def test_vercel_requirements_match_uv_lock():
    """requirements.txt (Vercel) is pinned from uv.lock — and that is a promise from
    its own header. A divergence means production is built from different versions
    than local development and CI.
    """
    lock = tomllib.loads((REPO_ROOT / "backend" / "uv.lock").read_text())
    locked = {package["name"].lower(): package["version"] for package in lock["package"]}

    mismatches = []
    for line in (REPO_ROOT / "requirements.txt").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.\[\]-]+)==([A-Za-z0-9_.]+)", line)
        assert match, f"the line does not parse as a pin: {line!r}"
        name = match.group(1).split("[")[0].lower().replace("_", "-")
        version = match.group(2)
        if locked.get(name) != version:
            mismatches.append(f"{name}: requirements.txt={version}, uv.lock={locked.get(name)}")

    assert mismatches == [], (
        "requirements.txt has drifted from backend/uv.lock:\n" + "\n".join(mismatches)
    )


def test_the_config_route_names_live_availability(client):
    assert "live_enabled" in client.get("/api/config").json()
