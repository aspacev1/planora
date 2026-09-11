import { useEffect, useMemo, useRef, useState } from "react";

import { errorKey } from "../api/errors";
import { saveFile } from "../api/export";
import type { ExportFormat, ExportOptions, ExportSection } from "../api/export";
import type { DownloadedFile } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { ExportPreview } from "./ExportPreview";
import {
  DATED_PERIODS,
  PERIODS,
  defaultZoom,
  pageCount,
  windowDays,
  zoomOptions,
} from "./pageBudget";
import type { Orientation, Period, Zoom } from "./pageBudget";
import "./export.css";

/**
 * How the dialog learns what the project has and does not have.
 *
 * Computed by the server (`GET /export/facts`) rather than by the browser: the plan's bounds and
 * "today" in the project's time zone are needed by both sides, and computed separately they would
 * diverge exactly where it is most noticeable — in the number of pages on the scale button against
 * the number of pages in the file.
 */
export type ExportFacts = {
  projectName: string;
  /** The plan's first and last date — the number of strip pages is computed from them. */
  start: string;
  end: string;
  today: string;
  /** Whether the plan is a calendar one. A relative one has no "today", and no windows from it either. */
  dated: boolean;
  tasks: number;
  categories: number;
  links: number;
  comments: number;
  proposalLines: number;
  scorecardMetrics: number;
  historyEvents: number;
  /** A client and a guest are not offered the internal sections at all. */
  internalAllowed: boolean;
};

type Props = {
  /** Not arrived yet — the dialog is already on screen, but the list of sections is still empty. */
  facts: ExportFacts | undefined;
  onClose: () => void;
  download: (options: ExportOptions) => Promise<DownloadedFile>;
};

/** A section and how much content it holds. An empty one is unavailable, with an explanation. */
type SectionRow = { section: ExportSection; count: number | null; internal?: boolean };

/** A stub for the loading time: the dates are today's, the counters are zero. */
const PENDING: ExportFacts = {
  projectName: "",
  start: new Date().toISOString().slice(0, 10),
  end: new Date().toISOString().slice(0, 10),
  today: new Date().toISOString().slice(0, 10),
  dated: true,
  tasks: 0,
  categories: 0,
  links: 0,
  comments: 0,
  proposalLines: 0,
  scorecardMetrics: 0,
  historyEvents: 0,
  internalAllowed: true,
};

const DEFAULT_SECTIONS: ExportSection[] = [
  "overview",
  "tasks",
  "gantt",
  "links",
  "proposal",
  "scorecard",
];

