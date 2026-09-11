import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { commentCounts, commentCountsQueryKey } from "../api/comments";
import { errorKey } from "../api/errors";
import { MEMBERS_QUERY_KEY, members } from "../api/org";
import { getProject, projectQueryKey } from "../api/projects";
import type { Category } from "../api/projects";
import { roleCanReadProposal, useCanWrite, useOrgRole } from "../auth/permissions";
import {
  IconCalendar,
  IconDownload,
  IconExpand,
  IconInvite,
  IconSettings,
  IconShare,
  IconShrink,
} from "../components/icons";
import { useEscape } from "../components/useEscape";
import { InviteDialog } from "../components/InviteDialog";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { exportFacts, exportFactsQueryKey, exportProject } from "../api/export";
import { ExportDialog } from "../export/ExportDialog";
import { Gantt } from "../gantt/Gantt";
import type { NewTaskAt } from "../gantt/Gantt";
import { usePrefersReducedMotion } from "../gantt/motion";
import { useGanttView } from "../gantt/useGanttView";
import { GanttViewControls } from "../gantt/ViewControls";
import { useLocale } from "../i18n/LocaleProvider";
import { LiveProvider } from "../live/LiveProvider";
import { OfflineBar } from "../live/OfflineBar";
import { useProjectLive } from "../live/useProjectLive";
import { DependencyNudge, DependencyNudgeProvider } from "../project/DependencyNudge";
import { deleteCategory } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { PlanApproval } from "../project/PlanApproval";
import { PlanChangesPanel } from "../project/PlanChangesPanel";
import { PlanSummary } from "../project/PlanSummary";
import { ProjectBar } from "../project/ProjectBar";
import { Proposal } from "../proposal/Proposal";
import { ProjectHistory } from "../project/ProjectHistory";
import { Scorecard } from "../scorecard/Scorecard";
import { ShiftReasonProvider } from "../project/ShiftReason";
import { StartDateDialog } from "../project/StartDateDialog";
import { UndoHotkey } from "../project/UndoHotkey";
import { TaskPanel } from "../task/TaskPanel";
import type { PanelTab } from "../task/TaskPanel";
import { CategoryForm, suggestColor } from "./CategoryForm";
import { ShareDialog } from "./ShareDialog";

/**
 * A single project's screen.
 *
 * Three explicit states rather than two: until the state arrives an empty chart
 * must not be shown — it reads as "there is nothing in this project". A 404
 * means both a non-existent project and someone else's: the interface does not
 * know the difference and does not pretend to.
 */
