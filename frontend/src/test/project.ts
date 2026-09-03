import { HttpResponse, http } from "msw";

import type { ProjectState } from "../api/projects";
import { addDays } from "../gantt/timescale";
import type { Locale } from "../i18n";
import { deleteCategory, deleteTask, reorderCategory, reorderTask } from "../project/optimistic";
import { server } from "./server";
import { ORG, USER, renderApp } from "./utils";

/**
 * Оснастка экрана проекта: одно состояние, одни ответы сервера, один способ
 * его нарисовать.
 *
 * Карточку задачи, перетаскивание и перестановку строк проверяют четыре разных
 * файла, и каждому нужен один и тот же проект с теми же датами. Скопированное
 * в четыре места состояние расходится на второй правке, и тесты начинают
 * проверять четыре разных проекта под одними названиями.
 */

export const MEMBERS = [
  { id: "u1", name: "Алексей", email: "a@b.c", role: "owner" },
  { id: "u2", name: "Мария", email: "m@b.c", role: "editor" },
];

export const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Календарный режим: заглушки существующих тестов живут настоящими датами.
  // Относительные проекты собирают своё состояние поверх этого (см. тесты
  // относительной шкалы).
  schedule_mode: "calendar" as const,
  start_date: null,

  calendar: { working_days: 31, holidays: ["2026-03-20"], extra_workdays: [] },
  settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
  categories: [
    { id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 },
    { id: "c2", name: "Разработка", color: "#a855f7", position: 1 },
  ],
  tasks: [
    {
      id: "t1",
      category_id: "c1",
      name: "Логотип",
      description: "Знак",
      start_date: "2026-03-04",
      end_date: "2026-03-10",
      duration_days: 5,
      milestone: false,
      critical: false,
      criticality: "high",
      status: "in_progress",
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
      baseline_start: null,
      baseline_duration: null,
      baseline_end: null,
      internal_note: "",
    },
  ],
  dependencies: [],
};

/** Тот же проект: обе категории на месте и в базовом состоянии. */
export const TWO_CATEGORIES = STATE;

/** Три задачи в одной категории — для перестановки строк. */
export const THREE_TASKS: ProjectState = {
  ...STATE,
  tasks: [
    { ...STATE.tasks[0], id: "t1", name: "Первая", position: 0 },
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Вторая",
      position: 1,
      start_date: "2026-03-11",
      end_date: "2026-03-17",
    },
    {
      ...STATE.tasks[0],
      id: "t3",
      name: "Третья",
      position: 2,
      start_date: "2026-03-18",
      end_date: "2026-03-24",
    },
  ],
};

/**
 * Тот же проект с утверждённым планом.
 *
 * Базовый план совпадает с текущими датами: задача ещё никуда не уехала, и
 * любое отклонение в тесте — целиком заслуга самого теста, а не оснастки.
 */
export const APPROVED: ProjectState = {
  ...STATE,
  plan_approved_at: "2026-03-01T09:00:00+00:00",
  plan_version: 1,
  tasks: [
    {
      ...STATE.tasks[0],
      baseline_start: "2026-03-04",
      baseline_duration: 5,
      baseline_end: "2026-03-10",
    },
  ],
};

/** Утверждённый план и задача, добавленная после утверждения. */
export const APPROVED_WITH_EXTRA: ProjectState = {
  ...APPROVED,
  tasks: [
    ...APPROVED.tasks,
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Сверх плана",
      position: 1,
      start_date: "2026-03-11",
      end_date: "2026-03-17",
      baseline_start: null,
      baseline_duration: null,
      baseline_end: null,
    },
  ],
};

/** Две задачи в одной категории — для сдвига категории целиком и для связей. */
export const TWO_TASKS: ProjectState = {
  ...STATE,
  tasks: [
    STATE.tasks[0],
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Макет",
      position: 1,
      start_date: "2026-03-11",
      end_date: "2026-03-17",
    },
  ],
};

/** Задача и веха: точка на шкале рисуется ромбом и граней не имеет. */
export const WITH_MILESTONE: ProjectState = {
  ...STATE,
  tasks: [
    STATE.tasks[0],
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Сдача",
      position: 1,
      start_date: "2026-03-16",
      end_date: "2026-03-16",
      duration_days: 1,
      milestone: true,
      status: "planned",
      progress_pct: 0,
    },
  ],
};

