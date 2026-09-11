import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetInvite, pendingInvite, rememberInvite, withInvite } from "./invite";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("адрес соседнего экрана", () => {
  it("без приглашения остаётся собой", () => {
    expect(withInvite("/login", null)).toBe("/login");
  });

  it("несёт приглашение и экранирует его", () => {
    expect(withInvite("/login", "a b/c")).toBe("/login?invite=a%20b%2Fc");
  });
});

describe("приглашение в пути", () => {
  it("не помнит ничего, пока ничего не запоминали", () => {
    expect(pendingInvite()).toBeNull();
  });

  it("помнит запомненное", () => {
    rememberInvite("tok-1");
    expect(pendingInvite()).toBe("tok-1");
  });

  it("забывает по просьбе: принятое приглашение не должно всплывать снова", () => {
    rememberInvite("tok-1");
    forgetInvite();
    expect(pendingInvite()).toBeNull();
  });

  it("забывает через час: вчерашнее приглашение не место посреди сегодняшнего входа", () => {
    vi.useFakeTimers();
    rememberInvite("tok-1");
    vi.advanceTimersByTime(61 * 60 * 1000);

    expect(pendingInvite()).toBeNull();
    // And it cleans up after itself rather than answering "no" over a live record.
    expect(localStorage.getItem("planora.pending_invite")).toBeNull();
  });

  it("держится в пределах часа: дорога до почтового ящика столько и занимает", () => {
    vi.useFakeTimers();
    rememberInvite("tok-1");
    vi.advanceTimersByTime(59 * 60 * 1000);

    expect(pendingInvite()).toBe("tok-1");
  });

  it("не падает на чужой записи под тем же ключом", () => {
    localStorage.setItem("planora.pending_invite", "{не json");
    expect(pendingInvite()).toBeNull();
  });

  it("не верит записи без отметки времени: срок у неё был бы неизвестен", () => {
    localStorage.setItem("planora.pending_invite", JSON.stringify({ token: "tok-1" }));
    expect(pendingInvite()).toBeNull();
  });

  it("переживает запрет хранилища, а не роняет экран входа", () => {
    const denied = () => {
      throw new Error("приватный режим");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);

    expect(() => rememberInvite("tok-1")).not.toThrow();
    expect(pendingInvite()).toBeNull();

    vi.restoreAllMocks();
  });
});
