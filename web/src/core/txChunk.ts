// Transaction size budgeting and chunking (TD-86): leaf helper importing only generated schema
// types and limits, shared by board scene edits, match saves, and hero undo decisions.

import { LIMITS } from "../gen/limits";
import type { Op } from "../gen/Op";

/** Bytes kept free in a transaction for what wraps its ops on the wire (the client's id, the
 * cseq and kind) and for each `more` key's own punctuation. */
export const TX_SLACK = 1024;

/** Ops as the server counts a transaction against `max_tx_bytes`: their JSON, in bytes. */
export const opsBytes = (ops: Op[]) => new TextEncoder().encode(JSON.stringify(ops)).length;

/** Whether ops fit one transaction's bytes, with room for what wraps them on the wire. */
export const fitsTx = (ops: Op[]) => opsBytes(ops) <= LIMITS.max_tx_bytes - TX_SLACK;

/** Groups of ops as transactions: each within the op and byte caps, a group never split
 * (a group here is one record's writes, itself within both). */
export function chunkByBytes(groups: Op[][]): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  let bytes = 0;
  for (const g of groups) {
    const n = opsBytes(g);
    if (cur.length && (cur.length + g.length > LIMITS.max_ops_per_tx || bytes + n > LIMITS.max_tx_bytes - TX_SLACK)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur = cur.concat(g);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
