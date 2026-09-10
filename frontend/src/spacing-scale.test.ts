/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Отступы, поля и просветы берутся из шкалы (`--space-*` в styles.css), а не
 * пишутся числом по месту. Тест ловит литерал раньше, чем он размножится:
 * прежде в стилях жили 10, 14, 18 и 22 пикселя рядом с 8, 12, 16 и 24, и
 * соседние блоки читались «почти ровными». Исключение объявляется на месте
 * комментарием со словами «вне шкалы» и причиной — обычно это геометрия
 * (компенсация рамки, ширина шеврона), а не воздух между блоками.
 */

/* Файлы читаются с диска, а не через `import.meta.glob(…?raw)`: в тестовой
   сборке стили проходят через конвейер CSS и приходят пустой строкой. Путь —
   от корня пакета (vitest запускается из `frontend/`), а не от
   `import.meta.url`: в среде jsdom это адрес http, а не file. */
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
    if (line.includes("вне шкалы") || line.includes("calc(")) continue;
    for (const declaration of line.matchAll(SPACING)) {
      for (const literal of declaration[1].matchAll(LITERAL)) {
        // 0 и 1px — не отступы: ноль ничего не отмеряет, пиксель — волосяная
        // компенсация рамки.
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
