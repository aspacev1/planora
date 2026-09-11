import { vi } from "vitest";

/**
 * The `matchMedia` that jsdom does not have at all.
 *
 * The "less motion" setting is a system preference, and it can only be asked about through `matchMedia`.
 * Without a substitute the application under test would never learn about it, and a check of respect for
 * that setting would only be checking that the code does not crash.
 */
export function matchMediaMock(query: string, matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (asked: string) => ({
      matches: asked === query ? matches : false,
      media: asked,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
}
