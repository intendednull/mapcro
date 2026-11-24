# Doorman doorway indicators — demo probe (`142815246`)

Stage 0 ground-truth probe for showing The Doorman's (`hero_id: 69`) placed doors on the minimap in Player and Scenes.

- **Replay:** standard 6v6 (`m_eGameMode == 1`), match `142815246`, build `6865`, duration `1,514.5 s` (25.2 min), winner Amber (`2`), Doorman on Sapphire (`3`, controller `1`, pawn `81`).
- **Probe:** `crates/replay/examples/doorman_door_probe.rs`.
- **Privacy:** no player names or account/Steam IDs were read or recorded.

---

## 1. Entity classes & schema

Scanning all send tables in build `6865` for classes or fields matching `door`, `portal`, or `doorman` yields 13 classes:

| Class | Spawns | Unique indices | Max concurrent / active | Role |
|---|---:|---:|---:|---|
| **`CCitadel_DoorwayPortal`** | **24** | **24** | **2 / 2** | **Primary door entity** (spawned on every door placement, both unpaired and linked) |
| **`CCitadel_Ability_Doorman_Doorway`** | 1 | 1 | 1 / 1 | Doorman's Doorway ability entity (`m_nSubclassID = 109766091`) |
| `CCitadelPortalTrigger` | 20 | 20 | 2 / 2 | Teleport trigger volume; spawns only for linked pairs (10 pairs × 2) |
| `CRenderPortal` | 20 | 20 | 2 / 2 | Portal render surface (`m_hLocalPortalLink`, `m_hRemotePortalLink`); linked pairs only |
| `CInfoPortalLink` | 40 | 38 | 4 / 4 | Portal transform link points (2 per linked door) |
| `CCitadelTriggerNoPortals` | 31 | 31 | 31 / 31 | Static map no-portal volumes |
| `CCitadel_Ability_Doorman_{Bomb,Cart,Hotel}` | 1 each | 1 each | 1 / 1 | Other Doorman abilities |
| `CDoormanBombProjectile` | 78 | 74 | 2 / 2 | Call Bell projectiles |
| `CProjectile_Doorman_Cart_Projectile` | 8 | 8 | 1 / 1 | Luggage Cart projectiles |
| `CBaseDoor`, `CPropDoorRotating` | 0 | 0 | 0 / 0 | Unused generic Source 2 door classes |

Other classes with matching field names: `CCitadelPlayerPawn.m_pMovementServices.m_bInPortalEnvironment` (`bool`), `CCitadelTeam.m_vecFOWEntities..m_bBackdoorProtectionActive` (`bool`), `CEnvCubemap.m_Entity_bIndoorCubeMap` (`bool`).

### Key fields on `CCitadel_DoorwayPortal`

