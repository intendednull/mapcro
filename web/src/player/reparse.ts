// Reparse, in the app (operator, 2026-11-11): a board's upload parsed in an older timeline format
// is stale (spec §6a, format versions). In a browser the way up is uploading the file again. In
// the app the demo is usually still in the replays folder and the app parses it itself, so a
// small alert offers one click: "Outdated" with Reparse, through the same path as a pick
// (`host.takeLocal`). Pure, so `reparse.test.ts` covers the table.

/** What the alert offers: Reparse; the update (the app's parser is older than the server's, so
 * a reparse can't help); or nothing, and the source panel's upload stays the way (today's). */
export type ReparseOffer = "reparse" | "update" | undefined;

/** The alert's words (spec §4b: tags, the game's register). */
export const REPARSE = {
  text: "Outdated",
  button: "Reparse",
  title: "Reparse replay",
  update: "Update the mapcro app",
} as const;

export function reparseOffer(o: {
  /** The page is in the app's window (`desktop.ts` `bridge`). */
  app: boolean;
  /** The open match's timeline is this board's upload in an older format (`api.ts` `staleUpload`). */
  stale: boolean;
  /** This user may upload to the board now (Player's `canUpload`: an editor, nothing under way). */
  canUpload: boolean;
  /** The app's replays folder has the match's demo. */
  inFolder: boolean;
  /** This run's app had a timeline refused as `outdated_parser`. */
  outdated: boolean;
}): ReparseOffer {
  if (!o.app || !o.stale || !o.canUpload) return undefined;
  if (o.outdated) return "update";
  return o.inFolder ? "reparse" : undefined;
}

/** Where "this app's parser is older than the server's" is kept: the window's sessionStorage, which
 * a page load in the app keeps and quitting the app (the only way to a new parser) drops. */
export const OUTDATED_KEY = "mapcro.app-outdated";
type Session = Pick<Storage, "getItem" | "setItem">;

const session = (): Session | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/** The server refused this app's timeline as older than its format. */
export function markOutdated(storage: Session | undefined = session()) {
  try {
    storage?.setItem(OUTDATED_KEY, "1");
  } catch {
    // Storage full or off: Reparse is offered again, and refused the same way.
  }
}

export function isOutdated(storage: Session | undefined = session()): boolean {
  try {
    return storage?.getItem(OUTDATED_KEY) === "1";
  } catch {
    return false;
  }
}
