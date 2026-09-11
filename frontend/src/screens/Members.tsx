import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { errorKey } from "../api/errors";
import {
  INVITATIONS_QUERY_KEY,
  listInvitations,
  reissueInvitation,
  revokeInvitation,
} from "../api/invitations";
import type { Invitation } from "../api/invitations";
import {
  MEMBERS_QUERY_KEY,
  ORG_QUERY_KEY,
  members,
  organization,
  removeMember,
  updateMemberRole,
} from "../api/org";
import type { Member } from "../api/org";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmAction } from "../components/ConfirmAction";
import { InviteDialog, IssuedLink } from "../components/InviteDialog";
import { ASSIGNABLE_ROLES } from "../components/roles";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

function InvitationRow({
  invitation,
  mailEnabled,
}: {
  invitation: Invitation;
  mailEnabled: boolean;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [link, setLink] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });

  const reissue = useMutation({
    mutationFn: (deliver: boolean) => reissueInvitation(invitation.id, deliver),
    onSuccess: (issued) => {
      setLink(issued.url);
      void refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: () => revokeInvitation(invitation.id),
    onSuccess: () => {
      setLink(null);
      // "The email did not go out" referred to a reissue that no longer exists:
      // next to "revoked" it would read as one more live problem.
      reissue.reset();
      void refresh();
      // Revoking kills an issued link — the most destructive thing that can be done
      // here — while on screen it changes two words in the status caption and makes a
      // row of buttons disappear. For an irreversible action that is too quiet.
      showToast({ message: t("invite.revoked") });
    },
  });

  const pending = invitation.status === "pending" || invitation.status === "expired";
  const error = reissue.error ?? revoke.error;

  return (
    <li className="invite">
      <span className="invite__who">{invitation.email ?? t("invite.link_only")}</span>
      <span className="muted">{t(`members.role.${invitation.role}`)}</span>
      <span className={invitation.status === "pending" ? "muted" : "invite__dead"}>
        {t(`invite.status.${invitation.status}`)}
      </span>

      {/* Only an unused invitation can be revoked and reissued: an accepted one is
          already a membership, and it is removed by a different action.

          All three ask: both "New link" and "Send again" are one and the same
          reissue that kills the previous token, and the second caption hides that
          more than the first. A person who pressed "send again" in the belief they
          were repeating the email breaks the link they sent yesterday. */}
      {pending && (
        <span className="invite__actions">
          <ConfirmAction
            className="button--quiet"
            label={t("invite.action.link")}
            warning={t("invite.action.reissue_warning")}
            confirm={t("invite.action.link_confirm")}
            onConfirm={() => reissue.mutate(false)}
          />
          {mailEnabled && invitation.email && (
            <ConfirmAction
              className="button--quiet"
              label={t("invite.action.resend")}
              warning={t("invite.action.reissue_warning")}
              confirm={t("invite.action.resend_confirm")}
              onConfirm={() => reissue.mutate(true)}
            />
          )}
          <ConfirmAction
            className="button--quiet"
            label={t("invite.action.revoke")}
            warning={t("invite.action.revoke_warning")}
            confirm={t("invite.action.revoke_confirm")}
            onConfirm={() => revoke.mutate()}
          />
        </span>
      )}

      {link && <IssuedLink url={link} />}
      {reissue.data?.mail_error && (
        <span className="error" role="alert">
          {t(`error.${reissue.data.mail_error}`)}
        </span>
      )}
      {error && (
        <span className="error" role="alert">
          {t(errorKey(error))}
        </span>
      )}
    </li>
  );
}

/**
 * A roster row: who this is, what role they have and — for the owner — what can be
 * done with it.
 *
 * The role applies immediately on choice, without a second press: it is reversible —
 * the same list brings the previous value back — while a confirmation on every choice
 * would turn the list into a questionnaire. The irreversible thing next to it
 * (removing from the organization) does ask, and the difference between them is
 * visible precisely in the fact that one asks and the other does not.
 */
