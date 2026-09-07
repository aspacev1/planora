import { relativeDayLabel } from "../gantt/relative";
import { formatShortDate } from "../i18n/dates";
import { translate } from "../i18n";
import type { Locale, Params } from "../i18n";

/**
 * Запись журнала → фраза на языке читателя.
 *
 * Здесь окупается решение хранить событие параметрами, а не готовым текстом:
 * один и тот же перенос читается на трёх языках, и язык выбирает тот, кто
 * смотрит, — а не тот, кто когда-то нажал кнопку.
 *
 * Причина сдвига через эту функцию не проходит вовсе: это текст пользователя,
 * и переводить его нечем и не нужно. Её показывает лента, как есть.
 */

/** Поля, которые карточка сохраняет одной операцией. Порядок — как в карточке. */
const TEXT_FIELDS = ["name", "description", "internal_note"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function formatEvent(
  op: Record<string, unknown>,
  locale: Locale,
  /**
   * Имена сущностей по идентификатору — как их отдаёт журнал. Позволяют
   * назвать исполнителя и концы связи; без словаря фраза остаётся безымянной,
   * как и была, — запись старого формата не ломает ленту.
   */
  names: Record<string, string> = {},
  /**
   * Читать ли даты как дни относительной оси. Журнал хранит координаты, и у
   * относительного проекта «переносом с 3 января» была бы выдача внутренней
   * системы координат за настоящую дату.
   */
  relative = false,
): string {
  const t = (key: string, params?: Params) => translate(locale, key, params);
  const say = (key: string, params?: Params) => t(`history.${key}`, params);
  const day = (iso: string) => (relative ? relativeDayLabel(t, iso) : formatShortDate(t, iso));

  switch (op.type) {
    case "move_task":
      return say("move_task", {
        from: day(String(op.from)),
        to: day(String(op.to)),
      });

    case "set_duration":
      // Через common.days, а не «{n} дней»: русский различает три формы, и
      // «21 дней» в ленте истории читается как опечатка приложения.
      return say("set_duration", {
        from: t("common.days", { count: Number(op.from) }),
        to: t("common.days", { count: Number(op.to) }),
      });

    case "resize_task": {
      // Левая грань меняет два поля одним движением, и фраза обязана назвать
      // оба: «сдвинул начало» умолчало бы о том, что задача заодно стала
      // длиннее, а «изменил длительность» — о том, что она сдвинулась.
      const before = asRecord(op.from);
      const after = asRecord(op.to);
      return say("resize_task", {
        from: day(String(before.start_date)),
        to: day(String(after.start_date)),
        was: t("common.days", { count: Number(before.duration_days) }),
        now: t("common.days", { count: Number(after.duration_days) }),
      });
    }

    case "move_category":
      // Знак сдвига решает, какую из двух фраз читать: «на 3 дня позже» и «на
      // 3 дня раньше» — разные события, и минус перед числом их не различает.
      return say(Number(op.days) > 0 ? "move_category_late" : "move_category_early", {
        days: t("common.days", { count: Math.abs(Number(op.days)) }),
        count: Array.isArray(op.task_ids) ? op.task_ids.length : 0,
      });

    case "set_milestone":
      return say(op.to === true ? "set_milestone_on" : "set_milestone_off");

    case "set_progress":
      return say("set_progress", { from: Number(op.from), to: Number(op.to) });

    case "set_criticality":
      return say("set_criticality", {
        from: t(`task.criticality.${String(op.from)}`),
        to: t(`task.criticality.${String(op.to)}`),
      });

    case "set_risk": {
      // Причина — текст человека, и во фразу она входит как есть: переводить
      // её нечем, а фраза без неё умалчивала бы о главном.
      const before = asRecord(op.from);
      const after = asRecord(op.to);
      const bounds = {
        from: t(`task.risk.${String(before.risk)}`),
        to: t(`task.risk.${String(after.risk)}`),
      };
      const note = typeof after.note === "string" ? after.note : "";
      return note !== "" && note !== before.note
        ? say("set_risk_noted", { ...bounds, note })
        : say("set_risk", bounds);
    }

    case "set_status":
      return say("set_status", {
        from: t(`task.status.${String(op.from)}`),
        to: t(`task.status.${String(op.to)}`),
      });

    case "set_task_fields": {
      const before = asRecord(op.from);
      const after = asRecord(op.to);
      // Только изменившиеся: операция несёт все три поля разом, и «изменил
      // название, описание и заметку» после правки одного описания — неправда.
      // Заметки может не быть ни в одной из границ: роль, которая её не видит,
      // получает запись без неё, и упоминать её тогда нечем.
      const changed = TEXT_FIELDS.filter(
        (field) => field in after && before[field] !== after[field],
      );
      if (changed.length === 0) return say("unknown");
      return say("set_task_fields", {
        fields: changed.map((field) => say(`field.${field}`)).join(", "),
      });
    }

    case "create_task":
      return say("create_task");
    case "delete_task":
      return say("delete_task");
    case "reorder_task":
      return say("reorder_task");
    case "reorder_category":
      return say("reorder_category");
    case "assign_user":
    case "unassign_user": {
      // Имя — содержимое, а не хрома: подставляется как есть. Безымянная
      // форма остаётся для записей, чей исполнитель стёр аккаунт.
      const name = names[String(op.user_id)];
      return name ? say(`${String(op.type)}_named`, { name }) : say(String(op.type));
    }
    case "add_dependency":
    case "remove_dependency": {
      const from = names[String(op.from_task_id)];
      const to = names[String(op.to_task_id)];
      return from && to
        ? say(`${String(op.type)}_named`, { from, to })
        : say(String(op.type));
    }
    case "create_category": {
      // Восстановленная отменой категория приходит со снимком своих задач:
      // «создал категорию» о вернувшемся вместе с ней этапе умалчивало бы.
      const restored = Array.isArray(op.tasks) ? op.tasks.length : 0;
      return restored === 0
        ? say("create_category")
        : say("create_category_with_tasks", { tasks: t("common.tasks", { count: restored }) });
    }
    case "delete_category": {
      // Число задач кладёт в запись сервер: снимок восстановления, по
      // которому их можно было бы сосчитать, виден не всякой роли.
      const gone = typeof op.tasks === "number" ? op.tasks : 0;
      return gone === 0
        ? say("delete_category")
        : say("delete_category_with_tasks", { tasks: t("common.tasks", { count: gone }) });
    }
    case "rename_category":
      return say("rename_category", { from: String(op.from), to: String(op.to) });
    case "set_category_color":
      return say("set_category_color");

    default:
      // Журнал переживёт версии приложения: запись, сделанную новой версией,
      // старая вкладка обязана показать, а не уронить карточку целиком.
      return say("unknown");
  }
}
