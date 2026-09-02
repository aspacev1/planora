import { request } from "./client";
import type { SlugCheck } from "./org";

export const PROJECTS_QUERY_KEY = ["projects"] as const;

/** Ключ состояния одного проекта. Отдельный от списка: они живут своей жизнью. */
export function projectQueryKey(id: string) {
  return ["project", id] as const;
}

export type Project = {
  id: string;
  name: string;
  slug: string;
};

/**
 * Рабочий календарь проекта в том виде, в каком его прислал сервер.
 *
 * `working_days` — битовая маска, где бит 0 это понедельник: так её считает
 * Python, и переводить её в другую нумерацию по дороге значило бы завести
 * второе представление одного и того же.
 */
export type Calendar = {
  working_days: number;
  holidays: string[];
  extra_workdays: string[];
};

export const CRITICALITY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

/**
 * Статус — хранимое поле, а не вывод из прогресса и дат, как в макете Planora:
 * «заблокировано» из прогресса не выводится вовсе, его назначает человек.
 * С прогрессом статус связан лёгкой сцепкой, и её правила живут на сервере
 * (см. бэкенд `set_status`/`set_progress`); клиент повторяет их только в
 * оптимистичных догадках.
 */
export const TASK_STATUSES = ["planned", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Category = {
  id: string;
  name: string;
  color: string;
  position: number;
};

export type Task = {
  id: string;
  category_id: string;
  name: string;
  description?: string;
  start_date: string;
  /**
   * Смещение от начала проекта в рабочих днях — модель задачи относительного
   * плана. Считает сервер из координаты `start_date`; у календарного проекта
   * его нет. Клиент рабочие дни не пересчитывает и здесь тоже.
   */
  duration_days: number;
  /** Считает сервер. Клиент календарную арифметику не повторяет. */
  end_date: string;
  /**
   * Веха: точка на шкале вместо отрезка — сдача этапа, согласование, дедлайн
   * подрядчика. Рисуется ромбом в своём дне и длительности не имеет: сервер
   * держит её равной одному дню и отбивает `set_duration` по вехе.
   *
   * Признак, а не вывод из «длительность равна одному дню»: однодневных задач
   * полно, и вехой они не становятся.
   */
  milestone: boolean;
  /**
   * Задача без запаса: сдвинь её на день — на день уедет весь проект.
   *
   * Считает сервер и присылает вместе с состоянием: запас меряется рабочими
   * днями, а рабочий календарь — свойство проекта, и второй его расчёт здесь
   * разошёлся бы с первым на первом же празднике.
   */
  critical: boolean;
  criticality: Criticality;
  status: TaskStatus;
  progress_pct: number;
  position: number;
  assignee_ids: string[];
  /**
   * Базовый план: даты на момент утверждения. `null` у всех задач, пока план
   * не утверждён, и у тех, что созданы после утверждения, — вторые и есть
   * «сверх первоначального плана». Отдельного флага нет намеренно: он был бы
   * вычислим из этих же полей и однажды разошёлся бы с ними.
   */
  baseline_start: string | null;
  baseline_duration: number | null;
  /** Считает сервер по календарю проекта — как и обычную дату окончания. */
  baseline_end: string | null;
  /** Приходит только тем, у кого есть право её читать. */
  internal_note?: string;
};

export type Dependency = {
  from_task_id: string;
  to_task_id: string;
};

export type ProjectOverrides = {
  timezone: string | null;
  working_days: number | null;
  shift_threshold_days: number | null;
  holidays_extra: string[];
  workdays_extra: string[];
};

/**
 * Каким временем живёт план: `relative` — предварительный план без дат
 * («Месяц 1 / Неделя 1»), `calendar` — старт назначен, даты настоящие.
 */
export type ScheduleMode = "relative" | "calendar";

export type ProjectState = {
  id: string;
  name: string;
  slug: string;
  deadline: string | null;
  project_end: string | null;
  schedule_mode: ScheduleMode;
  /** Назначенная дата старта; `null`, пока план относительный. */
  start_date: string | null;
  /**
   * Автоперенос по связям: последователь не начинается раньше, чем кончился
   * его предшественник. Выключен по умолчанию — до него связь не двигала
   * ничего вовсе. При включённом лента не предлагает подвинуть задачу руками
   * (см. DependencyNudge): предложение сделать сделанное читается как сбой.
   */
  auto_schedule?: boolean;
  /** `null` — план ещё черновик: правки свободны, ничего не спрашивается. */
  plan_approved_at: string | null;
  plan_version: number;
  /**
   * Что отменит кнопка «Отменить». `null` — отменять нечего.
   *
   * Приходит вместе с состоянием, а не отдельным запросом: кнопка обязана
   * быть неактивной сразу, а не оживать через кадр после отрисовки.
   */
  undoable: { seq: number; op: Record<string, unknown>; batch_id: string | null } | null;
  calendar: Calendar;
  settings?: { shift_threshold_days: number; timezone: string };
  /**
   * Сырые переопределения проекта: `null` означает «наследовать от
   * организации», а не «пусто». Экрану настроек нужно именно это различие —
   * показать унаследованное число как своё значит предложить человеку
   * переопределить то, что он и не переопределял.
   */
  overrides?: ProjectOverrides;
  categories: Category[];
  tasks: Task[];
  dependencies: Dependency[];
};

/**
 * Операции в том виде, в каком их принимает провод.
 *
 * Полей восстановления здесь нет и быть не может: `category_id` при создании
 * категории, `task_id` при создании задачи и `position` назначает сервер.
 * Сервер отбивает лишние поля (`extra="forbid"`), но полагаться на это как на
 * единственную защиту нельзя — тип обязан описывать контракт честно, иначе
 * такое поле однажды допишут и узнают об этом только в бою.
 */
export type Op =
  | { type: "create_category"; name: string; color: string }
  | {
      type: "create_task";
      category_id: string;
      name: string;
      start_date: string;
      duration_days: number;
      /**
       * Место строки в списке категории. Не названо — задача встаёт в конец;
       * названо — на этот номер, а занявшие его строки едут вниз. Так «плюс»
       * на границе строк заводит задачу там, куда указали, одной операцией —
       * то есть одной записью в истории и одним нажатием «Отменить».
       */
      position?: number;
      description?: string;
      internal_note?: string;
      criticality?: Criticality;
      status?: TaskStatus;
      progress_pct?: number;
      milestone?: boolean;
    }
  | { type: "delete_category"; category_id: string }
  /**
   * Переименование категории — своя операция, а не часть `create_category`:
   * заголовок правят на месте (в строке ленты или сметы), и правка обязана
   * остаться одной записью в истории, а не парой «удалить, создать заново».
   */
  | { type: "rename_category"; category_id: string; name: string }
  | { type: "delete_task"; task_id: string }
  | { type: "move_task"; task_id: string; start_date: string }
  /**
   * Сдвиг всей категории на N календарных дней — одна операция, а не пачка
   * `move_task` по числу задач: человек сделал одно движение, и история
   * обязана показать одну запись, а отмена вернуть всё одним нажатием.
   *
   * Дни, а не целевая дата: своих границ у категории нет — сводная полоса
   * рисуется по крайним датам её задач.
   */
  | { type: "move_category"; category_id: string; days: number }
  /**
   * Левая грань полоски: старт и длительность разом, конец на месте. Одна
   * операция, а не пара `move_task` + `set_duration`, — грань тянут одним
   * движением, и промежуточного состояния «уже сдвинули, но ещё не укоротили»
   * человек не создавал.
   */
  | { type: "resize_task"; task_id: string; start_date: string; duration_days: number }
  | { type: "set_duration"; task_id: string; duration_days: number }
  | { type: "set_milestone"; task_id: string; milestone: boolean }
  | {
      type: "set_task_fields";
      task_id: string;
      name: string;
      description: string;
      internal_note: string;
    }
  | { type: "set_criticality"; task_id: string; criticality: Criticality }
  | { type: "set_status"; task_id: string; status: TaskStatus }
  | { type: "set_progress"; task_id: string; progress_pct: number }
  | { type: "reorder_task"; task_id: string; category_id: string; position: number }
  /**
   * Категория встаёт на другое место в списке этапов. Отдельная операция от
   * `reorder_task`: место задачи описывается парой (категория, номер) — её и
   * переносят из этапа в этап, — а у категории родителя нет, и номер один.
   */
  | { type: "reorder_category"; category_id: string; position: number }
  | { type: "assign_user"; task_id: string; user_id: string }
  | { type: "unassign_user"; task_id: string; user_id: string }
  | { type: "add_dependency"; from_task_id: string; to_task_id: string }
  | { type: "remove_dependency"; from_task_id: string; to_task_id: string };

/** Ответ на применённую операцию. Номер ревизии — то, чем она отличается от соседних. */
export type Revision = {
  seq: number;
  op: Record<string, unknown>;
  inverse: Record<string, unknown>;
};

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("/api/projects");
}