function MemberRow({
  member,
  manageable,
  isMe,
  lastOwner,
}: {
  member: Member;
  /** The owner edits the roster; everyone else reads it as a line of text. */
  manageable: boolean;
  isMe: boolean;
  /** The organization rests on this person alone: there is nothing to touch their role with. */
  lastOwner: boolean;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const showToast = useToast();

  // The signed-in person's role lies in the `/api/org` response and decides what to
  // show the whole application: an owner who demoted themselves must see that at once
  // rather than after a reload.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ORG_QUERY_KEY }),
    ]);

  const changeRole = useMutation({
    mutationFn: (role: string) => updateMemberRole(member.id, role),
    onSuccess: (updated) => {
      void refresh();
      showToast({
        message: t("members.role_changed", {
          name: updated.name,
          role: t(`members.role.${updated.role}`),
        }),
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => removeMember(member.id),
    onSuccess: () => {
      void refresh();
      // Removing someone from the organization changes one vanished row on screen. For
      // an action that is only played back by a new invitation, that is not enough.
      showToast({ message: t("members.remove.done", { name: member.name }) });
    },
  });

  const error = changeRole.error ?? remove.error;

  if (!manageable) {
    return (
      <li className="members__row">
        <span>{member.name}</span>
        <span className="muted">{member.email}</span>
        <span className="muted members__role">{t(`members.role.${member.role}`)}</span>
      </li>
    );
  }

  return (
    <li className="members__row">
      <span>{member.name}</span>
      <span className="muted">{member.email}</span>

      <span className="members__actions">
        <select
          aria-label={t("members.role_of", { name: member.name })}
          title={t(`members.role_about.${member.role}`)}
          value={member.role}
          disabled={lastOwner || changeRole.isPending}
          onChange={(event) => changeRole.mutate(event.target.value)}
        >
          {ASSIGNABLE_ROLES.map((name) => (
            <option key={name} value={name}>
              {t(`members.role.${name}`)}
            </option>
          ))}
        </select>

        {/* You are not removed from the list yourself: leaving is a different action,
            named in its own words and standing apart. A "remove" button in your own row
            would look like the same small thing as in someone else's — while costing
            more: you cannot invite yourself back into the organization. */}
        {!isMe && !lastOwner && (
          <ConfirmAction
            className="button--quiet"
            label={t("members.remove.label")}
            warning={t("members.remove.warning", { name: member.name })}
            confirm={t("members.remove.confirm")}
            // The row does not disappear instantly — first the request goes, then the
            // updated roster arrives. A second press in that gap would get a
            // `member_not_found` for a job already done.
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        )}
      </span>

      {/* What is locked is not the person but the situation: the explanation stands
          where the disabled control is, otherwise it reads as "it broke". */}
      {lastOwner && <span className="muted members__note">{t("members.last_owner_hint")}</span>}

      {error && (
        <span className="error" role="alert">
          {t(errorKey(error))}
        </span>
      )}
    </li>
  );
}

/**
 * "Leave the organization" is the same action as removing a member, but on yourself.
 *
 * It stands as a separate section rather than a button in your own roster row, for
 * two reasons. The `client` role does not see the organization's roster at all (the
 * server answers them with a refusal), and a button inside the list would mean that
 * someone invited once is locked inside forever. And leaving is not a small edit to a
 * list: it is named in words and stands where it is looked for.
 */
function LeaveOrganization({ orgName, lastOwner }: { orgName: string; lastOwner: boolean }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const navigate = useNavigate();

  const leave = useMutation({
    mutationFn: (userId: string) => removeMember(userId),
    onSuccess: () => {
      // Everything is invalidated: the projects, the roster, the organization itself —
      // after leaving this is data from somebody else's place. Not `clear()`: the
      // session is alive, and throwing the profile out along with the cache would send
      // the application into "checking".
      void queryClient.invalidateQueries();
      showToast({ message: t("members.leave.done", { org: orgName }) });
      navigate("/projects");
    },
  });

  // There is nobody to leave and nowhere to leave from while neither who signed in nor
  // where they signed in is known: a section with an empty organization name in its
  // heading would promise an action on who knows what.
  if (!user) return null;

  return (
    <section className="members__leave">
      <h2>{t("members.leave.title")}</h2>
      <p className="muted">{t("members.leave.about", { org: orgName })}</p>

      {lastOwner ? (
        <p className="muted">{t("members.leave.last_owner")}</p>
      ) : (
        <ConfirmAction
          className="button--quiet"
          label={t("members.leave.title")}
          warning={t("members.leave.warning")}
          confirm={t("members.leave.confirm")}
          disabled={leave.isPending}
          onConfirm={() => leave.mutate(user.id)}
        />
      )}

      {leave.error && (
        <p className="error" role="alert">
          {t(errorKey(leave.error))}
        </p>
      )}
    </section>
  );
}

export function Members() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const org = useQuery({ queryKey: ORG_QUERY_KEY, queryFn: organization, staleTime: Infinity });
  const roster = useQuery({ queryKey: MEMBERS_QUERY_KEY, queryFn: members });
  const isOwner = org.data?.role === "owner";

  // The only owner cannot be demoted or removed — an organization without an owner is
  // not demoted but locked: there is nobody left in it to appoint a new one. The server
  // holds this rule itself (`last_owner`), and the list is needed so that the disabled
  // control explains itself before the press rather than after the refusal.
  const owners = roster.data?.filter((member) => member.role === "owner") ?? [];
  const soleOwnerId = owners.length === 1 ? owners[0].id : null;

  // Only the owner sees the invitations: the route answers everyone else with a
  // refusal, and there is no point asking it for a certain 403.
  const invitations = useQuery({
    queryKey: INVITATIONS_QUERY_KEY,
    queryFn: listInvitations,
    enabled: isOwner,
  });

  // The screen has no `<main>` of its own: it is a tab of the settings section, and
  // the frame has already given it one.
  return (
    <>
      <div className="screen__head">
        <h1>{t("members.title")}</h1>
        {isOwner && (
          <button type="button" onClick={() => setOpen(true)}>
            {t("invite.open")}
          </button>
        )}
      </div>

      {roster.error && (
        <p className="error" role="alert">
          {t(errorKey(roster.error))}
        </p>
      )}

      <ul className="members">
        {roster.data?.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            manageable={isOwner}
            isMe={member.id === user?.id}
            lastOwner={member.id === soleOwnerId}
          />
        ))}
      </ul>

      {isOwner && (
        <section>
          <h2>{t("invite.list.title")}</h2>
          {invitations.data?.invitations.length === 0 && (
            <p className="muted">{t("invite.list.empty")}</p>
          )}
          <ul className="invites">
            {invitations.data?.invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                mailEnabled={invitations.data.mail_enabled}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Shown to everyone and always, including the `client` role, which is not given
          the organization's roster at all: without this, someone invited once would
          stay inside forever. The organization's name arrives by a separate request and
          is available to any role. */}
      {org.data && (
        <LeaveOrganization
          orgName={org.data.name}
          lastOwner={soleOwnerId !== null && soleOwnerId === user?.id}
        />
      )}

      {open && <InviteDialog onClose={() => setOpen(false)} />}
    </>
  );
}
