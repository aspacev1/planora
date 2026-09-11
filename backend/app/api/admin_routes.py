"""The director's panel: who is registered and when they last used the product.

Access is decided not by a role within an organization — Role.OWNER only makes
sense inside one organization, and an installation may have any number of
organization owners — but by the director role (see app.director). This is a
property of the installation itself: the director need not belong to any of the
organizations they watch over.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.auth import current_user
from app.db import get_db
from app.director import is_director
from app.models import Membership, Organization, User

router = APIRouter(prefix="/api/admin", tags=["admin"])


def current_director(user: User = Depends(current_user)) -> User:
    """The same person as current_user, but admitted to the director's panel.

    A refusal is a 403, not a 404: the address names no one else's entity whose
    existence would be worth hiding. That the panel exists at all is already
    hidden from everyone else by the interface, which does not show the menu
    item (see UserOut.is_director in auth_routes.py).
    """
    if not is_director(user.email):
        raise HTTPException(status_code=403, detail="forbidden")
    return user


class AdminUserOut(BaseModel):
    id: str
    name: str
    email: str
    #: The registration date — the moment the account came into being.
    created_at: str
    #: The last time a request arrived with this person's session. `null` means
    #: no activity is visible yet: the account was created (or updated by a
    #: migration), but no request newer than the last refresh step has happened
    #: yet (see _LAST_USED_WRITE_STEP in app.auth).
    last_active_at: str | None
    #: The organizations the person belongs to, by name. Empty means they left
    #: them all, including their own, created at registration.
    organizations: list[str]


@router.get("/users", response_model=list[AdminUserOut])
def list_users(_: User = Depends(current_director), db: DbSession = Depends(get_db)):
    """Every account of the installation — the newest registrations first.

    Organizations are pulled in by one separate query and laid out by owner in
    memory rather than joined to the user list: a join would multiply a person's
    row by the number of their organizations and would require collapsing the
    duplicates right here.
    """
    users = db.scalars(select(User).order_by(User.created_at.desc(), User.id)).all()

    org_rows = db.execute(
        select(Membership.user_id, Organization.name).join(
            Organization, Organization.id == Membership.org_id
        )
    ).all()
    orgs_by_user: dict[uuid.UUID, list[str]] = {}
    for user_id, org_name in org_rows:
        orgs_by_user.setdefault(user_id, []).append(org_name)

    return [
        AdminUserOut(
            id=str(person.id),
            name=person.name,
            email=person.email,
            created_at=person.created_at.isoformat(),
            last_active_at=(
                person.last_active_at.isoformat() if person.last_active_at else None
            ),
            organizations=sorted(orgs_by_user.get(person.id, [])),
        )
        for person in users
    ]