export function ExportDialog({ facts: loaded, onClose, download }: Props) {
  const { t, locale } = useLocale();

  // While the facts are in transit the dialog is already open and its frame is visible. Waiting for
  // them while showing nothing would mean a delay between the press and the dialog appearing — that
  // is, a button that "did not work".
  const facts: ExportFacts = loaded ?? PENDING;
  const pending = loaded === undefined;
  const toast = useToast();

  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [period, setPeriod] = useState<Period>("all");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [busy, setBusy] = useState(false);

  const days = useMemo(
    () => windowDays(period, facts.start, facts.end, facts.today),
    [period, facts.start, facts.end, facts.today],
  );
  const options = useMemo(() => zoomOptions(days, orientation), [days, orientation]);
  // The scale is not stored until the person has chosen it: otherwise a "day" chosen for one period
  // would stay chosen for another, where it is unavailable.
  const [picked, setPicked] = useState<Zoom | null>(null);
  const zoom =
    picked !== null && options.find((o) => o.zoom === picked)?.allowed
      ? picked
      : defaultZoom(days, orientation);

  const rows: SectionRow[] = (
    [
      { section: "overview", count: null },
      { section: "tasks", count: facts.tasks },
      { section: "gantt", count: facts.tasks },
      { section: "links", count: facts.links },
      { section: "proposal", count: facts.proposalLines },
      { section: "scorecard", count: facts.scorecardMetrics },
      { section: "comments", count: facts.comments },
      { section: "history", count: facts.historyEvents, internal: true },
    ] satisfies SectionRow[]
  ).filter((row) => !row.internal || facts.internalAllowed);

  const available = (row: SectionRow) =>
    !pending && (row.count === null || row.count > 0);

  const [chosen, setChosen] = useState<Set<ExportSection>>(new Set());

  // The default set is chosen once — when it became known what the project has. It must not be
  // rebuilt on every arrival of the facts: React Query refreshes them in the background, and a
  // checkbox the person unticked would come back by itself.
  const seeded = useRef(false);
  useEffect(() => {
    if (loaded === undefined || seeded.current) return;
    seeded.current = true;
    setChosen(
      new Set(
        DEFAULT_SECTIONS.filter((section) => {
          const row = rows.find((candidate) => candidate.section === section);
          return row !== undefined && (row.count === null || row.count > 0);
        }),
      ),
    );
    // rows is derived from loaded: recomputing the effect by it would mean restarting it on every
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const toggle = (section: ExportSection) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  const sections = [...chosen];
  const pages = sections.includes("gantt")
    ? pageCount(days, zoom, orientation) + (sections.length > 1 ? 2 : 0)
    : Math.min(sections.length, 2);
  const filename = `Planora - ${facts.projectName} - ${facts.today}.${format}`;

  async function start() {
    setBusy(true);
    try {
      const file = await download({
        format,
        sections,
        zoom,
        period,
        orientation,
        locale,
      });
      saveFile(file, filename);
      onClose();
    } catch (error) {
      toast({ message: t(errorKey(error)) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("export.title")} onClose={onClose} wide>
      <p className="export__hint">{t("export.hint")}</p>

      <div className="export">
        <div className="export__side">
          <fieldset className="export__group">
            <legend className="export__label">{t("export.label.format")}</legend>
            <div className="export__formats">
              {(["xlsx", "pdf"] as const).map((value) => (
                <label
                  key={value}
                  className={`export__format${format === value ? " is-on" : ""}`}
                >
                  <input
                    type="radio"
                    name="export-format"
                    value={value}
                    checked={format === value}
                    onChange={() => setFormat(value)}
                  />
                  <span className={`export__badge export__badge--${value}`} aria-hidden="true">
                    {value === "xlsx" ? "XLS" : "PDF"}
                  </span>
                  <span>
                    <span className="export__format-name">{t(`export.format.${value}.name`)}</span>
                    <span className="export__format-note">
                      {t(`export.format.${value}.note`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="export__group">
            <legend className="export__label">{t("export.label.sections")}</legend>
            <div className="export__sections">
              {rows.map((row) => {
                const enabled = available(row);
                return (
                  <label
                    key={row.section}
                    className={`export__section${enabled ? "" : " is-off"}`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled && chosen.has(row.section)}
                      disabled={!enabled}
                      onChange={() => toggle(row.section)}
                    />
                    <span>
                      <span className="export__section-name">
                        {t(`export.section.${row.section}.name`)}
                      </span>
                      <span className={`export__section-note${enabled ? "" : " is-why"}`}>
                        {enabled
                          ? t(`export.section.${row.section}.note`, { n: row.count ?? 0 })
                          : t("export.section.empty")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {chosen.has("gantt") && (
            <div className="export__options">
              <fieldset className="export__group">
                <legend className="export__label">{t("export.label.period")}</legend>
                <div className="export__segments">
                  {PERIODS.map((value) => {
                    // A plan without dates has no "today" on its axis, and no windows from it
                    // either. The button stays, but with an explanation.
                    const undated = !facts.dated && DATED_PERIODS.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className={period === value ? "is-on" : ""}
                        disabled={undated}
                        title={undated ? t("export.period.undated") : undefined}
                        onClick={() => setPeriod(value)}
                      >
                        {t(`export.period.${value}`)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="export__group">
                <legend className="export__label">{t("export.label.zoom")}</legend>
                <div className="export__segments">
                  {options.map((option) => (
                    <button
                      key={option.zoom}
                      type="button"
                      className={zoom === option.zoom ? "is-on" : ""}
                      disabled={!option.allowed}
                      title={
                        option.allowed
                          ? undefined
                          : t("export.zoom.too_wide", { count: option.pages })
                      }
                      onClick={() => setPicked(option.zoom)}
                    >
                      {t(`export.zoom.${option.zoom}`)}
                      {format === "pdf" && (
                        <span className="export__price">
                          {t("export.pages", { count: option.pages })}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </fieldset>

              {format === "pdf" && (
                <fieldset className="export__group">
                  <legend className="export__label">{t("export.label.orientation")}</legend>
                  <div className="export__segments">
                    {(["landscape", "portrait"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={orientation === value ? "is-on" : ""}
                        onClick={() => setOrientation(value)}
                      >
                        {t(`export.orientation.${value}`)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}
        </div>

        <aside className="export__preview">
          <div className="export__preview-head">
            <span className="export__label">{t("export.preview")}</span>
            {format === "pdf" && (
              <span className="export__preview-pages">{t("export.pages", { count: pages })}</span>
            )}
          </div>
          <ExportPreview format={format} sections={sections} facts={facts} />
        </aside>
      </div>

      <div className="export__foot">
        <span className="export__filename" title={filename}>
          {filename}
        </span>
        <div className="export__actions">
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="button--primary"
            disabled={busy || pending || sections.length === 0}
            onClick={start}
          >
            {busy ? t("export.working") : t("export.download")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
