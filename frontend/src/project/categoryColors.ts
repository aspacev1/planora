/**
 * The palette for new categories.
 *
 * It lives in the browser rather than on the server: this is styling, not a property of the plan. It
 * is suggested by the number of already existing categories — that way two categories created in a
 * row do not come out the same colour, and a person does not have to pick a colour by hand every
 * time. The choice still stays theirs where they are asked for it: an automatically picked colour
 * clash on the eleventh category should be fixable rather than endured.
 *
 * A ready set is the whole choice: an arbitrary colour from the system's eyedropper can be
 * indistinguishable from its neighbour, unreadable on a light board and different for two people who
 * agreed to "paint it blue". Ten mutually distinguishable colours cover the task of "telling the
 * categories apart" and make the choice a matter of one click.
 *
 * The caption's key (`name`) is machine-readable: the text itself lives in the dictionaries, because
 * a screen reader must name the circle with a word in the person's language rather than with the
 * code `#3b82f6`.
 *
 * The module is separate from the creation form (`screens/CategoryForm.tsx`) because the palette has
 * a second consumer too — quickly adding a category from the bottom of the strip (see
 * `gantt/useQuickCategory.ts`), which has no reason to create a dialog with a colour choice while
 * still needing a colour. As a second copy of the same ten values this would diverge on the very
 * first edit of the palette.
 */
export const CATEGORY_COLORS = [
  { value: "#3b82f6", name: "blue" },
  { value: "#a855f7", name: "purple" },
  { value: "#f97316", name: "orange" },
  { value: "#10b981", name: "green" },
  { value: "#ef4444", name: "red" },
  { value: "#eab308", name: "yellow" },
  { value: "#06b6d4", name: "cyan" },
  { value: "#ec4899", name: "pink" },
  { value: "#64748b", name: "slate" },
  { value: "#b45309", name: "brown" },
] as const;

export function suggestColor(existing: number): string {
  return CATEGORY_COLORS[existing % CATEGORY_COLORS.length].value;
}
