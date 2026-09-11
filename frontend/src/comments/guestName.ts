const STORAGE_KEY = "planora.guest_name";

/**
 * A guest's name is remembered in the browser rather than on the server: a guest has no account, and
 * asking them to introduce themselves under every reply is a way to get three different "Nigar"s in one
 * feed.
 *
 * A browser's private mode can forbid localStorage — there the name simply does not survive a reload.
 * That is no reason to crash (see LocaleProvider).
 */
export function storedGuestName(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberGuestName(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // see storedGuestName()
  }
}
