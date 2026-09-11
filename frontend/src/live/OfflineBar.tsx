import { formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";

import "./live.css";

/**
 * The "no connection, showing data as of 14:32" strip.
 *
 * The time in the text is not decoration but the only thing that turns a warning into something useful:
 * "no connection" a person will work out anyway from dragging not working, while how stale what is in
 * front of them is, there is nowhere else to learn.
 *
 * `role="status"` rather than `alert`: the connection drops on its own, without the person's action, and
 * there is no reason to interrupt their keyboard work with it — a screen reader will mention the strip
 * once it has finished the current phrase.
 */
export function OfflineBar({ syncedAt }: { syncedAt: number | null }) {
  const { t, locale } = useLocale();

  return (
    <p className="offline-bar" role="status">
      {syncedAt === null
        ? t("live.offline")
        : t("live.offline_since", { time: formatTime(locale, syncedAt) })}
    </p>
  );
}
