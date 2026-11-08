// The browser's own right-click menu is off across the site (operator, 2026-11-08). Right-drag
// pans the map, and a pan that ends over a button or a panel would otherwise open the menu
// there. Our own right-click actions, where we want them, handle `contextmenu` themselves.
// Text fields keep it: paste, spellcheck and the like live there.

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || (t instanceof HTMLInputElement && t.type !== "button" && t.type !== "checkbox" && t.type !== "radio" && t.type !== "range") || t instanceof HTMLTextAreaElement);

export function suppressContextMenu(root: Document = document) {
  root.addEventListener("contextmenu", (e) => {
    if (!editable(e.target)) e.preventDefault();
  });
}
