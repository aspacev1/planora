import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";
import { OPTIONAL_COLUMNS } from "./columns";
import type { GanttView } from "./useGanttView";

/**
 * Органы управления видом ленты: масштаб и меню «Вид».
 *
 * Отдельным компонентом, а не куском разметки ленты: на рабочем экране они
 * стоят в шапке проекта, справа от вкладок (см. ProjectBar), а на публичной
 * странице — в собственном ряду над лентой. Разметка одна, место разное.
 *
 * Два меню, а не три и не одно. «Колонки» и «Вид» стояли рядом двумя
 * кнопками, различались одним словом и оба отвечали на «что показывать» —
 * теперь это одно меню двумя озаглавленными частями. Масштаб при этом остаётся
 * снаружи: его переключают чаще всего, и текущее значение обязано читаться,
 * не открывая ничего.
 */
export function GanttViewControls({
  view,
  variant = "toolbar",
}: {
  view: GanttView;
  /**
   * «toolbar» — тихие кнопки с рамкой, как в ряду над лентой на публичной
   * странице. «bar» — призрачные, без рамки, и масштаб назван одним значением:
   * в шапке проекта рядом стоят вкладки, и второй ряд обведённых плашек
   * спорил бы с ними за внимание. Имя «Масштаб: Месяц» при этом остаётся у
   * кнопки целиком — для читалки и подсказки.
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

      {/* Колонки первыми: они про таблицу слева, с которой чтение ленты и
          начинается. Название задачи в список не входит — строка без имени не
          говорит, о чём она. */}
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

        {/* Слои — то, чего нет в макете, но что уже есть в продукте: легенда,
            сводка по дедлайну, сноска и призрак базового плана. Так они
            перестают быть спрятанной стилем разметкой. */}
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
