"""HTTP around the Jira integration. No business logic here — it is in app/jira/."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, parse_role
from app.api.deps import ProjectContext, project_context
from app.auth import current_user
from app.db import get_db
from app.jira.credentials import client_for, credential, drop_credential, save_credential
from app.jira.errors import JiraError
from app.jira.sync import import_project, push_project, sync_project
from app.models import JiraProjectLink, Membership, Organization, User
from app.orgs import current_membership

router = APIRouter(prefix="/api/jira", tags=["jira"])
project_router = APIRouter(prefix="/api/projects", tags=["jira"])


def _admin(membership: Membership = Depends(current_membership)) -> Membership:
    if not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")
    return membership


def _project_creator(membership: Membership = Depends(current_membership)) -> Membership:
    """The same boundary as creating a project by hand
    (project_routes.create_project): a narrowed membership has no pre-granted
    access to a project that does not exist yet, and cannot have one, while an
    import creates exactly such a project."""
    if not can(
        parse_role(membership.role), Action.PROJECT_WRITE, scoped=membership.project_scoped
    ):
        raise HTTPException(status_code=403, detail="forbidden")
    return membership


def _refuse(error: JiraError) -> HTTPException:
    """A Jira failure is not a 500, by the same rule as AI (see ai_routes._refuse)."""
    if error.code in {"jira_not_configured", "jira_not_linked"}:
        return HTTPException(status_code=409, detail=error.code)
    if error.code in {"jira_url_not_https", "jira_url_invalid", "jira_url_private"}:
        return HTTPException(status_code=422, detail=error.code)
    return HTTPException(status_code=502, detail=error.code)


# --- connection -------------------------------------------------------------


class JiraCredentialIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str = Field(min_length=1, max_length=300)
    email: str = Field(min_length=1, max_length=320)
    #: Empty means keep the previous token. The token is never handed outward,
    #: and demanding it in order to edit the address would be demanding the
    #: impossible.
    api_token: str = ""


class JiraCredentialOut(BaseModel):
    base_url: str
    email: str
    #: A flag only. The token itself is not here and cannot be.
    configured: bool


@router.get("/credential", response_model=JiraCredentialOut)
def read_credential(membership: Membership = Depends(_admin), db: DbSession = Depends(get_db)):
    row = credential(db, db.get(Organization, membership.org_id))
    if row is None:
        return JiraCredentialOut(base_url="", email="", configured=False)
    return JiraCredentialOut(base_url=row.base_url, email=row.email, configured=True)


@router.put("/credential", response_model=JiraCredentialOut)
def write_credential(
    payload: JiraCredentialIn,
    membership: Membership = Depends(_admin),
    db: DbSession = Depends(get_db),
):
    org = db.get(Organization, membership.org_id)
    try:
        row = save_credential(
            db, org, base_url=payload.base_url, email=payload.email, api_token=payload.api_token
        )
    except JiraError as error:
        raise _refuse(error)
    except ValueError:
        raise HTTPException(status_code=422, detail="jira_token_required")
    return JiraCredentialOut(base_url=row.base_url, email=row.email, configured=True)


@router.delete("/credential", status_code=204)
def delete_credential(membership: Membership = Depends(_admin), db: DbSession = Depends(get_db)):
    drop_credential(db, db.get(Organization, membership.org_id))


# --- projects and import -----------------------------------------------------


class JiraProjectOut(BaseModel):
    key: str
    name: str


@router.get("/projects", response_model=list[JiraProjectOut])
def list_jira_projects(
    membership: Membership = Depends(_project_creator), db: DbSession = Depends(get_db)
):
    org = db.get(Organization, membership.org_id)
    try:
        client = client_for(db, org)
        projects = client.list_projects()
    except JiraError as error:
        raise _refuse(error)
    return [
        JiraProjectOut(key=p.get("key", ""), name=p.get("name") or p.get("key", ""))
        for p in projects
    ]


class JiraImportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jira_project_key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    #: Empty means the default query (the whole project). A hand edit is the way
    #: to narrow the import, for example to open issues only.
    jql: str | None = Field(default=None, max_length=2000)


class JiraImportOut(BaseModel):
    project_id: str
    batch_id: str
    created_categories: int
    created_tasks: int


@router.post("/import", response_model=JiraImportOut, status_code=201)
def import_from_jira(
    payload: JiraImportIn,
    user: User = Depends(current_user),
    membership: Membership = Depends(_project_creator),
    db: DbSession = Depends(get_db),
):
    org = db.get(Organization, membership.org_id)
    try:
        client = client_for(db, org)
        project, batch_id, result = import_project(
            db,
            org=org,
            client=client,
            jira_project_key=payload.jira_project_key,
            name=payload.name,
            jql=payload.jql,
            actor=user,
        )
    except JiraError as error:
        raise _refuse(error)
    return JiraImportOut(
        project_id=str(project.id),
        batch_id=str(batch_id),
        created_categories=result.created_categories,
        created_tasks=result.created_tasks,
    )


# --- a project created from Jira ---------------------------------------------


class JiraLinkOut(BaseModel):
    linked: bool
    jira_project_key: str | None = None
    jql: str | None = None
    last_synced_at: str | None = None


def _link_out(link: JiraProjectLink | None) -> JiraLinkOut:
    if link is None:
        return JiraLinkOut(linked=False)
    return JiraLinkOut(
        linked=True,
        jira_project_key=link.jira_project_key,
        jql=link.jql,
        last_synced_at=link.last_synced_at.isoformat() if link.last_synced_at else None,
    )


@project_router.get("/{project_id}/jira", response_model=JiraLinkOut)
def read_jira_link(context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)):
    link = db.scalar(
        select(JiraProjectLink).where(JiraProjectLink.project_id == context.project.id)
    )
    return _link_out(link)


class JiraSyncOut(BaseModel):
    batch_id: str
    created_categories: int
    created_tasks: int
    updated_tasks: int


@project_router.post("/{project_id}/jira/sync", response_model=JiraSyncOut, status_code=201)
def sync_from_jira(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    context.require(Action.PROJECT_WRITE)
    try:
        result, batch_id = sync_project(
            db,
            org=context.org,
            client_factory=lambda: client_for(db, context.org),
            project=context.project,
            actor=context.user,
        )
    except JiraError as error:
        raise _refuse(error)
    return JiraSyncOut(
        batch_id=str(batch_id),
        created_categories=result.created_categories,
        created_tasks=result.created_tasks,
        updated_tasks=result.updated_tasks,
    )


class JiraPushFailure(BaseModel):
    issue_key: str
    code: str


class JiraPushOut(BaseModel):
    pushed: int
    unchanged: int
    failed: list[JiraPushFailure]


@project_router.post("/{project_id}/jira/push", response_model=JiraPushOut, status_code=201)
def push_to_jira(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """Pushes task dates to Jira. A refusal for one task (Jira rejected the
    date, the token has no rights to it) does not fail the whole request — it
    comes back in a `failed` list rather than in the response code: the other
    tasks went through anyway."""
    context.require(Action.PROJECT_WRITE)
    try:
        result = push_project(
            db,
            org=context.org,
            client_factory=lambda: client_for(db, context.org),
            project=context.project,
            actor=context.user,
        )
    except JiraError as error:
        raise _refuse(error)
    return JiraPushOut(
        pushed=result.pushed,
        unchanged=result.unchanged,
        failed=[JiraPushFailure(**item) for item in result.failed],
    )
