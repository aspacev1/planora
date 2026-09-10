import { useQuery } from "@tanstack/react-query";

import { listTaskRevisions, revisionsQueryKey } from "../api/revisions";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { formatEvent } from "./formatEvent";

/**
 * Лента изменений задачи.
 *
 * Новые записи сверху: историю читают с последнего события, а не листают к
 * нему. Дата и автор стоят рядом с самим событием, а не колонкой сбоку —
 * колонка на узкой карточке отняла бы у фразы половину ширины.
 *
 * Отказ здесь ничего не ломает: журнал — не то, ради чего открыли карточку.
 * Блок просто не рисуется, а поля выше работают как работали.
 */
export function History({
  projectId,
  taskId,
  relative = false,
}: {
  projectId: string;
  taskId: string;
  /** Читать ли даты журнала как дни относительной оси (см. formatEvent). */
  relative?: boolean;
}) {
  const { t, locale } = useLocale();
  // Сутки читателя, как и в ленте истории проекта: обрезка ISO-строки давала
  // день по UTC, и правка, сделанная в час ночи, здесь и там датировалась
  // разными числами.
  const zone = useTimeZone();

  const query = useQuery({
    queryKey: revisionsQueryKey(projectId, taskId),
    queryFn: () => listTaskRevisions(projectId, taskId),
    retry: false,
  });

  if (query.error) return null;

  return (
    <section className="panel__history">
      <h3 className="panel__history-title">{t("history.title")}</h3>

      {query.data && query.data.length === 0 && <p className="muted">{t("history.empty")}</p>}

      <ol className="panel__events">
        {query.data?.map((entry) => (
          <li key={entry.seq} className="panel__event">
            <p className="panel__event-line">
              {/* Имя человека — содержимое, а не чрома: не переводится. */}
              {entry.actor && <span className="panel__event-actor">{entry.actor.name} </span>}
              {formatEvent(entry.op, locale, entry.names, relative)}
            </p>
            <p className="panel__event-meta">
              <span>{formatShortDate(t, dayIn(zone, new Date(entry.created_at)))}</span>
              {/* Причина — текст пользователя: выводится как есть, без
                  перевода и без кавычек от интерфейса. */}
              {entry.reason && <span className="panel__event-reason">{entry.reason}</span>}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
