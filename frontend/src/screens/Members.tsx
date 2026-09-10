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
      // «Письмо не ушло» относилось к перевыпуску, которого больше нет:
      // рядом с «отозвано» оно читалось бы как ещё одна живая проблема.
      reissue.reset();
      void refresh();
      // Отзыв убивает выданную ссылку — самое разрушительное, что здесь можно
      // сделать, — а на экране от него меняются два слова в подписи статуса и
      // исчезает ряд кнопок. Для необратимого действия это слишком тихо.
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

      {/* Отозвать и выпустить заново можно только неиспользованное: принятое
          приглашение — это уже членство, и снимают его другим действием.

          Спрашивают все три: и «Новая ссылка», и «Отправить ещё раз» — это
          один и тот же перевыпуск, убивающий прежний токен, и вторая подпись
          скрывает это сильнее первой. Человек, нажавший «отправить ещё раз»
          в уверенности, что повторяет письмо, ломает ссылку, отправленную
          вчера. */}
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
 * Строка состава: кто это, какая роль и — владельцу — что с ней можно сделать.
 *
 * Роль применяется сразу по выбору, без второго нажатия: она обратима — тот же
 * список возвращает прежнее значение, — а подтверждение у каждого выбора
 * превратило бы список в анкету. Необратимое рядом (вывод из организации)
 * спрашивает, и разница между ними видна именно по тому, что одно спрашивает,
 * а другое нет.
 */
function MemberRow({
  member,
  manageable,
  isMe,
  lastOwner,
}: {
  member: Member;
  /** Владелец правит состав; остальные читают его строкой текста. */
  manageable: boolean;
  isMe: boolean;
  /** Организация держится на этом человеке одном: трогать его роль нечем. */
  lastOwner: boolean;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const showToast = useToast();

  // Роль вошедшего лежит в ответе `/api/org` и решает, что показывать всему
  // приложению: владелец, разжаловавший сам себя, обязан увидеть это сразу, а
  // не после перезагрузки.
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
      // Вывод из организации меняет на экране одну исчезнувшую строку. Для
      // действия, которое отыгрывается только новым приглашением, этого мало.
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

        {/* Себя из списка не убирают: уход — это другое действие, названное
            своими словами и стоящее отдельно. Кнопка «убрать» в собственной
            строке выглядела бы такой же мелочью, как и в чужой, — а стоит
            дороже: назад в организацию себя не позовёшь. */}
        {!isMe && !lastOwner && (
          <ConfirmAction
            className="button--quiet"
            label={t("members.remove.label")}
            warning={t("members.remove.warning", { name: member.name })}
            confirm={t("members.remove.confirm")}
            // Строка исчезает не мгновенно — сначала уходит запрос, потом
            // приходит обновлённый состав. Второе нажатие в этот промежуток
            // получило бы `member_not_found` за уже сделанное дело.
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        )}
      </span>

      {/* Заперт не человек, а положение: пояснение стоит там же, где
          выключенный выбор, иначе оно читается как «сломалось». */}
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
 * «Покинуть организацию» — то же действие, что вывод участника, но над собой.
 *
 * Стоит отдельным разделом, а не кнопкой в своей строке состава, по двум
 * причинам. Роль `client` состава организации не видит вовсе (сервер отвечает
 * ей отказом), и кнопка внутри списка означала бы, что позванный однажды
 * заперт внутри навсегда. И уход — не мелкая правка списка: он называется
 * словами и стоит там, где его ищут.
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
      // Обесценивается всё: проекты, состав, сама организация — после ухода
      // это данные чужого места. Не `clear()`: сессия жива, и выбрасывать
      // вместе с кэшем профиль значило бы отправить приложение в «проверяю».
      void queryClient.invalidateQueries();
      showToast({ message: t("members.leave.done", { org: orgName }) });
      navigate("/projects");
    },
  });

  // Уходить некому и неоткуда, пока неизвестно ни кто вошёл, ни куда он
  // входил: раздел с пустым названием организации в заголовке обещал бы
  // действие над неизвестно чем.
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

  // Единственного владельца не разжаловать и не вывести — организация без
  // владельца не разжалована, а заперта: назначить нового в ней больше некому.
  // Сервер держит это правило сам (`last_owner`), а список нужен затем, чтобы
  // выключенный выбор объяснился до нажатия, а не после отказа.
  const owners = roster.data?.filter((member) => member.role === "owner") ?? [];
  const soleOwnerId = owners.length === 1 ? owners[0].id : null;

  // Приглашения видит только владелец: остальным маршрут отвечает отказом, и
  // спрашивать его ради заведомого 403 незачем.
  const invitations = useQuery({
    queryKey: INVITATIONS_QUERY_KEY,
    queryFn: listInvitations,
    enabled: isOwner,
  });

  // Своего `<main>` у экрана нет: он вкладка раздела настроек, и рама его уже
  // дала.
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

      {/* Показывается всем и всегда, включая роль `client`, которой состав
          организации не отдаётся вовсе: без этого позванный однажды остался бы
          внутри навсегда. Название организации приходит отдельным запросом и
          есть у любой роли. */}
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
