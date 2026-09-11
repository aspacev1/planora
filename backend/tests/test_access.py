import pytest

from app.access import (
    UNKNOWN_ROLE,
    Action,
    can,
    needs_project_grant,
    parse_role,
    require,
    visible_op,
)
from app.models import Role


def test_owner_can_do_everything():
    for action in Action:
        assert can(Role.OWNER, action, project_granted=True) is True


def test_editor_writes_projects_but_does_not_administer_the_org():
    assert can(Role.EDITOR, Action.PROJECT_WRITE) is True
    assert can(Role.EDITOR, Action.PROJECT_READ) is True
    assert can(Role.EDITOR, Action.ORG_ADMIN) is False


def test_viewer_reads_and_comments_only():
    assert can(Role.VIEWER, Action.PROJECT_READ) is True
    assert can(Role.VIEWER, Action.COMMENT) is True
    assert can(Role.VIEWER, Action.PROJECT_WRITE) is False


def test_client_reads_only_granted_projects():
    assert can(Role.CLIENT, Action.PROJECT_READ, project_granted=True) is True
    assert can(Role.CLIENT, Action.PROJECT_READ, project_granted=False) is False


def test_client_and_guest_never_see_the_internal_note():
    assert can(Role.CLIENT, Action.READ_INTERNAL_NOTE, project_granted=True) is False
    assert can(None, Action.READ_INTERNAL_NOTE, project_granted=True) is False
    assert can(Role.VIEWER, Action.READ_INTERNAL_NOTE) is True


def test_client_and_guest_never_read_the_proposal():
    """A client and a guest were promised deadlines and scope, not rates: the proposal
    and the client's document belong to members, the viewer included."""
    assert can(Role.CLIENT, Action.PROPOSAL_READ, project_granted=True) is False
    assert can(None, Action.PROPOSAL_READ, project_granted=True) is False
    assert can(Role.VIEWER, Action.PROPOSAL_READ) is True
    assert can(Role.EDITOR, Action.PROPOSAL_READ) is True


def test_guest_reads_the_shared_project_and_comments():
    assert can(None, Action.PROJECT_READ, project_granted=True) is True
    assert can(None, Action.COMMENT, project_granted=True) is True
    assert can(None, Action.PROJECT_WRITE, project_granted=True) is False


def test_the_proposal_is_internal_to_the_team():
    """The budget holds rates, cost and the conversation about the client: a reader of
    the project inside the team sees it, a client and a link-holding guest do not, even
    with a grant on the project. The same trimming the export already applies."""
    assert can(Role.OWNER, Action.PROPOSAL_READ) is True
    assert can(Role.EDITOR, Action.PROPOSAL_READ) is True
    assert can(Role.VIEWER, Action.PROPOSAL_READ) is True
    assert can(Role.CLIENT, Action.PROPOSAL_READ, project_granted=True) is False
    assert can(None, Action.PROPOSAL_READ, project_granted=True) is False


def test_require_raises_for_a_forbidden_action():
    with pytest.raises(PermissionError):
        require(Role.VIEWER, Action.PROJECT_WRITE)


def test_owner_succeeds_without_an_explicit_project_grant():
    # project_granted=False is the default value, and it is exactly what the routes
    # arrive with: owner is not in _NEEDS_GRANT and must not depend on a grant there is
    # nobody to issue today.
    for action in Action:
        assert can(Role.OWNER, action) is True


def test_comment_is_refused_to_client_and_guest_without_a_project_grant():
    assert can(Role.CLIENT, Action.COMMENT, project_granted=False) is False
    assert can(None, Action.COMMENT, project_granted=False) is False


def test_an_unknown_role_gets_nothing():
    """The matrix is locked by default: a value absent from Role does not even grant a
    guest's rights — otherwise a corrupted membership row would turn into a promotion to
    "link-holding guest"."""
    for action in Action:
        assert can(UNKNOWN_ROLE, action) is False
        assert can(UNKNOWN_ROLE, action, project_granted=True) is False


def test_parse_role_turns_a_broken_value_into_a_refusal_not_a_crash():
    # Role("шеф") raised ValueError — that is, a 500 before can() was even asked, and the
    # locked matrix turned out to be unreachable over HTTP.
    assert parse_role("owner") is Role.OWNER
    assert parse_role(None) is None
    assert parse_role("шеф") == UNKNOWN_ROLE
    assert can(parse_role("шеф"), Action.PROJECT_READ, project_granted=True) is False


# ---- The visibility of journal fields ----------------------------------------


def _create_task_op() -> dict:
    return {
        "type": "create_task",
        "task_id": "11111111-1111-1111-1111-111111111111",
        "name": "Logo",
        "internal_note": "тайный план",
    }


def test_visible_op_keeps_the_note_for_a_role_that_may_read_it():
    payload = _create_task_op()
    assert visible_op(payload, Role.EDITOR) == payload


def test_visible_op_strips_the_note_for_client_and_guest():
    payload = _create_task_op()

    for role in (Role.CLIENT, None):
        shown = visible_op(payload, role, project_granted=True)
        assert "internal_note" not in shown
        assert shown["name"] == "Logo"


