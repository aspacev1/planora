import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

/**
 * The tests' network.
 *
 * The initial handlers set only the answers asked for not by the screen under test but by the
 * environment around it: without them any test would fail — on a request it has nothing to do with.
 * Each is overridden through `server.use`, like any other answer.
 *
 * The list of organizations is asked for by the header on every protected screen. An empty list means
 * "there is nothing to switch between", that is, exactly the state a person with one organization
 * lives in.
 *
 * The reply counter is asked for by every screen with a strip — the working one and the public one.
 * An empty answer means "nothing has been discussed anywhere yet": that is where every project
 * begins, and in that state there is not a single number on the strip's rows.
 *
 * The Jira link is asked for by the project's settings on every render — the sync panel stays silent
 * until the "not linked" answer arrives, but the request goes out anyway, and tests that are not
 * about Jira (the public link, deleting a project, the toasts) have no reason to declare it
 * themselves every time.
 *
 * The install's settings are asked for by the application's frame — the "address not confirmed"
 * strip. Mail is enabled: this is an ordinary install, and a test about address confirmation must
 * not start by declaring a mail server.
 */
export const server = setupServer(
  http.get("/api/config", () =>
    HttpResponse.json({
      mail_enabled: true,
      signup_mode: "open",
      supported_locales: ["az", "en", "ru"],
      default_locale: "az",
      public_sharing_enabled: true,
      live_enabled: true,
    }),
  ),
  http.get("/api/org/list", () => HttpResponse.json([])),
  http.get("/api/projects/:projectId/comments/counts", () => HttpResponse.json({})),
  http.get("/api/public/:orgSlug/:projectSlug/comments/counts", () => HttpResponse.json({})),
  http.get("/api/projects/:projectId/jira", () =>
    HttpResponse.json({ linked: false, jira_project_key: null, jql: null, last_synced_at: null }),
  ),
);
