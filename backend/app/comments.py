"""Comments on a project and on an individual task.

A comment is not a mutation: it changes nothing in the plan, has no inverse
operation and does not land in the revision journal. That is why it lives in a
module of its own rather than as yet another branch in the operation registry,
where an `inverse` is mandatory.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models import Comment, Project, Task, User

# A guest's name is a signature under a remark, not text: a long name breaks the
# feed's layout without carrying meaning. It matches the column's length.
MAX_GUEST_NAME_LEN = 80


class CommentRejected(Exception):
    """A refusal to accept a comment.

    As with mutations, what goes outward is a machine code rather than prose:
    the server keeps no message dictionaries, the client composes them.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _clean_body(raw: str) -> str:
    body = raw.strip()
    if not body:
        raise CommentRejected("comment_empty", "пустой комментарий")
    if len(body) > get_settings().max_text_len:
        raise CommentRejected("comment_too_long", "комментарий длиннее допустимого")
    return body


def _clean_guest_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise CommentRejected("guest_name_required", "гость не назвал имени")
    return name[:MAX_GUEST_NAME_LEN]


def _resolve_task(db: DbSession, project: Project, task_id: uuid.UUID | None) -> uuid.UUID | None:
    if task_id is None:
        return None
    task = db.get(Task, task_id)
    # A task in someone else's project is indistinguishable from a nonexistent
    # one — by the same principle as in the routes: otherwise a comment becomes
    # a way of checking whether a task exists in another organization.
    if task is None or task.project_id != project.id:
        raise CommentRejected("task_not_found", "задача не найдена в этом проекте")
    return task.id


def add_comment(
    db: DbSession,
    project: Project,
    *,
    body: str,
    task_id: uuid.UUID | None = None,
    author: User | None = None,
    guest_name: str | None = None,
    internal: bool = False,
) -> Comment:
    """Adds a remark from a member or from a guest.

    Exactly one author: a member is signed by their account, a guest by the name
    they entered. Both at once or neither is the caller's error rather than bad
    input, so it is raised here as a ValueError rather than as a coded refusal.

    An internal remark is unavailable to a guest in both directions: they
    neither see it nor can write one. A guest with internal is an error in the
    calling code: the public route does not accept the flag at all.
    """
    if (author is None) == (guest_name is None):
        raise ValueError("у комментария должен быть ровно один автор: участник или гость")
    if internal and author is None:
        raise ValueError("внутренняя реплика не может быть гостевой")

    comment = Comment(
        project_id=project.id,
        task_id=_resolve_task(db, project, task_id),
        author_user_id=author.id if author is not None else None,
        guest_name=_clean_guest_name(guest_name) if guest_name is not None else None,
        body=_clean_body(body),
        internal=internal,
    )
    db.add(comment)
    db.flush()
    return comment


#: How many remarks are returned when the caller says nothing else, and what is
#: never exceeded. The ceiling is not decoration: otherwise a feed with years of
#: conversation arrives in full every time a card is opened.
DEFAULT_COMMENTS_LIMIT = 100
MAX_COMMENTS_LIMIT = 200


def list_comments(
    db: DbSession,
    project: Project,
    *,
    task_id: uuid.UUID | None = None,
    include_internal: bool = True,
    limit: int = DEFAULT_COMMENTS_LIMIT,
    before: uuid.UUID | None = None,
) -> Sequence[Comment]:
    """A project's feed, optionally that of a single task.

    Oldest first: a conversation is read top to bottom, unlike the revision
    journal, where the latest entry is what is wanted. What is returned is the
    tail of the conversation — the last `limit` remarks before the `before`
    cursor; "show earlier" pages backwards by passing the id of the oldest
    remark shown.

    The cursor is a (created_at, id) pair rather than a single timestamp: two
    remarks from one transaction are indistinguishable by time, and a page based
    on bare time would sometimes lose and sometimes duplicate one of them.

    include_internal=False is the feed through the eyes of a public-link guest:
    "aside" remarks do not reach it. The filter lives here rather than in the
    route: there are two routes serving the feed, and they must not diverge.
    """
    query = select(Comment).where(Comment.project_id == project.id)
    if task_id is not None:
        query = query.where(Comment.task_id == task_id)
    if not include_internal:
        query = query.where(Comment.internal.is_(False))

    if before is not None:
        anchor = db.get(Comment, before)
        if anchor is None or anchor.project_id != project.id:
            raise CommentRejected("comment_not_found", "курсор не найден в этом проекте")
        query = query.where(
            tuple_(Comment.created_at, Comment.id) < tuple_(anchor.created_at, anchor.id)
        )

    limit = max(1, min(limit, MAX_COMMENTS_LIMIT))
    rows = db.scalars(
        query.order_by(Comment.created_at.desc(), Comment.id.desc()).limit(limit)
    ).all()
    return list(reversed(rows))


def comment_counts(
    db: DbSession, project: Project, *, include_internal: bool = True
) -> dict[uuid.UUID, int]:
    """How many remarks each task of the project has.

    The counter sits on every row of the chart, so it is computed with one query
    per project rather than a query per task: with a hundred tasks the latter
    would mean a hundred trips to the database for one screen. Taking the whole
    feed for this will not do — it is returned as a tail of a hundred remarks
    (see list_comments), and a count based on it would lie precisely on those
    projects where there is a lot of conversation.

    Only tasks that have remarks are returned: zero is the absence of a key.
    Remarks on the project as a whole (`task_id is NULL`) are not counted at all
    — they belong to no row.

    `include_internal=False` is the count through the eyes of a public-link
    guest: they do not see "aside" remarks, and the number next to a task must
    not let slip that the team was discussing something.
    """
    query = (
        select(Comment.task_id, func.count())
        .where(Comment.project_id == project.id, Comment.task_id.is_not(None))
        .group_by(Comment.task_id)
    )
    if not include_internal:
        query = query.where(Comment.internal.is_(False))
    return {task_id: count for task_id, count in db.execute(query).all()}


def author_names(db: DbSession, comments: Sequence[Comment]) -> dict[uuid.UUID, str]:
    """The authors' names in one query, rather than a query per remark."""
    ids = {c.author_user_id for c in comments if c.author_user_id is not None}
    if not ids:
        return {}
    return {
        user.id: user.name for user in db.scalars(select(User).where(User.id.in_(ids))).all()
    }
