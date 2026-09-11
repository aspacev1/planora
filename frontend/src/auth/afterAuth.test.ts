import { describe, expect, it } from "vitest";

import { AFTER_AUTH_FALLBACK, afterAuthPath } from "./afterAuth";

describe("возврат после входа", () => {
  it("собирает адрес целиком — с запросом и якорем", () => {
    expect(
      afterAuthPath({ from: { pathname: "/projects/p1", search: "?tab=plan", hash: "#t7" } }),
    ).toBe("/projects/p1?tab=plan#t7");
  });

  it("без сохранённого адреса ведёт в список проектов", () => {
    expect(afterAuthPath(null)).toBe(AFTER_AUTH_FALLBACK);
    expect(afterAuthPath(undefined)).toBe(AFTER_AUTH_FALLBACK);
    expect(afterAuthPath({ from: "/projects/p1" })).toBe(AFTER_AUTH_FALLBACK);
  });

  it("не уводит на чужой сайт", () => {
    // `//example.com` is not a path but another site's address.
    expect(afterAuthPath({ from: { pathname: "//example.com" } })).toBe(AFTER_AUTH_FALLBACK);
    expect(afterAuthPath({ from: { pathname: "https://example.com/x" } })).toBe(
      AFTER_AUTH_FALLBACK,
    );
  });

  it("не возвращает на сам вход — иначе после пароля снова пароль", () => {
    expect(afterAuthPath({ from: { pathname: "/login" } })).toBe(AFTER_AUTH_FALLBACK);
    expect(afterAuthPath({ from: { pathname: "/register" } })).toBe(AFTER_AUTH_FALLBACK);
  });
});
