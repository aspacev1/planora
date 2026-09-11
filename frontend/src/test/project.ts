import { HttpResponse, http } from "msw";

import type { ProjectState } from "../api/projects";
import { addDays } from "../gantt/timescale";
import type { Locale } from "../i18n";
import { deleteCategory, deleteTask, reorderCategory, reorderTask } from "../project/optimistic";
import { server } from "./server";
import { ORG, USER, renderApp } from "./utils";

/**
 * The project screen's harness: one state, one set of server answers, one way to
 * render it.
 *
 * The task card, dragging and row reordering are checked by four different files,
 * and each of them needs the same project with the same dates. State copied into
 * four places diverges on the second edit, and the tests start checking four
 * different projects under the same names.
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
  // Calendar mode: the existing tests' fixtures live on real dates. Relative
  // projects build their own state on top of this (see the relative-scale tests).
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
      risk: "green",
      risk_note: "",
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

/** The same project: both categories in place and in their base state. */
export const TWO_CATEGORIES = STATE;

/** Three tasks in one category — for row reordering. */
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
 * The same project with an approved plan.
 *
 * The baseline plan coincides with the current dates: the task has not travelled
 * anywhere yet, and any deviation in a test is entirely the test's own doing
 * rather than the harness's.
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

/** An approved plan and a task added after the approval. */
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

/** Two tasks in one category — for shifting a whole category and for links. */
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

/** A task and a milestone: a point on the scale is drawn as a diamond and has no edges. */
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

/** A chain of two tasks and a lone third: the critical path is held by the first two. */
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

/** Two tasks with an arrow between them. */
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
 * An accepted operation, reflected in the state.
 *
 * Without this the stub server would answer "accepted" and go on handing out the
 * previous project: a refetch after a success would bring the change back, and the
 * test about a second click on an assignee would be checking something other than
 * what its name says.
 *
 * The end date is deliberately not recomputed here — the stub has no calendar. And
 * that is a good thing: a test expecting a recomputed end must declare it itself
 * rather than get it from a fake pretending to be the server.
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
      // The id is assigned by the server — here too. The client names a position
      // only when inserting in the middle; then the neighbours from that number
      // down move by one, as in `_make_room` on the server. Without a number the
      // task goes to the end of its category; the end equals the start, because it
      // is created as a one-day task and the stub has no calendar.
      const categoryId = op.category_id as string;
      const siblings = state.tasks.filter((task) => task.category_id === categoryId);
      const start = op.start_date as string;
      const position = typeof op.position === "number" ? op.position : siblings.length;
      const shifted = state.tasks.map((task) =>
        task.category_id === categoryId && task.position >= position
          ? { ...task, position: task.position + 1 }
          : task,
      );
      return {
        ...state,
        tasks: [
          ...shifted,
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
            risk: "green",
            risk_note: "",
            status: "planned",
            progress_pct: 0,
            position,
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
      // The same coupling as on the server: a milestone collapses the duration into
      // a day, while clearing the flag does not touch it.
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
      // The same coupling as on the server: a hundred percent is "done", and going
      // below a hundred from "done" is "in progress".
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
      // By the same device as `create_task`: the server assigns the id and the
      // position itself, and so does this.
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

// The harness's state. It lives in the module rather than in renderProject's
// closure, because the handlers are registered earlier — in beforeEach — and must
// see what the test will choose later.
let state: ProjectState = STATE;
let role = "owner";
const sent: Sent[] = [];

/**
 * The server's default answers. Set in `beforeEach` rather than inside
 * `renderProject`, and that matters: msw prefers the handler registered last. A
 * test declaring a refusal through `server.use` in its own body must override the
 * harness — and it only overrides what was registered before it.
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
    // The card's journal. Empty by default: a test that cares about the history
    // declares it itself.
    http.get("/api/projects/p1/revisions", () => HttpResponse.json([])),
    // The comment feed — empty for the same reason: a test that cares about the
    // conversation declares it itself.
    http.get("/api/projects/p1/comments", () => HttpResponse.json([])),
    // The approval chronicle — also empty: it is asked for both by the history feed
    // and by the changes panel, and it is needed there only for names — the
    // approver's and the deleted tasks'. A test that cares about versions declares
    // them itself.
    http.get("/api/projects/p1/plan/approvals", () => HttpResponse.json([])),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      const body = (await request.json()) as Sent;
      sent.push(body);
      const seq = sent.length;
      // The top of the journal moves along with the state — as on the server. A
      // stub that forgot about `undoable` would disable the undo button in the toast
      // simply because "there is nothing to undo", and the undo test would be
      // checking something other than what its name says.
      state = { ...applied(state, body.op), undoable: { seq, op: body.op, batch_id: null } };
      return HttpResponse.json({ seq, op: body.op, inverse: {} }, { status: 201 });
    }),
  );
}

/**
 * The operations that went to the server since the test began.
 *
 * The array is live: it fills up as things go, and there is no need to re-request
 * it. One and the same array for the whole test — so this can be called before the
 * render too, which is how it reads in the tests.
 */
export function captureMutations(): Sent[] {
  return sent;
}

export function renderProject(
  next: ProjectState = STATE,
  options: {
    canWrite?: boolean;
    /** The role in words — where two states, "writes / does not write", are not enough: a client does not write, like an observer, but sees less than they do. */
    role?: "owner" | "editor" | "viewer" | "client";
    locale?: Locale;
    route?: string;
  } = {},
) {
  const { canWrite = true, locale = "ru", route = "/projects/p1" } = options;
  state = next;
  // By the spec a guest is a role without write permission rather than a person
  // without a session: they see the chart but cannot touch it.
  role = options.role ?? (canWrite ? "owner" : "viewer");
  return renderApp({ route, locale });
}
