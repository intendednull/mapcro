// mapcro sync protocol: a deliberately small model of spec §3–§7.
//
// What it models: one record with fields, a server-ordered op log, optimistic clients with
// pending queues, WebSocket connections (FIFO while up; a disconnect loses everything in
// flight), reconnect with `hello(lastSeq)` + resend of pending work, and per-user undo.
// What it leaves out on purpose: game data, scenes, many records, validation/rejection,
// presence, persistence. Those don't change whether the protocol converges.
module sync {
  // Design switches, so the spec as first written and each fix can be checked side by side.
  // LIVE_AFTER_HELLO: the server sends live broadcasts on a connection only once it has
  //   processed that connection's hello (and sent its catch-up).
  // SERVER_SIDE_UNDO: undo sends conditional ops that the *server* evaluates at apply time
  //   (set-if-still-equal, restore-if-still-deleted), rather than a plain write decided on the client.
  const LIVE_AFTER_HELLO: bool
  const SERVER_SIDE_UNDO: bool

  type ClientId = str

  // ---- Scope. Small on purpose: protocol bugs show up with two clients and a few ops.
  pure val CLIENTS: Set[ClientId] = Set("a", "b")
  pure val FIELDS: Set[str] = Set("x")
  pure val VALUES: Set[int] = Set(1, 2)
  pure val MAX_TX = 3      // transactions (edits + undos) each client may create
  pure val MAX_DROPS = 1   // disconnects per client
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
  }

  // ---- Wire messages
  type Up = | Hello(int) | Submit(Tx)
  type Entry = { seq: int, tx: Tx }   // server -> client: the tx at log position `seq`

  // ---- State
  var log: List[Tx]                    // the server's ordered truth
  var board: Board                     // the server's board = applyTxs(INIT_BOARD, log)
  var cli: ClientId -> ClientState
  var up: ClientId -> List[Up]         // client -> server, in flight
  var down: ClientId -> List[Entry]    // server -> client, in flight
  var live: ClientId -> bool           // server side: may this connection get broadcasts?
  var clobbered: bool                  // ghost: an undo overwrote a value it did not write

  def view(c: ClientId): Board = applyTxs(cli.get(c).confirmed, cli.get(c).pending)
  pure def inLog(l: List[Tx], c: ClientId, k: int): bool =
    l.indices().exists(i => l[i].client == c and l[i].cseq == k)

  action init = all {
    log' = List(),
    board' = INIT_BOARD,
    cli' = CLIENTS.mapBy(_ => {
      confirmed: INIT_BOARD, lastSeq: 0, pending: List(), nextCseq: 0,
      undoStack: List(), connected: true, drops: 0,
    }),
    up' = CLIENTS.mapBy(_ => List()),
    down' = CLIENTS.mapBy(_ => List()),
    live' = CLIENTS.mapBy(_ => true),
    clobbered' = false,
  }

  // ---- Client: create a transaction (optimistic; sent now if connected, else on reconnect)
  action submit(c: ClientId, op: Op, isUndo: bool, undoExpect: int, stack: List[UndoEntry]): bool = {
    val s = cli.get(c)
    val tx = { client: c, cseq: s.nextCseq, op: op, isUndo: isUndo, undoExpect: undoExpect }
    all {
      s.nextCseq < MAX_TX,
      cli' = cli.set(c, { ...s, pending: s.pending.append(tx), nextCseq: s.nextCseq + 1, undoStack: stack }),
      up' = if (s.connected) up.setBy(c, q => q.append(Submit(tx))) else up,
      down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered,
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
              up' = up, down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered,
            }
        | UndoDelete(fs) =>
            if (SERVER_SIDE_UNDO) submit(c, Restore, true, -1, rest)
            else if (not(b.exists)) submit(c, Create(fs), true, -1, rest)
            else all {
              cli' = cli.set(c, { ...s, undoStack: rest }),
              up' = up, down' = down, log' = log, board' = board, live' = live, clobbered' = clobbered,
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
        | Hello(n) => all {
            // catch-up: everything after the client's lastSeq
            down' = down.setBy(c, d => d.concat(
              range(0, MAX_LOG).foldl(List(), (acc, i) =>
                if (i >= n and i < log.length()) acc.append({ seq: i + 1, tx: log[i] }) else acc))),
            up' = up.set(c, q.tail()),
            live' = live.set(c, true),
            log' = log, board' = board, cli' = cli, clobbered' = clobbered,
          }
        | Submit(tx) =>
            if (inLog(log, tx.client, tx.cseq)) all {   // duplicate after reconnect: ignore
              up' = up.set(c, q.tail()),
              down' = down, log' = log, board' = board, cli' = cli, live' = live, clobbered' = clobbered,
            } else {
              val e = { seq: log.length() + 1, tx: tx }
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
      val e = d[0]
      val acked = e.tx.client == c and s.pending.length() > 0 and s.pending[0].cseq == e.tx.cseq
      all {
        cli' = cli.set(c, { ...s,
          confirmed: applyOp(s.confirmed, e.tx.op),
          lastSeq: e.seq,
          pending: if (acked) s.pending.tail() else s.pending,
        }),
        down' = down.set(c, d.tail()),
        up' = up, log' = log, board' = board, live' = live, clobbered' = clobbered,
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
      log' = log, board' = board, clobbered' = clobbered,
    }
  }

  // spec §5: hello(lastSeq), then resend all pending work
  action reconnect(c: ClientId): bool = {
    val s = cli.get(c)
    all {
      not(s.connected),
      cli' = cli.set(c, { ...s, connected: true }),
      live' = live,   // not live until the server processes the hello (if LIVE_AFTER_HELLO)
      up' = up.set(c, List(Hello(s.lastSeq)).concat(s.pending.foldl(List(), (acc, t) => acc.append(Submit(t))))),
      down' = down, log' = log, board' = board, clobbered' = clobbered,
    }
  }

  action step = {
    nondet c = CLIENTS.oneOf()
    any { editSet(c), editDelete(c), undo(c), serverRecv(c), clientRecv(c), disconnect(c), reconnect(c) }
  }

  // ---- Properties
  // Every transaction is applied at most once.
  val exactlyOnce = log.indices().forall(i => log.indices().forall(j =>
    i < j implies not(log[i].client == log[j].client and log[i].cseq == log[j].cseq)))

  // Nothing a user did vanishes: every created tx is still pending or in the log.
  val noLostEdits = CLIENTS.forall(c => {
    val s = cli.get(c)
    range(0, MAX_TX).foldl(true, (ok, k) =>
      ok and (k >= s.nextCseq or s.pending.indices().exists(i => s.pending[i].cseq == k) or inLog(log, c, k)))
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

  val safety = exactlyOnce and noLostEdits and confirmedIsLogPrefix and quiescentConverges and noClobber
}
