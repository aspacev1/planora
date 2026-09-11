import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { INVITATIONS_QUERY_KEY, createInvitations, listInvitations } from "../api/invitations";
import type { Issued } from "../api/invitations";
import { PROJECTS_QUERY_KEY, listProjects } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { Modal } from "./Modal";
import { INVITABLE_ROLES, RoleHint } from "./roles";

/** Addresses are entered as a list: by commas, semicolons or line breaks. */
function parseEmails(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/**
 * A link shown once.
 *
 * A read-only field next to the button is not decoration: `navigator.clipboard` is not
 * everywhere (an old browser, a page over http, a denied permission), and without visible text
 * the link in such an install would be unreachable entirely.
 */
export function IssuedLink({ url }: { url: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  return (
    <p className="issued">
      <input className="issued__url" readOnly value={url} aria-label={t("invite.issued.link")} />
      <button
        type="button"
        className="button--quiet"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? t("invite.issued.copied") : t("invite.issued.copy")}
      </button>
    </p>
  );
}

function IssuedList({ issued }: { issued: Issued[] }) {
  const { t } = useLocale();

  return (
    <div className="issued-list">
      <p className="muted">{t("invite.issued.once")}</p>
      {issued.map((one) => (
        <div key={one.id}>
          <p>
            <strong>{one.email ?? t("invite.link_only")}</strong>{" "}
            {one.sent && <span className="ok">{t("invite.issued.sent")}</span>}
            {one.mail_error && (
              <span className="error" role="alert">
                {t(`error.${one.mail_error}`)}
              </span>
            )}
          </p>
          <IssuedLink url={one.url} />
        </div>
      ))}
    </div>
  );
}

/**
 * An invitation into the organization — together with the dialog it lives in.
 *
 * The dialog is drawn by the form itself rather than by the screen around it: whether the
 * fields have been touched is known only to them, and the dialog needs that answer so as not
 * to lose what was typed to a stray click. From outside such a flag would have to be shuttled
 * through a callback — that is, the form's state would be kept in two places at once.
 *
 * It lives among the shared parts rather than on the roster screen: people are invited both
 * from there and from a project's header, and a second copy of the form would diverge from the
 * first on the very first edit of the rules — on the list of roles that cannot be handed out,
 * for example.
 */
export function InviteDialog({
  projectId,
  onClose,
}: {
  /**
   * The project the invitation was sent from. It is also ticked in the list of projects in
   * advance: when inviting from a project's page, ticking it by hand is an extra step exactly
   * where a mistake costs the most for the `client` role (without ticks they will see no
   * project at all); for the other roles the tick simply narrows the invitation to this
   * project, and it can be unticked.
   */
  projectId?: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();

  const [raw, setRaw] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [projectIds, setProjectIds] = useState<string[]>(projectId ? [projectId] : []);
  const [deliver, setDeliver] = useState(true);

  const invitations = useQuery({ queryKey: INVITATIONS_QUERY_KEY, queryFn: listInvitations });
  // The list of projects is needed by any role: the ticked projects narrow the invitation to
  // them, regardless of who is being invited — a client, an editor or an observer.
  const projects = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: listProjects });

  const create = useMutation({
    mutationFn: createInvitations,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    },
  });

  const emails = parseEmails(raw);
  const mailEnabled = invitations.data?.mail_enabled ?? false;

  if (create.data) {
    return (
      <Modal title={t("invite.title")} onClose={onClose}>
        <IssuedList issued={create.data} />
        <div className="modal__actions">
          <button type="button" onClick={onClose}>
            {t("invite.issued.done")}
          </button>
        </div>
      </Modal>
    );
  }

  // The role and the projects count on a par with the addresses: the list of projects is ticked
  // one at a time, and a stray click outside the dialog removes them all at once. The project
  // the invitation was sent from, ticked on the person's behalf, does not count as input at
  // that: it was not chosen, and there is nothing to lose there.
  const projectsTouched =
    projectId === undefined
      ? projectIds.length > 0
      : projectIds.length !== 1 || projectIds[0] !== projectId;
  const dirty = raw !== "" || role !== "viewer" || projectsTouched || !deliver;

  return (
    <Modal title={t("invite.title")} onClose={onClose} dirty={dirty}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({
            emails,
            role,
            project_ids: projectIds,
            // Without mail configured there is nothing to send with — and nothing to ask about.
            deliver: mailEnabled && deliver,
          });
        }}
      >
        <p className="field">
          <label htmlFor="invite-emails">{t("invite.emails")}</label>
          <textarea
            id="invite-emails"
            rows={3}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
        </p>
        {/* An invitation without an address is not forgetfulness but a second delivery method,
            and it is named in words: such a link goes to whoever holds it. */}
        <p className="muted">
          {emails.length === 0 ? t("invite.link_only_hint") : t("invite.emails_hint")}
        </p>

        <p className="field">
          <label htmlFor="invite-role">{t("invite.role")}</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value)}>
            {INVITABLE_ROLES.map((name) => (
              <option key={name} value={name}>
                {t(`members.role.${name}`)}
              </option>
            ))}
          </select>
        </p>
        {/* The explanation is under the choice itself rather than in a help text beside it: the
            difference between an observer and a client is the difference between "sees all the
            organization's projects" and "sees only the ticked ones", and learning it after the
            invitation is sent is too late. */}
        <RoleHint role={role} />

        {/* Not only for a client: the list ticked here narrows any role to the listed projects
            — see Membership.project_scoped on the server. Nothing ticked — the role behaves as
            before: a client sees no project, an editor and an observer see the whole
            organization. */}
        <fieldset className="fieldset">
          <legend>{t("invite.projects")}</legend>
          <p className="muted">{t("invite.projects_hint")}</p>
          {projects.data?.map((project) => (
            <label key={project.id} className="checkbox">
              <input
                type="checkbox"
                checked={projectIds.includes(project.id)}
                onChange={(event) =>
                  setProjectIds((chosen) =>
                    event.target.checked
                      ? [...chosen, project.id]
                      : chosen.filter((id) => id !== project.id),
                  )
                }
              />
              {project.name}
            </label>
          ))}
        </fieldset>

        {mailEnabled && emails.length > 0 && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deliver}
              onChange={(event) => setDeliver(event.target.checked)}
            />
            {t("invite.deliver")}
          </label>
        )}

        {create.error && (
          <p className="error" role="alert">
            {t(errorKey(create.error))}
          </p>
        )}

        <div className="modal__actions">
          <button type="submit" disabled={create.isPending}>
            {t("invite.submit")}
          </button>
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