- **World position:** `CBodyComponent.m_skeletonInstance.m_vecOrigin.m_cell{X,Y,Z}` (`uint16`) + `m_vec{X,Y,Z}` (`CNetworkedQuantizedFloat`) — the same `ORIGIN` path as `CCitadelPlayerPawn`, so `parse.rs`'s `Body::of` resolves it automatically.
- **Orientation:** `CBodyComponent.m_skeletonInstance.m_angRotation` (`QAngle(pitch, yaw, roll)`); pitch and roll are `0`, yaw is the door's facing angle in degrees (e.g. `0`, `90`, `102.89`, `233.08`, `270`).
- **Team & owner:** `m_iTeamNum` (`uint8`, `2` = Amber, `3` = Sapphire); `m_hOwnerEntity` (`CHandle<CBaseEntity>`) points to `CCitadel_Ability_Doorman_Doorway` (whose own `m_hOwnerEntity` points to Doorman's `CCitadelPlayerPawn`).
- **Partner link:** `m_hLinkedDoorway` (`CHandle<CCitadel_DoorwayPortal>`) — `0x00FFFFFF` (`16777215`) while unpaired; points to the partner's handle once linked.
- **Timestamps & animation:** `m_flCreateTime` (`GameTime_t`), `CBodyComponent.m_animationController.m_hSequence` (`0` while unpaired, `2` on the tick it links).

### Key fields on `CCitadel_Ability_Doorman_Doorway`

- `m_hDoor1` (`CHandle<CCitadel_DoorwayPortal>`): holds the handle of the currently pending unpaired Door 1 (`0x00FFFFFF` once Door 2 links or Door 1 is cancelled).
- `m_hOwnerEntity` (`CHandle<CBaseEntity>`): Doorman's `CCitadelPlayerPawn`.
- `m_iTeamNum` (`uint8`), `m_nSubclassID` (`109766091` = `token("ability_doorman_doorway")`).
- `m_flCooldownStart`, `m_flCooldownEnd`, `m_iRemainingCharges`, `m_flChargeRechargeStart`, `m_flChargeRechargeEnd`, `m_nUpgradeInfo`, `m_eAbilitySlot` (switches to `46` while a linked pair is open).

---

## 2. Coordinates, orientation & lifecycle

- **Not pooled:** All 24 `CCitadel_DoorwayPortal` spawns had distinct entity indices (`24 spawns, 24 unique_indices, 0 index_reuses`) and `0` `active` transitions (`e.active` stayed `true` from spawn until entity deletion).
- **Unpaired Door 1 exists as a live entity:** Placing the first door immediately spawns a `CCitadel_DoorwayPortal` with `m_hLinkedDoorway == 0x00FFFFFF` and sets `CCitadel_Ability_Doorman_Doorway.m_hDoor1` to its handle. An unpaired door can sit indefinitely (up to **213.11 s** in `142815246`) or be cancelled/replaced before a second door is placed (4 unpaired doors in `142815246`, lasting `1.89 s`, `13.34 s`, `37.31 s`, and `213.11 s`).
- **Linking Door 2:** On the exact tick Door 2 is placed:
  - Door 2 spawns with `m_hLinkedDoorway = handle(Door 1)`.
  - Door 1 updates `m_hLinkedDoorway = handle(Door 2)` and `m_hSequence = 2`.
  - `CCitadel_Ability_Doorman_Doorway.m_hDoor1` resets to `0x00FFFFFF` and cooldown begins (`m_flCooldownEnd = m_flCooldownStart + 45 s`).
- **Start door vs End door (`m_ColorStart` gold vs `m_ColorEnd` blue):** 100% deterministic from `CCitadel_DoorwayPortal` alone (no ability entity needed):
  - Unpaired (`m_hLinkedDoorway == 0x00FFFFFF`) → always **start (`door1`)**.
  - Linked pair → **start (`door1`)** spawned earlier (`m_flCreateTime` strictly smaller, initially unlinked); **end (`door2`)** spawned linked (`m_flCreateTime` larger).
- **Closing / expiry:** Both doors of a linked pair are deleted on the **exact same tick**. Across the 10 linked pairs in `142815246`, linked open durations ranged from **8.12 s to 35.02 s** (9 closed early in `8.12–20.48 s`; 1 ran to full `35.02 s` expiry).
- **Simultaneous doors:** At most **2** (`1` pair) simultaneously in `142815246`. Because linking is carried pairwise via `m_hLinkedDoorway`, tracking by entity index/handle naturally handles multiple simultaneous pairs if Refresher / Echo Shard or future patches allow >2.

### Full door lifecycle summary (`142815246`, 24 doors = 10 pairs + 4 unpaired)

| Entity | Role | Spawn (s) | Linked (s) | Deleted (s) | Total (s) | Open (s) | Partner | Yaw (°) | Enemy FOW flips |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 3361 | door1 | 143.34 | 195.53 | 206.17 | 62.83 | 10.64 | 3472 | 270.0 | 28 |
| 3472 | door2 | 195.53 | 195.53 | 206.17 | 10.64 | 10.64 | 3361 | 270.0 | 2 |
| 3452 | door1 | 313.64 | 326.52 | 334.94 | 21.30 | 8.42 | 3474 | 102.9 | 2 |
| 3474 | door2 | 326.52 | 326.52 | 334.94 | 8.42 | 8.42 | 3452 | 0.0 | 2 |
| 3457 | unpaired | 407.30 | — | 409.19 | 1.89 | 0.00 | — | 232.5 | 1 (never seen) |
| 3462 | unpaired | 411.64 | — | 448.95 | 37.31 | 0.00 | — | 233.1 | 1 (never seen) |
| 3555 | unpaired | 456.81 | — | 669.92 | 213.11 | 0.00 | — | 233.1 | 3 |
| 3493 | door1 | 689.09 | 787.03 | 795.36 | 106.27 | 8.33 | 3497 | 233.1 | 5 |
| 3497 | door2 | 787.03 | 787.03 | 795.36 | 8.33 | 8.33 | 3493 | 0.0 | 3 |
| 3631 | door1 | 833.28 | 864.09 | 875.45 | 42.17 | 11.36 | 3674 | 0.0 | 8 |
| 3674 | door2 | 864.09 | 864.09 | 875.45 | 11.36 | 11.36 | 3631 | 90.0 | 8 |
| 3903 | door1 | 946.61 | 948.27 | 968.75 | 22.14 | 20.48 | 3904 | 120.0 | 5 |
| 3904 | door2 | 948.27 | 948.27 | 968.75 | 20.48 | 20.48 | 3903 | 0.0 | 5 |
| 4073 | door1 | 1013.28 | 1113.56 | 1124.72 | 111.44 | 11.16 | 3870 | 233.1 | 13 |
| 3870 | door2 | 1113.56 | 1113.56 | 1124.72 | 11.16 | 11.16 | 4073 | 270.0 | 3 |
| 3995 | door1 | 1169.67 | 1191.89 | 1202.34 | 32.67 | 10.45 | 4052 | 157.1 | 6 |
| 4052 | door2 | 1191.89 | 1191.89 | 1202.34 | 10.45 | 10.45 | 3995 | 90.0 | 2 |
| 3618 | door1 | 1238.19 | 1240.31 | 1248.67 | 10.48 | 8.36 | 3619 | 0.0 | 5 |
| 3619 | door2 | 1240.31 | 1240.31 | 1248.67 | 8.36 | 8.36 | 3618 | 268.6 | 5 |
| 3777 | door1 | 1286.89 | 1298.69 | 1306.81 | 19.92 | 8.12 | 3798 | 270.0 | 4 |
| 3798 | door2 | 1298.69 | 1298.69 | 1306.81 | 8.12 | 8.12 | 3777 | 232.5 | 2 |
| 3973 | door1 | 1393.97 | 1416.88 | 1451.89 | 57.92 | 35.02 | 3198 | 92.9 | 1 (never seen) |
| 3198 | door2 | 1416.88 | 1416.88 | 1451.89 | 35.02 | 35.02 | 3973 | 179.7 | 1 (never seen) |
| 3596 | unpaired | 1466.17 | — | 1479.52 | 13.34 | 0.00 | — | 163.3 | 2 |

---

## 3. Team ownership & Vision / Fog-of-War (`CCitadelTeam.m_vecFOWEntities`)

- **Team ownership:** Directly on `CCitadel_DoorwayPortal.m_iTeamNum` (`2` = Amber, `3` = Sapphire).
- **Tracked in `CCitadelTeam.m_vecFOWEntities`:** **Yes** — every `CCitadel_DoorwayPortal` appears in **both** teams' `m_vecFOWEntities` with **`m_eClass == 88`** (`113,298` tick-entries across the match).
  - **Own team (`observer == door.team`):** `m_bVisibleOnMap` is `true` from the spawn tick until deletion (`0` flips to `false` across all 24 doors).
  - **Enemy team (`observer != door.team`):** `m_bVisibleOnMap` starts `false` on spawn and dynamically flips **both ways** (`52` `false → true`, `41` `true → false` across the match). It is real-time line-of-sight visibility, not sticky.
  - **Linked pairs share enemy visibility:** Once linked, both doors in a pair flip `m_bVisibleOnMap` on the **exact same tick** (e.g., `3631`/`3674` at `864.61`, `866.11`, `866.63`, `869.11`, `872.11`, `873.61`, `874.13`; `3903`/`3904` at `965.77`, `967.13`, `967.64`). While unpaired, `door1` has its own independent enemy visibility.
  - **`m_eHeight` & `m_strCSSClass`:** `m_eHeight` is always `0` and `m_strCSSClass` is always `""` on `CCitadel_DoorwayPortal` FOW entries.
- **Gotcha:** `m_eClass == 88` is shared with at least one other entity class (`136,780` undecoded entries vs `113,298` `CCitadel_DoorwayPortal` entries in `142815246`). `vision_tick` MUST match by live `CCitadel_DoorwayPortal` entity index (just as hero FOW matches by `by_pawn`), never by `m_eClass == 88` alone.

---

## 4. User messages & `ActiveModifiers`

- **`CCitadelUserMsgEntityPortalled` (msg 361):** Fired only **2 times** in the entire match (once for an undecoded entity at `328.77 s`, once for `CProjectile_Doorman_Cart_Projectile` at `1305.61 s`). Does **not** fire reliably for hero passages or door lifecycle; do not use it for door tracking.
- **`ImportantAbilityUsed` (msg 365):** Fired `27` times for `ability_doorman_doorway` (the 24 placements + 3 unpaired cancels). `ability_doorman_doorway_close` did not appear as a msg 365 name.
- **`ActiveModifiers`:**
  - `501123431` (`ability_doorman_doorway/doorway_timer_modifier`, `duration: 35.0`): applied on Doorman's pawn when a pair links (`10` applications = `10` pairs), removed on the exact tick the pair closes/expires.
  - `1565439257` (unnamed, `ability_subclass = 109766091`): applied on every unpaired Door 1 (`parent = caster = CCitadel_DoorwayPortal`, `14` applications = `10 door1 + 4 unpaired`), removed on the exact tick it links or is deleted.
  - `1901997407` (`ability_doorman_doorway/doorway_barrier`, `duration: 12.0`): applied on Doorman's pawn when passing through a doorway (`5` applications).
  - `2693099904` (unnamed engine modifier, `ability_subclass = 0`, `duration: 6.0`): `1` application on a `CCitadel_DoorwayPortal`.

---

## 5. Timeline size & encoding implications

- Across a full 25.2-minute 6v6 match with Doorman: **24 doors** (`10` linked pairs + `4` unpaired), **117** enemy FOW flip entries (`52` on, `41` off, `24` initial `false`).
- A per-door interval record (`id`, `team`, `x`, `y`, `start`, `link`, `end`, `partner`, `seen: [[t0, t1], …]` at tenths of a second) serializes to **3,243 bytes (~3.2 KB) raw JSON** — under 0.2% of a ~1.8 MB raw timeline, and **0 bytes** (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) for matches without Doorman.
- **Recommendation for Stage 1:**
  - Track `CCitadel_DoorwayPortal` directly in `parse.rs` (only 24 entities/match, negligible memory; add to `classes` alongside `KOTH`/`IDOL`).
  - Record enemy `m_bVisibleOnMap` flips in `vision_tick` by matching live `CCitadel_DoorwayPortal` entity indices → derive `seen` intervals (same tenth-second interval representation as `players[].seen`).
  - Store `doors` as a top-level interval array in `Timeline` (each door carries `team`, `x`, `y`, `start`, `link` optional, `end`, `role`/`partner`, and `seen`). No ability-entity or modifier tracking is required to reconstruct complete door state, start/end color, or FOW visibility.
