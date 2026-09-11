import type { ReactNode } from "react";

import type { ProjectState } from "../api/projects";
import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";
import { PlanState } from "./ProjectHead";

/**
 * The project's working-screen header: the name, the plan's state, the tabs, the actions —
 * all on one line.
 *
 * It came in place of a four-tier construction (the header, the dates, the metrics bar, the
 * row of tabs), which together with the strip's toolbar left the tasks a third of the
 * window. These tiers used to fold on the strip's scroll into just such a line — now the
 * line is one and always: folding helped only someone who had already scrolled the plan,
 * while work begins at the top, where the header stood at full height.
 * The jump of content at the folding threshold went along with it.
 *
 * There is exactly one tier here, and in it three zones of different shape — so that the
 * eye separates them without reading. On the left, in text and chips — "where I am and what
 * state the plan is in", with the plan's business next to it (approve, assign a start date).
 * Then the tabs — underlined text rather than pills: navigation must not look like buttons.
 * On the right, quietly and without frames — "how to look" (the scale, the layers, full
 * screen), and the rare actions under "⋯": each opens a dialog and stood in the row of
 * permanent buttons only in order to stand there.
 *
 * There is deliberately no second tier above the strip: the former toolbar held eight chips
 * of the same shape as here, and both rows read as one blot. Its view controls moved here,
 * the plan's business to the plan's state, and creation into the strip itself, where every
 * level of the list has its own "plus".
 */
export function ProjectBar({
  state,
  tabs,
  planAction,
  summary,
  tools,
  actions,
  onShowChanges,
}: {
  state: ProjectState;
  /** The row of tabs. Arrives as a ready node: the addresses are known by the screen, not the header. */
  tabs?: ReactNode;
  /** The plan's business — approve, assign a start date — next to its state. */
  planAction?: ReactNode;
  /**
   * How much work is in the project (see PlanSummary). Unfolded by the chevron next to the
   * name: there is no permanent place for seven figures on this line — it would wrap, and
   * back would come the same tier that was left behind.
   */
  summary?: ReactNode;
  /**
   * How to look at what is open on the tab — the scale, the layers, the strip's full screen.
   * Pinned to the right edge before "⋯" and not passed on tabs without a strip: their
   * appearance and disappearance move nothing on the left.
   */
  tools?: ReactNode;
  /**
   * The project's rare actions. Folded under "⋯"; not passed (no permissions) — there is no
   * button at all, an empty menu would promise content that does not exist.
   */
  actions?: ReactNode;
  /** Open the list of divergences from the approved plan. */
  onShowChanges?: () => void;
}) {
  const { t } = useLocale();

  return (
    <header className="project-bar">
      {/* The screen's heading stays a heading: the line has shrunk, but where the person has
          landed is still named by the first level — both for those listening to the screen
          and for a search on the page. */}
      <h1 className="project-bar__name">{state.name}</h1>
      {/* The chevron stands right next to the name and unfolds the summary about the same
          project: it needs no caption of its own — aloud it is named the same as the summary
          itself. It is not made a button inside the heading: the heading must read as a
          heading rather than as a control. */}
      {summary && (
        <span className="project-bar__summary">
          <Menu
            label="▾"
            buttonClass="project-bar__summary-toggle"
            showCaret={false}
            buttonLabel={t("project.metrics.label")}
          >
            {summary}
          </Menu>
        </span>
      )}
      <PlanState state={state} onShowChanges={onShowChanges} />
      {planAction}
      {tabs}
      {/* The right edge is one node, so as to pin both the view controls and the "⋯" to the
          edge together, with a rule between them: to the left of the rule is how to look, to
          the right is what else can be done. */}
      {(tools || actions) && (
        <div className="project-bar__end">
          {tools && <div className="project-bar__tools">{tools}</div>}
          {tools && actions && <span className="project-bar__divider" aria-hidden="true" />}
          {actions && <div className="project-bar__actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}
