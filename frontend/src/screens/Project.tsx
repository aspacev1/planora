import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";

import { commentCounts, commentCountsQueryKey } from "../api/comments";
import { errorKey } from "../api/errors";
import { MEMBERS_QUERY_KEY, members } from "../api/org";
import { getProject, projectQueryKey } from "../api/projects";
import type { Category } from "../api/projects";
import { useCanWrite, useOrgRole } from "../auth/permissions";
import {
  IconDownload,
  IconExpand,
  IconInvite,
  IconSettings,
  IconShare,
  IconShrink,
} from "../components/icons";
import { useEscape } from "../components/useEscape";
import { InviteDialog } from "../components/InviteDialog";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { exportFacts, exportFactsQueryKey, exportProject } from "../api/export";
import { ExportDialog } from "../export/ExportDialog";
import { Gantt } from "../gantt/Gantt";
import type { NewTaskAt } from "../gantt/Gantt";
import { usePrefersReducedMotion } from "../gantt/motion";
import { useLocale } from "../i18n/LocaleProvider";
import { LiveProvider } from "../live/LiveProvider";
import { OfflineBar } from "../live/OfflineBar";
import { useProjectLive } from "../live/useProjectLive";
import { DependencyNudge, DependencyNudgeProvider } from "../project/DependencyNudge";
import { deleteCategory } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { PlanApproval } from "../project/PlanApproval";
import { PlanChangesPanel } from "../project/PlanChangesPanel";
import { PlanSummary } from "../project/PlanSummary";
import { ProjectBar } from "../project/ProjectBar";
import { Proposal } from "../proposal/Proposal";
import { ProjectHistory } from "../project/ProjectHistory";
import { Scorecard } from "../scorecard/Scorecard";
import { ShiftReasonProvider } from "../project/ShiftReason";
import { StartDateDialog } from "../project/StartDateDialog";
import { UndoHotkey } from "../project/UndoHotkey";
import { TaskPanel } from "../task/TaskPanel";
import type { PanelTab } from "../task/TaskPanel";
import { CategoryForm, suggestColor } from "./CategoryForm";
import { ShareDialog } from "./ShareDialog";

/**
 * Экран одного проекта.
 *
 * Три явных состояния, а не два: пока состояние не пришло, показывать пустую
 * диаграмму нельзя — она читается как «в проекте ничего нет». Отказ 404
 * означает и несуществующий проект, и чужой: интерфейс не знает разницы и не
 * притворяется, что знает.
 */
