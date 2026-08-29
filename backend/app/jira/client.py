"""Клиент Jira Cloud REST API v3 за тонким протоколом.

Тонкий по той же причине, что у app/ai/provider.py: слою синхронизации нужны
ровно четыре вещи — «кто я», «какие проекты видны», «какие поля есть» и
«какие задачи нашлись по запросу», — и urllib вместо клиента-обёртки библиотеки
не тянет лишней зависимости ради HTTP, который и так умеет стандартная
библиотека.

Сети в тестах нет: слой синхронизации проверяется на `RecordedJiraClient` —
не заглушке «чтобы компилировалось», а полноправной реализации того же
протокола, что и боевой клиент.
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
    """Отказ следовать за редиректами — тем же приёмом, что у app/ai/provider.py:
    адрес проверяется на публичность до запроса, и ответ 3xx не должен уводить
    его в обход этой проверки."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


_opener = urllib.request.build_opener(_NoRedirects())

#: Поля, которых слою синхронизации достаточно для эпика или задачи. `parent`
#: покрывает эпик team-managed проекта; классический «Epic Link» — отдельное
#: пользовательское поле, чей id инстанс-специфичен и находится через
#: list_fields() (см. app/jira/sync.py:resolve_epic_link_field).
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

#: Потолок страниц пагинации на один вызов — не самих задач (тот держит
#: max_results), а именно страниц: битый или бесконечный курсор Jira не
#: должен превращать один запрос в вечный цикл.
_MAX_PAGES = 200


class JiraClient(Protocol):
    def list_projects(self) -> list[dict]:
        """Проекты, видимые этому аккаунту: [{key, id, name}, …]."""
        ...

    def list_fields(self) -> list[dict]:
        """Поля инстанса — сырой ответ /rest/api/3/field."""
        ...

    def search_issues(
        self, jql: str, *, fields: list[str], max_results: int
    ) -> list[dict]:
        """Задачи по JQL, сырые объекты Jira, не длиннее max_results."""
        ...

    def update_issue_due_date(self, issue_key: str, due_date: date) -> None:
        """Отправляет срок задачи в Jira — кнопка «Отправить в Jira».

        Единственный пишущий вызов этого клиента: остальные три читают.
        Только Due Date — у Due Date есть системное поле на любом сайте Jira
        Cloud, а Start Date есть лишь при Advanced Roadmaps, чьим
        пользовательским полем этот клиент не занимается (см.
        app/jira/sync.py:push_project).
        """
        ...


class HttpJiraClient:
    """Basic-аутентификация: email + API-токен, тем же способом, каким Jira
    Cloud принимает личные токены (id.atlassian.com/manage-profile/security/api-tokens)."""

    def __init__(self, *, base_url: str, email: str, api_token: str, timeout: int):
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        credentials = f"{email}:{api_token}".encode()
        self._auth = "Basic " + base64.b64encode(credentials).decode()

    def _request(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None) -> dict:
        url = f"{self._base}{path}"
        if params:
            url += "?" + urlencode(params)
        # Проверка адреса — на каждом запросе, а не только при сохранении
        # подключения: DNS хоста мог смениться после (перепривязка — обычный
        # приём SSRF). Импорт локальный по той же причине, что в provider.py —
        # не заводить цикл между модулями.
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
                    "jira_unauthorized", f"Jira отказала в доступе ({error.code})"
                ) from error
            if error.code == 404:
                raise JiraError("jira_not_found", "Jira ответила 404") from error
            raise JiraError("jira_refused", f"Jira ответила {error.code}") from error
        except (urllib.error.URLError, OSError) as error:
            raise JiraError("jira_unreachable", str(error)) from error

        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise JiraError("jira_bad_json", "ответ Jira не разобрать как JSON") from error

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
        # /field отдаёт список прямо телом ответа, не обёрнутым в объект —
        # единственная ручка API v3 с такой формой из тех, что здесь нужны.
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
        # PUT /issue отвечает 204 без тела на успех — _request просто
        # возвращает {} для пустого ответа, и это ровно то, что здесь нужно.
        self._request(
            "PUT",
            f"/rest/api/3/issue/{issue_key}",
            body={"fields": {"duedate": due_date.isoformat()}},
        )


class RecordedJiraClient:
    """Заранее заготовленные ответы — тем же приёмом, что RecordedProvider
    у app/ai/provider.py. Ими проверяется всё, что не про сеть."""

    def __init__(
        self,
        *,
        projects: list[dict] | None = None,
        fields: list[dict] | None = None,
        issues: list[dict] | None = None,
        #: Ключи задач, на которых update_issue_due_date отказывает, —
        #: тест партичного отказа отправки: одна отвергнутая Jira задача не
        #: должна прерывать отправку остальных (см. app/jira/sync.py:push_project).
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
            raise JiraError("jira_refused", f"Jira отклонила срок для {issue_key}")


__all__ = ["JiraClient", "HttpJiraClient", "RecordedJiraClient", "JiraError", "ISSUE_FIELDS"]
