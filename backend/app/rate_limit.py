"""A request counter over a sliding window.

Created for guest comments, which have no account, no session and no other way
of telling a person from a script than the address they came from
(`GUEST_COMMENT_RATE_LIMIT`); the same window counts exports
(`export_routes`) and the client key for sign-in limits (`auth_routes`).

The counter lives in the process's memory, and that is a deliberate limitation
rather than an oversight: the product has no external services at all — no
queues, no Redis (see the "Architecture" section) — and introducing them for
the sake of one counter would change the promise of deploying with a single
`docker compose`. Two consequences follow that have to be accepted: a restart
resets the window, and an installation spread across several processes
(serverless) counts separately in each of them. For protection against flooding
the feed that is enough — this is a fuse, not a line of defence.
"""

import threading
import time
from collections import deque

from fastapi import Request


def client_key(request: Request) -> str:
    """Who counts as one client when counting by address.

    The direct connection address is useless here: both Caddy and Vercel stand
    in front of the application, and all requests arrive from one and the same
    address — the ceiling would become shared across the whole installation. So
    `X-Forwarded-For` is preferred.

    Anyone can forge the header, and that is accepted deliberately: the price of
    a forgery is a bypassed fuse — that is, exactly the state we would be in if
    we did not count at all. The header governs no permissions whatsoever. A
    production installation behind Caddy is genuinely protected meanwhile: Caddy
    overwrites X-Forwarded-For with the client's real address (see the
    Caddyfile), and a forgery from outside does not get through.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    first = forwarded.split(",")[0].strip()
    if first:
        return first
    return request.client.host if request.client else "unknown"


class SlidingWindow:
    """No more than `limit` events per key in `window` seconds."""

    #: After how many requests to sweep the whole dictionary. Keys do not vanish
    #: from it by themselves: an address that showed up once would leave an
    #: entry forever.
    SWEEP_EVERY = 256

    def __init__(self, *, limit: int, window: float) -> None:
        self._limit = limit
        self._window = window
        self._hits: dict[str, deque[float]] = {}
        self._since_sweep = 0
        # The same counter is read by uvicorn's pool threads: without a lock two
        # simultaneous comments read the same queue length and both pass the
        # ceiling.
        self._lock = threading.Lock()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        """Records an attempt and says whether it fits under the ceiling.

        A refusal records nothing: otherwise someone who hit the ceiling and
        keeps pressing the button would extend their own ban with every press,
        and the window would never expire.
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
        """How many keys the counter remembers. It exists to verify that the
        dictionary does not grow linearly with the number of addresses seen."""
        with self._lock:
            return len(self._hits)
