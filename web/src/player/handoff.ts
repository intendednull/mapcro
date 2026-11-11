// A replay the landing page was given (dropped or picked), handed to the board it opened for it
// (spec §6b): the board uploads it in Player, with progress, while you use the board.

export interface Handoff {
  board: string;
  id: string;
  /** The `.dem`, picked or dropped in a browser. */
  file?: File | undefined;
  /** In the Windows app, the replay picked from its folder: parsed there, and only the timeline
   * sent (the file is the fallback for a server without the timeline route). */
  local?: { timeline: () => Promise<Blob>; file: () => Promise<File> } | undefined;
  /** The upload started and the match is attached: the landing's "Your boards" keeps it. */
  opened: () => void;
}

let pending: Handoff | undefined;

export const handOff = (h: Handoff) => void (pending = h);

/** The upload handed to `board`, once. */
export function takeHandoff(board: string): Handoff | undefined {
  const h = pending?.board === board ? pending : undefined;
  if (h) pending = undefined;
  return h;
}
