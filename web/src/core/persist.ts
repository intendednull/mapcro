// Where a replica's state lives between page loads. Pending edits are saved here before they
// are sent (spec §4), so a closed tab never loses them.
//
// Two kinds of write (perf report 2026-11-07, finding 5). The whole replica state is large (55
// KiB on a 150-create board, 278 KiB at 1,000) and is saved lazily. Each transaction a live
// session sends is first written alone to a journal, a few hundred bytes. `load` folds the
// journal into the state. A journal entry the state already holds is ignored, and a saved state
// drops the entries it covers. Every committed prefix of these writes restores to a replica
// holding every transaction that was sent.

import type { Tx } from "../gen/Tx";

export interface Persist {
  /** A stored value; for a board, its replica state with the journal folded in. */
  load(key: string): Promise<string | undefined>;
  /** Store a value; for a board, the whole replica state. */
  save(key: string, value: string): Promise<void>;
  /** Journal transactions of `board` (durable once this resolves). Without it, every edit
   * saves the whole state before it is sent. */
  savePending?(board: string, txs: Tx[]): Promise<void>;
  /** Drop `client`'s journal entries below `cseq`: a saved state holds them. */
  dropPending?(board: string, client: string, below: number): Promise<void>;
}

/** The parts of a stored replica state (the engine's `ReplicaState`) the journal touches. */
interface StoredState {
  client: string;
  next_cseq: number;
  pending: Tx[];
  undo: Array<{ cseq: number }>;
  redo: Array<{ cseq: number }>;
}

/**
 * The state with the journal folded in: `client`'s transactions from `next_cseq` on, in order,
 * up to the first gap, become pending again. Undo history follows the transactions the stored
 * state can account for. The undo entry of a journaled edit isn't known here, so that edit
 * can't be undone after the reload; nothing is ever undone twice.
 */
export function foldPending(state: string, journal: Tx[]): { state: string; folded: number } {
  if (journal.length === 0) return { state, folded: 0 };
  const s = JSON.parse(state) as StoredState;
  const mine = journal.filter((t) => t.client === s.client && t.cseq >= s.next_cseq).sort((a, b) => a.cseq - b.cseq);
  let folded = 0;
  for (const tx of mine) {
    if (tx.cseq !== s.next_cseq) break;
    s.pending.push(tx);
    s.next_cseq = tx.cseq + 1;
    const k = tx.kind;
    if (k === "Edit") s.redo = [];
    else if ("Undo" in k) s.undo = s.undo.filter((e) => e.cseq !== k.Undo.of);
    else s.redo = s.redo.filter((e) => e.cseq !== k.Redo.of);
    folded += 1;
  }
  return { state: folded ? JSON.stringify(s) : state, folded };
}

const clientOf = (state: string): string | undefined => {
  try {
    return (JSON.parse(state) as Partial<StoredState>).client;
  } catch {
    return undefined;
  }
};

export class MemoryPersist implements Persist {
  readonly data = new Map<string, string>();
  /** Journal by board, then `client\0cseq`. */
  readonly journal = new Map<string, Map<string, Tx>>();
  async load(key: string) {
    const s = this.data.get(key);
    const j = this.journal.get(key);
    if (s === undefined || !j?.size) return s;
    const { state, folded } = foldPending(s, [...j.values()]);
    if (folded) this.data.set(key, state);
    const client = clientOf(s);
    for (const [k, tx] of j) if (tx.client === client) j.delete(k);
    return state;
  }
  async save(key: string, value: string) {
    this.data.set(key, value);
  }
  async savePending(board: string, txs: Tx[]) {
    let j = this.journal.get(board);
    if (!j) this.journal.set(board, (j = new Map()));
    for (const tx of txs) j.set(`${tx.client}\u0000${tx.cseq}`, tx);
  }
  async dropPending(board: string, client: string, below: number) {
    const j = this.journal.get(board);
    if (j) for (const [k, tx] of j) if (tx.client === client && tx.cseq < below) j.delete(k);
  }
}

/** IndexedDB: one record per board in `replicas`; the journal in `pending`, keyed
 * `[board, client, cseq]`. */
export class IdbPersist implements Persist {
  private db: Promise<IDBDatabase>;

  constructor(idb: IDBFactory = indexedDB, name = "mapcro") {
    this.db = new Promise((resolve, reject) => {
      const req = idb.open(name, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("replicas")) db.createObjectStore("replicas");
        if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(stores: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => T): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const out = f(t);
      // Resolve on commit, not on request success: only then is the write durable.
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  private static range(board: string, client?: string, below?: number) {
    if (client === undefined) return IDBKeyRange.bound([board], [board, []]);
    return IDBKeyRange.bound([board, client], below === undefined ? [board, client, []] : [board, client, below], false, below !== undefined);
  }

  /** Reads the state and its journal, and if the journal held anything of this state's
   * client, writes the folded state back and clears those entries, in one transaction. */
  async load(key: string) {
    let result: string | undefined;
    await this.tx(["replicas", "pending"], "readwrite", (t) => {
      const replicas = t.objectStore("replicas");
      const pending = t.objectStore("pending");
      const get = replicas.get(key) as IDBRequest<string | undefined>;
      const all = pending.getAll(IdbPersist.range(key)) as IDBRequest<Tx[]>;
      all.onsuccess = () => {
        result = get.result;
        if (result === undefined || all.result.length === 0) return;
        const { state, folded } = foldPending(result, all.result);
        if (folded) replicas.put(state, key);
        const client = clientOf(result);
        if (client !== undefined) pending.delete(IdbPersist.range(key, client));
        result = state;
      };
    });
    return result;
  }

  async save(key: string, value: string) {
    await this.tx(["replicas"], "readwrite", (t) => t.objectStore("replicas").put(value, key));
  }

  async savePending(board: string, txs: Tx[]) {
    await this.tx(["pending"], "readwrite", (t) => {
      const s = t.objectStore("pending");
      for (const tx of txs) s.put(tx, [board, tx.client, tx.cseq]);
    });
  }

  async dropPending(board: string, client: string, below: number) {
    await this.tx(["pending"], "readwrite", (t) => t.objectStore("pending").delete(IdbPersist.range(board, client, below)));
  }

  /** Remove these journal entries (the soak's crash model rolls back writes in flight). */
  async deletePending(board: string, txs: Tx[]) {
    await this.tx(["pending"], "readwrite", (t) => {
      const s = t.objectStore("pending");
      for (const tx of txs) s.delete([board, tx.client, tx.cseq]);
    });
  }
}
