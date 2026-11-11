// The tool picker's tools (spec §4), their keys, and which ones a view link gets. Ordered by use,
// the keys under the left hand (feedback #28, operator 2026-11-11): Q Select, W Laser, E Draw, A
// Arrow, S Comment, D Erase (D under E: draw and erase side by side). Other board keys: C the
// Clear menu, Shift+C clears all (Toolbar), T a new scene after this one (SceneTree), F follows the
// presenter (Board), K kills or revives the hovered hero (Tokens).
// "select" was "move" until feedback #31; the tool is this browser's own, never stored or sent.
export type Tool = "select" | "draw" | "arrow" | "callout" | "laser" | "erase";

export const TOOLS: Array<{ tool: Tool; label: string; key: string; icon: string }> = [
  { tool: "select", label: "Select", key: "Q", icon: '<path d="M5 3l13 6.5-5.6 1.6L10 17z"/><path d="M12.5 11.2L18 17"/>' },
  { tool: "laser", label: "Laser", key: "W", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
  { tool: "draw", label: "Draw", key: "E", icon: '<path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5z"/><path d="M13.5 7l3.5 3.5"/>' },
  { tool: "arrow", label: "Arrow", key: "A", icon: '<path d="M4 20C7 12 11 8 19 5"/><path d="M13 4.5l6 .5-1.5 5.8"/>' },
  { tool: "callout", label: "Comment", key: "S", icon: '<path d="M4 5h16v10h-9l-4 4v-4H4z"/><path d="M8 9h8M8 12h5"/>' },
  { tool: "erase", label: "Erase", key: "D", icon: '<path d="M9 20h11"/><path d="M4.5 15.5l9-9 6 6-7.5 7.5H8.5z"/><path d="M9.5 10.5l6 6"/>' },
];

export const VIEWER_TOOLS: Tool[] = ["select", "laser"];

export const ICON_CLEAR = '<path d="M4 19c3-1 4-4 7-4s3 3 6 2"/><path d="M14 4l6 6M20 4l-6 6"/>';
export const ICON_UNDO = '<path d="M9 6L4 11l5 5"/><path d="M4 11h10a5 5 0 010 10h-3"/>';
export const ICON_REDO = '<path d="M15 6l5 5-5 5"/><path d="M20 11H10a5 5 0 000 10h3"/>';
/** The Heals toggle: a cross in a ring, the healing pickups' own shape. */
export const ICON_HEALS = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M7.5 12h9"/>';
/** The Heavy boxes toggle: a crate, its lid's edge and one brace. */
export const ICON_CRATES = '<rect x="4.5" y="6.5" width="15" height="13" rx="1"/><path d="M4.5 10.5h15M7.5 19.5l9-9"/>';
export const ICON_COMMENTS = '<path d="M4 5h16v10h-9l-4 4v-4H4z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>';

/** What a plain key does on the board's toolbar (spec §4 "Keys"): a tool, the Clear menu (C), or
 * clear everything on the scene (Shift+C). Nothing with Ctrl, Cmd or Alt held (Ctrl+C copies), and
 * Clear is an editor's only. Where keys apply at all (not in a field, dialog or menu) is the
 * caller's (core/keys.ts `boardKeys`). */
export type ToolbarKey = { tool: Tool } | { clear: "menu" | "all" };
export function toolbarKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, editor: boolean): ToolbarKey | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const k = e.key.toLowerCase();
  if (k === "c") return editor ? { clear: e.shiftKey ? "all" : "menu" } : undefined;
  const hit = TOOLS.find((x) => x.key.toLowerCase() === k && (editor || VIEWER_TOOLS.includes(x.tool)));
  return hit ? { tool: hit.tool } : undefined;
}
