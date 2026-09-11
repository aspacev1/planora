import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { errorKey } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import {
  addPublicComment,
  getPublicProject,
  listPublicCommentCounts,
  listPublicComments,
  publicCommentCountsQueryKey,
  publicCommentsQueryKey,
  publicProjectQueryKey,
} from "../api/public";
import type { PublicProjectState } from "../api/public";
import { exportPublicProject } from "../api/export";
import { CommentThread } from "../comments/CommentThread";
import { IconDownload } from "../components/icons";
import { ToastProvider } from "../components/toast";
import { ExportDialog } from "../export/ExportDialog";
import { LocaleSwitch } from "../components/LocaleSwitch";
import { Gantt } from "../gantt/Gantt";
import { usePrefersReducedMotion } from "../gantt/motion";
import { useLocale } from "../i18n/LocaleProvider";
import type { ExportFacts } from "../export/ExportDialog";
import { ProjectHead } from "../project/ProjectHead";

/**
 * A project opened by a public link.
 *
 * The same chart as on the working screen, but read-only: `canWrite` here is not
 * switched off "for now", there is nowhere to take it from — a guest has neither
 * a session nor a role. Internal notes and assignees are not in the server's
 * response at all, and the markup does not have to hide them.
 *
 * The language switcher stands right on the page: a client may not share a
 * language with the team, and they have no profile to take a language from.
 */
export function PublicProject() {
  const { t } = useLocale();
  const { orgSlug = "", projectSlug = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [exporting, setExporting] = useState(false);
  const token = searchParams.get("s") ?? "";
  const queryClient = useQueryClient();
  const reducedMotion = usePrefersReducedMotion();

  const project = useQuery({
    queryKey: publicProjectQueryKey(orgSlug, projectSlug, token),
    queryFn: () => getPublicProject(orgSlug, projectSlug, token),
    retry: false,
  });

  const comments = useQuery({
    queryKey: publicCommentsQueryKey(orgSlug, projectSlug, token),
    queryFn: () => listPublicComments(orgSlug, projectSlug, token),
    retry: false,
    // The feed is asked for only once the page has opened: before that the token
    // may turn out to be dead, and a second request would bring a second error
    // about one and the same thing.
    enabled: project.isSuccess,
  });

  // The reply count on the rows — without the internal ones: they are filtered
  // by the server, not by the markup. The key lies inside the feed's key, so
  // one's own sent reply refreshes the counter too — with the same invalidation
  // as the feed itself.
  const counts = useQuery({
    queryKey: publicCommentCountsQueryKey(orgSlug, projectSlug, token),
    queryFn: () => listPublicCommentCounts(orgSlug, projectSlug, token),
    retry: false,
    enabled: project.isSuccess,
  });
  const commentsByTask = useMemo(
    () => new Map(Object.entries(counts.data ?? {})),
    [counts.data],
  );

  const send = useMutation({
    mutationFn: (input: { body: string; name: string }) =>
      addPublicComment(orgSlug, projectSlug, token, { name: input.name, body: input.body }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: publicCommentsQueryKey(orgSlug, projectSlug, token),
      }),
  });

  if (project.isPending) {
    return (
      <>
        {/* The header stands here too: it is not part of the project but the
            page's frame — with the sign-in and the language switcher, which are
            needed before the content arrives. The organization's name has not
            arrived yet, and its place is held by the product's name rather than
            emptiness, which would then jerk the line's height about. */}
        <PublicHeader title={t("app.title")} />
        <main className="screen screen--center">
          <p role="status">{t("common.loading")}</p>
        </main>
      </>
    );
  }

  if (project.error) {
    // A revoked link, a typo in the address and a non-existent project all come
    // back as one and the same refusal: the server deliberately does not tell
    // them apart, and inventing a difference here is not allowed.
    return (
      <>
        {/* And here too: a revoked link is most often opened by one of your own
            — the person who sent the link out. They need the sign-in, not just a
            message saying there is no way further. */}
        <PublicHeader title={t("app.title")} />
        <main className="screen screen--center">
          <p className="error" role="alert">
            {t(errorKey(project.error))}
          </p>
        </main>
      </>
    );
  }

  return (
    // Its own toasts rather than the protected screens' frame (see RequireAuth):
    // a guest has no frame, and the export dialog reports a refusal precisely
    // with a toast. Without a provider here the refusal went into an empty
    // handler, and "Download" simply did nothing — no file and no word about why.
    <ToastProvider>
      <PublicHeader title={project.data.org.name} projectId={project.data.id} />

      <main className="screen screen--wide">
        {/* The same header as on the working screen, but without the actions and
            without the plan line: a client following a link is promised dates and
            volume, not the approval version and the internal divergences from it. */}
        {/* Export is available to a guest: the same trimmed version they see on
            screen — without the baseline plan, the assignees and the internal
            replies. Refusing it would mean forbidding them to save what is
            already shown. */}
        <ProjectHead
          state={project.data}
          actions={
            <button
              type="button"
              className="button--quiet"
              onClick={() => setExporting(true)}
            >
              <IconDownload />
              {t("export.open")}
            </button>
          }
        />

        {exporting && (
          <ExportDialog
            facts={publicFacts(project.data)}
            onClose={() => setExporting(false)}
            download={(options) =>
              exportPublicProject(orgSlug, projectSlug, searchParams.toString(), options)
            }
          />
        )}

        <div className={`project__body${reducedMotion ? " motion-off" : ""}`}>
          {/* The reply counter is visible to a guest too — but does not become a
              button: they have no task card, and there is nothing for it to open
              (see Row). Knowing that this row has already been talked about is
              useful to them all the same: the conversation runs in the feed below. */}
          <Gantt
            projectId={project.data.id}
            state={project.data}
            canWrite={false}
            commentCounts={commentsByTask}
          />
        </div>

        <CommentThread
          comments={comments.data ?? []}
          loading={comments.isPending}
          error={comments.error}
          askName
          canComment={project.data.comments_enabled}
          onSend={(input) => send.mutateAsync(input)}
          sending={send.isPending}
          sendError={send.error}
        />
      </main>
    </ToastProvider>
  );
}

