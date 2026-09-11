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
 * Панель директора: кто зарегистрирован, в какой организации и когда в
 * последний раз пользовался продуктом.
 *
 * Не про одну организацию — про установку целиком, поэтому своей ленты прав
 * (роль, состав) здесь нет: доступ решает не `Role.OWNER`, а роль директора,
 * закреплённая на сервере за одним адресом (см. app.director,
 * app.api.admin_routes). Не-директор получает `forbidden` тем же способом,
 * что и на любом другом закрытом маршруте, — и экран показывает его тем же
 * баннером отказа, а не отдельным «нет доступа».
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

  // Даты приходят с сервера моментом времени в UTC, а не голым календарным
  // днём (в отличие от дат самого плана): срез символов строки отдал бы день
  // по Гринвичу, и человек восточнее его увидел бы вчерашнее число там, где
  // на часах уже настало сегодня. dayIn переводит момент в сутки пояса
  // читателя — тем же способом, что и лента истории проекта.
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
