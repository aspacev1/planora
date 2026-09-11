"""Broadcasting revisions to connected clients.

The rooms live in the process's memory. While there is a single server that is
enough; when a second one is needed, one class changes here and the routes and
mutations learn nothing about it — that is exactly why this module knows
nothing about HTTP, about sockets, or about what the dictionaries it delivers
contain.
"""

import asyncio
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

# How many messages to hold for a subscriber who cannot keep up with them. The
# cap is needed not for the sake of memory but for the sake of honesty: someone
# a hundred revisions behind will not catch the feed up piece by piece anyway —
# it is easier for them to re-read the whole project (§12), and a queue growing
# without limit merely delays that moment while accumulating what is knowingly
# useless.
BACKLOG_LIMIT = 128


class Subscriber:
    """One connection: the queue of what has not been handed to it yet.

    Falling behind is marked with a flag rather than an exception at the moment
    of publication: the hub publishes, and whoever fell behind should pay for
    falling behind — otherwise one stuck socket would break the broadcast for
    everyone else.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=BACKLOG_LIMIT)
        self.lagging = False

    def offer(self, message: dict) -> None:
        if self.lagging:
            return
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            self.lagging = True

    async def next(self) -> dict:
        return await self._queue.get()


class Hub:
    """Rooms by project."""

    def __init__(self) -> None:
        self._rooms: dict[uuid.UUID, set[Subscriber]] = {}

    @contextmanager
    def subscribe(self, project_id: uuid.UUID) -> Iterator[Subscriber]:
        """A subscription for the duration of the block.

        A context manager rather than a subscribe/unsubscribe pair: a socket is
        closed both on an error and on task cancellation, and a forgotten
        unsubscribe in one of those branches is a room that will never empty.
        """
        subscriber = Subscriber()
        self._rooms.setdefault(project_id, set()).add(subscriber)
        try:
            yield subscriber
        finally:
            room = self._rooms.get(project_id)
            if room is not None:
                room.discard(subscriber)
                # An empty room is deleted: otherwise the dictionary grows by one
                # key for every project anyone ever opened, and never shrinks.
                if not room:
                    del self._rooms[project_id]

    async def publish(self, project_id: uuid.UUID, message: dict) -> None:
        """Lay a message out across the room's queues.

        A coroutine, even though nothing inside it awaits. This is not
        decoration: the broadcast is started by a Starlette background task,
        which runs an ordinary function in a thread pool — and an
        `asyncio.Queue` must not be touched from a foreign thread. Declared as a
        coroutine, it is guaranteed to run in the event loop.

        A copy of the set rather than the set itself: a subscriber may drop off
        during the walk, and then the set would change underfoot.
        """
        for subscriber in tuple(self._rooms.get(project_id, ())):
            subscriber.offer(message)

    def listeners(self, project_id: uuid.UUID) -> int:
        """How many sockets are listening to the project. Needed by tests and diagnostics."""
        return len(self._rooms.get(project_id, ()))


hub = Hub()
