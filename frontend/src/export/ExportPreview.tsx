import { useLocale } from "../i18n/LocaleProvider";
import type { ExportFormat, ExportSection } from "../api/export";
import type { ExportFacts } from "./ExportDialog";

/**
 * A preview of the future file's first page.
 *
 * Hand-written SVG rather than a drawing library: there is not a single one in the project, and the
 * strip with the scorecard's sparkline are drawn the same way (see `gantt/`, `scorecard/`). There is all
 * the less reason to add a dependency for a picture a quarter of a window wide.
 *
 * This is not a scaled-down copy of the document but its layout: a person needs to understand what will
 * end up in the file before the file is assembled. So the blocks repeat the composition of what was
 * selected rather than the project's content.
 */
export function ExportPreview({
  format,
  sections,
  facts,
}: {
  format: ExportFormat;
  sections: ExportSection[];
  facts: ExportFacts;
}) {
  const { t } = useLocale();
  const has = (section: ExportSection) => sections.includes(section);

  // A workbook and a document look different at first glance: a workbook has sheet tabs at the bottom,
  // a document has a footer. Showing the same thing for both would mean not answering the very first
  // question — "what am I going to download".
  const isBook = format === "xlsx";

  return (
    <svg
      viewBox="0 0 290 205"
      className="export__sheet"
      role="img"
      aria-label={t("export.preview")}
    >
      <rect width="290" height="205" fill="var(--surface)" />

      <text x="12" y="19" className="export__pv-title">
        {facts.projectName}
      </text>
      <text x="12" y="28" className="export__pv-muted">
        {facts.start} — {facts.end}
      </text>

      {has("overview") && (
        <g>
          {[
            ["var(--bg-subtle)", "var(--text)"],
            ["var(--ok-soft)", "var(--ok)"],
            ["var(--accent-soft)", "var(--accent)"],
            ["var(--danger-soft)", "var(--danger-strong)"],
            ["var(--warn-soft)", "var(--warn)"],
            ["var(--bg-subtle)", "var(--text)"],
          ].map(([bg, fg], i) => (
            <g key={i}>
              <rect
                x={12 + i * 45}
                y="35"
                width="42"
                height="22"
                rx="3"
                fill={bg}
                stroke="var(--border)"
                strokeWidth=".5"
              />
              <rect x={17 + i * 45} y="41" width="14" height="7" rx="1.5" fill={fg} />
              <rect
                x={17 + i * 45}
                y="51"
                width="26"
                height="2.6"
                rx="1.3"
                fill="var(--border-strong)"
              />
            </g>
          ))}
        </g>
      )}

      {has("tasks") && <Block y={has("overview") ? 66 : 38} rows={6} label={t("export.section.tasks.name")} />}

      {has("gantt") && (
        <Gantt y={has("tasks") ? 128 : has("overview") ? 66 : 38} />
      )}

      {!has("tasks") && !has("gantt") && (has("proposal") || has("scorecard")) && (
        <Block y={has("overview") ? 66 : 38} rows={6} label={t("export.section.proposal.name")} />
      )}

      {isBook ? (
        <g>
          {/* The sheet tabs: a workbook has as many as there are selected sections. */}
          <line x1="0" y1="188" x2="290" y2="188" stroke="var(--border)" strokeWidth=".6" />
          {sections.slice(0, 6).map((section, i) => (
            <g key={section}>
              <rect
                x={10 + i * 45}
                y="191"
                width="42"
                height="10"
                rx="2"
                fill={i === 0 ? "var(--surface)" : "var(--bg)"}
                stroke="var(--border)"
                strokeWidth=".5"
              />
              <rect
                x={14 + i * 45}
                y="195"
                width={26}
                height="2.4"
                rx="1.2"
                fill="var(--text-faint)"
              />
            </g>
          ))}
        </g>
      ) : (
        <g>
          <line x1="12" y1="190" x2="278" y2="190" stroke="var(--border)" strokeWidth=".5" />
          <text x="12" y="198" className="export__pv-foot">
            {facts.projectName}
          </text>
        </g>
      )}
    </svg>
  );
}

/** A block of table rows: a heading, a header row and bands instead of text. */
function Block({ y, rows, label }: { y: number; rows: number; label: string }) {
  return (
    <g>
      <text x="12" y={y} className="export__pv-head">
        {label}
      </text>
      <line
        x1="12"
        y1={y + 3}
        x2="278"
        y2={y + 3}
        stroke="var(--border)"
        strokeWidth=".5"
      />
      {Array.from({ length: rows }, (_, i) => (
        <g key={i}>
          <rect
            x="12"
            y={y + 8 + i * 9}
            width="266"
            height="7"
            fill={i % 2 ? "var(--bg-subtle)" : "var(--surface)"}
          />
          <rect
            x="16"
            y={y + 10.5 + i * 9}
            width={60 + ((i * 37) % 50)}
            height="2.4"
            rx="1.2"
            fill="var(--border-strong)"
          />
          <rect
            x="120"
            y={y + 10.5 + i * 9}
            width="22"
            height="2.4"
            rx="1.2"
            fill="var(--accent)"
            opacity=".55"
          />
        </g>
      ))}
    </g>
  );
}

/** The strip: the names column, the scale's header and bars in four statuses. */
function Gantt({ y }: { y: number }) {
  const bars = [
    { row: 0, x: 96, w: 40, fill: "var(--ok)" },
    { row: 1, x: 128, w: 52, fill: "var(--accent)" },
    { row: 2, x: 150, w: 34, fill: "var(--danger)" },
    { row: 3, x: 178, w: 46, fill: "var(--bg-subtle)", outline: true },
    { row: 4, x: 212, w: 38, fill: "var(--bg-subtle)", outline: true },
  ];
  return (
    <g>
      <rect x="12" y={y} width="266" height="9" fill="var(--bg-subtle)" />
      <line x1="90" y1={y} x2="90" y2={y + 54} stroke="var(--border)" strokeWidth=".5" />
      {bars.map((bar) => (
        <g key={bar.row}>
          <rect
            x="16"
            y={y + 13 + bar.row * 9}
            width={52 + ((bar.row * 29) % 20)}
            height="2.4"
            rx="1.2"
            fill="var(--border-strong)"
          />
          <rect
            x={bar.x}
            y={y + 11.5 + bar.row * 9}
            width={bar.w}
            height="5"
            rx="1.6"
            fill={bar.fill}
            stroke={bar.outline ? "var(--text-faint)" : "none"}
            strokeWidth={bar.outline ? ".5" : "0"}
            strokeDasharray={bar.outline ? "1.5 1.5" : undefined}
          />
        </g>
      ))}
      <rect
        x="12"
        y={y}
        width="266"
        height="54"
        fill="none"
        stroke="var(--border)"
        strokeWidth=".5"
      />
    </g>
  );
}