export function createProject(name: string): Promise<Project> {
  return request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getProject(id: string): Promise<ProjectState> {
  return request<ProjectState>(`/api/projects/${id}`);
}

/**
 * Удаление проекта целиком. Единственное изменение мимо журнала ревизий:
 * журнал живёт внутри проекта и умирает вместе с ним, поэтому отмены у этого
 * действия нет — предупредить об этом человека обязан вызывающий.
 */
export function deleteProject(id: string): Promise<void> {
  return request<void>(`/api/projects/${id}`, { method: "DELETE" });
}

/**
 * Единственный способ изменить что-либо в проекте.
 *
 * Причина не подставляется пустой строкой, когда её нет: сервер отличает
 * «причины не требовалось» от «причина пустая», и первое — это отсутствие
 * ключа, а не ключ со значением.
 */
export function applyOp(projectId: string, op: Op, reason?: string): Promise<Revision> {
  return request<Revision>(`/api/projects/${projectId}/mutations`, {
    method: "POST",
    body: JSON.stringify(reason === undefined ? { op } : { op, reason }),
  });
}

/**
 * Правка настроек проекта.
 *
 * `null` здесь — значение, а не пропуск: он сбрасывает переопределение обратно
 * в «наследовать от организации». Поле, которого в объекте нет вовсе, не
 * меняется.
 */
export function updateProject(
  projectId: string,
  patch: Partial<{
    name: string;
    slug: string;
    deadline: string | null;
    timezone: string | null;
    working_days: number | null;
    shift_threshold_days: number | null;
    holidays_extra: string[];
    workdays_extra: string[];
    /**
     * Автоперенос по связям. `null` для него не значение: у организации такой
     * настройки нет, наследовать нечего — только да или нет.
     */
    auto_schedule: boolean;
  }>,
): Promise<ProjectState> {
  return request<ProjectState>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Что можно попросить у привязки к дате старта — и у её предпросмотра. */
export type ScheduleRequest = {
  start_date: string;
  /** Маска новой рабочей недели; не прислана — остаётся действующая. */
  working_days?: number;
  /** false — при повторной смене старта оставить даты задач как есть. */
  shift_tasks?: boolean;
};

/**
 * Предпросмотр привязки: границы проекта после неё, ничего не меняя.
 * Даты считает сервер — по рабочему календарю с праздниками, которых клиент
 * не знает и знать не должен.
 */
export function previewSchedule(
  projectId: string,
  body: ScheduleRequest,
): Promise<{ start_date: string; end_date: string | null }> {
  return request(`/api/projects/${projectId}/schedule/preview`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Назначение (или перенос) даты старта. Переводит относительный план в
 * календарный: смещения, длительности и связи сохраняются, меняется только
 * ось, на которой они отложены. Отмены через журнал у действия нет — обратный
 * путь остаётся видом «Относительный план».
 */
export function applySchedule(projectId: string, body: ScheduleRequest): Promise<ProjectState> {
  return request(`/api/projects/${projectId}/schedule`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function checkProjectSlug(projectId: string, slug: string): Promise<SlugCheck> {
  return request<SlugCheck>(
    `/api/projects/${projectId}/slug-check?slug=${encodeURIComponent(slug)}`,
  );
}

/**
 * Отменить последнее изменение.
 *
 * Что именно отменять, по-прежнему решает сервер: ревизия из середины журнала
 * не отменяется, и `seq` — не выбор, а условие. Это номер того изменения,
 * отмену которого интерфейс пообещал человеку; если верх журнала успел
 * уехать — чужая правка по сокету, своя правка в карточке, — сервер отвечает
 * `undo_conflict` вместо того, чтобы снять не тот шаг.
 *
 * Причина нужна, когда отмена уводит задачу от базового плана дальше порога, —
 * отмена проходит ту же проверку, что и всякий сдвиг.
 */
export function undoLast(
  projectId: string,
  options: { seq?: number; reason?: string } = {},
): Promise<{ seq: number }> {
  // Ключи не подставляются пустыми: сервер отличает «номер не назван» от
  // «названный номер», и первое — отсутствие ключа, а не ключ со значением.
  const body: Record<string, unknown> = {};
  if (options.seq !== undefined) body.expected_seq = options.seq;
  if (options.reason !== undefined) body.reason = options.reason;
  return request(`/api/projects/${projectId}/undo`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Откатить пачку целиком — ту, что применил AI одной кнопкой. Зовёт лента
 *  истории: в ней пачка стоит одной строкой и откатывается одним нажатием. */
export function undoBatch(projectId: string, batchId: string): Promise<{ undone: number }> {
  return request(`/api/projects/${projectId}/batches/${batchId}/undo`, { method: "POST" });
}

/** Одна утверждённая версия плана. Снимок — даты и длительности по задачам. */
export type PlanApproval = {
  version: number;
  approved_at: string;
  approved_by: { id: string; name: string } | null;
  snapshot: Record<string, { name: string; start_date: string; duration_days: number }>;
};

/**
 * Утвердить план — или переутвердить, если он уже утверждён.
 *
 * Маршрут один: действие одно и то же, различие лишь в том, кому оно
 * позволено, и решает это сервер.
 */
export function approvePlan(projectId: string): Promise<{ version: number; approved_at: string }> {
  return request(`/api/projects/${projectId}/plan/approvals`, { method: "POST" });
}

export function listPlanApprovals(projectId: string): Promise<PlanApproval[]> {
  return request<PlanApproval[]>(`/api/projects/${projectId}/plan/approvals`);
}
