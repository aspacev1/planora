import contextvars
import logging
import logging.config
import os
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings

# --- наблюдаемость -----------------------------------------------------------

#: Идентификатор текущего запроса — в каждой строке журнала, написанной во
#: время его обработки. Contextvar, а не глобальная переменная: запросы
#: обрабатываются вперемешку, и без контекста строки соседних запросов
#: подписывались бы друг другом.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


def configure_logging() -> None:
    """Журнал приложения: уровень из LOG_LEVEL, идентификатор запроса в каждой
    строке.

    dictConfig, а не basicConfig: uvicorn настраивает логирование сам, и
    basicConfig после него молча не делает ничего. disable_existing_loggers=
    False — логгеры uvicorn продолжают жить, мы лишь добавляем свои.
    """
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "filters": {"request_id": {"()": _RequestIdFilter}},
            "formatters": {
                "app": {
                    "format": "%(levelname)s %(name)s [%(request_id)s] %(message)s",
                }
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "app",
                    "filters": ["request_id"],
                }
            },
            "loggers": {
                "app": {
                    "level": get_settings().log_level.upper(),
                    "handlers": ["console"],
                    # Не отдавать записи дальше: у uvicorn свой handler, и
                    # без этого каждая строка печаталась бы дважды.
                    "propagate": False,
                }
            },
        }
    )


configure_logging()
logger = logging.getLogger("app.main")
from app.api import (
    admin_routes,
    ai_routes,
    auth_routes,
    export_routes,
    invite_routes,
    jira_routes,
    live_routes,
    meta_routes,
    org_routes,
    project_routes,
    proposal_routes,
    public_routes,
    scorecard_routes,
    share_routes,
)

def refuse_a_multi_worker_start() -> None:
    """Живая лента живёт в памяти процесса — воркер обязан быть один.

    Ревизия, применённая в воркере А, не доехала бы до сокетов, открытых в
    воркере Б: комнаты хаба у каждого процесса свои. Это ограничение описано
    в README, но описание не мешает задать --workers 4 — а этот отказ мешает.
    Проверяются переменные, которыми число воркеров задают uvicorn и gunicorn;
    появится вторая реплика по-настоящему — здесь же появится и общая шина
    (LISTEN/NOTIFY), см. план исправлений.
    """
    for name in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "GUNICORN_WORKERS"):
        value = os.getenv(name, "")
        if value.isdigit() and int(value) > 1:
            raise RuntimeError(
                f"{name}={value}: рассылка живой ленты живёт в памяти одного "
                "процесса, несколько воркеров молча потеряют события. "
                "Убери переменную или оставь одного воркера."
            )


def warn_about_a_default_public_base_url() -> None:
    """PUBLIC_BASE_URL, оставшийся умолчанием, — это ссылки на localhost в
    письмах и публичных адресах. Не отказ (локальная разработка законна),
    но и не молчание: боевая установка должна увидеть это в журнале."""
    if get_settings().public_base_url == "http://localhost:8000":
        logger.warning(
            "PUBLIC_BASE_URL не задан: ссылки в письмах и публичные адреса "
            "будут указывать на localhost. Для боевой установки задай его в .env."
        )


@asynccontextmanager
async def _lifespan(_: FastAPI):
    refuse_a_multi_worker_start()
    warn_about_a_default_public_base_url()
    yield


# Документация живёт под /api: на боевой раскладке (Caddy, Vercel) всё вне
# /api/* перехватывает фолбэк на index.html, и штатные /docs с /openapi.json
# были недоступны ровно там, где нужнее всего.
app = FastAPI(
    title="Planora",
    lifespan=_lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)


@app.middleware("http")
async def stamp_request_id(request: Request, call_next):
    """Идентификатор запроса: принимается от прокси или выдаётся здесь.

    Ответ несёт его в X-Request-ID, журнал — в каждой строке: «пришлите
    идентификатор из ответа» — это единственный способ найти в журнале ровно
    тот запрос, о котором говорит человек.
    """
    incoming = request.headers.get("x-request-id", "")
    # Чужое значение обрезается и чистится: заголовок — это ввод пользователя,
    # и он не должен уметь ни писать в журнал переводы строк, ни ронять ответ
    # символом вне latin-1. Только ASCII-буквоцифры, дефис и подчёркивание.
    request_id = (
        "".join(ch for ch in incoming if ch.isascii() and (ch.isalnum() or ch in "-_"))[:64]
        or uuid.uuid4().hex
    )
    token = request_id_var.set(request_id)
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers["X-Request-ID"] = request_id
    return response


