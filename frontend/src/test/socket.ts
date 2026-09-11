/**
 * A socket the test drives.
 *
 * Installed globally for the whole suite (see setup.ts), and not for convenience: a real `WebSocket`
 * from jsdom would reach for the network on every test that opens a project screen — for an answer
 * nobody gives. The tests would come to depend on whether anything is listening on the port beneath
 * them.
 *
 * What is implemented is exactly what useProjectLive uses: the constructor, three handlers, close().
 * An empty stub class in place of a platform API is a bad idea in general, but here the surface is
 * known and small, while the alternative is real networking in unit tests.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** All created during a test, in creation order: a reconnection is a new instance. */
  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  /** Everything the application sent into the socket. It must stay empty: the socket is a listening one. */
  readonly sent: string[] = [];

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  // --- what the test drives the socket with --------------------------------

  /** The server accepted the connection. */
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The server sent a message. */
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The connection dropped by itself: a pulled cable, a server that fell asleep. */
  drop(code = 1006) {
    this.close(code);
  }
}

/** The last opened socket. There is more than one where there was a reconnection. */
export function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("приложение не открыло ни одного сокета");
  return socket;
}

export function installFakeWebSocket() {
  FakeWebSocket.instances = [];
  // defineProperty rather than an assignment: jsdom declares WebSocket a read-only property, and a
  // plain assignment fails.
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
}
