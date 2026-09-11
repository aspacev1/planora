import os

os.environ.setdefault("APP_SECRET", "test-secret-not-for-production")
# Обязателен той же самой валидацией, что и APP_SECRET (см. app.config).
# Тесты, которым важен конкретный адрес директора, подменяют переменную сами
# monkeypatch'ем и сбрасывают кэш настроек — см. tests/test_admin_api.py.
os.environ.setdefault("DIRECTOR_EMAIL", "director@example.com")
# Тестовые адреса LLM — выдуманные хосты и localhost; проверка публичности
# адреса (защита от SSRF, app/ai/netguard.py) резолвила бы их в сеть на
# каждом тесте. Сама проверка тестируется отдельно, с явно выключенным
# рубильником и подменённым резолвером — без единого настоящего DNS-запроса.
os.environ.setdefault("AI_ALLOW_PRIVATE_URLS", "true")
# Пределы частоты и бюджета AI в общем прогоне выключены: сквозной сценарий
# интервью делает больше вызовов модели в секунду, чем позволено человеку в
# минуту. Своих тестов у этих ворот сейчас нет — они удалены вместе с
# остальными тестами AI; переменные оставлены, чтобы прогон не упирался в
# предел, если тесты вернутся.
os.environ.setdefault("AI_REQUESTS_PER_MINUTE", "0")
os.environ.setdefault("AI_DAILY_TOKEN_BUDGET", "0")
# Тот же довод, что у AI_ALLOW_PRIVATE_URLS: тестовые адреса Jira — выдуманные
# хосты и localhost, и без рубильника проверка публичности адреса
# (app/jira/netguard.py) резолвила бы их в сеть на каждом тесте. В отличие от
# LLM, своего теста у этой проверки больше нет: tests/test_jira_netguard.py
# удалён вместе с остальными тестами Jira.
os.environ.setdefault("JIRA_ALLOW_PRIVATE_URLS", "true")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.db import Base


def _safe_test_database_url() -> str:
    """Адрес тестовой базы, выведенный из DATABASE_URL, а не боевой адрес как есть.

    Разрушающие операции (drop_all/create_all) допустимы только по базе, чьё
    имя оканчивается на «_test», и никогда по базе из DATABASE_URL — иначе
    прогон тестов однажды снесёт рабочую базу разработки. Адрес разбирается
    через make_url()/set(), а не строковой склейкой, чтобы не развалиться на
    паролях со спецсимволами (например, слэшами).
    """
    prod_url = make_url(get_settings().database_url)
    prod_db = prod_url.database
    test_db = f"{prod_db}_test"
    test_url = prod_url.set(database=test_db)

    if test_db == prod_db or not test_db.endswith("_test"):
        raise RuntimeError(
            "отказ выполнять drop_all/create_all: выведенное имя тестовой базы "
            f"{test_db!r} совпадает с боевым DATABASE_URL ({prod_db!r}) или не "
            "оканчивается на '_test'. Тесты никогда не должны трогать базу из "
            "DATABASE_URL."
        )
    # render_as_string(hide_password=False): str(url) маскирует пароль
    # звёздочками, а нам нужен настоящий DSN для подключения.
    return test_url.render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def engine():
    test_url = _safe_test_database_url()
    engine = create_engine(test_url)

    try:
        with engine.connect():
            pass
    except OperationalError as exc:
        url = make_url(test_url)
        raise RuntimeError(
            f"тестовая база {url.database!r} недоступна "
            f"({url.render_as_string(hide_password=True)}).\n"
            "Если её ещё нет, создай её — Postgres поднят через docker compose, "
            "сервис 'db':\n"
            f"  docker compose exec db createdb -U {url.username} {url.database}\n"
            "или, если Postgres не в докере:\n"
            f"  createdb -h {url.host} -p {url.port} -U {url.username} {url.database}\n"
            f"Исходная ошибка: {exc}"
        ) from exc

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def mailbox(monkeypatch):
    """Перехватывает письма вместо отправки и отдаёт список доставленных.

    Подменяется build_transport, а не app.mail.send: так через тест проходит
    и сборка текста по шаблону, и выбор языка адресата — то есть ровно то,
    что ломается при правке словарей и молча уезжает в отправленное письмо.
    """
    import app.mail as mail_module

    delivered: list[mail_module.Letter] = []

    class Recorder:
        def deliver(self, letter: mail_module.Letter) -> None:
            delivered.append(letter)

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Recorder())
    return delivered


@pytest.fixture
def db(engine):
    """Сессия в транзакции, которая откатывается после теста."""
    connection = engine.connect()
    transaction = connection.begin()
    session = sessionmaker(bind=connection)()
    yield session
    session.close()
    transaction.rollback()
    connection.close()
