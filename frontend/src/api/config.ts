import { request } from "./client";

/** The install settings' cache key: one for the whole application and the whole session. */
export const CONFIG_QUERY_KEY = ["config"] as const;

/**
 * What the interface needs to know about the install before any sign-in.
 *
 * Switches only: there are and can be no addresses, keys or secrets here — the route is open to anyone
 * who opened the page (backend/app/api/meta_routes.py).
 */
export type InstallConfig = {
  /**
   * Whether mail is configured in the install. Without it emails go nowhere, nobody's address is
   * confirmed, and there is nothing to show a "confirm your address" hint for: it would become an
   * eternal strip with nothing to remove it with.
   */
  mail_enabled: boolean;
  signup_mode: string;
  supported_locales: string[];
  default_locale: string;
  public_sharing_enabled: boolean;
  live_enabled: boolean;
};

export function installConfig(): Promise<InstallConfig> {
  return request<InstallConfig>("/api/config");
}
