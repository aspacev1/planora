/**
 * A circle with initials — an avatar without photographs.
 *
 * There is no image upload in the product, and there is no reason to invent one for the sake of the
 * "Assignee" column: initials on a plain background solve the same task — telling people apart at a
 * glance. The shade is derived from the name deterministically rather than at random: one and the same
 * person must be the same colour in the list, the card and the comments, otherwise the colour stops
 * helping recognition.
 */

const HUES = [216, 262, 158, 24, 336, 96, 190, 282] as const;

function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return HUES[hash % HUES.length];
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // One word — one letter: "АЛ" out of "Алексей" would read as somebody else's initials.
  return words
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const hue = hueOf(name);
  return (
    <span
      className="avatar"
      // The name is the picture's accessible name: without it the owners column would be read from the
      // screen as a row of empty circles.
      role="img"
      aria-label={name}
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `hsl(${hue} 70% 90%)`,
        color: `hsl(${hue} 45% 32%)`,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
