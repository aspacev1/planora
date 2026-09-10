/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Один селектор живёт в одном файле. Тема (northstar-theme.css) перекрывает
 * только styles.css: она собирается сразу за ним, а стили компонентов
 * (gantt.css, panel.css, …) — позже, вместе со своими модулями. Стоит теме
 * объявить селектор, который уже есть в файле компонента, и при равном весе
 * побеждает компонент, а правило темы молча не действует — так карточка
 * задачи однажды оказалась смесью двух замыслов, ни один из которых не был
 * виден целиком. Тест ловит такой дубль до того, как он попадёт в сборку.
 *
 * `:root` не в счёт: токены каждый файл вправе объявлять свои.
 */

const SRC = join(process.cwd(), "src");
const THEME = join(SRC, "northstar-theme.css");
const BASE = join(SRC, "styles.css");

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Селекторы файла с учётом медиа-обёртки: правило внутри @media — другой ключ. */
function selectors(source: string): Set<string> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set<string>();
  const media: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    if (head.startsWith("@")) {
      media.push(head);
      i = open + 1;
      continue;
    }
    const close = text.indexOf("}", open);
    for (const part of head.split(",")) {
      const selector = part.trim().replace(/\s+/g, " ");
      if (selector && selector !== ":root") found.add(`${media.join(" ")}|${selector}`);
    }
    i = close + 1;
    while (media.length > 0 && /^\s*}/.test(text.slice(i))) {
      media.pop();
      i = text.indexOf("}", i) + 1;
    }
  }
  return found;
}

describe("каскад темы", () => {
  it("тема не объявляет селекторы, которые уже есть в стилях компонентов", () => {
    const theme = selectors(readFileSync(THEME, "utf8"));
    const shared = stylesheets(SRC)
      .filter((file) => file !== THEME && file !== BASE)
      .flatMap((file) =>
        [...selectors(readFileSync(file, "utf8"))]
          .filter((selector) => theme.has(selector))
          .map((selector) => `${file.replace(SRC, "src")}: ${selector.replace(/^\|/, "")}`),
      );
    expect(shared).toEqual([]);
  });
});
