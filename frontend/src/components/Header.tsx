import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink } from "react-router-dom";

import { ORG_QUERY_KEY, organization } from "../api/org";
import { useAuth } from "../auth/AuthProvider";
import { useLocale } from "../i18n/LocaleProvider";
import { IconBoard, IconCheck, IconCollapse, IconExit, IconSettings, IconShield } from "./icons";
import { LocaleSwitch } from "./LocaleSwitch";
import { OrgSwitch } from "./OrgSwitch";

/**
 * The application's sidebar.
 *
 * On the left rather than on top: there are few sections, but they grow
 * downwards — projects, roster, settings — and the column accepts a new item
 * without taking width from the chart. A horizontal header would start wrapping
 * onto a second line at the fifth item and jumping about in height.
 *
 * The order from top to bottom goes from the general to the personal: the
 * organization, the sections of work, the person. The sections stand right
 * under the organization's name: they are what the column is opened for, and
 * there is no room for an empty line above them. At the bottom, separated by a
 * rule, is everything to do with the signed-in person rather than with the work:
 * the language, the settings and signing out. That way "Sign out" does not end
 * up next to "Projects", which is aimed at most often.
 */
const COLLAPSED_KEY = "planora.sidebar_collapsed";

/* The logo declares `aria-expanded`, and that must speak about something named:
   without `aria-controls` the screen reader reports "collapsed" without saying
   what. Both areas are listed rather than one: collapsing removes the captions
   from the sections and from the bottom block alike. */
const NAV_ID = "sidebar-nav";
const FOOT_ID = "sidebar-foot";

function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    // A browser's private mode can forbid localStorage. The column then simply
    // opens expanded — that is no reason to crash.
    return false;
  }
}

