"""Rate counters that live in the database.

Unlike app.rate_limit (process memory, a fuse against flooding the guest feed),
these counters guard sign-in and registration — that is, password guessing and
mass account creation. Such a limit has to survive a process restart and be
shared across all replicas, and the only shared storage in this architecture is
Postgres: the product deliberately has no external services (Redis, queues).

The precision here is not absolute: two concurrent requests may both slip
through right at the ceiling — and that is accepted. The point of the limit is
to make guessing orders of magnitude more expensive, not to count attempts down
to the last one.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DbSession

from app.models import ThrottleEvent


def _cutoff(window_seconds: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=window_seconds)


def _sweep(db: DbSession, bucket: str, window_seconds: int) -> None:
    # Only this key's own rows are swept: other windows may be longer, and a
    # shared cleanup by the shortest window would eat their events.
    db.execute(
        delete(ThrottleEvent).where(
            ThrottleEvent.bucket == bucket, ThrottleEvent.at < _cutoff(window_seconds)
        )
    )


def check(db: DbSession, bucket: str, *, limit: int, window_seconds: int) -> bool:
    """Whether the key fits under the ceiling. Writes nothing.

    limit <= 0 means "no limit": the switch an administrator uses to turn the
    counter off must not turn into "everything is forbidden".
    """
    if limit <= 0:
        return True
    _sweep(db, bucket, window_seconds)
    count = db.scalar(
        select(func.count())
        .select_from(ThrottleEvent)
        .where(ThrottleEvent.bucket == bucket, ThrottleEvent.at >= _cutoff(window_seconds))
    )
    return count < limit


def note(db: DbSession, bucket: str) -> None:
    """Records an attempt unconditionally.

    Separate from check, because sign-in counts only failures: counting
    successes would mean locking a person out for working from two devices; and
    a failure is only known after the password has been verified.
    """
    db.add(ThrottleEvent(bucket=bucket))
    db.flush()


def hit(db: DbSession, bucket: str, *, limit: int, window_seconds: int) -> bool:
    """Check and record in one motion — for limits where everything counts."""
    if limit <= 0:
        return True
    if not check(db, bucket, limit=limit, window_seconds=window_seconds):
        return False
    note(db, bucket)
    return True