export function Project({
  tab = "gantt",
}: { tab?: "gantt" | "history" | "proposal" | "scorecard" } = {}) {
  const { t } = useLocale();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const role = useOrgRole();
  // The same flag as the strip's: a card sliding out is the same kind of motion
  // as a bar travelling, and they must switch off together.
  const reducedMotion = usePrefersReducedMotion();
  const [addingCategory, setAddingCategory] = useState(false);
  // The category we are asking about parting with. Held by id rather than by
  // the category itself: while the dialog is open the state arrives from the
  // server anew, and a dialog remembering the object would name an old name.
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Asked for only while the dialog is open: the section counts are needed once
  // in a screen's life, and there is no reason to pay a request per project view.
  const factsQuery = useQuery({
    queryKey: exportFactsQueryKey(projectId),
    queryFn: () => exportFacts(projectId),
    enabled: exporting,
  });
  // The organization invitation dialog. Opened right from the project: people
  // are invited when you are looking at the work you are about to hand them,
  // not when you have gone into the workspace settings.
  const [inviting, setInviting] = useState(false);
  // The dialog binding the plan to a start date — and moving an already assigned one.
  const [scheduling, setScheduling] = useState(false);
  // Whether the list of divergences from the approved plan is open. Lives here
  // rather than in the header: it is opened from two places — the divergence
  // marker and a link in the re-approval confirmation — and both sit in
  // different subtrees.
  const [showingChanges, setShowingChanges] = useState(false);
  // Whether the re-approval question has been asked. Also here: it is asked
  // both by the header button and from the changes panel's footer, and the
  // action has a single question.
  const [reapproving, setReapproving] = useState(false);
  // Whether the strip shows the ghost of the approved plan. Lifted out of the
  // strip because the same layer is driven by the toggle in the changes panel:
  // the list and the chart tell the same thing in two languages, and they share
  // one switch.
  const [showBaseline, setShowBaseline] = useState(true);
  // The strip's scale, columns and layers. Owned by the screen, not by the
  // strip: the controls sit in the project header, to the right of the tabs,
  // while the strip draws by them — and one state must have one owner (see
  // useGanttView).
  const ganttView = useGanttView(projectId, {
    baselineShown: showBaseline,
    onBaselineToggle: () => setShowBaseline((shown) => !shown),
  });
  // Where the new-task row is open. `null` — closed.
  //
  // A task is created right in the strip and not in a dialog: a plan is written
  // as a list, and a dialog between rows would mean opening, filling in and
  // closing it as many times as there are items in the plan. A single name is
  // asked for, the rest is edited in the card (see NewTaskRow).
  const [addingTaskAt, setAddingTaskAt] = useState<NewTaskAt | null>(null);
  // The task whose card is open. Held by id rather than by the task itself:
  // after every change the state arrives from the server anew, and a card
  // remembering the object would show stale data.
  //
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // A card is also opened by address: the "in the plan" marker on a quote line
  // leads here with `?task=<id>`, and the card must open right away rather than
  // after finding the row in the strip. By watching the address rather than as
  // the state's initial value: the screen is not remounted between the
  // project's tabs, and an initial value read on the quote would not survive to
  // the chart. The parameter is cleared right here: reloading the page must not
  // open the card again — opening it was asked for once.
  const [searchParams, setSearchParams] = useSearchParams();
  const taskFromAddress = searchParams.get("task");
  useEffect(() => {
    if (taskFromAddress === null) return;
    setSelectedTaskId(taskFromAddress);
    const next = new URLSearchParams(searchParams);
    next.delete("task");
    setSearchParams(next, { replace: true });
  }, [taskFromAddress, searchParams, setSearchParams]);
  // Which section to open the card on. Two paths lead into it from a strip row:
  // the name and the bar go to the properties, the reply counter goes straight
  // to the discussion. After that the card drives its own tabs.
  const [selectedTaskTab, setSelectedTaskTab] = useState<PanelTab>("details");
  const openTask = (taskId: string, tab: PanelTab = "details") => {
    setSelectedTaskTab(tab);
    // The card slides out into the same place on the right as the divergence
    // list: two sliding columns cannot fit there, and whichever opened last
    // takes it alone. It is the list that closes — the card is what was just
    // asked for.
    setShowingChanges(false);
    // A repeat click on the same row closes the card: people do that without
    // thinking, and without it the click looks like nothing happened. Going
    // from the name to the reply counter, though, is not a repeat but a
    // different section of the same card, and must not close it.
    setSelectedTaskId((current) =>
      current === taskId && tab === selectedTaskTab ? null : taskId,
    );
  };
    // A card arrived at from somewhere else — from the scorecard, from the
    // divergence list — must open rather than toggle. The "a repeat click
    // closes" rule is about the strip row at hand; a person who picked a task
    // in a list expects its card, even if it was already open on the strip.
  const showTask = (taskId: string) => {
    setSelectedTaskTab("details");
    setShowingChanges(false);
    setSelectedTaskId(taskId);
  };

  // The strip is expanded to the full screen. Not remembered between visits:
  // full screen is turned on deliberately, and a project opening without a
  // header and a column would read as broken rather than as conveniently
  // configured.
  const [focusMode, setFocusMode] = useState(false);

  const query = useQuery({
    queryKey: projectQueryKey(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
  });

  // The live connection opens with the screen and lives as long as it is open:
  // other people's revisions arrive on their own, and a drop is the only thing
  // that locks editing.
  const live = useProjectLive(projectId);

  const offline = live.status === "offline";

  // A dropped connection brings back the ordinary view: the offline strip
  // stands above the chart, and a full-screen chart would cover it — the person
  // would see that the bars had stopped moving and not see why.
  useEffect(() => {
    if (offline) setFocusMode(false);
  }, [offline]);

  // There is nothing to expand on the other tabs: full-screen mode carried from
  // tab to tab would cover the history or the quote, which it has nothing to do
  // with.
  useEffect(() => {
    if (tab !== "gantt") setFocusMode(false);
  }, [tab]);

  // Esc collapses full screen — through the same layer that closes dialogs and
  // menus: the full-screen strip is the top layer while it is expanded.
  useEscape(() => setFocusMode(false), focusMode);

  const { apply } = useProjectMutation(projectId);
  // The refusal stays silent — the same way as with row reordering
  // (useReorder): rolling the guess back inside `apply` has already returned
  // the category to the screen, and that is enough — it was deleted in another
  // tab, and the next refetch will show the truth.
  const removeCategory = (categoryId: string) => {
    void apply({ type: "delete_category", category_id: categoryId }, (state) =>
      deleteCategory(state, categoryId),
    ).catch(() => {});
  };

  // The organization's roster — only for the assignee names in the bar's hover
  // card. Asked for by the screen rather than by the strip: the strip has no
  // "this is a public page" flag, and deciding whether to go for the roster is
  // not its job. A refusal is not the screen's error: the `client` role never
  // gets this route at all, and the card then does without the assignee line.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: members,
    retry: false,
    staleTime: Infinity,
  });
  const assigneeNames = useMemo(
    () => new Map((membersQuery.data ?? []).map((member) => [member.id, member.name])),
    [membersQuery.data],
  );

  // How many replies each task has — the number on a strip row. As a separate
  // request rather than a state field: a comment does not change the state, and
  // a counter baked into it would show yesterday's number until the next plan
  // edit. The key lies inside the comment feed's key, so both your own reply
  // and someone else's over the socket refresh it with the same invalidation
  // (see api/comments.ts).
  const countsQuery = useQuery({
    queryKey: commentCountsQueryKey(projectId),
    queryFn: () => commentCounts(projectId),
    retry: false,
  });
  const commentsByTask = useMemo(
    () => new Map(Object.entries(countsQuery.data ?? {})),
    [countsQuery.data],
  );

  if (query.isPending) {
    return (
      <main className="screen">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  if (query.error) {
    return (
      <main className="screen">
        <p className="error" role="alert">
          {t(errorKey(query.error))}
        </p>
      </main>
    );
  }

  // The task may have disappeared between opening the card and the server's
  // next answer: it was deleted in another tab. The card then simply is not drawn.
  const selectedTask = query.data.tasks.find((task) => task.id === selectedTaskId) ?? null;
  // The same goes for the category being asked about: it may have been deleted
  // while the question was being read — then there is nothing to ask about.
  const deletingCategory =
    query.data.categories.find((category) => category.id === deletingCategoryId) ?? null;

  // While there is no connection, what is shown is stale by an unknown amount,
  // and any change would land on top of someone else's edits blindly. The
  // permission has not gone anywhere, though — which is why the flags are
  // different: `canWrite` answers "who is allowed", this one answers "is it
  // allowed right now".
  const editable = canWrite && !offline;

  // For a client the quote's address leads to the chart: they have no such tab
  // (see below), and the server would refuse the quote anyway. A refusal in
  // words would read as a breakage to someone who was not aiming here but came
  // by someone else's link.
  if (tab === "proposal" && role === "client") {
    return <Navigate to={`/projects/${projectId}`} replace />;
  }

  return (
    <ShiftReasonProvider>
      <DependencyNudgeProvider>
        <LiveProvider live={live}>
          <main className="screen screen--wide">
            {/* Ctrl/⌘+Z — on both tabs at once, rather than inside the strip or
                the history: it undoes the project's last change, and that does
                not depend on which tab is open. */}
            <UndoHotkey projectId={projectId} state={query.data} enabled={editable} />

            {/* The header is one line: name, plan state, tabs, actions. In
                full-screen mode it is hidden entirely: nothing stands above the
                strip there. */}
            {!focusMode && (
              <ProjectBar
                state={query.data}
                onShowChanges={() => setShowingChanges(true)}
                summary={<PlanSummary state={query.data} />}
                tabs={
                  /* The tabs live in the address rather than in the screen's
                     state: the history gets linked to in conversations, and a
                     link must open it straight away. */
                  <nav className="tabs" aria-label={t("history.tabs_label")}>
                    <NavLink to={`/projects/${projectId}`} end className={tabClass}>
                      {t("history.tab_gantt")}
                    </NavLink>
                    {/* The quote sits between the strip and the history, as in
                        the mockup: the strip stays the project's first screen,
                        the quote is next to it. The tab is not shown to a
                        client: the server does not give them the quote
                        (Action.PROPOSAL_READ), and nobody needs a road to a
                        certain refusal. The server decides either way. */}
                    {role !== "client" && (
                      <NavLink to={`/projects/${projectId}/proposal`} className={tabClass}>
                        {t("history.tab_proposal")}
                      </NavLink>
                    )}
                    {/* The scorecard comes after the quote, before the history:
                        the week's summary is closer to the work than the
                        journal is. On a public page (/p/...) there are no tabs
                        at all. */}
                    <NavLink to={`/projects/${projectId}/scorecard`} className={tabClass}>
                      {t("history.tab_scorecard")}
                    </NavLink>
                    <NavLink to={`/projects/${projectId}/history`} className={tabClass}>
                      {t("history.tab_history")}
                    </NavLink>
                  </nav>
                }
                planAction={
                    <>
                      <PlanApproval
                        projectId={projectId}
                        state={query.data}
                        canApprove={editable}
                        // Re-approval is an owner's right: it moves the baseline
                        // all explained shifts are measured from.
                        canReapprove={role === "owner" && !offline}
                        confirming={reapproving}
                        onConfirmingChange={setReapproving}
                        onShowChanges={() => setShowingChanges(true)}
                      />
                      {/* Binding the plan to a date is the plan's business, as
                          approval is, and stands next to its state rather than
                          in the row of strip settings where it used to live: it
                          changes the project, not how the project is looked at.
                          Outlined rather than filled — like re-approval next to
                          it: the action matters but happens once, and there is
                          nothing for it to share a first glance with. The hint
                          about when the date is assigned is on the button
                          itself.

                          Moving an already assigned date is rare, and it lives
                          under "⋯". A reader of a relative plan gets a mode
                          badge instead of a button: a scale without months would
                          read as a breakage without it. */}
                      {query.data.schedule_mode === "relative" &&
                        (canWrite ? (
                          <button
                            type="button"
                            className="button--accent"
                            disabled={offline}
                            title={t("gantt.relative.hint")}
                            onClick={() => setScheduling(true)}
                          >
                            {t("schedule.open")}
                          </button>
                        ) : (
                          <span className="project-toolbar__mode" title={t("gantt.relative.hint")}>
                            {t("gantt.relative.badge")}
                          </span>
                        ))}
                    </>
                  }
                  // How to look at the strip — on the right, apart from the tabs
                  // and quieter than them: these are second-class controls, and
                  // the other tabs have none — a scale means nothing to the
                  // quote or the history. The group is pinned to the right edge,
                  // so its appearance and disappearance move nothing on the left.
                  tools={
                    tab === "gantt" ? (
                      <>
                        <GanttViewControls view={ganttView} variant="bar" />
                        {/* The full-screen strip comes last in the row of view
                            settings: it is a way of looking too, the widest of
                            them. An icon without a caption: arrows into the
                            corners are understood by everyone, and the name
                            stayed with the button — for the screen reader and
                            the tooltip. Leaving the mode has its own button on
                            top of the strip (see below): the header is hidden
                            in it. */}
                        <button
                          type="button"
                          className="button--ghost project-toolbar__icon"
                          aria-pressed={false}
                          aria-label={t("gantt.toolbar.focus")}
                          title={t("gantt.toolbar.focus")}
                          onClick={() => {
                            // The page scroll is reset before expanding: the
                            // strip's height is measured from the window
                            // (useViewportFit), and a layer opened on a scrolled
                            // page would measure it from an edge that has moved
                            // away.
                            window.scrollTo(0, 0);
                            setFocusMode(true);
                          }}
                        >
                          <IconExpand />
                        </button>
                      </>
                    ) : undefined
                  }
                  // Rare actions go under "⋯": each opens a dialog, and in the
                  // row of permanent buttons they only stood there in order to
                  // stand there. Four chips in a line is exactly the tier the
                  // header grew into the last time (the "Export" button arrived
                  // after the header had already been squeezed).
                  //
                  // A guest is not handed the buttons at all: they would promise
                  // an action the server will reject. A menu without a single
                  // item is not drawn — a reader without write permission is
                  // left with the export alone, and it is the only item in the
                  // menu.
                  //
                  // Every action has an icon to the left of its caption: a row
                  // of identical chips differed only by a word, and finding the
                  // right one meant reading all of them in turn, whereas a
                  // drawing is found by the eye before the word is read. The
                  // icons are `aria-hidden`: read aloud they would repeat the
                  // caption next to them.
                  actions={
                    <Menu
                      label="⋯"
                      showCaret={false}
                      buttonLabel={t("project.actions.more")}
                    >
                      {/* Publishing is an action on the project, and it stands
                          in the common row of actions rather than right next to
                          the name: the plan's state now lives by the name, and
                          the actions are gathered in one place. Not shown to a
                          guest or a reader: the server will reject such an
                          attempt. */}
                      {canWrite && (
                        <button
                          type="button"
                          className="menu__item"
                          disabled={offline}
                          onClick={() => setSharing(true)}
                        >
                          <IconShare />
                          {t("share.open")}
                        </button>
                      )}
                      {/* Export stands in the common row of actions rather than
                          in the strip's toolbar: the file is built from the
                          quote and from the scorecard too, while the toolbar
                          lives only on the strip's tab. Shown to everyone
                          entitled to read the project — a client and a guest
                          will get the same trimmed version they see on screen. */}
                      <button
                        type="button"
                        className="menu__item"
                        disabled={offline}
                        onClick={() => setExporting(true)}
                      >
                        <IconDownload />
                        {t("export.open")}
                      </button>
                      {/* Moving the start date of an already bound plan lives
                          here rather than in the header: for a configured
                          project this is rare, and a permanent button stood in
                          the row only in order to stand there. The first
                          binding, on the contrary, stands in the header by the
                          plan's state — it is the plan's business, not a rarity. */}
                      {canWrite && query.data.schedule_mode === "calendar" && (
                        <button
                          type="button"
                          className="menu__item"
                          disabled={offline}
                          onClick={() => setScheduling(true)}
                        >
                          <IconCalendar />
                          {t("schedule.change")}
                        </button>
                      )}
                      {/* The invitation stands next to publishing: both buttons
                          answer "let someone look", and the difference between
                          them is who. A link opens the project for reading to
                          anyone, an invitation calls a person into the
                          organization with a role and permissions.

                          The permission here is stricter than its neighbours' —
                          the owner, not anyone who can write: an invitation
                          hands out access to the whole organization, and the
                          server (invitations.py) answers someone else's attempt
                          with a refusal. A dropped live connection does not
                          disable the button, unlike publishing: an invitation
                          does not write to the project and has no stale state in
                          front of it. */}
                      {role === "owner" && (
                        <button
                          type="button"
                          className="menu__item"
                          onClick={() => setInviting(true)}
                        >
                          <IconInvite />
                          {t("invite.open")}
                        </button>
                      )}
                      {/* The settings live here and not in the sidebar they were
                          moved to for a while: there is one column for the whole
                          application, and the settings belong to this project.

                          The caption is one word, and the action's full name is
                          given to `aria-label`: the entrance to the workspace
                          settings stands nearby in the column with the same
                          word, and what tells them apart is the place — the
                          project's row of actions under its name — together with
                          the icon. Someone listening to the screen cannot see
                          the place, and is still told the subject. The visible
                          caption is contained in the spoken one in full, so
                          voice control ("press settings") lands on the button.

                          The permission is the same as the other actions': for a
                          reader the link would promise a server refusal. */}
                      {canWrite && (
                        <Link
                          to={`/projects/${projectId}/settings`}
                          className="menu__item"
                          aria-label={t("settings.project.link_aria")}
                        >
                          <IconSettings />
                          {t("settings.project.link")}
                        </Link>
                      )}
                    </Menu>
                  }
              />
            )}

            {offline && <OfflineBar syncedAt={query.dataUpdatedAt || null} />}

            {/* The quote, the scorecard and the history share one wrapper with
                the header's margins on either side (see .project__pane): the
                strip is not part of it, it runs edge to edge. */}
            {tab !== "gantt" && (
              <div className="project__pane">
              {tab === "history" && (
                <ProjectHistory projectId={projectId} state={query.data} canUndo={editable} />
              )}

              {tab === "proposal" && (
                <Proposal
                  projectId={projectId}
                  canWrite={editable}
                  canExport={roleCanReadProposal(role)}
                />
              )}

              {/* The scorecard is given "who is allowed", not "is it allowed
                  right now": it accounts for a dropped connection itself —
                  recalculation goes dark while reading stays. A task from the
                  drill-down opens on the strip — by the same transition as from
                  the divergence list. */}
              {tab === "scorecard" && (
                <Scorecard
                  projectId={projectId}
                  canWrite={canWrite}
                  onOpenTask={(taskId) => {
                    navigate(`/projects/${projectId}`);
                    showTask(taskId);
                  }}
                />
              )}
              </div>
            )}

            {/* The offer to move a linked task stands above the strip rather
                than on top of it: it is unobtrusive and must not cover what the
                person has just moved. In full-screen mode it is absent: nothing
                stands above the strip there, and a layer on top of it would
                cover the tasks. */}
            {tab === "gantt" && editable && !focusMode && (
              <DependencyNudge projectId={projectId} state={query.data} />
            )}

            {/* The chart takes the full width while the card is closed: an empty
                column on the right takes a third of the screen from the strip for nothing. */}
            {tab === "gantt" && (
            <div
              className={`project__body${reducedMotion ? " motion-off" : ""}${
                focusMode ? " project__body--focus" : ""
              }`}
            >
              <Gantt
                projectId={projectId}
                state={query.data}
                canWrite={editable}
                assigneeNames={assigneeNames}
                baselineShown={showBaseline}
                onBaselineToggle={() => setShowBaseline((shown) => !shown)}
                viewState={ganttView}
                onAddTask={editable ? setAddingTaskAt : undefined}
                newTaskAt={addingTaskAt}
                onCloseNewTask={() => setAddingTaskAt(null)}
                // The "plus" in the table's corner and the button in an empty
                // strip open the same dialog: a category is created where you
                // are looking — by the list's heading or in the middle of an
                // empty field — and not in a row above the strip.
                onAddCategory={editable ? () => setAddingCategory(true) : undefined}
                // The cross on a category row only asks: deleting takes the
                // whole stage with it, and naming what exactly will go has to
                // happen before it goes — not in a toast afterwards.
                onDeleteCategory={editable ? setDeletingCategoryId : undefined}
                selectedTaskId={selectedTaskId}
                onSelectTask={(taskId) => openTask(taskId)}
                onOpenComments={(taskId) => openTask(taskId, "comments")}
                commentCounts={commentsByTask}
              />

              {/* The header is hidden in full screen, and the expand button with
                  it — the exit lives on top of the strip itself, in the top
                  right corner, where it is looked for out of habit from video
                  and maps. Esc does the same. */}
              {focusMode && (
                <button
                  type="button"
                  className="button--quiet project-toolbar__icon project__focus-exit"
                  aria-pressed={true}
                  aria-label={t("gantt.toolbar.focus_exit")}
                  title={t("gantt.toolbar.focus_exit")}
                  onClick={() => setFocusMode(false)}
                >
                  <IconShrink />
                </button>
              )}

              {selectedTask && (
                <TaskPanel
                  projectId={projectId}
                  task={selectedTask}
                  state={query.data}
                  canWrite={editable}
                  initialTab={selectedTaskTab}
                  onClose={() => setSelectedTaskId(null)}
                />
              )}
            </div>
            )}

            {sharing && <ShareDialog projectId={projectId} onClose={() => setSharing(false)} />}

            {/* What the project has and has not is reported to the dialog by the
                screen: it already has the state in hand, and a dialog that went
                for it itself would show an empty list of sections for the first
                half-second after opening. */}
            {exporting && (
              <ExportDialog
                facts={
                  factsQuery.data && {
                    projectName: query.data.name,
                    start: factsQuery.data.start,
                    end: factsQuery.data.end,
                    today: factsQuery.data.today,
                    dated: factsQuery.data.dated,
                    tasks: factsQuery.data.tasks,
                    categories: factsQuery.data.categories,
                    links: factsQuery.data.links,
                    comments: factsQuery.data.comments,
                    proposalLines: factsQuery.data.proposal_lines,
                    scorecardMetrics: factsQuery.data.scorecard_metrics,
                    historyEvents: factsQuery.data.history_events,
                    internalAllowed: factsQuery.data.internal_allowed,
                  }
                }
                onClose={() => setExporting(false)}
                download={(options) => exportProject(projectId, options)}
              />
            )}

            {/* The same set of fields as on the organization roster screen — and
                the same component: people are invited the same way wherever they
                are called from. The project is passed on and marked in the list
                in advance — for any role, not only "Client". */}
            {inviting && (
              <InviteDialog projectId={projectId} onClose={() => setInviting(false)} />
            )}

            {scheduling && (
              <StartDateDialog
                projectId={projectId}
                state={query.data}
                onClose={() => setScheduling(false)}
              />
            )}

            {/* The list of divergences from the plan is a sliding column on the
                right, with no backdrop: the strip on the left stays visible and
                workable, and the ghosts of the approved plan on it are read
                together with the list. It can be open on any tab: the divergence
                marker stands in the header, and the header is one for all three.
                A task's name leads into its card — and that lives only on the
                strip, so going there brings you back to it as well. */}
            {showingChanges && (
              <PlanChangesPanel
                projectId={projectId}
                state={query.data}
                canReapprove={role === "owner" && !offline}
                baselineShown={showBaseline}
                onBaselineToggle={() => setShowBaseline((shown) => !shown)}
                onReapprove={() => setReapproving(true)}
                onOpenTask={(taskId) => {
                  navigate(`/projects/${projectId}`);
                  showTask(taskId);
                }}
                onClose={() => setShowingChanges(false)}
              />
            )}

            {addingCategory && (
              <CategoryForm
                projectId={projectId}
                suggested={suggestColor(query.data.categories.length)}
                onClose={() => setAddingCategory(false)}
              />
            )}

            {/* The dialog lives on the screen rather than in the strip's row:
                the row disappears at the same instant as the category, and a
                question living in it would carry itself away. The category may
                already be gone — deleted in another tab while the question was
                being read; then there is no dialog. */}
            {deletingCategory && (
              <DeleteCategoryDialog
                category={deletingCategory}
                tasks={query.data.tasks.filter(
                  (task) => task.category_id === deletingCategory.id,
                ).length}
                onConfirm={() => {
                  removeCategory(deletingCategory.id);
                  setDeletingCategoryId(null);
                }}
                onClose={() => setDeletingCategoryId(null)}
              />
            )}
          </main>
        </LiveProvider>
      </DependencyNudgeProvider>
    </ShiftReasonProvider>
  );
}

/**
 * The question before deleting a category — as a dialog, not a popover on the row.
 *
 * A popover in the button's place (as a task has in its card) literally does
 * not fit here: a category's row lives in a column two hundred pixels wide, and
 * a warning about a dozen tasks would push out the category's own name — the
 * only thing that shows you were not aiming at the neighbouring one.
 *
 * The dialog names the number of tasks, not only the name: "delete the
 * category" sounds like parting with a heading, while the whole stage goes with
 * it. There is an undo, at that — the journal keeps a snapshot for it — and
 * that is said outright: otherwise a person leaves an unneeded stage on the
 * strip purely out of caution.
 */
function DeleteCategoryDialog({
  category,
  tasks,
  onConfirm,
  onClose,
}: {
  category: Category;
  /** How many tasks will go with the category. Zero — the stage is empty. */
  tasks: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();

  return (
    <Modal title={t("category.delete_title", { name: category.name })} onClose={onClose}>
      <p>
        {tasks === 0
          ? t("category.delete_warning_empty")
          : t("category.delete_warning", { tasks: t("common.tasks", { count: tasks }) })}
      </p>

      {/* Refusal comes first — as in the project deletion dialog: the dialog
          puts the focus on the first control, and an action that looks
          irreversible must have the safe button first at hand. */}
      <div className="modal__actions">
        <button type="button" className="button--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="button--danger" onClick={onConfirm}>
          {t("category.delete_confirm")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The current tab is marked with a class rather than a colour: the underline
 * shows the tab's bounds in full, and it shows where the click will land.
 */
function tabClass({ isActive }: { isActive: boolean }) {
  return `tabs__link${isActive ? " is-current" : ""}`;
}
