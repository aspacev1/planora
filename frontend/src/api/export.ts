import type { Orientation, Period, Zoom } from "../export/pageBudget";
import { request, requestFile, saveFile } from "./client";
import type { DownloadedFile } from "./client";

/** Что положить в файл. Значения совпадают с `ExportSection` на сервере. */
export type ExportSection =
  | "overview"
  | "tasks"
  | "gantt"
  | "links"
  | "proposal"
  | "scorecard"
  | "comments"
  | "history";

export type ExportFormat = "xlsx" | "pdf";

export type ExportOptions = {
  format: ExportFormat;
  sections: ExportSection[];
  zoom: Zoom;
  period: Period;
  orientation: Orientation;
  locale: string;
};

/**
 * Строка запроса выгрузки.
 *
 * `include` повторяется по разделу — так его объявляет сервер, и так его
 * проверяет схема FastAPI: неизвестный раздел отбраковывается ею, а не
 * рукописной проверкой на клиенте.
 */
function query(options: ExportOptions): string {
  const params = new URLSearchParams();
  for (const section of options.sections) params.append("include", section);
  params.set("zoom", options.zoom);
  params.set("period", options.period);
  params.set("orientation", options.orientation);
  params.set("locale", options.locale);
  return params.toString();
}

/**
 * Чем наполнены разделы — чтобы окно не предлагало пустых.
 *
 * Границы плана и «сегодня» приходят отсюда же, а не считаются в браузере: их
 * считает тот, кто потом соберёт файл, и число страниц на кнопке масштаба
 * из-за этого не может разойтись с числом страниц в файле. Часовой пояс у
 * проекта свой, и «сегодня» браузера ему не указ.
 */
export type ExportFactsResponse = {
  start: string;
  end: string;
  today: string;
  dated: boolean;
  tasks: number;
  categories: number;
  links: number;
  comments: number;
  proposal_lines: number;
  scorecard_metrics: number;
  history_events: number;
  internal_allowed: boolean;
};

export const exportFactsQueryKey = (projectId: string) => ["export-facts", projectId];

export function exportFacts(projectId: string): Promise<ExportFactsResponse> {
  return request<ExportFactsResponse>(`/api/projects/${projectId}/export/facts`);
}

export function exportProject(
  projectId: string,
  options: ExportOptions,
): Promise<DownloadedFile> {
  return requestFile(
    `/api/projects/${projectId}/export.${options.format}?${query(options)}`,
  );
}

/**
 * Выгрузка с публичной страницы. Токен ссылки уже стоит в адресе страницы, и
 * сюда он передаётся как есть — собирать его заново клиент не умеет и не
 * должен (см. ShareControls: адрес ссылки знает только сервер).
 */
export function exportPublicProject(
  orgSlug: string,
  projectSlug: string,
  search: string,
  options: ExportOptions,
): Promise<DownloadedFile> {
  const params = new URLSearchParams(search);
  const own = new URLSearchParams(query(options));
  for (const [key, value] of own) params.append(key, value);
  return requestFile(
    `/api/public/${orgSlug}/${projectSlug}/export.${options.format}?${params}`,
  );
}

export { saveFile };
