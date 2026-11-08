// mapcro sync protocol: a deliberately small model of spec §3–§7.
//
// What it models: one record with fields, a server-ordered op log, optimistic clients with
// pending queues, WebSocket connections (FIFO while up; a disconnect loses everything in
// flight), reconnect with `hello(lastSeq)` + resend of pending work, and per-user undo.
// Rejection is modelled too: re-creating a record someone else already restored is refused,
// which is the state-dependent kind of rejection honest clients hit.
// A fresh client (no stored copy, or storage cleared) may start from a snapshot of the board
// rather than replay the log from the start (spec §5). The server may compact its log, and a
// client whose copy is older than what's kept is rebased onto the board as it is (spec §9).
// What it leaves out on purpose: game data, scenes, many records, presence, persistence.
module sync {
  // Design switches, so the spec as first written and each fix can be checked side by side.
  // LIVE_AFTER_HELLO: the server sends live broadcasts on a connection only once it has
  //   processed that connection's hello (and sent its catch-up).
  // SERVER_SIDE_UNDO: undo sends conditional ops that the *server* evaluates at apply time
  //   (set-if-still-equal, restore-if-still-deleted), rather than a plain write decided on the client.
  const LIVE_AFTER_HELLO: bool
  const SERVER_SIDE_UNDO: bool
  // REJECT_BEFORE_CATCHUP: a hello is answered with the client's outstanding rejections *before*
  //   the catch-up entries (engine finding 3: a lost rejection must not arrive after later acks).
  const REJECT_BEFORE_CATCHUP: bool
  // SNAPSHOT_ON_JOIN: a fresh client starts from a snapshot of the server's board at some log
  //   position k (the current one, or a slightly stale cached one) and says hello from k, rather
  //   than replaying everything from 0. Off: k is always 0.
  const SNAPSHOT_ON_JOIN: bool
  // SNAPSHOT_SKEW: the seq the client is told its snapshot is at, minus where it really is.
  //   0 is correct; 1 is the off-by-one the implementation must not make (the model catches it).
  const SNAPSHOT_SKEW: int
  // REBASE: the server may answer a hello with the board as it is (and which of the client's
  //   transactions it already holds) instead of catch-up, and must when the client's copy is
  //   older than the compaction floor. Off: no compaction, catch-up only.
  const REBASE: bool
  // REBASE_DROPS_DECIDED: the rebased client drops its pending transactions the server says are
  //   decided. Off is the bug: they stay pending for ever (or are applied twice).
  const REBASE_DROPS_DECIDED: bool
  // PRUNE_KEEPS_NEXT: when a hello prunes the rejections its client has heard, the server keeps
  //   that client's next expected cseq durably (client_seqs). Off is the bug the review found: a
  //   restart rebuilds it from the log and the stored rejections, one short if the last decided
  //   transaction was a pruned rejection, and the client's next submit is a sequence gap.
  const PRUNE_KEEPS_NEXT: bool

  type ClientId = str

  // ---- Scope. Small on purpose: protocol bugs show up with two clients and a few ops.
  pure val CLIENTS: Set[ClientId] = Set("a", "b")
  pure val FIELDS: Set[str] = Set("x")
  pure val VALUES: Set[int] = Set(1, 2)
  pure val MAX_TX = 3      // transactions (edits + undos) each client may create
  pure val MAX_DROPS = 1   // disconnects per client
  pure val MAX_RELOADS = 1 // fresh reloads (storage cleared) per client
  pure val MAX_COMPACTS = 1 // times the server compacts its log
  pure val MAX_RESTARTS = 1 // server restarts (it rebuilds from what's durable)
  pure val MAX_LOG = MAX_TX * 2   // upper bound on log length (2 clients); constant for Apalache

  // ---- Board: a single record that can be deleted and recreated.
  type Board = { exists: bool, fields: str -> int }
  pure val INIT_BOARD: Board = { exists: true, fields: FIELDS.mapBy(_ => 0) }

  type Op =
    | SetField({ field: str, value: int })
    | Delete
    | Create(str -> int)
    | SetIf({ field: str, expect: int, value: int })   // applies only if field == expect
    | Restore                                          // undelete, keeping the server's fields

