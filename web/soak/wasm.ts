// The WASM replica, loaded from the built module, plus the two checks the soak borrows from it.

import { readFileSync } from "node:fs";
import { BoardReplica, initSync, newClientId, newClientSecret } from "../src/wasm/mapcro_wasm.js";
import type { Tx } from "../src/gen/Tx";

export function loadWasm(path: string) {
  initSync({ module: readFileSync(path) });
}

/** `validate_doc` on a `Doc` JSON: the replica's constructor runs it on the base it is given. */
export function validateDoc(docJson: string): string | undefined {
  try {
    new BoardReplica(newClientId(), newClientSecret(), `{"doc":${docJson},"seq":0}`).free();
    return undefined;
  } catch (e) {
    return String(e);
  }
}

/** Replays a log from a base through a fresh replica: the board as the log says it should be. */
export function replay(baseJson: string, entries: Array<{ seq: number; tx: Tx }>): string {
  const r = new BoardReplica(newClientId(), newClientSecret(), baseJson);
  try {
    for (const e of entries) r.receive(JSON.stringify({ t: "msg", msg: { Entry: e } }));
    return JSON.stringify(JSON.parse(r.view()));
  } finally {
    r.free();
  }
}

/** Records the seq each local transaction was made against, for counting real conflicts. */
export function recordBaseSeqs(into: Map<string, number>) {
  const proto = BoardReplica.prototype as unknown as Record<string, (this: BoardReplica, ...a: unknown[]) => string>;
  for (const name of ["edit", "undo", "redo"]) {
    const orig = proto[name]!;
    proto[name] = function (this: BoardReplica, ...args: unknown[]) {
      const base = this.lastSeq();
      const out = orig.apply(this, args);
      for (const f of (JSON.parse(out) as { frames: Array<{ msg?: { Submit?: Tx } }> }).frames) {
        const tx = f.msg?.Submit;
        if (tx) into.set(`${tx.client}:${tx.cseq}`, base);
      }
      return out;
    };
  }
}
