"""A Jira Cloud REST API v3 client behind a thin protocol.

Thin for the same reason as app/ai/provider.py: the sync layer needs exactly
four things — "who am I", "which projects are visible", "which fields exist" and
"which issues matched a query" — and urllib instead of a library's wrapper
client avoids pulling in an extra dependency for HTTP the standard library
already speaks.

There is no network in the tests: the sync layer is checked against
`RecordedJiraClient` — not a stub "so it compiles" but a full implementation of
the same protocol as the production client.
"""

import base64
import json
import urllib.error
import urllib.request
from datetime import date
from typing import Protocol
from urllib.parse import urlencode

from app.jira.errors import JiraError
from app.jira.netguard import ensure_public_https


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refusing to follow redirects — the same technique as in app/ai/provider.py:
    the address is checked for being public before the request, and a 3xx response
    must not lead it around that check."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


_opener = urllib.request.build_opener(_NoRedirects())

#: The fields the sync layer needs for an epic or an issue. `parent` covers the
#: epic of a team-managed project; the classic "Epic Link" is a separate custom
#: field whose id is instance-specific and is found through list_fields() (see
#: app/jira/sync.py:resolve_epic_link_field).
ISSUE_FIELDS = (
    "summary",
    "description",
    "status",
    "priority",
    "duedate",
    "created",
    "issuetype",
    "parent",
)

#: The ceiling on pagination pages per call — not on the issues themselves (that
#: is held by max_results) but on the pages specifically: a broken or endless
#: Jira cursor must not turn one request into an eternal loop.
_MAX_PAGES = 200


class JiraClient(Protocol):
    def list_projects(self) -> list[dict]:
        """The projects visible to this account: [{key, id, name}, ...]."""
        ...

    def list_fields(self) -> list[dict]:
        """The instance's fields — the raw answer of /rest/api/3/field."""
        ...

    def search_issues(
        self, jql: str, *, fields: list[str], max_results: int
    ) -> list[dict]:
        """Issues by JQL, as raw Jira objects, no longer than max_results."""
        ...

    def update_issue_due_date(self, issue_key: str, due_date: date) -> None:
        """Pushes a task's due date to Jira — the "Push to Jira" button.

        The only writing call of this client: the other three read. Due Date
        only — Due Date has a system field on any Jira Cloud site, while Start
        Date exists only with Advanced Roadmaps, whose custom field this client
        does not deal with (see app/jira/sync.py:push_project).
        """
        ...


class HttpJiraClient:
    """Basic authentication: email + API token, the same way Jira Cloud accepts
    personal tokens (id.atlassian.com/manage-profile/security/api-tokens)."""

    def __init__(self, *, base_url: str, email: str, api_token: str, timeout: int):
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        credentials = f"{email}:{api_token}".encode()
        self._auth = "Basic " + base64.b64encode(credentials).decode()

    def _request(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None) -> dict:
        url = f"{self._base}{path}"
        if params:
            url += "?" + urlencode(params)
        # The address is checked on every request, not only when the connection
        # is saved: the host's DNS could have changed since (rebinding is a
        # standard SSRF technique). The import is local for the same reason as in
        # provider.py — not to create a cycle between modules.
        ensure_public_https(url)

        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": self._auth,
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with _opener.open(request, timeout=self._timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise JiraError(
                    "jira_unauthorized", f"Jira refused access ({error.code})"
                ) from error
            if error.code == 404:
                raise JiraError("jira_not_found", "Jira answered 404") from error
            raise JiraError("jira_refused", f"Jira answered {error.code}") from error
        except (urllib.error.URLError, OSError) as error:
            raise JiraError("jira_unreachable", str(error)) from error

        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise JiraError("jira_bad_json", "Jira's answer cannot be parsed as JSON") from error

    def list_projects(self) -> list[dict]:
        projects: list[dict] = []
        start = 0
        for _ in range(_MAX_PAGES):
            body = self._request(
                "GET",
                "/rest/api/3/project/search",
                params={"startAt": start, "maxResults": 50},
            )
            values = body.get("values", [])
            projects.extend(
                {"key": v.get("key"), "id": v.get("id"), "name": v.get("name")} for v in values
            )
            if body.get("isLast", True) or not values:
                break
            start += len(values)
        return projects

    def list_fields(self) -> list[dict]:
        body = self._request("GET", "/rest/api/3/field")
        # /field returns the list directly as the response body, not wrapped in
        # an object — the only API v3 endpoint of those needed here with that shape.
        return body if isinstance(body, list) else []

    def search_issues(self, jql: str, *, fields: list[str], max_results: int) -> list[dict]:
        issues: list[dict] = []
        start = 0
        page_size = min(100, max_results) or 1
        for _ in range(_MAX_PAGES):
            remaining = max_results - len(issues)
            if remaining <= 0:
                break
            body = self._request(
                "POST",
                "/rest/api/3/search",
                body={
                    "jql": jql,
                    "startAt": start,
                    "maxResults": min(page_size, remaining),
                    "fields": fields,
                },
            )
            page = body.get("issues", [])
            issues.extend(page)
            total = body.get("total")
            start += len(page)
            if not page or (total is not None and start >= total):
                break
        return issues[:max_results]

    def update_issue_due_date(self, issue_key: str, due_date: date) -> None:
        # PUT /issue answers 204 with no body on success — _request simply
        # returns {} for an empty response, and that is exactly what is needed here.
        self._request(
            "PUT",
            f"/rest/api/3/issue/{issue_key}",
            body={"fields": {"duedate": due_date.isoformat()}},
        )


class RecordedJiraClient:
    """Pre-arranged answers — the same technique as RecordedProvider in
    app/ai/provider.py. Everything that is not about the network is checked with them."""

    def __init__(
        self,
        *,
        projects: list[dict] | None = None,
        fields: list[dict] | None = None,
        issues: list[dict] | None = None,
        #: The keys of issues on which update_issue_due_date refuses — the test
        #: of a partial push failure: one issue rejected by Jira must not
        #: interrupt pushing the rest (see app/jira/sync.py:push_project).
        due_date_failures: frozenset[str] = frozenset(),
    ):
        self._projects = projects or []
        self._fields = fields or []
        self._issues = issues or []
        self._due_date_failures = due_date_failures
        self.search_calls: list[str] = []
        self.due_date_calls: list[tuple[str, date]] = []

    def list_projects(self) -> list[dict]:
        return self._projects

    def list_fields(self) -> list[dict]:
        return self._fields

    def search_issues(self, jql: str, *, fields: list[str], max_results: int) -> list[dict]:  # noqa: ARG002
        self.search_calls.append(jql)
        return self._issues[:max_results]

    def update_issue_due_date(self, issue_key: str, due_date: date) -> None:
        self.due_date_calls.append((issue_key, due_date))
        if issue_key in self._due_date_failures:
            raise JiraError("jira_refused", f"Jira rejected the date for {issue_key}")


__all__ = ["JiraClient", "HttpJiraClient", "RecordedJiraClient", "JiraError", "ISSUE_FIELDS"]
