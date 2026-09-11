import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { AppRoutes } from "../AppRoutes";
import { AuthProvider } from "../auth/AuthProvider";
import { LocaleProvider } from "../i18n/LocaleProvider";
import type { Locale } from "../i18n";

/**
 * A client for one test, without retries: retrying a failed request hides the error from the
 * test for several seconds and makes the failure look like a timeout.
 */
export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function Providers({
  children,
  locale = "az",
  route = "/",
}: {
  children: ReactNode;
  locale?: Locale;
  route?: string;
}) {
  return (
    <QueryClientProvider client={newQueryClient()}>
      <LocaleProvider initial={locale}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options: { locale?: Locale; route?: string } = {},
) {
  return render(<Providers {...options}>{ui}</Providers>);
}

/**
 * A profile for the tests. `locale` matches the language the interface is rendered in: the
 * profile's language beats the browser's, and a divergence here would mean the test checks
 * something other than what its name says.
 */
export const USER = {
  id: "u1",
  name: "Алексей",
  email: "a@b.c",
  locale: "ru",
  // No zone chosen: the day is counted by the browser — the state everyone who never thought
  // about this setting lives in.
  timezone: null as string | null,
  email_verified: true,
  is_director: false,
};

/**
 * An organization for the tests. The name is deliberately Azerbaijani: user content is not
 * translated whatever the interface language, and that is only noticeable on a name that does
 * not match the screen's language.
 */
export const ORG = {
  id: "o1",
  name: "Şəhər Studiyası",
  slug: "seher-studiyasi",
  role: "owner",
  settings: {
    default_locale: "az",
    default_timezone: "Asia/Baku",
    // Monday to Friday: bit 0 is Monday, as the server counts it.
    working_days: 0b11111,
    week_start: 0,
    holiday_calendar: ["2026-03-20"],
    default_shift_threshold_days: 2,
    public_sharing_enabled: true,
    default_comments_enabled: true,
  },
};

/**
 * The responses without which a protected route does not open at all: the profile and the
 * organization. A test about projects must not rewrite them itself — otherwise half its text
 * will be about signing in rather than about what it checks. They come first, so that a test's
 * `server.use` can override any of them.
 */
export function sessionHandlers() {
  return [
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/org", () => HttpResponse.json(ORG)),
    // The language switcher saves the choice to the profile — on any screen that has it, that
    // is, on any protected one. A test about projects must not declare this itself, but it must
    // not fail on an undeclared request either.
    http.patch("/api/auth/me", async ({ request }) => {
      const patch = (await request.json()) as Partial<typeof USER>;
      return HttpResponse.json({ ...USER, ...patch });
    }),
    // The comment feed hangs on every project screen, and a test about the chart must not fail on
    // a request it has nothing to do with. Empty by default: a test about the conversation
    // declares its own and overrides this one, because it is registered later.
    http.get("/api/projects/:projectId/comments", () => HttpResponse.json([])),
    // The roster is asked for by the chart itself — for the "Assignee" filter. For the same
    // reason as the comments: empty by default, a test about owners declares its own.
    http.get("/api/org/members", () => HttpResponse.json([])),
  ];
}

/**
 * The current address, lifted into the markup.
 *
 * Navigation after a successful action is observable behaviour, and it has to be checked the way
 * a person sees it: by where they landed. Faking `useNavigate` instead would check that the
 * component called a function — and would go on staying green if there were no route at that
 * address at all.
 */
function LocationProbe() {
  const location = useLocation();
  // Together with the query and the hash: a return to a sent link must preserve it whole, and
  // that cannot be seen from the path alone.
  return <span data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

/** The whole application: routes, authentication, languages — as in production. */
export function renderApp(options: { route?: string; locale?: Locale } = {}) {
  const { route = "/", locale = "ru" } = options;
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <LocaleProvider initial={locale}>
        <MemoryRouter initialEntries={[route]}>
          <AuthProvider>
            <AppRoutes />
            <LocationProbe />
          </AuthProvider>
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}
