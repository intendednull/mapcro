// Share (design/v1-board/share-dialog*.html): mint view or edit links with a label; see the
// links you made (the owner sees all), as a tree. No revocation in the UI (spec §11): the
// footer offers Clone instead.

import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { cx } from "../ui/cx";
import { linkIdOf, linkTree, mintedTokens, rememberMinted } from "./share";

const X = '<path d="M6 6l12 12M18 6L6 18"/>';
const KEY_ICO = '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>';
const COPY = '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>';
const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function ShareDialog(p: { board: string; token: string; role: "owner" | "edit"; onClose: () => void; onClone: () => void }) {
  const api = new Api("");
  const [label, setLabel] = createSignal("");
  const [role, setRole] = createSignal<"view" | "edit">("view");
  const [minted, setMinted] = createSignal<{ url: string; role: "view" | "edit" }>();
  const [copied, setCopied] = createSignal<string>();
  const [error, setError] = createSignal("");
  const [mine] = createResource(() => linkIdOf(p.token));
  const [links, { refetch }] = createResource(() => api.listLinks(p.board, p.token));
  const rows = () => (mine() && links() ? linkTree(links()!, mine()!) : []);
  const tokens = () => (links(), mintedTokens(p.board));
  let input!: HTMLInputElement;
  onMount(() => input.focus());

  const mint = async (e: Event) => {
    e.preventDefault();
    setError("");
    try {
      const r = role();
      const { link_id, token } = await api.mintLink(p.board, p.token, r, label().trim());
      rememberMinted(p.board, link_id, token);
      setMinted({ url: shareUrl(location.origin, p.board, token), role: r });
      setLabel("");
      void refetch();
    } catch (err) {
      setError(`Couldn't make the link: ${String(err)}`);
    }
  };
  const doCopy = async (key: string, url: string) => {
    if (await copy(url)) setCopied(key);
  };

  return (
    <div class="scrim" data-testid="share-dialog" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog" role="dialog" aria-labelledby="share-h" onKeyDown={(e) => e.key === "Escape" && p.onClose()}>
        <header>
          <div>
            <h2 id="share-h">Share this board</h2>
            <p>
              {p.role === "owner"
                ? "You own this board, so you see every link, including the ones editors shared onward. A link is the only way in: there are no accounts or passwords."
                : "You're on an edit link, so you can share this board onward. You see the links you made and the ones shared from them; the owner sees every link."}
            </p>
          </div>
          <button class="x" aria-label="Close" onClick={() => p.onClose()}>
            <Ico d={X} />
          </button>
        </header>
        <div class="body">
          <h3>New link</h3>
          <form class="mint" onSubmit={mint}>
            <div class="field">
              <label for="mint-label">Label, so you know who has it</label>
              <input
                ref={input}
                id="mint-label"
                class="input"
                maxLength={40}
                placeholder="e.g. Night Owls scrim, coaches"
                value={label()}
                onInput={(e) => setLabel(e.currentTarget.value)}
              />
            </div>
            <div class="seg role" role="radiogroup" aria-label="What the link can do">
              <button type="button" class={cx(role() === "view" && "on")} aria-pressed={role() === "view"} onClick={() => setRole("view")}>
                View only
              </button>
              <button type="button" class={cx(role() === "edit" && "on")} aria-pressed={role() === "edit"} onClick={() => setRole("edit")}>
                Can edit
              </button>
            </div>
            <button class="btn primary" style={{ height: "36px" }} type="submit" data-testid="mint">
              Create link
            </button>
          </form>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
          <Show when={minted()}>
            {(m) => (
              <div class="minted" data-testid="minted">
                <div class="row">
                  <span class="url" data-testid="minted-url">
                    {m().url.split("#")[0]}
                    <span class="frag">#{m().url.split("#")[1]}</span>
                  </span>
                  <button class="btn small" onClick={() => doCopy("minted", m().url)}>
                    <Ico d={COPY} />
                    {copied() === "minted" ? "Copied" : "Copy link"}
                  </button>
                </div>
                <div class="key">
                  <Ico d={KEY_ICO} />
                  <span>
                    <b>This link is the key.</b>{" "}
                    {m().role === "edit"
                      ? "Anyone who has it can edit this board, with no sign-in, and share it onward. Send it only to the people you mean."
                      : "Anyone who has it can watch this board live, with no sign-in. Send it only to the people you mean."}
                  </span>
                </div>
              </div>
            )}
          </Show>
          <div class="links" data-testid="link-list">
            <h3>
              {p.role === "owner" ? "All links on this board" : "Links you've made"}{" "}
              <small>{p.role === "owner" ? "you see every link because you own it" : "and the ones shared from them"}</small>
            </h3>
            <Show when={rows().length === 0 && !links.loading}>
              <p class="muted">No links yet.</p>
            </Show>
            <For each={rows()}>
              {(r) => {
                const token = () => tokens()[r.link.link_id];
                return (
                  <div class={cx("link-row", r.depth > 0 && "child", r.link.revoked && "revoked")} style={{ "--depth": String(r.depth) }} data-link={r.link.label}>
                    <div class="lb">
                      <b>{r.link.label || "Unlabelled link"}</b>{" "}
                      <span class={cx("badge", r.link.role)}>{r.link.role === "edit" ? "Can edit" : "View only"}</span>
                      <div>{r.mine ? `Made by you, ${day(r.link.created_at)}` : `Shared${r.from ? ` from “${r.from}”` : ""}, ${day(r.link.created_at)}`}</div>
                    </div>
                    <Show when={token()} fallback={<span />}>
                      <button class="btn small ghost" onClick={() => doCopy(r.link.link_id, shareUrl(location.origin, p.board, token()!))}>
                        <Ico d={COPY} />
                        {copied() === r.link.link_id ? "Copied" : "Copy"}
                      </button>
                    </Show>
                    <span />
                  </div>
                );
              }}
            </For>
          </div>
        </div>
        <footer>
          <span>
            {p.role === "owner"
              ? "Links can't be taken back. To stop sharing with someone, clone the board and don't send them the new link."
              : "Links can't be taken back. To start fresh with a different group, clone the board: you'll own the copy."}
          </span>
          <button class="btn small" data-testid="share-clone" onClick={() => p.onClone()}>
            Clone to a new board
          </button>
        </footer>
      </div>
    </div>
  );
}
