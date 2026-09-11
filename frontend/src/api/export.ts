import type { Orientation, Period, Zoom } from "../export/pageBudget";
import { request, requestFile, saveFile } from "./client";
import type { DownloadedFile } from "./client";

/** What to put into the file. The values match `ExportSection` on the server. */
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
 * The export's query string.
 *
 * `include` is repeated per section — that is how the server declares it, and that is how FastAPI's
 * schema validates it: an unknown section is rejected by the schema rather than by a hand-written
 * check on the client.
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
 * What the sections are filled with — so that the dialog does not offer empty ones.
 *
 * The plan's bounds and "today" come from here too rather than being computed in the browser: they
 * are computed by whoever will then assemble the file, and because of that the number of pages on the
 * scale button cannot diverge from the number of pages in the file. A project has its own time zone,
 * and the browser's "today" is no authority to it.
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
 * An export from the public page. The link's token is already in the page's address, and it is passed
 * here as is — the client neither can nor should assemble it anew (see ShareControls: only the server
 * knows the link's address).
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

/**
 * The address of the commercial proposal's PDF — the document for the client.
 *
 * An address rather than a download: the button on the screen is an ordinary link with a `download`
 * attribute, and the browser saves the file itself under the name from the server's response. The
 * language passed is the one the person is currently viewing the proposal in — as with a project's
 * export.
 */
export function proposalPdfUrl(projectId: string, locale: string): string {
  const params = new URLSearchParams({ locale });
  return `/api/projects/${projectId}/proposal/export.pdf?${params}`;
}

export { saveFile };
