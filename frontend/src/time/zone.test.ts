import { describe, expect, it } from "vitest";

import { dayIn, timeZoneNames } from "./zone";

/**
 * The reader's day.
 *
 * The tests go in "zone versus UTC" pairs: it was precisely the divergence between them that was the
 * defect — "today", taken by truncating `toISOString()`, showed half the readers the neighbouring date
 * every night.
 *
 * The machine's own clock in this run is set to UTC (the test environment), so the zones are chosen on
 * either side of Greenwich: the eastern one catches running ahead, the western one running behind.
 */
describe("день в часовом поясе", () => {
  it("восточнее Гринвича ночь — это уже сегодня", () => {
    // 00:30 on 15 August in Moscow is 21:30 on the 14th in UTC.
    const at = Date.UTC(2026, 7, 14, 21, 30);

    expect(dayIn("Europe/Moscow", at)).toBe("2026-08-15");
    // What the reader saw before the fix: yesterday's date.
    expect(new Date(at).toISOString().slice(0, 10)).toBe("2026-08-14");
  });

  it("западнее Гринвича вечер — это ещё сегодня", () => {
    // 20:00 on 14 August in New York is already midnight on the 15th in UTC.
    const at = Date.UTC(2026, 7, 15, 0, 0);

    expect(dayIn("America/New_York", at)).toBe("2026-08-14");
    expect(new Date(at).toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("считает по часам машины, когда пояс неизвестен", () => {
    expect(dayIn(undefined, Date.UTC(2026, 7, 14, 21, 30))).toBe("2026-08-14");
    expect(dayIn(null, Date.UTC(2026, 7, 14, 21, 30))).toBe("2026-08-14");
  });

  it("не падает на поясе, которого не знает браузер", () => {
    // The name was checked by the server against its own IANA database, and a browser can be older than
    // it. The day is then computed by the machine's clock rather than bringing the whole screen down.
    expect(dayIn("Mars/Olympus", Date.UTC(2026, 7, 14, 21, 30))).toBe("2026-08-14");
  });

  it("отдаёт день в том же виде, в каком даты пишет сервер", () => {
    // Leading zeros are not a trifle: date strings compare as dates only when the fields have the same
    // width (see gantt/timescale.ts).
    expect(dayIn("Asia/Baku", Date.UTC(2026, 0, 4, 12, 0))).toBe("2026-01-04");
  });
});

describe("список поясов для настроек", () => {
  it("содержит сохранённый выбор, даже если браузер о нём не знает", () => {
    expect(timeZoneNames("Mars/Olympus")).toContain("Mars/Olympus");
  });

  it("не повторяет пояс, который браузер и так знает", () => {
    const names = timeZoneNames("Europe/Moscow", "Europe/Moscow");

    expect(names.filter((name) => name === "Europe/Moscow")).toHaveLength(1);
  });

  it("пропускает пустой выбор: «по браузеру» — это не имя пояса", () => {
    expect(timeZoneNames(null, undefined)).not.toContain("");
  });
});