export function Project({
  tab = "gantt",
}: { tab?: "gantt" | "history" | "proposal" | "scorecard" } = {}) {
  const { t } = useLocale();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const role = useOrgRole();
  // Тот же признак, что и у ленты: выезд карточки — такое же движение, как
  // переезд полоски, и выключаться они обязаны вместе.
  const reducedMotion = usePrefersReducedMotion();
  const [addingCategory, setAddingCategory] = useState(false);
  // Категория, о расставании с которой спрашивают. Держится идентификатором,
  // а не самой категорией: пока окно открыто, состояние приходит с сервера
  // заново, и окно, помнящее объект, называло бы человеку старое имя.
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Спрашивается только при открытом окне: числа разделов нужны раз в жизни
  // экрана, а платить за них запросом на каждый показ проекта не за что.
  const factsQuery = useQuery({
    queryKey: exportFactsQueryKey(projectId),
    queryFn: () => exportFacts(projectId),
    enabled: exporting,
  });
  // Окно приглашения в организацию. Открывается прямо с проекта: зовут людей
  // тогда, когда смотрят на работу, которую собираются им отдать, а не когда
  // зашли в настройки рабочего пространства.
  const [inviting, setInviting] = useState(false);
  // Окно привязки плана к дате старта — и переноса уже назначенной даты.
  const [scheduling, setScheduling] = useState(false);
  // Открыт ли список расхождений с согласованным планом. Живёт здесь, а не в
  // шапке: открывают его из двух мест — пометкой о расхождении и ссылкой в
  // подтверждении переутверждения, — и оба стоят в разных поддеревьях.
  const [showingChanges, setShowingChanges] = useState(false);
  // Задан ли вопрос о переутверждении. Тоже здесь: его задают и кнопкой в
  // шапке, и из подвала панели изменений, а вопрос у действия один.
  const [reapproving, setReapproving] = useState(false);
  // Показывает ли лента призрак согласованного плана. Поднят из ленты, потому
  // что тем же слоем управляет тумблер в панели изменений: список и диаграмма
  // рассказывают одно и то же двумя языками, и переключатель у них общий.
  const [showBaseline, setShowBaseline] = useState(true);
  // Где открыта строка новой задачи. `null` — закрыта.
  //
  // Задачу заводят прямо в ленте, а не в окне: план пишут списком, и окно
  // между строками означало бы открыть, заполнить и закрыть его столько раз,
  // сколько в плане дел. Спрашивается одно имя, остальное правится в карточке
  // (см. NewTaskRow).
  const [addingTaskAt, setAddingTaskAt] = useState<NewTaskAt | null>(null);
  // Задача, карточка которой открыта. Держится идентификатором, а не самой
  // задачей: после каждого изменения состояние приходит с сервера заново, и
  // карточка, помнящая объект, показывала бы устаревшие данные.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // С какого раздела открыть карточку. Со строки ленты в неё ведут два пути:
  // по имени и полоске — к свойствам, по счётчику реплик — сразу в обсуждение.
  // Дальше вкладками управляет сама карточка.
  const [selectedTaskTab, setSelectedTaskTab] = useState<PanelTab>("details");
  const openTask = (taskId: string, tab: PanelTab = "details") => {
    setSelectedTaskTab(tab);
    // Карточка выезжает на то же место справа, что и список расхождений: двум
    // выдвижным колонкам там не разойтись, и открытая последней занимает его
    // одна. Закрывается именно список — за карточкой пришли только что.
    setShowingChanges(false);
    // Повторный щелчок по той же строке закрывает карточку: люди делают так не
    // задумываясь, и без этого щелчок выглядит бездействием. Переход же с имени
    // на счётчик реплик — не повтор, а другой раздел той же карточки, и
    // закрывать её он не должен.
    setSelectedTaskId((current) =>
      current === taskId && tab === selectedTaskTab ? null : taskId,
    );
  };

  // Лента развёрнута на весь экран. Между визитами не запоминается: полный
  // экран включают осознанно, и открывшийся без шапки и колонки проект читался
  // бы как сломанный, а не как удобно настроенный.
  const [focusMode, setFocusMode] = useState(false);

  const query = useQuery({
    queryKey: projectQueryKey(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
  });

  // Живая связь открывается вместе с экраном и живёт, пока он открыт: ревизии
  // соседей приезжают сами, а обрыв — единственное, что запирает редактирование.
  const live = useProjectLive(projectId);

  const offline = live.status === "offline";

  // Обрыв связи возвращает обычный вид: полоска офлайна стоит над лентой, а
  // полноэкранная лента накрыла бы её — человек видел бы, что полоски перестали
  // двигаться, и не видел бы почему.
  useEffect(() => {
    if (offline) setFocusMode(false);
  }, [offline]);

  // На других вкладках разворачивать нечего: полноэкранный режим, унесённый со
  // вкладки на вкладку, накрыл бы собой историю или смету, к которым он не
  // относится.
  useEffect(() => {
    if (tab !== "gantt") setFocusMode(false);
  }, [tab]);

  // Esc сворачивает полный экран — тем же слоем, что закрывает окна и меню:
  // полноэкранная лента и есть верхний слой, пока она развёрнута.
  useEscape(() => setFocusMode(false), focusMode);

  const { apply } = useProjectMutation(projectId);
  // Отказ молчит — тем же образом, что у перестановки строк (useReorder):
  // откат догадки внутри `apply` уже вернул категорию на экран, и этого
  // достаточно — удалить успели в соседней вкладке, и правду покажет
  // ближайший перезапрос.
  const removeCategory = (categoryId: string) => {
    void apply({ type: "delete_category", category_id: categoryId }, (state) =>
      deleteCategory(state, categoryId),
    ).catch(() => {});
  };

  // Состав организации — только ради имён исполнителей в карточке наведения на
  // полоску. Спрашивает экран, а не лента: у ленты нет признака «это публичная
  // страница», и решать, ходить ли за составом, она не должна. Отказ — не
  // ошибка экрана: роль `client` этот маршрут не получает вовсе, и карточка
  // тогда обходится без строки исполнителей.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: members,
    retry: false,
    staleTime: Infinity,
  });
  const assigneeNames = useMemo(
    () => new Map((membersQuery.data ?? []).map((member) => [member.id, member.name])),
    [membersQuery.data],
  );

  // Сколько реплик у каждой задачи — число на строке ленты. Отдельным
  // запросом, а не полем состояния: комментарий состояния не меняет, и
  // счётчик, вшитый в него, показывал бы вчерашнее число до ближайшей правки
  // плана. Ключ лежит внутри ключа ленты реплик, поэтому и своя реплика, и
  // чужая по сокету обновляют его тем же сбросом (см. api/comments.ts).
  const countsQuery = useQuery({
    queryKey: commentCountsQueryKey(projectId),
    queryFn: () => commentCounts(projectId),
    retry: false,
  });
  const commentsByTask = useMemo(
    () => new Map(Object.entries(countsQuery.data ?? {})),
    [countsQuery.data],
  );

  if (query.isPending) {
    return (
      <main className="screen">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  if (query.error) {
    return (
      <main className="screen">
        <p className="error" role="alert">
          {t(errorKey(query.error))}
        </p>
      </main>
    );
  }

  // Задача могла исчезнуть между открытием карточки и следующим ответом
  // сервера: её удалили в соседней вкладке. Карточка тогда просто не рисуется.
  const selectedTask = query.data.tasks.find((task) => task.id === selectedTaskId) ?? null;
  // То же и с категорией, о которой спрашивают: её могли удалить, пока вопрос
  // читали, — тогда спрашивать не о чем.
  const deletingCategory =
    query.data.categories.find((category) => category.id === deletingCategoryId) ?? null;

  // Пока связи нет, показанное устарело неизвестно насколько, и любое изменение
  // легло бы поверх чужих правок вслепую. Право при этом никуда не делось —
  // поэтому признаки разные: `canWrite` отвечает на «кому можно», а этот — на
  // «можно ли сейчас».
  const editable = canWrite && !offline;

  return (
    <ShiftReasonProvider>
      <DependencyNudgeProvider>
        <LiveProvider live={live}>
          <main className="screen screen--wide">
            {/* Ctrl/⌘+Z — на обеих вкладках сразу, а не внутри ленты или
                истории: отменяется последнее изменение проекта, и от того,
                какая вкладка открыта, оно не зависит. */}
            <UndoHotkey projectId={projectId} state={query.data} enabled={editable} />

            {/* Шапка — одна строка: имя, состояние плана, вкладки, действия.
                В полноэкранном режиме прячется целиком: над лентой там не
                стоит ничего. */}
            {!focusMode && (
              <ProjectBar
                state={query.data}
                onShowChanges={() => setShowingChanges(true)}
                summary={<PlanSummary state={query.data} />}
                tabs={
                  /* Вкладки — в адресе, а не в состоянии экрана: на историю
                     ссылаются в переписке, и ссылка обязана открывать её
                     сразу. */
                  <nav className="tabs" aria-label={t("history.tabs_label")}>
                    <NavLink to={`/projects/${projectId}`} end className={tabClass}>
                      {t("history.tab_gantt")}
                    </NavLink>
                    {/* Предложение — между лентой и историей, как в макете:
                        лента остаётся первым экраном проекта, смета — рядом. */}
                    <NavLink to={`/projects/${projectId}/proposal`} className={tabClass}>
                      {t("history.tab_proposal")}
                    </NavLink>
                    {/* Скоркард — после сметы, перед историей: сводка недели
                        ближе к работе, чем журнал. На публичной странице
                        (/p/...) вкладок нет вовсе. */}
                    <NavLink to={`/projects/${projectId}/scorecard`} className={tabClass}>
                      {t("history.tab_scorecard")}
                    </NavLink>
                    <NavLink to={`/projects/${projectId}/history`} className={tabClass}>
                      {t("history.tab_history")}
                    </NavLink>
                  </nav>
                }
                planAction={
                    <PlanApproval
                      projectId={projectId}
                      state={query.data}
                      canApprove={editable}
                      // Пересогласование — право владельца: оно сдвигает базу, от
                      // которой считаются все объяснённые сдвиги.
                      canReapprove={role === "owner" && !offline}
                      confirming={reapproving}
                      onConfirmingChange={setReapproving}
                      onShowChanges={() => setShowingChanges(true)}
                    />
                  }
                  // Редкие действия — под «⋯»: каждое открывает окно, и в ряду
                  // постоянных кнопок они стояли только затем, чтобы там
                  // стоять. Четыре плашки в строке — это и есть тот ярус, из
                  // которого шапка выросла в последний раз (кнопка «Экспорт»
                  // приехала уже после того, как шапку сжимали).
                  //
                  // Гостю кнопки не передаются вовсе: они обещали бы действие,
                  // которое сервер отклонит. Меню без единого пункта не
                  // рисуется — читателю без права на запись остаётся только
                  // выгрузка, и она в меню одна.
                  //
                  // Каждое действие — со значком слева от подписи: ряд одинаковых
                  // плашек различался только словом, и найти в нём нужную можно
                  // было, лишь прочитав все подряд, а рисунок находится глазом
                  // раньше, чем читается слово. Значки `aria-hidden`: вслух они
                  // повторили бы стоящую рядом подпись.
                  actions={
                    <Menu
                      label="⋯"
                      showCaret={false}
                      buttonLabel={t("project.actions.more")}
                    >
                      {/* Публикация — действие над проектом, и стоит она в общем
                          ряду действий, а не вплотную к названию: у названия теперь
                          живёт состояние плана, а действия собраны в одном месте.
                          Гостю и читателю не показывается: сервер такую попытку
                          отклонит. */}
                      {canWrite && (
                        <button
                          type="button"
                          className="menu__item"
                          disabled={offline}
                          onClick={() => setSharing(true)}
                        >
                          <IconShare />
                          {t("share.open")}
                        </button>
                      )}
                      {/* Выгрузка стоит в общем ряду действий, а не в тулбаре
                          ленты: файл собирается и из сметы, и из скоркарда, а
                          тулбар живёт только на вкладке ленты. Показывается
                          всем, кто вправе проект читать, — клиент и гость
                          получат тот же урез, что видят на экране. */}
                      <button
                        type="button"
                        className="menu__item"
                        disabled={offline}
                        onClick={() => setExporting(true)}
                      >
                        <IconDownload />
                        {t("export.open")}
                      </button>
                      {/* Приглашение стоит рядом с публикацией: обе кнопки отвечают
                          на «дать посмотреть», и разница между ними — кому. Ссылка
                          открывает проект на чтение кому угодно, приглашение зовёт
                          человека в организацию с ролью и правами.

                          Право здесь строже соседей — владелец, а не всякий, кто
                          может писать: приглашение раздаёт доступ ко всей
                          организации, и сервер (invitations.py) отвечает на чужую
                          попытку отказом. Обрыв живой связи кнопку не гасит, в
                          отличие от публикации: приглашение не пишет в проект и
                          устаревшего состояния перед собой не имеет. */}
                      {role === "owner" && (
                        <button
                          type="button"
                          className="menu__item"
                          onClick={() => setInviting(true)}
                        >
                          <IconInvite />
                          {t("invite.open")}
                        </button>
                      )}
                      {/* Настройки — здесь, а не в боковом меню, куда они на время
                          уезжали: колонка одна на всё приложение, а настройки —
                          этого проекта.

                          Подпись — одно слово, а полное имя действия отдано
                          `aria-label`: в колонке рядом стоит вход в настройки
                          рабочего пространства с тем же словом, и различает их
                          место — ряд действий проекта под его названием — вместе со
                          значком. Тому, кто слушает экран, места не видно, и ему
                          по-прежнему называется подлежащее. Видимая подпись входит
                          в озвученную целиком, поэтому голосовое управление
                          («нажми настройки») попадает по кнопке.

                          Право то же, что и у остальных действий: читателю ссылка
                          обещала бы отказ сервера. */}
                      {canWrite && (
                        <Link
                          to={`/projects/${projectId}/settings`}
                          className="menu__item"
                          aria-label={t("settings.project.link_aria")}
                        >
                          <IconSettings />
                          {t("settings.project.link")}
                        </Link>
                      )}
                    </Menu>
                  }
              />
            )}

            {offline && <OfflineBar syncedAt={query.dataUpdatedAt || null} />}

            {tab === "history" && (
              <ProjectHistory projectId={projectId} state={query.data} canUndo={editable} />
            )}

            {tab === "proposal" && <Proposal projectId={projectId} canWrite={editable} />}

            {/* Скоркарду отдаётся «кому можно», а не «можно ли сейчас»:
                обрыв связи он учитывает сам — пересчёт гаснет, а чтение
                остаётся. Задача из drill-down открывается на ленте — тем же
                переходом, что и из списка расхождений. */}
            {tab === "scorecard" && (
              <Scorecard
                projectId={projectId}
                canWrite={canWrite}
                onOpenTask={(taskId) => {
                  navigate(`/projects/${projectId}`);
                  openTask(taskId);
                }}
              />
            )}

            {/* Предложение подвинуть связанную задачу — над лентой, а не поверх
                неё: оно ненавязчивое и не должно закрывать то, что человек только
                что подвинул. В полноэкранном режиме его нет: над лентой там
                ничего не стоит, а слой поверх неё закрыл бы задачи. */}
            {tab === "gantt" && editable && !focusMode && (
              <DependencyNudge projectId={projectId} state={query.data} />
            )}

            {/* Диаграмма занимает всю ширину, пока карточка закрыта: пустая колонка
                справа отнимает у ленты треть экрана ради ничего. */}
            {tab === "gantt" && (
            <div
              className={`project__body${reducedMotion ? " motion-off" : ""}${
                focusMode ? " project__body--focus" : ""
              }`}
            >
              <Gantt
                projectId={projectId}
                state={query.data}
                canWrite={editable}
                assigneeNames={assigneeNames}
                baselineShown={showBaseline}
                onBaselineToggle={() => setShowBaseline((shown) => !shown)}
                toolbarAction={
                  canWrite ? (
                    <>
                      {/* Сначала категория, потом задача — в порядке, в каком
                          проект и заполняют: задачу некуда класть, пока нет ни
                          одной категории, и кнопка задачи до первой категории
                          не показывается — строке ввода негде было бы
                          открыться. Дальше она открывается в первой категории:
                          положить задачу в любую другую — тот же «плюс» на её
                          строке, а перенести написанную можно ручкой. */}
                      <button
                        type="button"
                        className="button--quiet"
                        disabled={offline}
                        onClick={() => setAddingCategory(true)}
                      >
                        {t("category.create")}
                      </button>
                      {query.data.categories.length > 0 && (
                        <button
                          type="button"
                          className="project-toolbar__primary"
                          disabled={offline}
                          onClick={() =>
                            setAddingTaskAt({
                              categoryId: query.data.categories[0].id,
                              before: null,
                            })
                          }
                        >
                          {t("task.create")}
                        </button>
                      )}
                    </>
                  ) : undefined
                }
                scheduleAction={
                  canWrite ? (
                    <button
                      type="button"
                      // Первая привязка выделена акцентом, но контуром, а не
                      // заливкой: залитых кнопок в ряду было две — эта и
                      // «Новая задача», — и первый взгляд они делили поровну,
                      // хотя задачу здесь заводят десятки раз, а дату старта
                      // назначают однажды. Перенос уже назначенной даты —
                      // тихая кнопка: главного действия у настроенного
                      // проекта здесь нет.
                      className={
                        query.data.schedule_mode === "relative"
                          ? "button--accent"
                          : "button--quiet"
                      }
                      disabled={offline}
                      // Подсказка «когда назначают дату старта» — на самой
                      // кнопке: плашка «Относительный план», носившая её
                      // прежде, стояла тут же и говорила то же самое третий
                      // раз после шкалы без месяцев и этой кнопки (см.
                      // Gantt.tsx). У календарного проекта подсказки нет —
                      // объяснять нечего.
                      title={
                        query.data.schedule_mode === "relative"
                          ? t("gantt.relative.hint")
                          : undefined
                      }
                      onClick={() => setScheduling(true)}
                    >
                      {query.data.schedule_mode === "relative"
                        ? t("schedule.open")
                        : t("schedule.change")}
                    </button>
                  ) : undefined
                }
                focusAction={
                  /* Значок без подписи: «На весь экран» — единственная кнопка
                     ряда, которую можно назвать рисунком и не потерять смысла
                     (стрелки в углы понимают все), а подпись в одиннадцать
                     букв стояла в самом конце перегруженной строки. Имя
                     осталось при кнопке целиком — `aria-label` для тех, кто
                     слушает экран, и `title` для тех, кто навёл курсор. */
                  <button
                    type="button"
                    className="button--quiet project-toolbar__icon"
                    aria-pressed={focusMode}
                    aria-label={t(focusMode ? "gantt.toolbar.focus_exit" : "gantt.toolbar.focus")}
                    title={t(focusMode ? "gantt.toolbar.focus_exit" : "gantt.toolbar.focus")}
                    onClick={() => {
                      // Прокрутка страницы обнуляется до разворота: высоту
                      // ленты меряют от окна (useViewportFit), и слой,
                      // раскрытый на прокрученной странице, отмерил бы её от
                      // уехавшего края.
                      if (!focusMode) window.scrollTo(0, 0);
                      setFocusMode((current) => !current);
                    }}
                  >
                    {focusMode ? <IconShrink /> : <IconExpand />}
                  </button>
                }
                onAddTask={editable ? setAddingTaskAt : undefined}
                newTaskAt={addingTaskAt}
                onCloseNewTask={() => setAddingTaskAt(null)}
                // Кнопка в пустой ленте открывает то же окно, что и «Новая
                // категория» в тулбаре: пустому проекту действие называют там,
                // куда он смотрит, а не только в ряду настроек показа.
                onAddCategory={editable ? () => setAddingCategory(true) : undefined}
                // Крестик на строке категории только спрашивает: удаление
                // уносит с собой весь этап, и назвать, что именно уйдёт,
                // нужно до того, как оно ушло, — а не тостом после.
                onDeleteCategory={editable ? setDeletingCategoryId : undefined}
                selectedTaskId={selectedTaskId}
                onSelectTask={(taskId) => openTask(taskId)}
                onOpenComments={(taskId) => openTask(taskId, "comments")}
                commentCounts={commentsByTask}
              />

              {selectedTask && (
                <TaskPanel
                  projectId={projectId}
                  task={selectedTask}
                  state={query.data}
                  canWrite={editable}
                  initialTab={selectedTaskTab}
                  onClose={() => setSelectedTaskId(null)}
                />
              )}
            </div>
            )}

            {sharing && <ShareDialog projectId={projectId} onClose={() => setSharing(false)} />}

            {/* Что в проекте есть, а чего нет, окну сообщает экран: состояние
                у него уже на руках, и окно, сходившее за ним само, показывало
                бы пустой список разделов первые полсекунды после открытия. */}
            {exporting && (
              <ExportDialog
                facts={
                  factsQuery.data && {
                    projectName: query.data.name,
                    start: factsQuery.data.start,
                    end: factsQuery.data.end,
                    today: factsQuery.data.today,
                    dated: factsQuery.data.dated,
                    tasks: factsQuery.data.tasks,
                    categories: factsQuery.data.categories,
                    links: factsQuery.data.links,
                    comments: factsQuery.data.comments,
                    proposalLines: factsQuery.data.proposal_lines,
                    scorecardMetrics: factsQuery.data.scorecard_metrics,
                    historyEvents: factsQuery.data.history_events,
                    internalAllowed: factsQuery.data.internal_allowed,
                  }
                }
                onClose={() => setExporting(false)}
                download={(options) => exportProject(projectId, options)}
              />
            )}

            {/* Тот же состав полей, что и на экране состава организации, — и
                тот же компонент: приглашают одинаково, откуда бы ни звали.
                Проект передаётся дальше и отмечается в списке заранее — для
                любой роли, не только «Клиента». */}
            {inviting && (
              <InviteDialog projectId={projectId} onClose={() => setInviting(false)} />
            )}

            {scheduling && (
              <StartDateDialog
                projectId={projectId}
                state={query.data}
                onClose={() => setScheduling(false)}
              />
            )}

            {/* Список расхождений с планом — выдвижной колонкой справа, без
                подложки: лента слева остаётся видимой и рабочей, и призраки
                согласованного плана на ней читаются вместе со списком. Открыт
                может быть на любой вкладке: пометка о расхождении стоит в
                шапке, а шапка одна на все три. С имени задачи ведёт в её
                карточку — а та живёт только на ленте, поэтому переход туда
                заодно и возвращает на неё. */}
            {showingChanges && (
              <PlanChangesPanel
                projectId={projectId}
                state={query.data}
                canReapprove={role === "owner" && !offline}
                baselineShown={showBaseline}
                onBaselineToggle={() => setShowBaseline((shown) => !shown)}
                onReapprove={() => setReapproving(true)}
                onOpenTask={(taskId) => {
                  navigate(`/projects/${projectId}`);
                  openTask(taskId);
                }}
                onClose={() => setShowingChanges(false)}
              />
            )}

            {addingCategory && (
              <CategoryForm
                projectId={projectId}
                suggested={suggestColor(query.data.categories.length)}
                onClose={() => setAddingCategory(false)}
              />
            )}

            {/* Окно живёт на экране, а не в строке ленты: строка исчезает в тот
                же миг, что и категория, и вопрос, живущий в ней, унёс бы с
                собой сам себя. Категории может уже не быть — её удалили в
                соседней вкладке, пока вопрос читали; тогда окна нет. */}
            {deletingCategory && (
              <DeleteCategoryDialog
                category={deletingCategory}
                tasks={query.data.tasks.filter(
                  (task) => task.category_id === deletingCategory.id,
                ).length}
                onConfirm={() => {
                  removeCategory(deletingCategory.id);
                  setDeletingCategoryId(null);
                }}
                onClose={() => setDeletingCategoryId(null)}
              />
            )}
          </main>
        </LiveProvider>
      </DependencyNudgeProvider>
    </ShiftReasonProvider>
  );
}

/**
 * Вопрос перед удалением категории — окном, а не выноской на строке.
 *
 * Выноска на месте кнопки (как у задачи в карточке) здесь не помещается
 * буквально: строка категории живёт в колонке шириной в двести пикселей, и
 * предупреждение о десятке задач вытеснило бы из неё имя самой категории —
 * то единственное, по чему видно, что целились не в соседнюю.
 *
 * Окно называет число задач, а не только имя: «удалить категорию» звучит как
 * расставание с заголовком, а уходит вместе с ним весь этап. Отмена при этом
 * есть — снимок для неё хранит журнал, — и об этом сказано прямо: иначе
 * человек оставляет ненужный этап на ленте просто из осторожности.
 */
function DeleteCategoryDialog({
  category,
  tasks,
  onConfirm,
  onClose,
}: {
  category: Category;
  /** Сколько задач уйдёт вместе с категорией. Ноль — этап пуст. */
  tasks: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();

  return (
    <Modal title={t("category.delete_title", { name: category.name })} onClose={onClose}>
      <p>
        {tasks === 0
          ? t("category.delete_warning_empty")
          : t("category.delete_warning", { tasks: t("common.tasks", { count: tasks }) })}
      </p>

      {/* Отказ первым — как в окне удаления проекта: окно ставит фокус на
          первый орган управления, и у необратимого на вид действия первой под
          рукой обязана быть безопасная кнопка. */}
      <div className="modal__actions">
        <button type="button" className="button--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="button--danger" onClick={onConfirm}>
          {t("category.delete_confirm")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Текущая вкладка помечается классом, а не цветом: подчёркивание снизу
 * показывает границы вкладки целиком, и по нему видно, куда попадёт щелчок.
 */
function tabClass({ isActive }: { isActive: boolean }) {
  return `tabs__link${isActive ? " is-current" : ""}`;
}