/**
 * The header of a page opened by link — and the only way from here into the
 * application itself.
 *
 * A public link is opened not only by a client: your own team walks it too, and
 * so does whoever sent it out. The header used to hold a "public page" caption
 * and the language switcher, and a person who ended up here saw no way inside at
 * all — the sign-in address had to be known by heart.
 *
 * What to offer is decided by the session rather than by a guess:
 *
 * — a guest gets "Sign in", and after signing in they land in this same project
 *   rather than in the general list: they came by a link to this one, and losing
 *   it at the password step would mean making them look for the project again.
 *   To someone else's account the project will answer with the same refusal as
 *   ever: a link opens a page, not access, and the header has nothing to decide
 *   about access with;
 * — someone signed in gets "Open in the application": offering them a sign-in
 *   means asking for a password from someone who is already signed in;
 * — while the session is being checked — nothing: showing "Sign in" and
 *   replacing it a moment later with a different link is worse than showing that
 *   link a moment later.
 *
 * A link styled as a button rather than an underlined word: the "public page"
 * caption and the language switcher stand next to it, and among words a word
 * would be lost.
 */
function PublicHeader({ title, projectId }: { title: string; projectId?: string }) {
  const { t } = useLocale();
  const { status } = useAuth();
  // The project's address is known only once the project has opened: on a
  // revoked link there is nowhere to come back to after signing in, and the
  // person lands where an ordinary sign-in leads — in the list of projects.
  const inApp = projectId === undefined ? null : `/projects/${projectId}`;

  return (
    <header className="header">
      <span className="header__brand">{title}</span>
      <div className="header__side">
        <span className="muted">{t("public.badge")}</span>
        <LocaleSwitch />
        {status === "anonymous" && (
          <Link
            className="button-link"
            to="/login"
            // The same way `RequireAuth` remembers an address: the sign-in
            // screen reads it from the navigation state (see afterAuthPath).
            state={inApp === null ? undefined : { from: { pathname: inApp } }}
          >
            {t("public.login")}
          </Link>
        )}
        {status === "authenticated" && (
          <Link className="button-link" to={inApp ?? "/projects"}>
            {t("public.open_app")}
          </Link>
        )}
      </div>
    </header>
  );
}


/**
 * What to offer a guest in the export dialog.
 *
 * Computed from the same state that is drawn on screen rather than by a request:
 * a public page has no `export/facts` route — and creating one would mean handing
 * out the section counters, which the guest will not see anyway.
 *
 * The quote, the scorecard and the edit journal are not offered to them at all —
 * by the same rule that applies on the server: an export does not show more than
 * the page it was called from shows (see INTERNAL_SECTIONS).
 */
function publicFacts(state: PublicProjectState): ExportFacts {
  const starts = state.tasks.map((task) => task.start_date).sort();
  return {
    projectName: state.name,
    start: starts[0] ?? state.start_date ?? new Date().toISOString().slice(0, 10),
    end: state.project_end ?? starts[starts.length - 1] ?? new Date().toISOString().slice(0, 10),
    // A guest's "today" is the browser's: a public response does not carry the
    // project's time zone. That does not affect the number of pages: the windows
    // are counted in whole days, and a difference of a zone does not shift them.
    today: new Date().toISOString().slice(0, 10),
    dated: state.schedule_mode === "calendar",
    tasks: state.tasks.length,
    categories: state.categories.length,
    links: state.dependencies.length,
    comments: 0,
    proposalLines: 0,
    scorecardMetrics: 0,
    historyEvents: 0,
    internalAllowed: false,
  };
}