  // isUndo marks an undo; undoExpect is the value the undone SetField wrote (-1 otherwise).
  type Tx = { client: ClientId, cseq: int, op: Op, isUndo: bool, undoExpect: int }

  pure def applyOp(b: Board, op: Op): Board = match op {
    | SetField(s) => if (b.exists) { ...b, fields: b.fields.set(s.field, s.value) } else b
    | Delete => { ...b, exists: false }
    | Create(fs) => { exists: true, fields: fs }
    | SetIf(s) => if (b.exists and b.fields.get(s.field) == s.expect) { ...b, fields: b.fields.set(s.field, s.value) } else b
    | Restore => { ...b, exists: true }
  }
  pure def applyTxs(b: Board, txs: List[Tx]): Board = txs.foldl(b, (acc, t) => applyOp(acc, t.op))

  // ---- Undo history: what each of my edits changed, as I saw it when I made it.
  type UndoEntry =
    | UndoSet({ field: str, before: int, after: int })
    | UndoDelete(str -> int)

  type ClientState = {
    confirmed: Board,          // state at server seq `lastSeq`
    lastSeq: int,
    pending: List[Tx],         // sent or unsent, not yet seen back from the server
    nextCseq: int,
    undoStack: List[UndoEntry],
    connected: bool,
    drops: int,
    rejected: Set[int],        // cseqs the server refused
    reloads: int,
    // A fresh reload is a new identity in the real client (a new client id), so transactions
    // below `epoch` were made by "someone else". Same id here keeps the state space small.
    epoch: int,
  }

  // ---- Wire messages
  type Up = | Hello({ lastSeq: int, pendingFrom: int }) | Submit(Tx)
  type Entry = { seq: int, tx: Tx }   // the tx at log position `seq`
  // DRebase: the board at log position `seq`, and the client's oldest undecided cseq then.
  type Down = | DEntry(Entry) | DRej(int) | DRebase({ board: Board, seq: int, decidedBelow: int })

  // ---- State
  var log: List[Tx]                    // the server's ordered truth
  var board: Board                     // the server's board = applyTxs(INIT_BOARD, log)
  var cli: ClientId -> ClientState
  var up: ClientId -> List[Up]         // client -> server, in flight
  var down: ClientId -> List[Down]     // server -> client, in flight
  var live: ClientId -> bool           // server side: may this connection get broadcasts?
  var clobbered: bool                  // ghost: an undo overwrote a value it did not write
  var srvRejected: ClientId -> Set[int] // server side: cseqs refused, per client
  var ackMismatch: bool                // ghost: a client got its own ack out of pending order
  var floor: int                       // server side: entries at or below this are compacted away
  var compacts: int
  var srvNext: ClientId -> int         // server side, in memory: every cseq below it is decided
  var clientSeqs: ClientId -> int      // server side, durable: next cseqs kept (compaction, prune)
  var baseAt: int                      // server side, durable: the log position of the stored base
  var restarts: int
  var gapped: bool                     // ghost: an honest client's submit was a sequence gap

  def view(c: ClientId): Board = applyTxs(cli.get(c).confirmed, cli.get(c).pending)
  pure def inLog(l: List[Tx], c: ClientId, k: int): bool =
    l.indices().exists(i => l[i].client == c and l[i].cseq == k)

