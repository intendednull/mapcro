// One undo over two documents (sessions.md §7.2, operator decision 10): the session's strip
// edits and your edits on the board you're on, interleaved by when you made them. Each document
// keeps its own stack (the WASM replica's, evaluated by the server, §7); this keeps only the
// order of the steps: one mark per undoable edit, naming the document it went to. Undo takes the
// newest mark whose document is here and can undo; a board that isn't mounted keeps its marks,
// so switching back brings its edits back into reach, and nothing ever undoes another board's.

import { type Accessor, createSignal } from "solid-js";

/** A document's own undo stack. */
export interface UndoSide {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
}

/** Marks kept, newest last; older ones fall off (their documents still hold the steps). */
const MAX_MARKS = 1000;

export class UndoHistory {
  private undos: string[] = [];
  private redos: string[] = [];
  private readonly sides = new Map<string, UndoSide>();
  /** Moves on with every edit, undo and redo: a point in the history (`at`). */
  private seq = 0;
  private readonly version: Accessor<number>;
  private readonly bump: () => void;

  constructor() {
    const [v, set] = createSignal(0, { equals: false });
    this.version = v;
    this.bump = () => set(0);
  }

  /** A document is here (the session, or the mounted board); the returned call takes it away. */
  attach(id: string, side: UndoSide): () => void {
    this.sides.set(id, side);
    this.bump();
    return () => {
      if (this.sides.get(id) === side) this.sides.delete(id);
      this.bump();
    };
  }

  /** You made an undoable edit on `id`: it's the newest step, and that document's redo is gone. */
  edited(id: string): void {
    this.undos.push(id);
    if (this.undos.length > MAX_MARKS) this.undos.splice(0, this.undos.length - MAX_MARKS);
    this.redos = this.redos.filter((x) => x !== id);
    this.seq += 1;
    this.bump();
  }

  /** Where the history is now; a toast keeps it to know whether its step is still the newest. */
  at(): number {
    this.version();
    return this.seq;
  }

  /** Nothing was edited, undone or redone since `at` (reactive). */
  live(at: number): boolean {
    return this.at() === at;
  }

  /**
   * A toast's Undo (sessions.md §7.2): take back the newest `n` steps, which must all be `id`'s,
   * and only if nothing was done since `at`, when they were made. Never an older step instead:
   * if one can't be undone (a peer's edit made it a no-op), it stops there.
   */
  undoSince(at: number, id: string, n = 1): boolean {
    if (at !== this.seq) return false;
    const side = this.sides.get(id);
    const tail = this.undos.slice(-n);
    if (!side || tail.length < n || tail.some((x) => x !== id) || !side.canUndo()) return false;
    for (let k = 0; k < n && side.canUndo(); k++) {
      this.undos.pop();
      this.redos.push(id);
      side.undo();
    }
    this.seq += 1;
    this.bump();
    return true;
  }

  /** The newest step that can be undone here, as an index into the marks. */
  private newest(marks: string[], can: (s: UndoSide) => boolean, prune: boolean): number {
    for (let i = marks.length - 1; i >= 0; i--) {
      const side = this.sides.get(marks[i]!);
      if (!side) continue; // a board not mounted: its steps wait for it
      if (can(side)) return i;
      // Its document has nothing left to take back (a remote edit made it a no-op, its stack
      // was cut): the mark is spent.
      if (prune) marks.splice(i, 1);
    }
    return -1;
  }

  undo(): boolean {
    const i = this.newest(this.undos, (s) => s.canUndo(), true);
    if (i < 0) return (this.bump(), false);
    const [id] = this.undos.splice(i, 1);
    this.redos.push(id!);
    this.sides.get(id!)!.undo();
    this.seq += 1;
    this.bump();
    return true;
  }

  redo(): boolean {
    const i = this.newest(this.redos, (s) => s.canRedo(), true);
    if (i < 0) return (this.bump(), false);
    const [id] = this.redos.splice(i, 1);
    this.undos.push(id!);
    this.sides.get(id!)!.redo();
    this.seq += 1;
    this.bump();
    return true;
  }

  canUndo(): boolean {
    this.version();
    return this.newest([...this.undos], (s) => s.canUndo(), false) >= 0;
  }

  canRedo(): boolean {
    this.version();
    return this.newest([...this.redos], (s) => s.canRedo(), false) >= 0;
  }
}
