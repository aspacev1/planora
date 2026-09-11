import { useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet } from "react-router-dom";

import { ORG_QUERY_KEY, organization } from "../api/org";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The settings section's frame: the organization, the members, the profile.
 *
 * Three screens are gathered under one address because all three configure the same thing — the
 * workspace rather than the work in it. Apart they stood in the column as three items in a row, two
 * of which were marked with the same cog, and the difference between "Organization" and "Settings"
 * could only be read after a click.
 *
 * A project's settings are not part of this and cannot be: they belong to the project, live at its
 * address and exist only while the project is open. A "Project settings" tab in a section available
 * always would promise an answer to "which project" that it does not have.
 *
 * Each tab keeps its own heading rather than having it replaced by a shared "Settings": tabs are
 * navigation, while a page's title answers "where have I landed", and one heading for three
 * different screens would stop answering that.
 */
export function Settings() {
  const { t } = useLocale();

  return (
    <main className="screen">
      <nav className="tabs" aria-label={t("settings.tabs_label")}>
        {/* The organization's settings are for the owner only: for the rest they would open as
            disabled fields, that is, would promise an action that does not exist. */}
        <OwnerOnly>
          <NavLink to="/settings/organization" className={tabClass}>
            {t("nav.org_settings")}
          </NavLink>
        </OwnerOnly>
        {/* The members are visible to everyone: the server will answer the `client` role with a
            refusal, but deciding about access on the client is not the interface's business. */}
        <NavLink to="/settings/members" className={tabClass}>
          {t("members.title")}
        </NavLink>
        <NavLink to="/settings/profile" className={tabClass}>
          {t("settings.profile.title")}
        </NavLink>
      </nav>

      <Outlet />
    </main>
  );
}

/**
 * Where `/settings` itself leads.
 *
 * For an owner — to the organization: that is what they come to the settings for. For the rest — to
 * the profile: the only tab where they have anything to change. While the role is unknown nothing is
 * shown: a redirect at random would take an owner to the profile and come back only after they had
 * read a screen that was not theirs.
 */
export function SettingsHome() {
  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });

  if (org.isPending) return null;
  return <Navigate to={org.data?.role === "owner" ? "organization" : "profile"} replace />;
}

/** The same request as the frame's, and from the same cache: there will be no second trip. */
function OwnerOnly({ children }: { children: React.ReactNode }) {
  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });

  return org.data?.role === "owner" ? <>{children}</> : null;
}

/**
 * The current tab is marked with a class rather than with a colour: the underline shows the tab's
 * bounds in full, and it shows where the click will land.
 */
function tabClass({ isActive }: { isActive: boolean }) {
  return `tabs__link${isActive ? " is-current" : ""}`;
}
