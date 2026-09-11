from datetime import date

import pytest

from app.comments import CommentRejected, add_comment, list_comments
from app.models import Category, Organization, Project, Task, User
from app.security import hash_password


@pytest.fixture
def project(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def author(db):
    user = User(email="a@b.c", password_hash=hash_password("s3cret-pass"), name="Alex")
    db.add(user)
    db.flush()
    return user


def _task(db, project) -> Task:
    category = Category(project_id=project.id, name="Design", color="#3b82f6", position=0)
    db.add(category)
    db.flush()
    task = Task(
        project_id=project.id,
        category_id=category.id,
        name="Логотип",
        start_date=date(2026, 3, 4),
        duration_days=5,
    )
    db.add(task)
    db.flush()
    return task


def test_reply_keeps_the_text_as_it_was_written(db, project, author):
    """The body is the user's content: no translation, no reformatting."""
    comment = add_comment(db, project, body="  Согласовано с клиентом  ", author=author)

    assert comment.body == "Согласовано с клиентом"
    assert comment.author_user_id == author.id
    assert comment.guest_name is None
    assert comment.task_id is None


def test_empty_reply_is_refused(db, project, author):
    """Spaces are not a remark. Otherwise the feed grows empty lines that can
    neither be read nor deleted."""
    with pytest.raises(CommentRejected) as refusal:
        add_comment(db, project, body="   \n  ", author=author)

    assert refusal.value.code == "comment_empty"


def test_reply_to_a_task_of_another_project_is_refused(db, project, author):
    """A task of another project is not a task of this one. Without the check a
    remark rides out into someone else's feed, and whoever is not shown that project
    will see it."""
    other = Project(org_id=project.org_id, name="Other", slug="other")
    db.add(other)
    db.flush()
    stranger = _task(db, other)

    with pytest.raises(CommentRejected) as refusal:
        add_comment(db, project, body="сюда", task_id=stranger.id, author=author)

    assert refusal.value.code == "task_not_found"


def test_thread_reads_from_older_to_newer(db, project, author):
    """A conversation is read top to bottom, unlike the revision journal."""
    for text in ("первое", "второе", "третье"):
        add_comment(db, project, body=text, author=author)

    assert [c.body for c in list_comments(db, project)] == ["первое", "второе", "третье"]


def test_the_task_thread_shows_only_its_own_replies(db, project, author):
    """A task card shows the conversation about it rather than everything at once.

    There is no filtering in the other direction: a project's feed is its whole
    conversation, remarks on rows included. Hiding them from it would mean
    introducing a second place one has to look into so as not to miss what was said.
    """
    task = _task(db, project)
    add_comment(db, project, body="о проекте", author=author)
    add_comment(db, project, body="о задаче", task_id=task.id, author=author)

    assert [c.body for c in list_comments(db, project)] == ["о проекте", "о задаче"]
    assert [c.body for c in list_comments(db, project, task_id=task.id)] == ["о задаче"]


def test_guest_signs_with_a_name(db, project):
    """A link-holding guest is signed by a name rather than by an account. There is
    no route to them yet, but the domain must be able to record one — otherwise
    public links would start with a rewrite of this module."""
    comment = add_comment(db, project, body="а когда сдача?", guest_name="Мария")

    assert comment.guest_name == "Мария"
    assert comment.author_user_id is None


def test_reply_without_any_author_is_refused(db, project):
    """Neither an account nor a name — there is nothing to sign the remark with. That
    is the caller's error rather than bad input: a route either knows the member or
    has received a guest's name, and it has no third case."""
    with pytest.raises(ValueError):
        add_comment(db, project, body="аноним")


def test_reply_signed_twice_is_refused_as_well(db, project, author):
    """A member pretending to be a guest is the same oversight from the other side,
    and the database constraint will not let that through either."""
    with pytest.raises(ValueError):
        add_comment(db, project, body="и так и так", author=author, guest_name="Мария")
