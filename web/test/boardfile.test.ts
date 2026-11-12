import { describe, expect, it } from "vitest";
import { fileName, isBoardFile, refusalTag } from "../src/core/boardfile";

describe("board files", () => {
  it("are named after the board, safely", () => {
    expect(fileName("Scrim prep")).toBe("Scrim prep.mapcro.json");
    expect(fileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j.mapcro.json");
    expect(fileName("../../etc/passwd")).toBe("_.._etc_passwd.mapcro.json");
    expect(fileName("  ...  ")).toBe("board.mapcro.json");
    expect(fileName("x".repeat(200))).toBe(`${"x".repeat(80)}.mapcro.json`);
  });

  it("are told from replays", () => {
    expect(isBoardFile("Scrim prep.mapcro.json")).toBe(true);
    expect(isBoardFile("BOARD.JSON")).toBe(true);
    expect(isBoardFile("130816395.dem")).toBe(false);
  });

  it("refusals are tags", () => {
    expect(refusalTag(422, "newer")).toBe("Newer file");
    expect(refusalTag(413)).toBe("Too large");
    expect(refusalTag(413, "too_large")).toBe("Too large");
    expect(refusalTag(400, "not_a_board")).toBe("Not a board");
    expect(refusalTag(422, "invalid")).toBe("Bad file");
    expect(refusalTag(400, "too_deep")).toBe("Bad file");
    expect(refusalTag(429, "rate_limited")).toBe("Try later");
    expect(refusalTag(507)).toBe("Server full");
    expect(refusalTag(500)).toBe("Failed");
  });
});