/** Цепочка из двух задач и одинокая третья: критический путь держат первые две. */
export const WITH_CRITICAL_PATH: ProjectState = {
  ...STATE,
  tasks: [
    { ...STATE.tasks[0], critical: true },
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Макет",
      position: 1,
      start_date: "2026-03-11",
      end_date: "2026-03-17",
      critical: true,
    },
    {
      ...STATE.tasks[0],
      id: "t3",
      name: "Сбоку",
      position: 2,
      start_date: "2026-03-04",
      end_date: "2026-03-05",
      critical: false,
    },
  ],
  dependencies: [{ from_task_id: "t1", to_task_id: "t2" }],
};

/** Две задачи со стрелкой между ними. */
export const WITH_DEPENDENCY: ProjectState = {
  ...STATE,
  tasks: [
    STATE.tasks[0],
    {
      ...STATE.tasks[0],
      id: "t2",
      name: "Макет",
      position: 1,
      start_date: "2026-03-11",
      end_date: "2026-03-17",
    },
  ],
  dependencies: [{ from_task_id: "t1", to_task_id: "t2" }],
};

export type Sent = { op: Record<string, unknown>; reason?: string };

/**
 * Принятая операция, отражённая в состоянии.
 *
 * Без этого сервер-заглушка отвечал бы «принято» и продолжал отдавать прежний
 * проект: перезапрос после успеха возвращал бы изменение назад, и тест на
 * второй щелчок по исполнителю проверял бы не то, что написано в его названии.
 *
 * Дата окончания здесь не пересчитывается намеренно — календаря у заглушки
 * нет. Это и хорошо: тест, ожидающий пересчитанный конец, обязан объявить его
 * сам, а не получить его от подделки под сервер.
 */
function applied(state: ProjectState, op: Record<string, unknown>): ProjectState {
  const id = op.task_id as string;
  const patch = (fields: Partial<ProjectState["tasks"][number]>) => ({
    ...state,
    tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...fields } : task)),
  });
  const assignees = state.tasks.find((task) => task.id === id)?.assignee_ids ?? [];

  switch (op.type) {
    case "create_task": {
      // Идентификатор и позицию назначает сервер — здесь тоже: клиент их не
      // присылает и присылать не должен. Задача встаёт в конец своей
      // категории, как на сервере; конец равен началу, потому что заводится
      // она однодневной, а календаря у заглушки нет.
      const categoryId = op.category_id as string;
      const siblings = state.tasks.filter((task) => task.category_id === categoryId);
      const start = op.start_date as string;
      return {
        ...state,
        tasks: [
          ...state.tasks,
          {
            ...STATE.tasks[0],
            id: `new${state.tasks.length + 1}`,
            category_id: categoryId,
            name: op.name as string,
            description: "",
            internal_note: "",
            start_date: start,
            end_date: start,
            duration_days: op.duration_days as number,
            milestone: false,
            criticality: "normal",
            status: "planned",
            progress_pct: 0,
            position: siblings.length,
            assignee_ids: [],
            baseline_start: null,
            baseline_duration: null,
            baseline_end: null,
          },
        ],
      };
    }
    case "move_task":
      return patch({ start_date: op.start_date as string });
    case "set_duration":
      return patch({ duration_days: op.duration_days as number });
    case "resize_task":
      return patch({
        start_date: op.start_date as string,
        duration_days: op.duration_days as number,
      });
    case "set_milestone": {
      // Та же сцепка, что на сервере: веха схлопывает длительность в день, а
      // снятый признак её не трогает.
      const milestone = op.milestone as boolean;
      const was = state.tasks.find((task) => task.id === id);
      return patch({ milestone, duration_days: milestone ? 1 : was?.duration_days });
    }
    case "move_category":
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.category_id === op.category_id
            ? { ...task, start_date: addDays(task.start_date, op.days as number) }
            : task,
        ),
      };
    case "set_progress": {
      // Та же сцепка, что на сервере: сто процентов — «готово», спуск ниже
      // ста из «готово» — «в работе».
      const pct = op.progress_pct as number;
      const was = state.tasks.find((task) => task.id === id);
      return patch({
        progress_pct: pct,
        status:
          pct >= 100 ? "done" : was?.status === "done" && pct < 100 ? "in_progress" : was?.status,
      });
    }
    case "set_status": {
      const status = op.status as ProjectState["tasks"][number]["status"];
      const was = state.tasks.find((task) => task.id === id);
      return patch({
        status,
        progress_pct: status === "done" ? 100 : was?.progress_pct,
      });
    }
    case "add_dependency":
      return {
        ...state,
        dependencies: [
          ...state.dependencies,
          { from_task_id: op.from_task_id as string, to_task_id: op.to_task_id as string },
        ],
      };
    case "remove_dependency":
      return {
        ...state,
        dependencies: state.dependencies.filter(
          (link) =>
            !(link.from_task_id === op.from_task_id && link.to_task_id === op.to_task_id),
        ),
      };
    case "set_criticality":
      return patch({ criticality: op.criticality as ProjectState["tasks"][number]["criticality"] });
    case "set_task_fields":
      return patch({
        name: op.name as string,
        description: op.description as string,
        internal_note: op.internal_note as string,
      });
    case "assign_user":
      return patch({ assignee_ids: [...assignees, op.user_id as string] });
    case "unassign_user":
      return patch({ assignee_ids: assignees.filter((user) => user !== op.user_id) });
    case "reorder_task":
      return reorderTask(state, id, op.category_id as string, op.position as number);
    case "reorder_category":
      return reorderCategory(state, op.category_id as string, op.position as number);
    case "delete_task":
      return deleteTask(state, id);
    case "delete_category":
      return deleteCategory(state, op.category_id as string);
    case "create_category":
      // Тем же приёмом, что и `create_task`: сервер сам назначает
      // идентификатор и позицию, здесь тоже.
      return {
        ...state,
        categories: [
          ...state.categories,
          {
            id: `newcat${state.categories.length + 1}`,
            name: op.name as string,
            color: op.color as string,
            position: state.categories.length,
          },
        ],
      };
    case "rename_category":
      return {
        ...state,
        categories: state.categories.map((category) =>
          category.id === op.category_id ? { ...category, name: op.name as string } : category,
        ),
      };
    default:
      return state;
  }
}