  action init = all {
    log' = List(),
    board' = INIT_BOARD,
    cli' = CLIENTS.mapBy(_ => {
      confirmed: INIT_BOARD, lastSeq: 0, pending: List(), nextCseq: 0,
      undoStack: List(), connected: true, drops: 0, rejected: Set(), reloads: 0, epoch: 0,
    }),
    up' = CLIENTS.mapBy(_ => List()),
    down' = CLIENTS.mapBy(_ => List()),
    live' = CLIENTS.mapBy(_ => true),
    clobbered' = false,
    srvRejected' = CLIENTS.mapBy(_ => Set()),
    ackMismatch' = false,
    floor' = 0,
    compacts' = 0,
    srvNext' = CLIENTS.mapBy(_ => 0),
    clientSeqs' = CLIENTS.mapBy(_ => 0),
    baseAt' = 0,
    restarts' = 0,
    gapped' = false,
  }

  // ---- Client: create a transaction (optimistic; sent now if connected, else on reconnect)
  action submit(c: ClientId, op: Op, isUndo: bool, undoExpect: int, stack: List[UndoEntry]): bool = {
    val s = cli.get(c)
    val tx = { client: c, cseq: s.nextCseq, op: op, isUndo: isUndo, undoExpect: undoExpect }
    all {
      s.nextCseq < MAX_TX,
      cli' = cli.set(c, { ...s, pending: s.pending.append(tx), nextCseq: s.nextCseq + 1, undoStack: stack }),
      up' = if (s.connected) up.setBy(c, q => q.append(Submit(tx))) else up,
      down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
    }
  }

  action editSet(c: ClientId): bool = {
    nondet f = FIELDS.oneOf()
    nondet v = VALUES.oneOf()
    val b = view(c)
    all {
      b.exists,
      b.fields.get(f) != v,
      submit(c, SetField({ field: f, value: v }), false, -1,
        cli.get(c).undoStack.append(UndoSet({ field: f, before: b.fields.get(f), after: v }))),
    }
  }

  action editDelete(c: ClientId): bool = {
    val b = view(c)
    all { b.exists, submit(c, Delete, false, -1, cli.get(c).undoStack.append(UndoDelete(b.fields))) }
  }

  // Re-create the record if this client sees it deleted. Concurrently someone may already have
  // restored it; then the server refuses (the honest, state-dependent kind of rejection).
  action editRecreate(c: ClientId): bool = {
    val b = view(c)
    all { not(b.exists), submit(c, Create(b.fields), false, -1, cli.get(c).undoStack) }
  }

  // Spec §7 as written: undo writes the before-value only if the field still holds my
  // after-value, *as this client currently sees it*.
  action undo(c: ClientId): bool = {
    val s = cli.get(c)
    val b = view(c)
    val n = s.undoStack.length()
    all {
      n > 0,
      val e = s.undoStack[n - 1]
      val rest = s.undoStack.slice(0, n - 1)
      match e {
        | UndoSet(u) =>
            if (SERVER_SIDE_UNDO)
              submit(c, SetIf({ field: u.field, expect: u.after, value: u.before }), true, u.after, rest)
            else if (b.exists and b.fields.get(u.field) == u.after)
              submit(c, SetField({ field: u.field, value: u.before }), true, u.after, rest)
            else all {   // someone changed it since: skip, but still pop the entry
              cli' = cli.set(c, { ...s, undoStack: rest }),
              up' = up, down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            }
        | UndoDelete(fs) =>
            if (SERVER_SIDE_UNDO) submit(c, Restore, true, -1, rest)
            else if (not(b.exists)) submit(c, Create(fs), true, -1, rest)
            else all {
              cli' = cli.set(c, { ...s, undoStack: rest }),
              up' = up, down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            }
      },
    }
  }

  // ---- Server: handle the next message from client c
  action serverRecv(c: ClientId): bool = {
    val q = up.get(c)
    all {
      q.length() > 0,
      match q[0] {
        | Hello(h) => {
            // catch-up: everything after the client's lastSeq, plus rejections it may have missed
            val catchUp = range(0, MAX_LOG).foldl(List(), (acc, i) =>
              if (i >= h.lastSeq and i < log.length()) acc.append(DEntry({ seq: i + 1, tx: log[i] })) else acc)
            // or a rebase: the board now, and the client's oldest cseq the server hasn't decided
            val decidedBelow = srvNext.get(c)
            val rebase = List(DRebase({ board: board, seq: log.length(), decidedBelow: decidedBelow }))
            // below the floor the entries are gone, so it must rebase; above, it may (far behind)
            nondet chooseRebase = Set(true, false).oneOf()
            val useRebase = REBASE and (h.lastSeq < floor or chooseRebase)
            val reply = if (useRebase) rebase else catchUp
            val rejections = range(0, MAX_TX).foldl(List(), (acc, k) =>
              if (k >= h.pendingFrom and srvRejected.get(c).contains(k)) acc.append(DRej(k)) else acc)
            all {
              not(REBASE) or h.lastSeq >= floor or useRebase,
              down' = down.setBy(c, d => d.concat(
                if (REJECT_BEFORE_CATCHUP) rejections.concat(reply) else reply.concat(rejections))),
              up' = up.set(c, q.tail()),
              live' = live.set(c, true),
              // the client has heard every rejection below pendingFrom: forget them
              srvRejected' = srvRejected.setBy(c, r => r.filter(k => k >= h.pendingFrom)),
              clientSeqs' = if (PRUNE_KEEPS_NEXT) clientSeqs.setBy(c, n => if (n > srvNext.get(c)) n else srvNext.get(c)) else clientSeqs,
              log' = log, board' = board, cli' = cli, clobbered' = clobbered, ackMismatch' = ackMismatch,
              floor' = floor, compacts' = compacts, srvNext' = srvNext, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            }
          }
        | Submit(tx) =>
            if (tx.cseq < srvNext.get(c)) all {   // already decided: ignore
              up' = up.set(c, q.tail()),
              down' = down, log' = log, board' = board, cli' = cli, live' = live, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            } else if (tx.cseq > srvNext.get(c)) all {   // a sequence gap: the real server closes
              gapped' = true,
              up' = up.set(c, q.tail()),
              down' = down, log' = log, board' = board, cli' = cli, live' = live, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch,
              floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts,
            } else if (match tx.op { | Create(_) => board.exists | _ => false }) all {
              // refused: tell the sender only
              srvRejected' = srvRejected.setBy(c, r => r.union(Set(tx.cseq))),
              down' = down.setBy(c, d => d.append(DRej(tx.cseq))),
              up' = up.set(c, q.tail()),
              srvNext' = srvNext.set(c, tx.cseq + 1),
              log' = log, board' = board, cli' = cli, live' = live, clobbered' = clobbered, ackMismatch' = ackMismatch,
              floor' = floor, compacts' = compacts, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            } else {
              val e = DEntry({ seq: log.length() + 1, tx: tx })
              // Did this undo overwrite something its own edit didn't write?
              val wouldClobber = tx.isUndo and match tx.op {
                | SetField(s) => board.exists and board.fields.get(s.field) != tx.undoExpect
                | Create(fs) => not(board.exists) and fs != board.fields
                | _ => false   // SetIf and Restore check on the server, by construction
              }
              all {
                log' = log.append(tx),
                board' = applyOp(board, tx.op),
                // broadcast to every connected client, including the sender (its ack)
                down' = CLIENTS.mapBy(k =>
                  if (if (LIVE_AFTER_HELLO) live.get(k) else cli.get(k).connected) down.get(k).append(e)
                  else down.get(k)),
                up' = up.set(c, q.tail()),
                cli' = cli, live' = live,
                clobbered' = (clobbered or wouldClobber),
                srvNext' = srvNext.set(c, tx.cseq + 1),
                srvRejected' = srvRejected, ackMismatch' = ackMismatch,
                floor' = floor, compacts' = compacts, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
              }
            }
      },
    }
  }

  // ---- Client: handle the next entry from the server (spec §3: apply, then rebase pending)
  action clientRecv(c: ClientId): bool = {
    val d = down.get(c)
    val s = cli.get(c)
    all {
      d.length() > 0,
      match d[0] {
        | DEntry(e) =>
          val own = e.tx.client == c and e.tx.cseq >= s.epoch
          val acked = own and s.pending.length() > 0 and s.pending[0].cseq == e.tx.cseq
          all {
            cli' = cli.set(c, { ...s,
              confirmed: applyOp(s.confirmed, e.tx.op),
              lastSeq: e.seq,
              pending: if (acked) s.pending.tail() else s.pending,
            }),
            ackMismatch' = (ackMismatch or (own and not(acked))), floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
            down' = down.set(c, d.tail()),
            up' = up, log' = log, board' = board, live' = live, clobbered' = clobbered, srvRejected' = srvRejected,
          }
        | DRebase(r) => all {
            // Adopt the board. A pending transaction below `decidedBelow` is either in it (applied)
            // or was refused (and its rejection came first, so it's gone already): drop it. The
            // rest stay pending, on top, and are resent as on any reconnect. Undo history is kept.
            cli' = cli.set(c, { ...s,
              confirmed: r.board,
              lastSeq: r.seq,
              pending: if (REBASE_DROPS_DECIDED) s.pending.select(t => t.cseq >= r.decidedBelow) else s.pending,
            }),
            down' = down.set(c, d.tail()),
            up' = up, log' = log, board' = board, live' = live, clobbered' = clobbered,
            srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
          }
        | DRej(k) => all {
            cli' = cli.set(c, { ...s,
              pending: s.pending.select(t => t.cseq != k),
              rejected: s.rejected.union(Set(k)),
            }),
            down' = down.set(c, d.tail()),
            up' = up, log' = log, board' = board, live' = live, clobbered' = clobbered,
            srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
          }
      },
    }
  }

  // ---- Network faults: a disconnect loses everything in flight on that connection
  action disconnect(c: ClientId): bool = {
    val s = cli.get(c)
    all {
      s.connected, s.drops < MAX_DROPS,
      cli' = cli.set(c, { ...s, connected: false, drops: s.drops + 1 }),
      up' = up.set(c, List()), down' = down.set(c, List()),
      live' = live.set(c, false),
      log' = log, board' = board, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
    }
  }

  // spec §5: hello(lastSeq), then resend all pending work
  action reconnect(c: ClientId): bool = {
    val s = cli.get(c)
    all {
      not(s.connected),
      cli' = cli.set(c, { ...s, connected: true }),
      live' = live,   // not live until the server processes the hello (if LIVE_AFTER_HELLO)
      up' = up.set(c, List(Hello({ lastSeq: s.lastSeq, pendingFrom: if (s.pending.length() > 0) s.pending[0].cseq else s.nextCseq })).concat(s.pending.foldl(List(), (acc, t) => acc.append(Submit(t))))),
      down' = down, log' = log, board' = board, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
    }
  }

  // spec §5: a client with no stored copy (a new device, or one that cleared its storage) joins
  // fresh. Only with no pending work: clearing storage with unsynced edits loses them, by the
  // user's choice, which isn't the protocol's to prevent. Its old connection is gone. It starts
  // from the server's board at log position k, taken atomically (the room holds the board), and
  // says hello from there; entries after k come as catch-up, then live ones.
  action freshReload(c: ClientId): bool = {
    val s = cli.get(c)
    nondet k = 0.to(MAX_LOG).oneOf()
    all {
      s.pending.length() == 0, s.reloads < MAX_RELOADS,
      k <= log.length(), SNAPSHOT_ON_JOIN or k == 0,
      cli' = cli.set(c, { ...s,
        confirmed: applyTxs(INIT_BOARD, log.slice(0, k)),
        lastSeq: k + SNAPSHOT_SKEW,
        undoStack: List(), connected: true, reloads: s.reloads + 1, epoch: s.nextCseq,
      }),
      up' = up.set(c, List(Hello({ lastSeq: k + SNAPSHOT_SKEW, pendingFrom: s.nextCseq }))),
      down' = down.set(c, List()),
      live' = live.set(c, false),
      log' = log, board' = board, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch, floor' = floor, compacts' = compacts, srvNext' = srvNext, clientSeqs' = clientSeqs, baseAt' = baseAt, restarts' = restarts, gapped' = gapped,
    }
  }

  // spec §9: the server snapshots its board and drops the log up to some position. Clients whose
  // copy is older than that can no longer be caught up and are rebased instead.
  action compact: bool = {
    nondet k = 0.to(MAX_LOG).oneOf()
    all {
      REBASE, compacts < MAX_COMPACTS, k > floor, k <= log.length(),
      floor' = k, compacts' = compacts + 1,
      // the base is the board now, and every client's next cseq is kept with it
      baseAt' = log.length(), clientSeqs' = srvNext,
      log' = log, board' = board, cli' = cli, up' = up, down' = down, live' = live,
      clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch,
      srvNext' = srvNext, restarts' = restarts, gapped' = gapped,
    }
  }

  // The server restarts: every connection drops, and it rebuilds each client's next cseq from
  // what's durable only: the log after the base, the stored rejections, and client_seqs.
  pure def maxNext(a: int, b: int): int = if (a > b) a else b
  action restart: bool = {
    val rebuilt = CLIENTS.mapBy(c => {
      val fromLog = range(0, MAX_LOG).foldl(0, (m, i) =>
        if (i >= baseAt and i < log.length() and log[i].client == c) maxNext(m, log[i].cseq + 1) else m)
      val fromRej = range(0, MAX_TX).foldl(0, (m, k) => if (srvRejected.get(c).contains(k)) maxNext(m, k + 1) else m)
      maxNext(clientSeqs.get(c), maxNext(fromLog, fromRej))
    })
    all {
      restarts < MAX_RESTARTS,
      srvNext' = rebuilt,
      cli' = CLIENTS.mapBy(c => { ...cli.get(c), connected: false }),
      up' = CLIENTS.mapBy(_ => List()), down' = CLIENTS.mapBy(_ => List()), live' = CLIENTS.mapBy(_ => false),
      restarts' = restarts + 1,
      log' = log, board' = board, clobbered' = clobbered, srvRejected' = srvRejected, ackMismatch' = ackMismatch,
      floor' = floor, compacts' = compacts, clientSeqs' = clientSeqs, baseAt' = baseAt, gapped' = gapped,
    }
  }

  action step = {
    nondet c = CLIENTS.oneOf()
    any { editSet(c), editDelete(c), editRecreate(c), undo(c), serverRecv(c), clientRecv(c), disconnect(c), reconnect(c), freshReload(c), compact, restart }
  }

  // ---- Properties
  // Every transaction is applied at most once.
  val exactlyOnce = log.indices().forall(i => log.indices().forall(j =>
    i < j implies not(log[i].client == log[j].client and log[i].cseq == log[j].cseq)))

  // Nothing a user did vanishes: every created tx is still pending or in the log.
  val noLostEdits = CLIENTS.forall(c => {
    val s = cli.get(c)
    range(0, MAX_TX).foldl(true, (ok, k) =>
      ok and (k >= s.nextCseq or s.pending.indices().exists(i => s.pending[i].cseq == k) or inLog(log, c, k)
              or s.rejected.contains(k)))
  })

  // A client's confirmed board is exactly the server's log prefix it claims to have seen.
  val confirmedIsLogPrefix = CLIENTS.forall(c => {
    val s = cli.get(c)
    s.lastSeq <= log.length() and s.confirmed == applyTxs(INIT_BOARD, log.slice(0, s.lastSeq))
  })

  // When everything is delivered and nobody has pending work, everyone sees the server's board.
  val quiescentConverges = CLIENTS.forall(c => {
    val s = cli.get(c)
    s.connected and up.get(c).length() == 0 and down.get(c).length() == 0 and s.pending.length() == 0
  }) implies CLIENTS.forall(c => cli.get(c).confirmed == board)

  // Undo never overwrites a value its edit did not write (spec §7's promise).
  val noClobber = not(clobbered)

  // A client's own acks arrive in the order of its pending queue (engine finding 3).
  val acksInOrder = not(ackMismatch)

  // A refused transaction never lands, and a client never thinks a landed one was refused.
  val rejectedNeverLogged = CLIENTS.forall(c => cli.get(c).rejected.forall(k => not(inLog(log, c, k))))

  // An honest client's submit is never a sequence gap (the real server would close it, for ever).
  val noGap = not(gapped)

  val safety = noGap and exactlyOnce and noLostEdits and confirmedIsLogPrefix and quiescentConverges and noClobber
    and acksInOrder and rejectedNeverLogged
}
