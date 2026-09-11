import { relativeDayLabel } from "../gantt/relative";
import { formatShortDate } from "../i18n/dates";
import { translate } from "../i18n";
import type { Locale, Params } from "../i18n";

/**
 * A journal entry → a phrase in the reader's language.
 *
 * This is where the decision to store an event as parameters rather than as ready text pays
 * off: one and the same move is read in three languages, and the language is chosen by
 * whoever is looking — not by whoever once pressed a button.
 *
 * A shift's reason does not go through this function at all: it is the user's text, and
 * there is nothing to translate it with and no need. The feed shows it as is.
 */

/** The fields the card saves in one operation. The order is the card's. */
const TEXT_FIELDS = ["name", "description", "internal_note"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function formatEvent(
  op: Record<string, unknown>,
  locale: Locale,
  /**
   * Entity names by id — as the journal hands them out. They make it possible to name an
   * assignee and the ends of a link; without the dictionary the phrase stays nameless, as it
   * was — an entry in the old format does not break the feed.
   */
  names: Record<string, string> = {},
  /**
   * Whether to read the dates as days of the relative axis. The journal stores coordinates,
   * and for a relative project "moved from 3 January" would be passing off an internal
   * coordinate system as a real date.
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
      // Through common.days rather than "{n} days": Russian distinguishes three forms, and
      // "21 дней" in the history feed reads as a typo by the application.
      return say("set_duration", {
        from: t("common.days", { count: Number(op.from) }),
        to: t("common.days", { count: Number(op.to) }),
      });

    case "resize_task": {
      // The left edge changes two fields in one motion, and the phrase must name both: "moved
      // the start" would pass over the task becoming longer as well, and "changed the duration"
      // would pass over it moving.
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
      // The shift's sign decides which of the two phrases to read: "3 days later" and "3 days
      // earlier" are different events, and a minus before the number does not tell them apart.
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
      // The reason is a person's text, and it enters the phrase as is: there is nothing to
      // translate it with, and a phrase without it would pass over the main thing.
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
      // Only the changed ones: the operation carries all three fields at once, and "changed the
      // name, the description and the note" after editing one description is untrue. The note
      // may be absent from both bounds: a role that does not see it gets an entry without it,
      // and there is then nothing to mention it with.
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
      // The name is content, not chrome: it is substituted as is. The nameless form is left for
      // entries whose assignee has erased their account.
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
      // A category restored by an undo arrives with a snapshot of its tasks: "created a category"
      // would pass over the stage that came back with it.
      const restored = Array.isArray(op.tasks) ? op.tasks.length : 0;
      return restored === 0
        ? say("create_category")
        : say("create_category_with_tasks", { tasks: t("common.tasks", { count: restored }) });
    }
    case "delete_category": {
      // The number of tasks is put into the entry by the server: the restoration snapshot, which
      // they could be counted from, is not visible to every role.
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
      // The journal will outlive the application's versions: an entry made by a new version must
      // be shown by an old tab rather than bringing the whole card down.
      return say("unknown");
  }
}
