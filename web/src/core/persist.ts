// Where a replica's state lives between page loads. Pending edits are saved here before they
// are sent (spec §4), so a closed tab never loses them.

export interface Persist {
  load(board: string): Promise<string | undefined>;
  save(board: string, state: string): Promise<void>;
}

export class MemoryPersist implements Persist {
  readonly data = new Map<string, string>();
  async load(board: string) {
    return this.data.get(board);
  }
  async save(board: string, state: string) {
    this.data.set(board, state);
  }
}

/** IndexedDB, one record per board. */
export class IdbPersist implements Persist {
  private db: Promise<IDBDatabase>;

  constructor(idb: IDBFactory = indexedDB, name = "mapcro") {
    this.db = new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("replicas");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const t = db.transaction("replicas", mode);
      const req = f(t.objectStore("replicas"));
      // Resolve on commit, not on request success: only then is the write durable.
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  load(board: string) {
    return this.tx("readonly", (s) => s.get(board) as IDBRequest<string | undefined>);
  }

  async save(board: string, state: string) {
    await this.tx("readwrite", (s) => s.put(state, board));
  }
}
