import os
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.config import get_settings


class Base(DeclarativeBase):
    pass


# A connection pool makes sense where there is one long-lived process: under
# docker-compose and a local uvicorn a connection is opened once and reused,
# while pool_pre_ping weeds out the ones the database has closed on its own.
#
# In serverless there is not one process but as many as the platform decided to
# spin up under load, and each would hold a pool of its own. Postgres counts
# connections globally, so that arrangement hits the server's limit at quite
# modest traffic. NullPool releases the connection right after the query; reuse
# does not disappear in the process — it is taken over by an external pooler
# (with Neon and Supabase that is the address with `-pooler`, and that is what
# belongs in DATABASE_URL on Vercel).
#
# prepare_threshold=None turns server-side prepared statements off. psycopg
# creates them by itself after the fifth repetition of a query, but they live
# inside a Postgres session, and a pooler in transaction mode hands different
# requests different sessions — so a query finds something prepared that does
# not exist in its session ("prepared statement _pg3_0 already exists" from the
# other side). Recent pgbouncer versions handle this, but there is no reason to
# depend on the version of someone else's pooler.
#
# VERCEL is set by the platform itself; there is no need to set it by hand.
_engine_options: dict[str, object] = (
    {"poolclass": NullPool, "connect_args": {"prepare_threshold": None}}
    if os.getenv("VERCEL")
    else {"pool_pre_ping": True}
)

engine = create_engine(get_settings().database_url, **_engine_options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
