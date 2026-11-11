/** Input types that take typed text: Space is a character there. Range, checkbox, radio,
 * colour, file and the button types don't. */
const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

/** A field the user types into (spec §6b "Keys while watching"): there Space is a space. */
export function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);
}

/** Space plays or pauses from anywhere on the board but a text field, an open dialog or a menu
 * (they keep their own keys). */
export function spacePlays(el: Element | null): boolean {
  if (isTextField(el)) return false;
  return !(el instanceof Element && el.closest('[role="dialog"], [role="menu"], [aria-modal="true"]'));
}
