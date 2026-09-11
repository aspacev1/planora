"""A project's public link: issuing, revoking, parsing the address.

The address itself is assembled here too — from `PUBLIC_BASE_URL` rather than
from the request's headers. The `Host` header is supplied by whoever came, and
a link assembled from it will one day go out in an email with somebody else's
domain; an environment variable is set by whoever deployed and is the same for
every request.
"""

import secrets
from datetime import datetime, timezone
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models import Organization, Project, ShareLink

# The public address: /p/<organization slug>/<project slug>. The token goes in
# the query rather than as part of the path, and that separation is not
# cosmetic. The path is what a person reads and recognizes the project by; the
# token is what makes revoking a link meaningful: without it "reissue the link"
# would not change the address at all, and the old link would not die but keep
# working.
PUBLIC_PATH_PREFIX = "/p"
TOKEN_PARAM = "s"


class SharingDisabled(Exception):
    """Public links are forbidden — by the installation or by an organization setting."""


def sharing_allowed(org: Organization) -> bool:
    """Whether public links are allowed for this organization.

    Two switches, and the order between them is one-way:
    `PUBLIC_SHARING_ENABLED` turns publishing off across the whole installation,
    and no organization setting overrides it. A closed perimeter is the decision
    of whoever deployed.
    """
    return get_settings().public_sharing_enabled and org.public_sharing_enabled


def active_link(db: DbSession, project: Project) -> ShareLink | None:
    return db.scalar(
        select(ShareLink).where(
            ShareLink.project_id == project.id, ShareLink.revoked_at.is_(None)
        )
    )


class AlreadyShared(Exception):
    """The project already has a live link — there is nothing to "create" here."""


class NotShared(Exception):
    """There is no live link — there is nothing to "reissue"."""


def create_link(db: DbSession, project: Project, org: Organization) -> ShareLink:
    """The first issue of a link. If one already exists — a refusal, not a silent reissue.

    Separating this from rotate_link is about idempotence in the worst case: two
    clicks on "Publish" (or a network retry) must not silently kill an address
    that has just been sent around. Killing an address is a separate, explicitly
    named action.
    """
    if active_link(db, project) is not None:
        raise AlreadyShared
    return issue_link(db, project, org)


def rotate_link(db: DbSession, project: Project, org: Organization) -> ShareLink:
    """Reissue: the old address dies instantly, the settings move across."""
    if active_link(db, project) is None:
        raise NotShared
    return issue_link(db, project, org)


def issue_link(db: DbSession, project: Project, org: Organization) -> ShareLink:
    """Issues a link, killing the previous one.

    The shared body of create_link and rotate_link. The comment setting moves to
    the new link: the person turned comments off deliberately, and reissuing the
    address is no reason to silently turn them back on.
    """
    if not sharing_allowed(org):
        raise SharingDisabled

    previous = active_link(db, project)
    comments_enabled = (
        previous.comments_enabled if previous is not None else org.default_comments_enabled
    )
    if previous is not None:
        revoke_link(db, project)

    link = ShareLink(
        project_id=project.id,
        token=secrets.token_urlsafe(32),
        comments_enabled=comments_enabled,
    )
    db.add(link)
    db.flush()
    return link


def revoke_link(db: DbSession, project: Project) -> ShareLink | None:
    """Extinguishes the link in force. The row stays: the address must answer
    "this link is no longer valid" rather than "there is no such project"."""
    link = active_link(db, project)
    if link is None:
        return None
    link.revoked_at = datetime.now(timezone.utc)
    db.flush()
    return link


def set_comments_enabled(db: DbSession, project: Project, enabled: bool) -> ShareLink | None:
    link = active_link(db, project)
    if link is None:
        return None
    link.comments_enabled = enabled
    db.flush()
    return link


def resolve(
    db: DbSession, *, org_slug: str, project_slug: str, token: str
) -> tuple[Organization, Project, ShareLink] | None:
    """The project behind a public address and token.

    Everything must match at once: the slugs name the project, the token proves
    the address was issued by the owner. A token that fits another project does
    not open this one — otherwise one valid link would be enough to read any
    project of the installation by substituting other people's slugs.

    There is no separate answer for "the slug exists but the token is wrong",
    and there will not be: it turns a tokenless address into a way of checking
    whether a project exists.
    """
    if not token:
        return None

    row = db.execute(
        select(Organization, Project, ShareLink)
        .join(Project, Project.org_id == Organization.id)
        .join(ShareLink, ShareLink.project_id == Project.id)
        .where(
            Organization.slug == org_slug,
            Project.slug == project_slug,
            ShareLink.token == token,
            ShareLink.revoked_at.is_(None),
        )
    ).first()
    if row is None:
        return None

    org, project, link = row
    # The switch applies to links already handed out as well: an organization
    # that turned publishing off expects the addresses it distributed to have
    # stopped opening, not merely that issuing new ones was closed.
    if not sharing_allowed(org):
        return None
    return org, project, link


def public_url(org: Organization, project: Project, link: ShareLink) -> str:
    base = get_settings().public_base_url.rstrip("/")
    path = f"{PUBLIC_PATH_PREFIX}/{quote(org.slug)}/{quote(project.slug)}"
    return f"{base}{path}?{TOKEN_PARAM}={quote(link.token)}"
