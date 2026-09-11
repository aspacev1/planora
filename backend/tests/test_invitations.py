"""Invitations as a domain: issuing, revoking, reissuing and accepting.

The tests hit the module's functions rather than HTTP: the same rules apply both to
accepting by link and to registering through one, while the HTTP layer of those two
paths differs. What the specification requires to be kept explicitly in tests is checked
separately: the token lies as a hash, an accepted invitation does not fire a second
time, the role from the link is not substituted, the limit fires.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.auth import register
from app.config import get_settings
from app.invitations import (
    InvitationError,
    Status,
    accept,
    by_token,
    create,
    reissue,
    revoke,
    status_of,
)
from app.models import Invitation, Membership, Project, ProjectAccess, Role
from app.orgs import member_of, remove_membership
from app.projects import create_project
from app.security import hash_token

def granted_project_ids(db, *, user_id):
    """The projects a person has explicit access to — through a test's eyes."""
    return set(
        db.scalars(select(ProjectAccess.project_id).where(ProjectAccess.user_id == user_id)).all()
    )

NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)


def _owner(db, *, name="Acme", email="owner@example.com"):
    user = register(db, name=name, email=email, password="s3cret-pass")
    db.flush()
    membership = db.scalar(select(Membership).where(Membership.user_id == user.id))
    return user, membership.org_id


def _invite(
    db, org_id, inviter_id, *, role="viewer", emails=("guest@example.com",), projects=(), now=NOW
):
    [(invitation, token)] = create(
        db,
        org_id=org_id,
        inviter_id=inviter_id,
        role=role,
        emails=list(emails),
        project_ids=list(projects),
        now=now,
    )
    return invitation, token


def test_the_token_is_stored_hashed_and_never_in_the_open(db):
    owner, org_id = _owner(db)
    invitation, token = _invite(db, org_id, owner.id)

    assert invitation.token_hash != token
    assert invitation.token_hash == hash_token(token)
    # The direct consequence: an invitation can be found only by presenting the token.
    assert by_token(db, token).id == invitation.id
    assert by_token(db, "не тот токен") is None


def test_an_invitation_without_an_address_belongs_to_whoever_holds_the_link(db):
    owner, org_id = _owner(db)
    [(invitation, token)] = create(
        db, org_id=org_id, inviter_id=owner.id, role="viewer", emails=[], project_ids=[], now=NOW
    )
    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    assert invitation.email is None
    accept(db, invitation, user=stranger, now=NOW)
    assert db.scalar(
        select(Membership).where(Membership.user_id == stranger.id, Membership.org_id == org_id)
    ) is not None


def test_accepting_creates_a_membership_with_the_role_from_the_invitation(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, role="viewer")
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    membership = accept(db, invitation, user=guest, now=NOW)

    # The role is fixed at the moment of the invitation: whoever accepts influences it in
    # no way — neither by their address nor by how they opened the link.
    assert membership.role == Role.VIEWER
    assert invitation.accepted_at == NOW
    assert invitation.accepted_by == guest.id


