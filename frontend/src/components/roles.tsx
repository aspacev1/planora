import { useLocale } from "../i18n/LocaleProvider";

/**
 * The roles that can be handed out by an invitation. The owner is not among them.
 *
 * An owner disposes of the whole organization: deletes projects, re-approves plans, invites anyone.
 * Handing that out through a dropdown of four words, where missing by one line gives itself away by
 * nothing, is too cheap; and an invitation with no address goes to whoever holds it, so anyone who
 * opened a forwarded link would become an owner.
 *
 * The server holds the same rule itself (`role_not_invitable` in invitations.py) rather than relying
 * on this list: a hidden dropdown row does not stop anyone from sending the request by hand.
 */
export const INVITABLE_ROLES = ["editor", "viewer", "client"] as const;

/**
 * The roles an owner assigns to an existing member. The owner is here.
 *
 * The difference from an invitation is not in strictness but in the recipient: an invitation goes
 * outside and can reach whoever holds the link, while here the person is already inside, named by
 * name and visible in the list. This is the very "separate action" an invitation is forbidden the
 * owner for.
 */
export const ASSIGNABLE_ROLES = ["owner", "editor", "viewer", "client"] as const;

/**
 * What this role gives — as a line under the choice.
 *
 * Four words in a dropdown do not answer the single question the inviter asks: "an observer — who is
 * that, and how do they differ from a client?" A guess costs dearly: a client invited as an observer
 * sees all the organization's projects, including the ones nobody meant to show them.
 *
 * An explanation of the chosen role rather than a table of four rows: a list is read while choosing,
 * and unfolding a four-item help text under every field means hiding the form itself.
 */
export function RoleHint({ role }: { role: string }) {
  const { t } = useLocale();
  return <p className="muted field__hint">{t(`members.role_about.${role}`)}</p>;
}
