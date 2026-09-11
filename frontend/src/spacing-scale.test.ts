/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Padding, margins and gaps come from the scale (`--space-*` in styles.css)
 * rather than being written as a number in place. The test catches a literal
 * before it multiplies: the styles used to hold 10, 14, 18 and 22 pixels next
 * to 8, 12, 16 and 24, and neighbouring blocks read as "almost even". An
 * exception is declared in place with a comment containing the words
 * "off-scale" and a reason — usually it is geometry (compensating for a
 * border, a chevron's width) rather than air between blocks.
 */

/* The files are read from disk rather than through `import.meta.glob(...?raw)`:
   in the test build the styles go through the CSS pipeline and arrive as an
   empty string. The path is from the package root (vitest runs from
   `frontend/`) rather than from `import.meta.url`: in jsdom that is an http
   address, not a file one. */
const SRC = join(process.cwd(), "src");

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const STYLESHEETS = Object.fromEntries(
  stylesheets(SRC).map((path) => [path.replace(SRC, "src"), readFileSync(path, "utf8")]),
);

const SPACING =
  /(?<![\w-])(?:padding|margin|gap|row-gap|column-gap|padding-(?:left|right|top|bottom|inline|block)|margin-(?:left|right|top|bottom|inline|block))\s*:\s*([^;{}]+);/g;
const LITERAL = /(?<![\d.\w-])(\d+)px\b/g;

function offenders(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    if (line.includes("off-scale") || line.includes("calc(")) continue;
    for (const declaration of line.matchAll(SPACING)) {
      for (const literal of declaration[1].matchAll(LITERAL)) {
        // 0 and 1px are not spacing: zero measures nothing, and a pixel is a
        // hairline compensation for a border.
        if (Number(literal[1]) > 1) found.push(line.trim());
      }
    }
  }
  return found;
}

describe("шкала расстояний", () => {
  it("объявлена в styles.css с шагом 4px", () => {
    const root = STYLESHEETS["src/styles.css"];
    const tokens = [...root.matchAll(/--space-(\d+):\s*(\d+)px;/g)].map(([, name, value]) => [Number(name), Number(value)]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const [name, value] of tokens) {
      expect(value).toBe(name);
      expect(value === 2 || value === 6 || value % 4 === 0).toBe(true);
    }
  });

  it("отступы в стилях берутся из шкалы, а не пишутся числом", () => {
    const report = Object.entries(STYLESHEETS).flatMap(([file, source]) =>
      offenders(source).map((line) => `${file}: ${line}`),
    );
    expect(report).toEqual([]);
  });
});