def test_an_accepted_invitation_does_not_work_a_second_time(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    other = register(db, name="Other", email="other@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=other, now=NOW)
    assert error.value.code == "invite_accepted"


def test_an_expired_invitation_says_so_instead_of_failing_silently(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    later = NOW + timedelta(days=get_settings().invite_ttl_days + 1)
    assert status_of(invitation, later) is Status.EXPIRED
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=guest, now=later)
    assert error.value.code == "invite_expired"


def test_a_revoked_invitation_dies_immediately(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    revoke(db, invitation, now=NOW)
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=guest, now=NOW)
    assert error.value.code == "invite_revoked"


def test_an_accepted_invitation_reads_as_accepted_even_after_its_date(db):
    """The order of checks in status_of: an accepted one stays accepted after it expires too.

    Otherwise a person opening their own old link will go and ask for a new one instead of
    simply signing in.
    """
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    assert status_of(invitation, NOW + timedelta(days=365)) is Status.ACCEPTED


def test_an_invitation_addressed_to_someone_is_not_accepted_by_another_account(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=("guest@example.com",))
    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=stranger, now=NOW)
    assert error.value.code == "invite_wrong_email"
    assert invitation.accepted_at is None


def test_the_address_binds_regardless_of_case(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=("Guest@Example.com",))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    assert invitation.accepted_by == guest.id


def test_reissuing_kills_the_previous_link(db):
    owner, org_id = _owner(db)
    invitation, first = _invite(db, org_id, owner.id)

    second = reissue(db, invitation, now=NOW)

    assert second != first
    # The old link stops finding the invitation — otherwise there would be nothing to
    # revoke "that particular sent message" with.
    assert by_token(db, first) is None
    assert by_token(db, second).id == invitation.id


def test_reissuing_starts_the_lifetime_over(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    was = invitation.expires_at

    reissue(db, invitation, now=NOW + timedelta(days=3))

    assert invitation.expires_at > was


def test_an_accepted_invitation_cannot_be_reissued_or_revoked(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    with pytest.raises(InvitationError) as reissue_error:
        reissue(db, invitation, now=NOW)
    assert reissue_error.value.code == "invite_accepted"

    with pytest.raises(InvitationError) as revoke_error:
        revoke(db, invitation, now=NOW)
    assert revoke_error.value.code == "invite_accepted"


def test_revoking_twice_changes_nothing_and_is_not_an_error(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)

    revoke(db, invitation, now=NOW)
    first_time = invitation.revoked_at
    revoke(db, invitation, now=NOW + timedelta(hours=1))

    assert invitation.revoked_at == first_time


def test_a_second_invitation_to_the_same_address_reissues_the_live_one(db):
    """Two valid tokens for one address would mean that "that particular message" can no
    longer be revoked: a revocation would kill one link while the second kept working
    alongside it."""
    owner, org_id = _owner(db)
    first_invitation, first_token = _invite(db, org_id, owner.id)
    second_invitation, second_token = _invite(db, org_id, owner.id)

    assert second_invitation.id == first_invitation.id
    assert by_token(db, first_token) is None
    assert by_token(db, second_token).id == first_invitation.id
    assert db.scalar(select(Invitation).where(Invitation.org_id == org_id)) is not None


def test_a_new_invitation_is_issued_once_the_previous_one_is_accepted(db):
    """An accepted invitation is not reissued: a new one is issued in its place.

    Inviting the same address a second time is possible exactly once the person has left
    the organization — while they are inside, issuing answers `already_member`. That is
    the path walked here: accepted, left, invited anew.
    """
    owner, org_id = _owner(db)
    first_invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, first_invitation, user=guest, now=NOW)
    remove_membership(db, member_of(db, org_id=org_id, user_id=guest.id))

    second_invitation, _ = _invite(db, org_id, owner.id)

    assert second_invitation.id != first_invitation.id


def test_the_hourly_ceiling_stops_the_next_batch(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "2")
    get_settings.cache_clear()
    try:
        owner, org_id = _owner(db)
        create(
            db,
            org_id=org_id,
            inviter_id=owner.id,
            role="viewer",
            emails=["one@example.com", "two@example.com"],
            project_ids=[],
            now=NOW,
        )

        with pytest.raises(InvitationError) as error:
            _invite(db, org_id, owner.id, emails=("three@example.com",))
        assert error.value.code == "invite_rate_limited"

        # The ceiling is hourly rather than eternal: past the window it lets go.
        _invite(db, org_id, owner.id, emails=("three@example.com",), now=NOW + timedelta(hours=2))
    finally:
        get_settings.cache_clear()


def test_the_ceiling_counts_the_whole_batch_before_issuing_any_of_it(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "2")
    get_settings.cache_clear()
    try:
        owner, org_id = _owner(db)
        with pytest.raises(InvitationError):
            create(
                db,
                org_id=org_id,
                inviter_id=owner.id,
                role="viewer",
                emails=["one@example.com", "two@example.com", "three@example.com"],
                project_ids=[],
                now=NOW,
            )
        # A refusal before the first insert: a half-sent batch is worse than one refused
        # entirely — half the addresses would have to be worked out by eye.
        assert db.scalar(select(Invitation).where(Invitation.org_id == org_id)) is None
    finally:
        get_settings.cache_clear()


def test_the_ceiling_belongs_to_the_organization_not_to_the_installation(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "1")
    get_settings.cache_clear()
    try:
        first_owner, first_org = _owner(db, name="Acme", email="acme@example.com")
        second_owner, second_org = _owner(db, name="Globex", email="globex@example.com")

        _invite(db, first_org, first_owner.id, emails=("one@example.com",))
        _invite(db, second_org, second_owner.id, emails=("two@example.com",))
    finally:
        get_settings.cache_clear()


def test_a_client_invitation_grants_the_projects_it_names(db):
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    other = create_project(db, org_id=org_id, name="Launch")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="client", projects=(project.id,))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    assert granted_project_ids(db, user_id=guest.id) == {project.id}
    assert other.id not in granted_project_ids(db, user_id=guest.id)


def test_an_editor_invited_with_projects_is_scoped_to_them(db):
    """The selected projects narrow the membership as a whole, regardless of the role: an
    editor invited into particular projects has their access to the organization narrowed
    to those same ones — by the same project_access row as a client."""
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    other = create_project(db, org_id=org_id, name="Internal")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="editor", projects=(project.id,))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    membership = accept(db, invitation, user=guest, now=NOW)

    assert membership.role == Role.EDITOR
    assert membership.project_scoped is True
    assert granted_project_ids(db, user_id=guest.id) == {project.id}
    assert other.id not in granted_project_ids(db, user_id=guest.id)


