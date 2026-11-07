// Presence in the chrome (spec §8): others' cursors on the map, the people list with one-click
// Follow, the follow chip in the header, and the "presenting" pill for whoever is followed.

import { For, Show } from "solid-js";
import { colorOf } from "../core/device";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import { type Viewpoint, worldToView } from "../map/transform";
import { cx } from "../ui/cx";
import { followable } from "./follow";

const letter = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
const nameOf = (p: PeerPresence) => p.state?.name || "Joining";

export function Avatar(p: { name: string; color: number; sm?: boolean; title?: string }) {
  return (
    <span class={cx("av", p.sm && "sm")} style={{ background: colorOf(p.color) }} title={p.title ?? p.name}>
      {letter(p.name)}
    </span>
  );
}

const EYE = '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>';
const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

/** Others' cursors, only for people looking at the same scene. */
export function Cursors(p: { peers: PeerPresence[]; scene: RecordId | undefined; vp: Viewpoint; k: number }) {
  const shown = () => p.peers.filter((x) => x.state?.cursor && x.state.scene === p.scene && !x.state.drag && x.state.laser.length === 0);
  return (
    <g class="cursors">
      <For each={shown()}>
        {(x) => {
          const at = () => worldToView(x.state!.cursor!, p.vp);
          const name = () => nameOf(x);
          return (
            <g class="cur" data-cursor={name()} transform={`translate(${at().x} ${at().y}) scale(${1.2 * p.k})`} style={{ "pointer-events": "none" }}>
              <path d="M0 0 L0 24 L6.5 18 L11 28 L15 26 L10.5 16.5 L19 16 Z" fill={colorOf(x.state!.color)} />
              <rect x="16" y="24" width={name().length * 7.6 + 18} height="22" fill={colorOf(x.state!.color)} />
              <text x="25" y="35">
                {name()}
              </text>
            </g>
          );
        }}
      </For>
    </g>
  );
}

/** The header chip: who you follow (Stop), or who is presenting (Follow, key F). */
export function FollowChip(p: {
  following: PeerPresence | undefined;
  presenters: Array<{ peer: PeerPresence; followers: number }>;
  sceneLabel: (scene: RecordId | null | undefined) => string;
  follow: (peer: number) => void;
  stop: () => void;
}) {
  const others = () => p.presenters.filter((x) => x.peer.peer !== p.following?.peer);
  const lead = () => (p.following ? undefined : others()[0]);
  const also = () => (p.following ? others() : others().slice(1));
  return (
    <Show when={p.following || lead()}>
      <div class={cx("follow-chip", p.following && "on")} data-testid="follow-chip">
        <Show
          when={p.following}
          fallback={
            <>
              <Avatar name={nameOf(lead()!.peer)} color={lead()!.peer.state!.color} sm />
              <span>
                <b>{nameOf(lead()!.peer)}</b> is presenting
              </span>
              <span class="where">{p.sceneLabel(lead()!.peer.state?.scene)}</span>
              <button class="follow" data-testid="follow-presenter" onClick={() => p.follow(lead()!.peer.peer)}>
                <Ico d={EYE} />
                Follow <kbd>F</kbd>
              </button>
            </>
          }
        >
          {(f) => (
            <>
              <Ico d={EYE} />
              <Avatar name={nameOf(f())} color={f().state!.color} sm />
              <span>
                <b>Following {nameOf(f())}</b>
              </span>
              <span class="where">{p.sceneLabel(f().state?.scene)}</span>
              <button class="link" data-testid="stop-following" onClick={() => p.stop()}>
                Stop
              </button>
            </>
          )}
        </Show>
        <Show when={also().length > 0}>
          <span class="chip-sep" />
          <span class="also">Also presenting</span>
          <For each={also()}>
            {(x) => (
              <button class="switch" onClick={() => p.follow(x.peer.peer)}>
                <Avatar name={nameOf(x.peer)} color={x.peer.state!.color} sm />
                {nameOf(x.peer)}
              </button>
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}

export function PresentingPill(p: { followers: number }) {
  return (
    <Show when={p.followers > 0}>
      <div class="present-pill" data-testid="presenting">
        <span class="live" />
        Presenting
        <span class="count">{p.followers} following</span>
      </div>
    </Show>
  );
}

export function PeopleList(p: {
  me: { name: string; color: number } | undefined;
  myRole: string | undefined;
  myPeer: number | undefined;
  peers: PeerPresence[];
  following: number | undefined;
  followersOf: (peer: number | undefined) => number;
  sceneLabel: (scene: RecordId | null | undefined) => string;
  follow: (peer: number) => void;
  stop: () => void;
  rename: () => void;
}) {
  const nameById = (id: number | null | undefined) =>
    id == null ? undefined : id === p.myPeer ? "you" : (p.peers.find((x) => x.peer === id)?.state?.name ?? "someone");
  const doing = (x: PeerPresence) => {
    const s = x.state!;
    const parts: string[] = [];
    const n = p.followersOf(x.peer);
    if (n > 0) parts.push(`presenting, ${p.sceneLabel(s.scene)}`);
    if (s.following != null) parts.push(`following ${nameById(s.following)}`);
    if (s.drag) parts.push("moving");
    else if (s.laser.length) parts.push("laser");
    return parts.join(" · ");
  };
  const myState = () => {
    const n = p.followersOf(p.myPeer);
    if (n > 0) return "presenting";
    if (p.following !== undefined) return `following ${nameById(p.following)}`;
    return "";
  };
  return (
    <div class="people" data-testid="people">
      <Show when={p.me}>
        <div class="person" data-person="me">
          <Avatar name={p.me!.name} color={p.me!.color} />
          <span class="nm">
            <b>
              {p.me!.name} <span class="you-tag">(you)</span>
            </b>
            <span class={cx("state", myState().startsWith("following") && "following", myState() === "presenting" && "presenting")}>
              {myState() || (p.myRole === "view" ? "view only" : p.myRole ?? "")}
            </span>
          </span>
          <button class="pf-btn ghost" data-testid="rename" onClick={() => p.rename()}>
            Name
          </button>
        </div>
      </Show>
      <For each={p.peers}>
        {(x) => (
          <div class="person" data-person={nameOf(x)} data-focus={x.state?.focus ?? ""}>
            <Avatar name={nameOf(x)} color={x.state!.color} />
            <span class="nm">
              <b>{nameOf(x)}</b>
              <span class={cx("state", doing(x).includes("following") && "following", doing(x).startsWith("presenting") && "presenting")}>
                {doing(x)}
              </span>
            </span>
            <Show when={followable(x)} fallback={<span class="nofollow">view only</span>}>
              <button
                class={cx("pf-btn", p.following === x.peer && "on")}
                data-testid={`follow-${nameOf(x)}`}
                aria-pressed={p.following === x.peer}
                onClick={() => (p.following === x.peer ? p.stop() : p.follow(x.peer))}
              >
                {p.following === x.peer ? "Following" : "Follow"}
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
