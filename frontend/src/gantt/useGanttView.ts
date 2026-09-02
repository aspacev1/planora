import { useCallback, useEffect, useState } from "react";

import type { ColumnKey, ColumnLayout } from "./columns";
import {
  defaultLayout,
  rememberLayout,
  reorderColumns,
  storedLayout,
  toggleColumn,
} from "./columns";
import type { Zoom } from "./scale";
import { rememberZoom, storedZoom } from "./scalePreference";

/** Что из необязательных слоёв показывать. Состояние экрана, не проекта. */
export type ViewFlags = {
  baseline: boolean;
  legend: boolean;
  summary: boolean;
  caption: boolean;
  critical: boolean;
};

/**
 * Как смотреть на ленту: масштаб, колонки таблицы, слои.
 *
 * Одним предметом, а не тремя порознь: органы управления этим состоянием
 * стоят не в ленте, а в шапке экрана проекта (см. ProjectBar), и лента
 * получает его готовым — тем же путём, что и на публичной странице, где она
 * заводит его сама. Два владельца одного состояния разошлись бы на первом же
 * переключении масштаба: шапка показывала бы «Месяц», лента рисовала бы дни.
 */
export type GanttView = {
  zoom: Zoom;
  setZoom: (next: Zoom) => void;
  layout: ColumnLayout;
  setLayout: (next: ColumnLayout) => void;
  switchColumn: (column: ColumnKey) => void;
  toggleTable: () => void;
  resizeColumn: (column: ColumnKey, width: number) => void;
  moveColumn: (moved: ColumnKey, before: ColumnKey) => void;
  /** Включён ли слой. Базовый план может решаться снаружи (см. options). */
  flag: (flag: keyof ViewFlags) => boolean;
  toggle: (flag: keyof ViewFlags) => void;
};

export function useGanttView(
  projectId: string,
  {
    baselineShown,
    onBaselineToggle,
  }: {
    /**
     * Показывать ли призрак согласованного плана — снаружи.
     *
     * Не передано — лента решает сама своим флажком «Вид». Передано — решает
     * экран, и тот же переключатель стоит в окне изменений.
     */
    baselineShown?: boolean;
    onBaselineToggle?: () => void;
  } = {},
): GanttView {
  // Лента по умолчанию открывается в дневном масштабе — самом крупном: на
  // нём у деления хватает места на день недели над числом, и первое, что
  // человек видит, — ближайшие дни, а не сжатый до неразличимости квартал.
  // Но если для этого проекта масштаб уже выбирали, лента открывается им:
  // переключение вкладок и уход на другой экран не должны каждый раз
  // спрашивать заново то, что уже решили (см. scalePreference.ts).
  const [zoom, setZoomState] = useState<Zoom>(() => storedZoom(projectId) ?? "day");

  // Экран проекта не размонтирует ленту при смене адреса — те же компоненты
  // просто получают другой `projectId`. Без этого эффекта лента при переходе
  // между проектами тащила бы за собой масштаб предыдущего вместо того,
  // чтобы вспомнить, каким его в последний раз выбрали здесь.
  useEffect(() => {
    setZoomState(storedZoom(projectId) ?? "day");
  }, [projectId]);

  const setZoom = useCallback(
    (next: Zoom) => {
      setZoomState(next);
      rememberZoom(projectId, next);
    },
    [projectId],
  );

  // Колонки закреплённой таблицы — набор и ширины. Живут там же, где масштаб,
  // и по той же причине: раскладка — состояние экрана, привязанное к проекту,
  // а не свойство плана, и сосед по проекту чужой её получать не должен.
  const [layout, setLayoutState] = useState<ColumnLayout>(
    () => storedLayout(projectId) ?? defaultLayout(),
  );
  useEffect(() => {
    setLayoutState(storedLayout(projectId) ?? defaultLayout());
  }, [projectId]);

  // Устойчивая ссылка: лента разворачивает свёрнутую таблицу эффектом, когда
  // в ней открывают строку ввода, и эффект зависит от этой функции — новая
  // ссылка на каждой отрисовке гоняла бы его вхолостую.
  const setLayout = useCallback(
    (next: ColumnLayout) => {
      setLayoutState(next);
      rememberLayout(projectId, next);
    },
    [projectId],
  );
  const switchColumn = (column: ColumnKey) =>
    setLayout({ ...layout, shown: toggleColumn(layout.shown, column) });
  // Таблица целиком: свёрнутая отдаёт всё своё место шкале. Полугодовой план
  // иначе виден только кусками — таблица занимает треть экрана, и разглядеть
  // за ней форму проекта нельзя, не уехав прокруткой от имён задач.
  const toggleTable = () => setLayout({ ...layout, collapsed: !layout.collapsed });
  const resizeColumn = (column: ColumnKey, width: number) =>
    setLayout({ ...layout, widths: { ...layout.widths, [column]: width } });
  const moveColumn = (moved: ColumnKey, before: ColumnKey) =>
    setLayout({ ...layout, shown: reorderColumns(layout.shown, moved, before) });

  // Необязательные слои. Базовый план и сводка по дедлайну видны сразу:
  // первый — язык отклонений, вторая — единственная цифра, которая
  // по-настоящему интересует заказчика. Легенда и сноска ждут, пока их
  // попросят через «Вид», — как в макете, где их нет вовсе.
  const [flags, setFlags] = useState<ViewFlags>({
    baseline: true,
    legend: false,
    summary: true,
    caption: false,
    // Критический путь ждёт, пока его попросят: он красит полоски третьим
    // способом поверх статуса и просрочки, и включённый всегда превращал бы
    // ленту в карту цепочек там, где спрашивают всего лишь «что когда».
    critical: false,
  });
  const toggleFlag = (flag: keyof ViewFlags) =>
    setFlags((current) => ({ ...current, [flag]: !current[flag] }));

  // Призрак базового плана — единственный слой, которым управляют и снаружи:
  // окно изменений показывает те же расхождения списком и включает их же на
  // ленте. Флажок «Вид» и тумблер в окне обязаны быть одним переключателем, а
  // не двумя одинаковыми, — иначе один говорит «включено» там, где второй уже
  // выключил. Своё состояние остаётся про запас: у публичной страницы окна
  // изменений нет, и поднимать флаг ей некуда.
  const baselineOn = baselineShown ?? flags.baseline;
  const flag = (name: keyof ViewFlags) => (name === "baseline" ? baselineOn : flags[name]);
  const toggle = (name: keyof ViewFlags) =>
    name === "baseline" && onBaselineToggle ? onBaselineToggle() : toggleFlag(name);

  return {
    zoom,
    setZoom,
    layout,
    setLayout,
    switchColumn,
    toggleTable,
    resizeColumn,
    moveColumn,
    flag,
    toggle,
  };
}