def test_a_viewer_invited_without_projects_keeps_seeing_the_whole_org(db):
    """An empty list of projects narrows nothing: a viewer with nothing selected behaves
    exactly as they did before this capability appeared."""
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, role="viewer", projects=())
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    membership = accept(db, invitation, user=guest, now=NOW)

    assert membership.role == Role.VIEWER
    assert membership.project_scoped is False
    assert granted_project_ids(db, user_id=guest.id) == set()


def test_accepting_does_not_scope_the_membership_of_someone_already_inside(db):
    """Like the role, the narrowing of an existing membership is not touched by an
    invitation — otherwise an owner who carelessly opened their own link would end up
    locked inside a list of someone else's choosing."""
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    invitation, _ = _invite(db, org_id, owner.id, emails=(), role="editor", projects=(project.id,))

    membership = accept(db, invitation, user=owner, now=NOW)

    assert membership.role == Role.OWNER
    assert membership.project_scoped is False


def test_a_project_of_another_organization_cannot_be_granted(db):
    owner, org_id = _owner(db)
    _, foreign_org = _owner(db, name="Globex", email="globex@example.com")
    foreign = create_project(db, org_id=foreign_org, name="Secret")
    db.flush()

    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, role="client", projects=(foreign.id,))
    assert error.value.code == "project_not_found"


def test_an_unknown_role_is_refused_at_the_door(db):
    owner, org_id = _owner(db)
    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, role="superuser")
    assert error.value.code == "unknown_role"


def test_a_project_deleted_between_the_invitation_and_the_acceptance_is_skipped(db):
    """A reference to a vanished project is no reason to refuse a person entry."""
    owner, org_id = _owner(db)
    alive = create_project(db, org_id=org_id, name="Redesign")
    doomed = create_project(db, org_id=org_id, name="Cancelled")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="client", projects=(alive.id, doomed.id))
    db.delete(db.get(Project, doomed.id))
    db.flush()

    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    assert granted_project_ids(db, user_id=guest.id) == {alive.id}


def test_accepting_does_not_rewrite_the_role_of_an_existing_membership(db):
    """An invitation invites from the outside rather than rewriting the role of someone already inside.

    Otherwise an owner who carelessly opened their own link would demote themselves — and
    there would be nobody left to fix it. The invitation here is a link one specifically:
    issuing one to one's own address is rejected earlier, with the code `already_member`,
    while a link with no address goes to whoever presents it and does reach `accept`.
    """
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=(), role="viewer")

    membership = accept(db, invitation, user=owner, now=NOW)

    assert membership.role == Role.OWNER
    assert (
        len(db.scalars(select(Membership).where(Membership.user_id == owner.id)).all()) == 1
    )