// Состояние оснастки. Живёт в модуле, а не в замыкании renderProject, потому
// что обработчики регистрируются раньше — в beforeEach, — и обязаны видеть то,
// что тест выберет позже.
let state: ProjectState = STATE;
let role = "owner";
const sent: Sent[] = [];

/**
 * Ответы сервера по умолчанию. Ставятся в `beforeEach`, а не внутри
 * `renderProject`, и это важно: msw отдаёт предпочтение обработчику,
 * зарегистрированному последним. Тест, объявляющий отказ через `server.use` в
 * своём теле, обязан перебить оснастку — а перебивает он только то, что
 * зарегистрировано до него.
 */
export function projectFixtures() {
  state = STATE;
  role = "owner";
  sent.length = 0;

  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/org", () => HttpResponse.json({ ...ORG, role })),
    http.get("/api/org/members", () => HttpResponse.json(MEMBERS)),
    http.get("/api/projects/p1", () => HttpResponse.json(state)),
    // Журнал карточки. Пустой по умолчанию: тест, которому история важна,
    // объявляет её сам.
    http.get("/api/projects/p1/revisions", () => HttpResponse.json([])),
    // Лента комментариев — по той же причине пустая: тест, которому разговор
    // важен, объявляет его сам.
    http.get("/api/projects/p1/comments", () => HttpResponse.json([])),
    // Летопись согласований — тоже пустая: её спрашивают и лента истории, и
    // окно изменений, а нужна она там лишь для имён — согласовавшего и
    // удалённых задач. Тест, которому версии важны, объявляет их сам.
    http.get("/api/projects/p1/plan/approvals", () => HttpResponse.json([])),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      const body = (await request.json()) as Sent;
      sent.push(body);
      const seq = sent.length;
      // Верх журнала двигается вместе с состоянием — как на сервере.
      // Заглушка, забывшая про `undoable`, гасила бы кнопку отмены в тосте
      // просто потому, что «отменять нечего», и тест на отмену проверял бы
      // не то, что написано в его названии.
      state = { ...applied(state, body.op), undoable: { seq, op: body.op, batch_id: null } };
      return HttpResponse.json({ seq, op: body.op, inverse: {} }, { status: 201 });
    }),
  );
}

/**
 * Операции, ушедшие на сервер с начала теста.
 *
 * Массив живой: он наполняется по ходу, и его не нужно перезапрашивать. Один и
 * тот же массив на весь тест — поэтому вызвать это можно и до отрисовки, как
 * оно и читается в тестах.
 */
export function captureMutations(): Sent[] {
  return sent;
}

export function renderProject(
  next: ProjectState = STATE,
  options: {
    canWrite?: boolean;
    /** Роль словами — там, где двух состояний «пишет / не пишет» мало: клиент не пишет, как и наблюдатель, но видит меньше него. */
    role?: "owner" | "editor" | "viewer" | "client";
    locale?: Locale;
    route?: string;
  } = {},
) {
  const { canWrite = true, locale = "ru", route = "/projects/p1" } = options;
  state = next;
  // Гость по спеку — это роль без права писать, а не человек без сессии:
  // диаграмму он видит, трогать её не может.
  role = options.role ?? (canWrite ? "owner" : "viewer");
  return renderApp({ route, locale });
}
