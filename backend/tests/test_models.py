from datetime import date, datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.calendar import WEEKDAYS_MON_FRI
from app.models import (
    Category,
    Comment,
    Membership,
    Organization,
    Project,
    ShareLink,
    Task,
    User,
)
from app.security import hash_password


def test_organization_defaults_come_from_the_spec(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()

    assert org.default_locale == "az"
    assert org.working_days == WEEKDAYS_MON_FRI
    assert org.default_shift_threshold_days == 2
    assert org.holiday_calendar == []


def test_project_overrides_are_null_by_default(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()

    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()

    # null means "inherit" rather than "empty" — there must be no copies of the organization's values
    assert project.working_days is None
    assert project.shift_threshold_days is None
    assert project.timezone is None


def test_task_belongs_to_a_category_and_keeps_its_position(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    category = Category(project_id=project.id, name="Design", color="#3b82f6", position=0)
    db.add(category)
    db.flush()

    task = Task(
        project_id=project.id,
        category_id=category.id,
        name="Logo",
        start_date=date(2026, 3, 4),
        duration_days=5,
        position=0,
    )
    db.add(task)
    db.flush()

    assert task.criticality == "normal"
    assert task.progress_pct == 0
    assert task.status == "planned"
    assert task.baseline_start is None


def test_membership_role_outside_the_enum_is_refused_by_the_database(db):
    """The column was a free String(16): anything landed in it, while Role(...) on
    such a value raised ValueError — that is, a 500."""
    org = Organization(name="Acme", slug="acme")
    user = User(email="a@example.com", password_hash=hash_password("x"), name="A")
    db.add_all([org, user])
    db.flush()

    # SAVEPOINT: only the failed insert is rolled back, not the fixture's transaction
    # around the whole test.
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(Membership(org_id=org.id, user_id=user.id, role="шеф"))
            db.flush()

    db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
    db.flush()


def test_comment_has_exactly_one_kind_of_author(db):
    """The author is either a member or a guest — and never both at once or neither.

    Both columns are nullable individually, so "exactly one" is held only by the
    CHECK. Without it an entry with no author gets into the table at all and surfaces
    in the feed with an empty signature.
    """
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    user = User(email="a@b.c", password_hash=hash_password("s3cret-pass"), name="Alex")
    db.add(user)
    db.flush()

    db.add(Comment(project_id=project.id, author_user_id=user.id, body="ok"))
    db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(Comment(project_id=project.id, body="ничей"))
            db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                Comment(
                    project_id=project.id,
                    author_user_id=user.id,
                    guest_name="Гость",
                    body="оба сразу",
                )
            )
            db.flush()


def test_comment_without_a_task_belongs_to_the_project(db):
    """task_id is nullable: a remark is sometimes on the whole project rather than on a row."""
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()

    comment = Comment(project_id=project.id, guest_name="Гость", body="привет")
    db.add(comment)
    db.flush()

    assert comment.task_id is None
    assert comment.created_at is not None


def test_project_has_at_most_one_active_share_link(db):
    """A project has one address in force: a second would mean two different
    addresses and the question of which of them is the main one. There may be any
    number of revoked ones meanwhile — that is the record of which address died when,
    not litter."""
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()

    link = ShareLink(project_id=project.id, token="tok-1")
    db.add(link)
    db.flush()

    assert link.comments_enabled is True
    assert link.revoked_at is None

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(ShareLink(project_id=project.id, token="tok-2"))
            db.flush()

    # And after a revocation the place is freed: publishing anew is an ordinary thing.
    link.revoked_at = datetime.now(timezone.utc)
    db.flush()
    db.add(ShareLink(project_id=project.id, token="tok-3"))
    db.flush()