def test_accepting_twice_over_does_not_duplicate_project_access(db):
    # Invitations are link ones: issuing does not let you invite by address someone who is
    # already inside (`already_member`), while a link with no address does reach
    # acceptance — and a second acceptance must leave one access to the project, not two.
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    first, _ = _invite(db, org_id, owner.id, role="client", emails=(), projects=(project.id,))
    accept(db, first, user=guest, now=NOW)
    second, _ = _invite(db, org_id, owner.id, role="client", emails=(), projects=(project.id,))
    accept(db, second, user=guest, now=NOW)

    rows = db.scalars(select(ProjectAccess).where(ProjectAccess.user_id == guest.id)).all()
    assert len(rows) == 1


def test_an_invitation_survives_acceptance_as_a_record_of_who_invited_whom(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    stored = db.get(Invitation, invitation.id)
    assert stored.invited_by == owner.id
    assert stored.accepted_by == guest.id


def test_an_empty_address_is_refused_rather_than_turned_into_a_link_invitation(db):
    owner, org_id = _owner(db)
    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, emails=("   ",))
    assert error.value.code == "invalid_email"


def test_the_same_address_twice_in_one_batch_produces_one_invitation(db):
    owner, org_id = _owner(db)
    issued = create(
        db,
        org_id=org_id,
        inviter_id=owner.id,
        role="viewer",
        emails=["guest@example.com", "GUEST@example.com"],
        project_ids=[],
        now=NOW,
    )
    assert len(issued) == 1


def test_a_random_uuid_is_not_a_token(db):
    assert by_token(db, str(uuid.uuid4())) is None
    assert by_token(db, "") is None


def test_the_owner_role_is_not_handed_out_by_an_invitation(db):
    """An owner is not appointed by an invitation.

    An owner governs the whole organization, and an invitation with no address
    additionally goes to whoever presents it: the owner would become anyone who opened a
    forwarded link. They are appointed individually and by a different action — PATCH
    /api/org/members. The refusal code is its own rather than a generic `unknown_role`:
    the role exists, it simply cannot be handed out this way.
    """
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="owner")

    assert failure.value.code == "role_not_invitable"


def test_an_address_already_inside_the_organization_is_refused(db):
    """There is nothing to invite someone already inside with: the invitation would change nothing.

    `accept` does not touch an existing membership's role — that is, such an invitation
    would look like an action while doing nothing. The inviter learns about that right
    away rather than after a week of waiting for the person to "finally come in".
    """
    owner, org_id = _owner(db)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.add(Membership(org_id=org_id, user_id=guest.id, role="viewer"))
    db.flush()

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, emails=("guest@example.com",))

    assert failure.value.code == "already_member"


def test_one_address_already_inside_refuses_the_whole_batch(db):
    """A refusal for the whole list, and before a single invitation has been issued.

    Otherwise some invitations would already exist by the time of the refusal, and
    resending the corrected list would issue them a second time — with new links in place
    of the ones just sent around.
    """
    owner, org_id = _owner(db)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.add(Membership(org_id=org_id, user_id=guest.id, role="viewer"))
    db.flush()

    with pytest.raises(InvitationError):
        create(
            db,
            org_id=org_id,
            inviter_id=owner.id,
            role="viewer",
            emails=["fresh@example.com", "guest@example.com"],
            project_ids=[],
            now=NOW,
        )

    assert db.scalars(select(Invitation).where(Invitation.org_id == org_id)).all() == []


def test_a_member_of_another_organization_is_still_invitable(db):
    """The check looks at this organization rather than at users in general.

    A person working in someone else's company is the most ordinary invitee: everyone who
    came off the street has an organization of their own.
    """
    owner, org_id = _owner(db)
    register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, emails=("stranger@example.com",))

    assert invitation.email == "stranger@example.com"


def test_a_bearer_invitation_is_not_measured_against_the_roster(db):
    """A link with no address has no recipient — there is nothing to compare against.

    Refusing it because "someone in the organization is already there" would mean
    forbidding the second means of delivery in every non-empty organization.
    """
    owner, org_id = _owner(db)

    invitation, _ = _invite(db, org_id, owner.id, emails=())

    assert invitation.email is None


def test_a_bearer_invitation_cannot_smuggle_the_owner_role_either(db):
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="owner", emails=())

    assert failure.value.code == "role_not_invitable"


def test_an_unknown_role_is_still_told_apart_from_a_forbidden_one(db):
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="admiral")

    assert failure.value.code == "unknown_role"
