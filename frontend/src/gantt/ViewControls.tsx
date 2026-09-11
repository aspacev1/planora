import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";
import { OPTIONAL_COLUMNS } from "./columns";
import type { GanttView } from "./useGanttView";

/**
 * The strip's view controls: the scale and the "View" menu.
 *
 * A separate component rather than a piece of the strip's markup: on the working screen they stand
 * in the project's header, to the right of the tabs (see ProjectBar), while on the public page they
 * are in a row of their own above the strip. The markup is one, the place differs.
 *
 * Two menus rather than three or one. "Columns" and "View" stood side by side as two buttons,
 * differed by one word and both answered "what to show" — now it is one menu with two titled parts.
 * The scale stays outside at that: it is switched most often, and its current value must be readable
 * without opening anything.
 */
export function GanttViewControls({
  view,
  variant = "toolbar",
}: {
  view: GanttView;
  /**
   * "toolbar" — quiet buttons with a frame, as in the row above the strip on the public page. "bar"
   * — ghost ones, without a frame, and the scale is named by a single value: in the project's header
   * the tabs stand next to it, and a second row of outlined chips would compete with them for
   * attention. The name "Scale: Month" stays with the button in full at that — for the screen reader
   * and the tooltip.
   */
  variant?: "toolbar" | "bar";
}) {
  const { t } = useLocale();
  const buttonClass = variant === "bar" ? "button--ghost" : "button--quiet";
  const zoomName = t(`gantt.toolbar.${view.zoom}`);
  const scaleName = t("gantt.toolbar.scale", { value: zoomName });

  return (
    <>
      <Menu
        label={variant === "bar" ? zoomName : scaleName}
        buttonLabel={variant === "bar" ? scaleName : undefined}
        buttonClass={buttonClass}
      >
        {(["day", "week", "month"] as const).map((value) => (
          <label key={value} className="menu__item">
            <input
              type="radio"
              name="gantt-scale"
              checked={view.zoom === value}
              onChange={() => view.setZoom(value)}
            />
            {t(`gantt.toolbar.${value}`)}
          </label>
        ))}
      </Menu>

      {/* The columns come first: they are about the table on the left, which reading the strip starts
          with. The task's name is not in the list — a row without a name does not say what it is
          about. */}
      <Menu label={t("gantt.toolbar.view")} buttonClass={buttonClass}>
        <p className="menu__title">{t("gantt.toolbar.columns")}</p>
        {OPTIONAL_COLUMNS.map((column) => (
          <label key={column} className="menu__item">
            <input
              type="checkbox"
              checked={view.layout.shown.includes(column)}
              onChange={() => view.switchColumn(column)}
            />
            {t(`gantt.col.${column}`)}
          </label>
        ))}

        <div className="menu__sep" />

        {/* The layers are what the mockup does not have but the product already does: the legend, the
            deadline summary, the footnote and the baseline plan's ghost. That way they stop being
            markup hidden by a style. */}
        <p className="menu__title">{t("gantt.view.layers")}</p>
        {(
          [
            ["baseline", t("gantt.view.baseline")],
            ["critical", t("gantt.view.critical")],
            ["legend", t("gantt.view.legend")],
            ["summary", t("gantt.view.summary")],
            ["caption", t("gantt.view.caption")],
          ] as const
        ).map(([flag, label]) => (
          <label key={flag} className="menu__item">
            <input type="checkbox" checked={view.flag(flag)} onChange={() => view.toggle(flag)} />
            {label}
          </label>
        ))}
      </Menu>
    </>
  );
}
