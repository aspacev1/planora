import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ADMIN_USERS_QUERY_KEY, adminUsers } from "../api/admin";
import type { AdminUser } from "../api/admin";
import { errorKey } from "../api/errors";
import { formatDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { dayIn } from "../time/zone";
import { useTimeZone } from "../time/useToday";

/**
 * The director's panel: who is registered, in which organization and when they last used the product.
 *
 * Not about one organization but about the whole install, so there is no permissions feed of its own
 * (the role, the roster) here: access is decided not by `Role.OWNER` but by the director role, pinned
 * on the server to one address (see app.director, app.api.admin_routes). A non-director gets
 * `forbidden` the same way as on any other closed route — and the screen shows it with the same refusal
 * banner rather than a separate "no access".
 */
export function Admin() {
  const { t, locale } = useLocale();
  const zone = useTimeZone();
  const [query, setQuery] = useState("");

  const roster = useQuery({ queryKey: ADMIN_USERS_QUERY_KEY, queryFn: adminUsers });

  const filtered = useMemo(() => {
    const rows = roster.data ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle),
    );
  }, [roster.data, query]);

  return (
    <main className="screen">
      <div className="screen__head">
        <h1>{t("admin.title")}</h1>
      </div>
      <p className="muted">{t("admin.subtitle")}</p>

      {roster.error && (
        <p className="error" role="alert">
          {t(errorKey(roster.error))}
        </p>
      )}

      {roster.isPending && <p role="status">{t("common.loading")}</p>}

      {roster.data && roster.data.length === 0 && (
        <div className="empty">
          <p className="empty__title">{t("admin.empty")}</p>
        </div>
      )}

      {roster.data && roster.data.length > 0 && (
        <>
          <input
            type="search"
            className="admin__search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("admin.search_placeholder")}
            aria-label={t("admin.search_placeholder")}
          />

          {filtered.length === 0 ? (
            <p className="muted">{t("admin.no_match")}</p>
          ) : (
            <div className="report__scroll">
              <table className="report">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.col.user")}</th>
                    <th scope="col">{t("admin.col.organizations")}</th>
                    <th scope="col">{t("admin.col.registered")}</th>
                    <th scope="col">{t("admin.col.last_active")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <AdminUserRow key={row.id} row={row} locale={locale} zone={zone} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted">{t("admin.count", { count: filtered.length })}</p>
        </>
      )}
    </main>
  );
}

function AdminUserRow({
  row,
  locale,
  zone,
}: {
  row: AdminUser;
  locale: ReturnType<typeof useLocale>["locale"];
  zone: string | undefined;
}) {
  const { t } = useLocale();

  // The dates arrive from the server as moments in time in UTC rather than as bare calendar days
  // (unlike the plan's own dates): slicing the string's characters would give the day in Greenwich, and
  // a person east of it would see yesterday's date where their clock already shows today. dayIn converts
  // a moment into the reader's zone's day — the same way the project's history feed does.
  const registeredDay = dayIn(zone, new Date(row.created_at));
  const activeDay = row.last_active_at ? dayIn(zone, new Date(row.last_active_at)) : null;

  return (
    <tr>
      <th scope="row">
        <div>{row.name}</div>
        <div className="muted">{row.email}</div>
      </th>
      <td>
        {row.organizations.length > 0 ? row.organizations.join(", ") : t("admin.no_organization")}
      </td>
      <td>{formatDate(t, registeredDay)}</td>
      <td>
        {row.last_active_at && activeDay ? (
          <>
            {formatDate(t, activeDay)} · {formatTime(locale, new Date(row.last_active_at))}
          </>
        ) : (
          <span className="muted">{t("admin.never_active")}</span>
        )}
      </td>
    </tr>
  );
}
