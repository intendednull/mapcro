import { describe, expect, it } from "vitest";
import type { LinkInfo } from "../src/core/api";
import { linkIdOf, linkTree } from "../src/board/share";

const l = (link_id: string, role: LinkInfo["role"], minted_by: string | null, t: number, label = link_id): LinkInfo => ({
  link_id, role, label, created_at: t, revoked: false, minted_by,
});

describe("share dialog link tree", () => {
  const rows = [l("own", "owner", null, 0), l("team", "edit", "own", 1), l("vod", "view", "own", 4), l("juno", "edit", "team", 2), l("sub", "view", "juno", 3)];
  it("owner: every link, nested under the one it was shared from, owner link hidden", () => {
    expect(linkTree(rows, "own").map((r) => [r.link.link_id, r.depth, r.from ?? "-", r.mine])).toEqual([
      ["team", 0, "-", true],
      ["juno", 1, "team", false],
      ["sub", 2, "juno", false],
      ["vod", 0, "-", true],
    ]);
  });
  it("editor: its subtree, its own link as the root (the server sends only that subtree)", () => {
    const sub = [l("juno", "edit", "team", 2), l("sub", "view", "juno", 3)];
    expect(linkTree(sub, "team").map((r) => [r.link.link_id, r.depth, r.mine])).toEqual([["juno", 0, true], ["sub", 1, false]]);
  });
  it("link ids match the server's (first 16 hex of SHA-256)", async () => {
    // sha256("abc") = ba7816bf8f01cfea...
    expect(await linkIdOf("abc")).toBe("ba7816bf8f01cfea");
  });
});
