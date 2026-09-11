/**
 * A request error named by a machine code.
 *
 * `code` is the only thing that can be shown to a person, and even then through a
 * dictionary. `message` exists for the developer's log and deliberately contains neither
 * the code nor the response body: otherwise it would one day be printed into the interface
 * as is, and an Azerbaijani reader would see `session_expired`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * The numbers the server attached to a refusal as headers.
   *
   * Their place is precisely in the headers rather than in `detail`: a refusal's body must
   * stay a machine code the client translates by dictionary, and mixing numbers into it
   * would mean making the client parse a string.
   */
  readonly hints: Record<string, number>;

  constructor(code: string, status: number, hints: Record<string, number> = {}) {
    super(`запрос завершился со статусом ${status}`);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.hints = hints;
  }
}

/**
 * The headers the numeric hints are read from, and the names they land under in `hints`.
 *
 * The list is explicit rather than "we will take anything that looks like a number":
 * otherwise a stray header from an intermediate proxy would one day turn into a hint the
 * interface relies on.
 */
const NUMERIC_HINT_HEADERS: Record<string, string> = {
  "x-shift-deviation-days": "deviationDays",
  "x-shift-threshold-days": "thresholdDays",
};

function hintsFrom(headers: Headers): Record<string, number> {
  const hints: Record<string, number> = {};
  for (const [header, name] of Object.entries(NUMERIC_HINT_HEADERS)) {
    const raw = headers.get(header);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) hints[name] = value;
  }
  return hints;
}

/** The code "the server is unavailable" lies under in the dictionary. */
export const NETWORK_ERROR_CODE = "network";

function codeFromBody(body: unknown): string {
  if (body === null || typeof body !== "object") return "unknown";
  const detail = (body as { detail?: unknown }).detail;

  // FastAPI has two error shapes. `detail` as a string is our machine code.
  if (typeof detail === "string" && detail !== "") return detail;

  // `detail` as an array is Pydantic's schema rejection. We fold it into a single code:
  // showing a person Pydantic's English prose on an Azerbaijani interface will not do, and
  // parsing it field by field is a task of a different order.
  if (Array.isArray(detail)) return "validation_error";

  return "unknown";
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      // The session lives in an HTTP-only cookie: the client does not read it but must send
      // it — without that every request looks anonymous.
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });
  } catch {
    // The network did not answer: the server is down, DNS did not resolve, the cable was
    // pulled. A separate code, because this is the only error a person can fix themselves.
    throw new ApiError(NETWORK_ERROR_CODE, 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(codeFromBody(body), response.status, hintsFrom(response.headers));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** A file downloaded from the server: the content and the name to save it under. */
export type DownloadedFile = { blob: Blob; filename: string };

/**
 * A request whose answer is a file rather than JSON.
 *
 * A separate function rather than a flag on `request`: that one always parses the body as
 * JSON and must stay that way — otherwise every call to it would start returning a union of
 * two types. What they have in common is the refusal parsing: the error code arrives in the
 * same body and is translated by the same dictionary.
 */
export async function requestFile(
  path: string,
  init?: RequestInit,
): Promise<DownloadedFile> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "include", ...init });
  } catch {
    throw new ApiError(NETWORK_ERROR_CODE, 0);
  }

  if (!response.ok) {
    // A refusal arrives as JSON even from a route that serves a file: the server changes the
    // response type along with the status.
    const body = await response.json().catch(() => null);
    throw new ApiError(codeFromBody(body), response.status, hintsFrom(response.headers));
  }

  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get("content-disposition")),
  };
}

/**
 * The file name from `Content-Disposition`.
 *
 * `filename*` (RFC 5987) is read rather than `filename`: the second is limited to ASCII by
 * the standard, and the server puts a placeholder with underscores in it — a project's name
 * in Russian or Azerbaijani lives only in the first. An empty string is not a breakage: the
 * caller will substitute a name of its own rather than save the file as "undefined".
 */
export function filenameFrom(header: string | null): string {
  if (header === null) return "";

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // A broken percent-encoding is no reason to bring the download down.
    }
  }

  const plain = /filename="([^"]*)"/i.exec(header);
  return plain ? plain[1] : "";
}

/**
 * Save the received file under its name.
 *
 * The link is created and removed right here: a node left in the document would accumulate
 * on every download. `revokeObjectURL` goes on the next frame rather than at once: some
 * browsers do not manage to start the download from an already revoked address.
 */
export function saveFile(file: DownloadedFile, fallbackName: string): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
