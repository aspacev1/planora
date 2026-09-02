"""Счётчик обращений в скользящем окне.

Заведён ради гостевых комментариев, у которых нет ни аккаунта, ни сессии,
ни какого-либо другого способа отличить человека от скрипта, кроме адреса, с
которого он пришёл (`GUEST_COMMENT_RATE_LIMIT`); тем же окном считаются
выгрузки (`export_routes`) и ключ клиента для лимитов входа (`auth_routes`).

Счётчик живёт в памяти процесса, и это осознанное ограничение, а не
недосмотр: внешних сервисов у продукта нет вовсе — ни очередей, ни Redis
(см. раздел «Архитектура»), — а заводить их ради одного счётчика значило бы
менять обещание развёртывания одним `docker compose`. Отсюда два следствия,
которые надо принять: перезапуск обнуляет окно, а установка, размазанная по
нескольким процессам (serverless), считает каждым из них отдельно. Для
защиты от заливки ленты этого достаточно — это предохранитель, а не рубеж
обороны.
"""

import threading
import time
from collections import deque

from fastapi import Request


def client_key(request: Request) -> str:
    """Кого считать одним клиентом при счёте по адресу.

    Прямой адрес соединения здесь бесполезен: и Caddy, и Vercel стоят перед
    приложением, и все запросы приходят с одного и того же адреса — потолок
    стал бы общим на всю установку. Поэтому предпочитается `X-Forwarded-For`.

    Подделать заголовок может кто угодно, и это принято сознательно: цена
    подделки — обойденный предохранитель, то есть ровно то состояние, в
    котором мы оказались бы, не считая вовсе. Правами заголовок не
    распоряжается ничем. Боевая установка за Caddy при этом защищена
    по-настоящему: Caddy переписывает X-Forwarded-For настоящим адресом
    клиента (см. Caddyfile), и подделка снаружи не доходит.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    first = forwarded.split(",")[0].strip()
    if first:
        return first
    return request.client.host if request.client else "unknown"


class SlidingWindow:
    """Не больше `limit` событий на ключ за `window` секунд."""

    #: Через сколько обращений подметать словарь целиком. Просто так ключи из
    #: него не исчезают: адрес, зашедший однажды, оставил бы запись навсегда.
    SWEEP_EVERY = 256

    def __init__(self, *, limit: int, window: float) -> None:
        self._limit = limit
        self._window = window
        self._hits: dict[str, deque[float]] = {}
        self._since_sweep = 0
        # Один и тот же счётчик читают потоки пула uvicorn: без замка два
        # одновременных комментария читают одну и ту же длину очереди и оба
        # проходят потолок.
        self._lock = threading.Lock()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        """Отмечает попытку и говорит, укладывается ли она в потолок.

        Отказ ничего не записывает: иначе тот, кто упёрся в потолок и жмёт
        кнопку дальше, продлевал бы себе запрет каждым нажатием, и окно
        никогда бы не истекало.
        """
        if self._limit <= 0:
            return False

        moment = time.monotonic() if now is None else now
        with self._lock:
            self._sweep(moment)
            hits = self._hits.setdefault(key, deque())
            self._trim(hits, moment)
            if len(hits) >= self._limit:
                return False
            hits.append(moment)
            return True

    def _trim(self, hits: deque[float], moment: float) -> None:
        while hits and hits[0] <= moment - self._window:
            hits.popleft()

    def _sweep(self, moment: float) -> None:
        self._since_sweep += 1
        if self._since_sweep < self.SWEEP_EVERY:
            return
        self._since_sweep = 0
        for key in list(self._hits):
            self._trim(self._hits[key], moment)
            if not self._hits[key]:
                del self._hits[key]

    def __len__(self) -> int:
        """Сколько ключей помнит счётчик. Существует ради проверки того, что
        словарь не растёт линейно по числу заходивших адресов."""
        with self._lock:
            return len(self._hits)
