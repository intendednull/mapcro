// What you select is highlighted in your presence colour, the one your avatar and cursor wear:
// a solid ring with a glow on a hero, the same round a picked objective. Others' picks show in
// theirs (operator, 2026-11-09: "instead of a dotted circle for select, it should highlight the
// thing in your user color").

import { type Browser, type Page, expect, test } from "./fixtures";
import { dragToken, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

/** Join with a chosen presence colour (the join card's swatch). */
async function join(browser: Browser, url: string, name: string, colour: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(url);
  await page.locator("#join-name").fill(name);
  await page.getByTestId("join-card").getByRole("button", { name: `Colour: ${colour}` }).click();
  await page.locator("#join-name").press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return page;
}

// Rose and Lime from the presence palette, as the browser computes them.
const ROSE = "rgb(240, 143, 176)";
const LIME = "rgb(197, 224, 122)";

// The camps patch east of mid on the fallback map (objectives.spec.ts).
const PATCH: [[number, number], [number, number]] = [[0.655, 0.355], [0.728, 0.468]];

test("a selection is highlighted, solid, in the selector's own colour; others' picks in theirs", async ({ browser }) => {
  const url = await newBoardUrl(server, "selection colour");
  const a = await join(browser, url, "Coach", "Rose");
  const b = await join(browser, url, "Marrow", "Lime");
  // My avatar wears the colour the highlight must match.
  await expect(a.locator(".av.ring")).toHaveCSS("background-color", ROSE);

  // A hero: shift-click selects it; its ring is solid, in Rose, with a glow.
  await dragToken(a, "Amber-0", 0.3, 0.6);
  const tok = a.locator('.tok[data-slot="Amber-0"]');
  const bb = (await tok.boundingBox())!;
  await a.keyboard.down("Shift");
  await a.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await a.keyboard.up("Shift");
  const sel = tok.locator(".sel");
  await expect(sel).toHaveCount(1);
  await expect(sel).toHaveCSS("stroke", ROSE);
  await expect(sel).toHaveCSS("stroke-dasharray", "none");
  expect(await sel.evaluate((e) => getComputedStyle(e).filter)).toContain(ROSE);
  await a.locator("[data-testid=map]").screenshot({ path: "shots/selection-colour-hero.png" });

  // Objectives: a marquee over camps picks them; each wears a solid Rose ring.
  await a.keyboard.press("Escape");
  const p0 = await mapPoint(a, ...PATCH[0]);
  const p1 = await mapPoint(a, ...PATCH[1]);
  await a.mouse.move(p0.x, p0.y);
  await a.mouse.down();
  await a.mouse.move(p1.x, p1.y, { steps: 6 });
  await a.mouse.up();
  const picked = a.locator(".mapbox .mk.picked");
  await expect(picked.first()).toBeVisible();
  const ring = await picked.first().evaluate((e) => {
    const s = getComputedStyle(e, "::after");
    return { color: s.borderTopColor, style: s.borderTopStyle, glow: s.boxShadow };
  });
  expect(ring).toEqual({ color: ROSE, style: "solid", glow: expect.stringContaining(ROSE) });
  await a.locator("[data-testid=map]").screenshot({ path: "shots/selection-colour-objectives.png" });

  // The other editor sees them in Coach's colour, not its own.
  const theirs = b.locator('.picks[data-picks="Coach"] .pick-ring').first();
  await expect(theirs).toHaveCSS("stroke", ROSE);
  await expect(theirs).toHaveCSS("stroke-dasharray", "none");
  await expect(b.locator(".av.ring")).toHaveCSS("background-color", LIME);
});