def test_visible_op_does_not_mutate_the_stored_payload():
    # revision.op on the entry itself must not be touched: a future undo would restore
    # the task without its note.
    payload = _create_task_op()
    visible_op(payload, Role.CLIENT, project_granted=True)
    assert payload["internal_note"] == "тайный план"


def test_visible_op_strips_notes_from_tasks_inside_a_deleted_category():
    """The snapshot of a deleted category carries its tasks' notes — as a list.

    A walk over nested dicts silently fails on it: the note lies two levels deep — in a
    dict inside a list inside the entry — and the client would get it along with the
    restore snapshot.
    """
    payload = {
        "type": "create_category",
        "category_id": "22222222-2222-2222-2222-222222222222",
        "name": "Design",
        "tasks": [_create_task_op()],
    }

    shown = visible_op(payload, Role.CLIENT, project_granted=True)

    assert "internal_note" not in shown["tasks"][0]
    assert shown["tasks"][0]["name"] == "Logo"
    # The stored entry is intact: an undo must bring the task back with its note.
    assert payload["tasks"][0]["internal_note"] == "тайный план"


def test_visible_op_passes_through_operations_without_a_note():
    payload = {"type": "delete_task", "task_id": "11111111-1111-1111-1111-111111111111"}
    assert visible_op(payload, Role.CLIENT, project_granted=True) is payload


def test_only_the_roles_that_are_invited_project_by_project_need_a_grant():
    """The list of roles that need explicit access is asked for from outside — the
    project list selects rows by it. The knowledge stays in access but has stopped
    being private."""
    assert needs_project_grant(Role.CLIENT) is True
    assert needs_project_grant(None) is True
    assert needs_project_grant(Role.VIEWER) is False
    assert needs_project_grant(Role.OWNER) is False


def test_a_scoped_membership_needs_a_grant_regardless_of_role():
    """`scoped` is a property of a particular membership (Membership.project_scoped)
    rather than of a role: an editor and a viewer can be narrowed to the selected
    projects without touching the permission matrix itself."""
    assert needs_project_grant(Role.EDITOR, scoped=True) is True
    assert needs_project_grant(Role.VIEWER, scoped=True) is True
    # With no narrowing, the previous behaviour: the whole organization by role alone.
    assert needs_project_grant(Role.EDITOR, scoped=False) is False
    assert needs_project_grant(Role.VIEWER, scoped=False) is False
    # client and guest are always narrowed; scoped adds nothing to them and takes nothing away.
    assert needs_project_grant(Role.CLIENT, scoped=False) is True
    assert needs_project_grant(None, scoped=False) is True


def test_owner_is_never_scoped_even_if_the_flag_is_somehow_set():
    """An owner governs the whole organization: an owner locked inside a handful of
    projects is an organization without an administrator. A flag on the membership row
    (after a narrowed editor was promoted, for instance) must not change that."""
    assert needs_project_grant(Role.OWNER, scoped=True) is False
    assert can(Role.OWNER, Action.PROJECT_READ, project_granted=False, scoped=True) is True


def test_a_scoped_editor_reads_only_the_granted_project():
    assert can(Role.EDITOR, Action.PROJECT_READ, project_granted=False, scoped=True) is False
    assert can(Role.EDITOR, Action.PROJECT_WRITE, project_granted=False, scoped=True) is False
    assert can(Role.EDITOR, Action.PROJECT_READ, project_granted=True, scoped=True) is True
    assert can(Role.EDITOR, Action.PROJECT_WRITE, project_granted=True, scoped=True) is True


def test_an_unscoped_editor_is_unaffected_by_the_new_parameter():
    # scoped=False is the same default value as before: narrowing does not switch itself on.
    assert can(Role.EDITOR, Action.PROJECT_READ) is True
    assert can(Role.EDITOR, Action.PROJECT_WRITE) is True


def test_team_pace_is_for_the_team_and_assessment_for_the_owner():
    """The per-person pace figures are seen by the team, the viewer included; the
    assessment ("missed it silently") only by the owner. A client and a guest see
    neither: they look at the plan, not at the contributors."""
    assert can(Role.OWNER, Action.TEAM_PACE_READ) is True
    assert can(Role.EDITOR, Action.TEAM_PACE_READ) is True
    assert can(Role.VIEWER, Action.TEAM_PACE_READ) is True
    assert can(Role.CLIENT, Action.TEAM_PACE_READ, project_granted=True) is False
    assert can(None, Action.TEAM_PACE_READ, project_granted=True) is False

    assert can(Role.OWNER, Action.TEAM_ASSESSMENT_READ) is True
    assert can(Role.EDITOR, Action.TEAM_ASSESSMENT_READ) is False
    assert can(Role.VIEWER, Action.TEAM_ASSESSMENT_READ) is False
    assert can(Role.CLIENT, Action.TEAM_ASSESSMENT_READ, project_granted=True) is False
