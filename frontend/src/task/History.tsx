import { useQuery } from "@tanstack/react-query";

import { listTaskRevisions, revisionsQueryKey } from "../api/revisions";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { formatEvent } from "./formatEvent";

/**
 * A task's change feed.
 *
 * The new entries on top: history is read from the last event rather than scrolled to it. The date and
 * the author stand next to the event itself rather than in a column on the side — a column on a narrow
 * card would take half the width from the phrase.
 *
 * A refusal here breaks nothing: the journal is not what the card was opened for. The block is simply
 * not drawn, and the fields above work as they worked.
 */
export function History({
  projectId,
  taskId,
  relative = false,
}: {
  projectId: string;
  taskId: string;
  /** Whether to read the journal's dates as days of the relative axis (see formatEvent). */
  relative?: boolean;
}) {
  const { t, locale } = useLocale();
  // The reader's day, as in the project's history feed: truncating an ISO string gave the day in UTC,
  // and an edit made at one in the morning was dated with different dates here and there.
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
              {/* A person's name is content, not chrome: it is not translated. */}
              {entry.actor && <span className="panel__event-actor">{entry.actor.name} </span>}
              {formatEvent(entry.op, locale, entry.names, relative)}
            </p>
            <p className="panel__event-meta">
              <span>{formatShortDate(t, dayIn(zone, new Date(entry.created_at)))}</span>
              {/* The reason is the user's text: printed as is, without translation and without quotation
                  marks from the interface. */}
              {entry.reason && <span className="panel__event-reason">{entry.reason}</span>}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
