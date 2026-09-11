import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ME_QUERY_KEY, updateProfile } from "../api/auth";
import type { User } from "../api/auth";
import { useAuth } from "../auth/AuthProvider";
import { SUPPORTED_LOCALES } from "../i18n";
import type { Locale } from "../i18n";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The captions are language codes rather than names: "Azərbaycan / English / Русский" would have to be
 * read in a language the person may not even know — at exactly the moment they are looking for their
 * own.
 *
 * It stands in the sidebar (above "Settings") and on the public page, where there is no column at all.
 * One and the same switcher for both places: a copy would write the same profile field with a second
 * piece of code and would diverge from this one on the very first edit — one would learn to apply the
 * language at once, the other would not.
 *
 * A signed-in person's choice goes into the profile rather than only into the browser's memory: the
 * language lives in the profile, and a person who chose Russian at work must see Russian at home too.
 * A server refusal rolls nothing back at that — the language has already switched, and bringing it back
 * because of a failed write would mean punishing a person for somebody else's network error; the next
 * choice will be written.
 */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useLocale();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const remember = useMutation({
    mutationFn: (next: Locale) => updateProfile({ locale: next }),
    onSuccess: (updated: User) => queryClient.setQueryData(ME_QUERY_KEY, updated),
  });

  const choose = (next: Locale) => {
    setLocale(next);
    if (user) remember.mutate(next);
  };

  return (
    <div className="locale-switch" role="group" aria-label={t("locale.switch_label")}>
      {SUPPORTED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          className="button--quiet"
          // aria-pressed rather than a colour highlight: the selected language must be audible rather
          // than only visible.
          aria-pressed={code === locale}
          onClick={() => choose(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