@app.middleware("http")
async def reject_oversized_bodies(request: Request, call_next):
    """Потолок размера тела — до разбора JSON.

    Pydantic ограничивает длины полей, но сначала весь JSON должен доехать и
    разобраться — гигабайтное тело съедало бы память и время до первой
    проверки. Смотрится Content-Length: клиент без него (chunked) редок, и
    его тело всё равно упрётся в потолки полей — заголовок закрывает
    дешёвый путь, не претендуя на герметичность.
    """
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > get_settings().max_body_bytes:
        return JSONResponse(status_code=413, content={"detail": "body_too_large"})
    return await call_next(request)


_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _origin_host(value: str) -> str | None:
    host = urlsplit(value).hostname
    return host.lower() if host else None


@app.middleware("http")
async def reject_cross_origin_writes(request: Request, call_next):
    """CSRF в глубину: пишущий запрос с чужого сайта отвергается по Origin.

    Первая линия — SameSite=Lax на куке, но она защищает не всех: старые
    браузеры, встраивание в webview и будущие правки атрибутов куки не должны
    оставлять запись без второй линии. Браузер выставляет Origin на все
    cross-site запросы с телом, и подделать его со страницы нельзя.

    Сверяется хост, а не строка целиком: тот же сайт за прокси виден
    приложению по внутреннему имени, и сравнение со схемой/портом дало бы
    ложные отказы. Ожидаемые хосты — свой Host, X-Forwarded-Host от прокси и
    хост PUBLIC_BASE_URL. Запрос без Origin и Referer проходит: это не
    браузер (curl, тесты, здоровье), и CSRF ему не грозит — кука без
    браузера не подставляется сама.
    """
    if request.method in _WRITE_METHODS and request.url.path.startswith("/api/"):
        stated = request.headers.get("origin") or request.headers.get("referer")
        if stated:
            source = _origin_host(stated)
            allowed = {
                _origin_host(f"//{request.headers.get('host', '')}"),
                _origin_host(f"//{request.headers.get('x-forwarded-host', '')}"),
                _origin_host(get_settings().public_base_url),
            }
            allowed.discard(None)
            if source not in allowed:
                return JSONResponse(status_code=403, content={"detail": "csrf_origin_mismatch"})
    return await call_next(request)
app.include_router(meta_routes.router)
app.include_router(auth_routes.router)
app.include_router(org_routes.router)
app.include_router(invite_routes.router)
app.include_router(invite_routes.public_router)
app.include_router(project_routes.router)
app.include_router(proposal_routes.router)
app.include_router(scorecard_routes.router)
app.include_router(export_routes.router)
app.include_router(share_routes.router)
app.include_router(public_routes.router)
app.include_router(live_routes.router)
app.include_router(ai_routes.router)
app.include_router(jira_routes.router)
app.include_router(jira_routes.project_router)
app.include_router(admin_routes.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness: процесс жив и отвечает. В базу не ходит намеренно — упавшая
    база не повод перезапускать процесс, а ровно это оркестратор и делает с
    провалившим liveness."""
    return {"status": "ok"}


@app.get("/api/health/ready")
def readiness():
    """Readiness: готов ли процесс обслуживать запросы по-настоящему, то есть
    достаёт ли до базы. Отдельно от liveness: на этот отвечает «нет» — и
    балансировщик уводит трафик, не убивая процесс."""
    from sqlalchemy import text

    from app.db import engine

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        logger.exception("readiness: база недоступна")
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ready"}


# Определён последним — значит, обёрнут вокруг остальных middleware и
# срабатывает первым: CSRF и лимит тела видят уже переписанный путь.
@app.middleware("http")
async def accept_the_v1_prefix(request: Request, call_next):
    """Версионный алиас: /api/v1/* обслуживается как /api/*.

    Версия появляется в адресе до того, как появится вторая версия: клиенты,
    закладывающиеся на /api/v1, переживут появление /api/v2 без правок, а
    нынешний /api/* остаётся псевдонимом первой версии. Переписывается только
    путь HTTP-запроса; WebSocket живёт на /api/projects/{id}/live без алиаса.
    """
    path = request.scope["path"]
    if path.startswith("/api/v1/"):
        request.scope["path"] = "/api/" + path[len("/api/v1/") :]
    return await call_next(request)
