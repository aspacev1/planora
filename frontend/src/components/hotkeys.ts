/**
 * The application's keyboard shortcuts: how to call them and when to stay silent.
 *
 * Three rules, the same for every hotkey, live here rather than being repeated in every listener:
 * the modifier's name depends on the system, the layout substitutes the letter, and an input field
 * is entitled to its own shortcuts before the application. Every next listener rewriting them anew
 * will get exactly the one of the three it did not think about wrong.
 */

/**
 * The main modifier's caption — what a person sees in a hint.
 *
 * On a Mac it is ⌘, everywhere else Ctrl. Writing "Ctrl+Z" on a Mac would mean naming a key that
 * undoes nothing there: a hint that leads astray is worse than a missing one.
 */
export function modKeyLabel(): string {
  // userAgent rather than `navigator.platform`: the latter is declared deprecated, while
  // `userAgentData` is not in all the browsers the application serves.
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/.test(agent) ? "⌘" : "Ctrl";
}

/**
 * The undo combination: Ctrl/⌘+Z without Shift.
 *
 * Shift is cut off deliberately: Ctrl+Shift+Z is "redo", and the server cannot redo, so undoing a
 * second change in a row by it would mean doing the opposite of what the person asked for.
 */
export function isUndoChord(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  // `code` rather than only `key`: on a Russian layout the same key gives "я", and a comparison
  // with "z" would stay silent exactly where the application speaks Russian. But `code` is asked
  // for only where `key` is not a Latin letter: on a German layout the physical KeyZ gives "y", and
  // Ctrl+Y (which is "redo" for everyone) would undo a change instead of redoing it.
  const key = event.key.toLowerCase();
  if (key === "z") return true;
  return event.code === "KeyZ" && !/^[a-z]$/.test(key);
}

/**
 * Typing text: a field has its own undo, and the application must not interrupt it.
 *
 * A person erasing a typo in a task's name expects Ctrl+Z to bring the letter back rather than roll
 * back somebody else's move on the strip behind the form.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
