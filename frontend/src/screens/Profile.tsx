import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ME_QUERY_KEY, updateProfile } from "../api/auth";
import type { User } from "../api/auth";
import { useAuth } from "../auth/AuthProvider";
import { TextField, useFieldSaves } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";
import { TimeZoneField } from "../settings/fields";
import { browserTimeZone } from "../time/zone";

/**
 * The signed-in person's profile: the name, the address and the time zone.
 *
 * The language is no longer here — the switcher stands in the sidebar, above "Settings". There too
 * it writes the same profile field, and a second copy of it on this screen would mean two identical
 * switchers in one window: the column is visible from here as well.
 *
 * The time zone, on the contrary, lives precisely here rather than in the organization's settings:
 * the organization sets the planning zone, shared by the whole team, while this one answers "what is
 * today's date for me" — and for people sitting in different cities the answer differs. A level
 * higher it would be one for everybody and would lie to half of them.
 *
 * The screen has no `<main>` of its own: it is a tab of the settings section, and the frame has
 * already given it one.
 */
export function Profile() {
  const { t } = useLocale();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (patch: { name?: string; timezone?: string | null }) => updateProfile(patch),
    // A successful write is reported by the field itself (see `useFieldSaves`) rather than by a toast
    // over the screen: the name is saved on blur, and the person looks for the answer to that gesture
    // where they have just been typing.
    onSuccess: (updated: User) => queryClient.setQueryData(ME_QUERY_KEY, updated),
  });
  const saves = useFieldSaves(save.mutateAsync);

  const detected = browserTimeZone();

  if (!user) return null;

  return (
    <>
      <div className="screen__head">
        <h1>{t("settings.profile.title")}</h1>
      </div>

      <section className="settings">
        <TextField
          id="profile-name"
          label={t("auth.field.name")}
          value={user.name}
          save={saves.at("profile-name")}
          onCommit={(value) => saves.commitText("profile-name", value, (name) => ({ name }))}
        />

        <TimeZoneField
          id="profile-timezone"
          label={t("settings.timezone")}
          hint={t("settings.profile.timezone_hint")}
          autoLabel={
            detected
              ? t("settings.profile.timezone_auto_at", { zone: detected })
              : t("settings.profile.timezone_auto")
          }
          value={user.timezone}
          // Through the same field submission as the name: otherwise a server refusal would be mute —
          // the list would go back to the previous zone, and the person would not understand why the
          // choice did not hold.
          save={saves.at("profile-timezone")}
          onChange={(timezone) => saves.commit("profile-timezone", { timezone })}
        />

        <p className="field">
          <span className="settings__key">{t("auth.field.email")}</span>
          {/* The address is not editable: the sign-in rests on it, and changing the address means
              confirming a new address, that is, a separate job. */}
          <span className="muted">{user.email}</span>
        </p>
      </section>
    </>
  );
}
