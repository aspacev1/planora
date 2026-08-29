/**
 * Ошибка запроса, названная машинным кодом.
 *
 * `code` — единственное, что можно показывать человеку, и то через словарь.
 * `message` существует для журнала разработчика и намеренно не содержит ни
 * кода, ни тела ответа: иначе однажды его выведут в интерфейс как есть, и
 * азербайджанский читатель увидит `session_expired`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Числа, которые сервер приложил к отказу заголовками.
   *
   * Их место именно в заголовках, а не в `detail`: тело отказа обязано
   * оставаться машинным кодом, который клиент переводит по словарю, и
   * подмешивать в него числа значило бы заставить клиент разбирать строку.
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
 * Заголовки, из которых читаются числовые подсказки, и имена, под которыми
 * они ложатся в `hints`.
 *
 * Список явный, а не «возьмём всё, что похоже на число»: иначе случайный
 * заголовок промежуточного прокси однажды превратился бы в подсказку, на
 * которую опирается интерфейс.
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

/** Код, под которым в словаре лежит «сервер недоступен». */
export const NETWORK_ERROR_CODE = "network";

function codeFromBody(body: unknown): string {
  if (body === null || typeof body !== "object") return "unknown";
  const detail = (body as { detail?: unknown }).detail;

  // У FastAPI две формы ошибки. `detail` строкой — наш машинный код.
  if (typeof detail === "string" && detail !== "") return detail;

  // `detail` массивом — отбраковка схемы Pydantic. Её сворачиваем в один код:
  // показывать человеку английскую прозу Pydantic на азербайджанском
  // интерфейсе нельзя, а разбирать её по полям — задача не этого плана.
  if (Array.isArray(detail)) return "validation_error";

  return "unknown";
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      // Сессия живёт в HTTP-only куке: клиент её не читает, но обязан
      // отправлять — без этого каждый запрос выглядит анонимным.
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });
  } catch {
    // Сеть не ответила: сервер лежит, DNS не разрешился, кабель выдернут.
    // Отдельный код, потому что это единственная ошибка, которую человек
    // может починить сам.
    throw new ApiError(NETWORK_ERROR_CODE, 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(codeFromBody(body), response.status, hintsFrom(response.headers));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Файл, скачанный с сервера: содержимое и имя, под которым его сохранять. */
export type DownloadedFile = { blob: Blob; filename: string };

/**
 * Запрос, ответ на который — файл, а не JSON.
 *
 * Отдельная функция, а не флаг у `request`: та всегда разбирает тело как JSON
 * и обязана такой остаться — иначе каждый её вызов начнёт возвращать
 * объединение двух типов. Общее у них — разбор отказа: код ошибки приходит
 * тем же телом и переводится тем же словарём.
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
    // Отказ приходит JSON'ом даже у маршрута, отдающего файл: сервер меняет
    // тип ответа вместе со статусом.
    const body = await response.json().catch(() => null);
    throw new ApiError(codeFromBody(body), response.status, hintsFrom(response.headers));
  }

  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get("content-disposition")),
  };
}

/**
 * Имя файла из `Content-Disposition`.
 *
 * Читается `filename*` (RFC 5987), а не `filename`: второй по стандарту
 * ограничен ASCII, и сервер кладёт в него заглушку с подчёркиваниями — имя
 * проекта на русском или азербайджанском живёт только в первом. Пустая
 * строка — не поломка: вызывающий подставит своё имя, а не сохранит файл под
 * «undefined».
 */
export function filenameFrom(header: string | null): string {
  if (header === null) return "";

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Испорченная процентная кодировка — не повод ронять скачивание.
    }
  }

  const plain = /filename="([^"]*)"/i.exec(header);
  return plain ? plain[1] : "";
}

/**
 * Сохранить полученный файл под его именем.
 *
 * Ссылка создаётся и убирается тут же: узел, оставленный в документе, копился
 * бы на каждое скачивание. `revokeObjectURL` — в следующем кадре, а не сразу:
 * часть браузеров не успевает начать загрузку по уже отозванному адресу.
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