export function Header() {
  const { t } = useLocale();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(storedCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (next) {
          localStorage.setItem(COLLAPSED_KEY, "1");
        } else {
          localStorage.removeItem(COLLAPSED_KEY);
        }
      } catch {
        // see storedCollapsed()
      }
      return next;
    });
  };

  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });

  // The organization's name is user content: it arrives from the server as is
  // and is not translated whatever the interface language. Until it arrives the
  // caption holds the product's name rather than emptiness, which would jerk
  // the column's width about. An empty name from the server is emptiness too:
  // `||` and not `??`, otherwise the square on the left would be left without a
  // letter.
  const title = org.data?.name?.trim() || t("app.title");

  // The toggle's caption is needed twice — by the screen reader and by the
  // tooltip in the collapsed column — and must be one string: having drifted
  // apart, they would give one button two different names.
  const toggleLabel = collapsed ? t("nav.sidebar_expand") : t("nav.sidebar_collapse");

  return (
    <header className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      {/* The logo collapses and expands the column itself: a separate button
          with an arrow took up room in the application's narrowest line and
          demanded aiming at 24 pixels, while the logo is a large target that
          stays visible in both states. */}
      {/* The tooltip is our own rather than the `title` attribute. The native
          one is drawn by the system, and the application controls neither its
          place nor its lifetime: it stood on top of the "Projects" item,
          covering its icon and half its caption, and hung around for another
          couple of seconds after the cursor had left. Ours knows about the
          column: it stands to the right of the rail, goes out at once and is
          visible only where there are no captions. */}
      <button
        type="button"
        className="sidebar__workspace"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls={`${NAV_ID} ${FOOT_ID}`}
        aria-label={toggleLabel}
      >
        {/* The square with the first letter is not decoration: in a column of
            identical lines a patch of colour is found by the eye faster than a
            word is read. In a collapsed column it remains the only visible line
            — it shows what application this is and whose organization it is, and
            it is also what expands the column back. */}
        <span className="sidebar__avatar" aria-hidden="true">
          {[...title][0]}
        </span>
        <span className="sidebar__brand">{title}</span>
        {/* An arrow instead of a caption: in an expanded column the
            organization's name stands next to it, and a "Hide menu" tooltip
            would retell in words what the drawing says more briefly. It appears
            under the cursor and on focus — a permanent one would read as part of
            the logo. */}
        <IconCollapse className="sidebar__fold" />
        {/* In the rail it is the other way round: there is nowhere to draw an
            arrow, and the only thing that explains a lone square is a word.
            `aria-hidden`, because the button has already been given a name by
            `aria-label`, and without this the screen reader would say it twice. */}
        <span className="sidebar__tip" aria-hidden="true">
          {toggleLabel}
        </span>
      </button>

      {/* There is no greeting here any more: a person knows their own name
          without the column, and a "Hello, N" line pushed the sections fifty
          pixels down — there is no reason to pay for politeness with room in the
          very top of the column. */}
      <OrgSwitch />

      {/* The sections of work — and only they. The organization's roster moved
          from here into the settings: invitations and roles configure the
          workspace rather than the work in it, and they have no business
          standing next to "Projects". Some routes answer the `client` role with
          a refusal, but the links stay visible — hiding them would mean deciding
          about access on the client, and the server is what decides. */}
      <nav className="sidebar__nav" id={NAV_ID}>
        {/* "Projects" leads where signing in leads — to `/projects`. The item
            used to point at "/", where a different screen with the same heading
            lived: a click on the only item about projects took you somewhere
            other than where you had just landed after signing in.

            Without `end`: a project's page is part of this same section, and the
            item stays highlighted while the person moves around inside.
            Otherwise on `/projects/42` the column highlights nothing, and it
            does not show where you are. */}
        {/* One item about projects, not three. The former neighbours —
            "Portfolio" and "Reports" — showed the same set of projects under
            their own heading: one boiled down to cards with a verdict, the other
            to a table with readiness and dates. There is one section, and the
            summary lives in its table — choosing which of the three to look at
            is no longer needed. The icon is the one that used to distinguish
            "Projects" specifically from the numbers of "Reports". */}
        {/* The caption is a separate node, as in the bottom block: a collapsed
            column hides the captions, and there is nothing to hide in bare text
            inside a link — the whole line would have to be dimmed, icon and all,
            which is how the rail turned out empty.

            The name is also given separately, as `aria-label`: a hidden caption
            disappears not only from the screen but from the accessibility tree,
            and the icon next to it is `aria-hidden` — a collapsed item would be
            left with no name at all. The string is the same one, so there is
            nothing for the names to drift apart over. */}
        <NavLink to="/projects" className={navClass} aria-label={t("nav.projects")}>
          <IconBoard className="sidebar__icon" />
          <span className="sidebar__label">{t("nav.projects")}</span>
        </NavLink>
        <NavLink to="/my-tasks" className={navClass} aria-label={t("nav.my_tasks")}>
          <IconCheck className="sidebar__icon" />
          <span className="sidebar__label">{t("nav.my_tasks")}</span>
        </NavLink>
      </nav>

      <div className="sidebar__foot" id={FOOT_ID}>
        {/* One cog instead of three items in a row. There used to be
            "Organization", "Settings" (the project's) and "Profile" here — the
            first two with the same icon and with captions from which you could
            not guess which was about what. The project's settings moved into the
            project's own header, where the word "settings" has a subject, and
            the rest became tabs inside this section. */}
        {/* The interface language lives here rather than as a tab in the
            settings: people come to it not to "configure the workspace" but to
            read the current screen, and three clicks to reach it (settings →
            profile → choice) cost more than a line in the column. It stands
            above "Settings" rather than below: it is the single most common
            reason to look here, while "Sign out" stays last — it is aimed at
            least often.

            The switcher is the same one as on the public page, and it is what
            writes the profile field too: there is no second copy — which would
            have drifted from this one on the first edit — either here or on the
            profile screen any more. */}
        <LocaleSwitch />
        {/* Visible only to the director — the single install-wide role, pinned
            on the server to one address (see UserOut.is_director and
            app.director). For the rest the item is not just hidden for tidiness:
            the server will refuse anyway, and showing anyone the road to a
            certain 403 serves no purpose. It stands above "Settings" — neither
            item is about the personal, but the director's panel concerns the
            whole install rather than a single organization, and putting it level
            with the language rather than inside the workspace settings is more
            honest here. */}
        {user?.is_director && (
          <NavLink to="/admin" className={navClass} aria-label={t("nav.admin")}>
            <IconShield className="sidebar__icon" />
            <span className="sidebar__label">{t("nav.admin")}</span>
          </NavLink>
        )}
        {/* The caption is a separate node, because it is hidden in two places:
            on a narrow screen the bottom block moves into the top line, and on a
            wide one the column collapses into a rail. In both cases there is no
            room for the caption, while the items themselves must stay. The name
            for reading aloud is set explicitly at that — the icon is
            `aria-hidden`, and without aria-label a collapsed item would be left
            with no name. */}
        <NavLink to="/settings" className={navClass} aria-label={t("nav.settings")}>
          <IconSettings className="sidebar__icon" />
          <span className="sidebar__label">{t("nav.settings")}</span>
        </NavLink>
        {/* The icon on the left is the same as the neighbouring items': without
            it the "Sign out" caption drifted left on its own, towards the
            column's edge, and the row below broke. A door with an arrow out says
            the same about leaving as the word does — and is found by the eye
            faster when it is specifically what is being looked for. */}
        <button
          type="button"
          className="button--quiet sidebar__button"
          aria-label={t("nav.logout")}
          onClick={() => void logout()}
        >
          <IconExit className="sidebar__icon" />
          <span className="sidebar__label">{t("nav.logout")}</span>
        </button>
      </div>
    </header>
  );
}

/**
 * The current section is marked with a class rather than with the link's
 * colour: the fill shows the item's bounds in full, and it shows where the click
 * will land. `NavLink`'s ready-made `active` class will not do for this — it
 * says nothing about what the item is, and the rule would have to be written
 * through two selectors.
 */
function navClass({ isActive }: { isActive: boolean }) {
  return `sidebar__link${isActive ? " is-current" : ""}`;
}
