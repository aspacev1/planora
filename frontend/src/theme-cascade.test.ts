/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * One selector lives in one file. The theme (northstar-theme.css) overrides
 * only styles.css: it is assembled right after it, while the component styles
 * (gantt.css, panel.css, ...) come later, together with their own modules.
 * Should the theme declare a selector that already exists in a component's
 * file, at equal weight the component wins and the theme's rule silently does
 * nothing — that is how the task card once turned out to be a mixture of two
 * intentions, neither of which was visible in full. The test catches such a
 * duplicate before it reaches a build.
 *
 * `:root` does not count: every file is entitled to declare tokens of its own.
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

/** A file's selectors, accounting for a media wrapper: a rule inside @media is a different key. */
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
