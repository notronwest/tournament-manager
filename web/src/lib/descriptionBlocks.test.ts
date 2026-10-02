import { describe, expect, it } from "vitest";
import { parseDescription } from "./descriptionBlocks";

const LEAF_PEEPER = `The Leaves Are Falling, but the Competition is Rising!
Join us October 2nd–4th for the 2nd Annual Leaf Peeping Pickleball Tournament at White Mountain Pickleball Club—a full weekend of competition.
Tournament Details:
📆 Dates: Friday, October 2nd – Sunday, October 4th
📍 Location: White Mountain Pickleball Club – Lincoln, NH
💰 Registration (includes 1 event):
$65 Early Bird through Sept 1st — $75 after
$20 for each additional event
WMPC Members save $5 (ask about the member code)
Divisions:
🏆 Friday: Singles
💵 Sunday: Open Division (Cash) — purse up to $1,500, scaling with the field (12 teams = full $1,500 purse)
Skill Levels:
3.0–3.5
4.0+
Open
(Note: Divisions may be merged if minimum registration is not met.)
What to Expect:
✓ Multiple guaranteed matches – more play, more fun
✔ Prizes, medals, and major bragging rights
Don't miss this unique opportunity to play pickleball indoors while the mountains glow outside. Register today—spots will go fast!`;

describe("parseDescription", () => {
  const blocks = parseDescription(LEAF_PEEPER);

  it("keeps the intro as paragraphs", () => {
    expect(blocks[0]).toEqual({ kind: "paragraph", text: "The Leaves Are Falling, but the Competition is Rising!" });
    expect(blocks[1].kind).toBe("paragraph");
  });

  it("detects headings", () => {
    const headings = blocks.filter((b) => b.kind === "heading").map((b) => b.kind === "heading" && b.text);
    expect(headings).toEqual(["Tournament Details", "Divisions", "Skill Levels", "What to Expect"]);
  });

  it("nests short lines under an emoji item ending in a colon", () => {
    const list = blocks[3];
    expect(list.kind).toBe("list");
    if (list.kind !== "list") return;
    expect(list.items).toHaveLength(3);
    expect(list.items[0]).toEqual({ marker: "📆", text: "Dates: Friday, October 2nd – Sunday, October 4th", children: [] });
    expect(list.items[2].marker).toBe("💰");
    expect(list.items[2].children).toEqual([
      "$65 Early Bird through Sept 1st — $75 after",
      "$20 for each additional event",
      "WMPC Members save $5 (ask about the member code)",
    ]);
  });

  it("turns short lines under a heading into a plain list, notes into note paragraphs", () => {
    const i = blocks.findIndex((b) => b.kind === "heading" && b.text === "Skill Levels");
    const list = blocks[i + 1];
    expect(list.kind === "list" && list.items.map((it) => [it.marker, it.text])).toEqual([
      [null, "3.0–3.5"], [null, "4.0+"], [null, "Open"],
    ]);
    expect(blocks[i + 2]).toMatchObject({ kind: "paragraph", note: true });
  });

  it("handles check marks and a long closing paragraph", () => {
    const last = blocks[blocks.length - 1];
    expect(last.kind).toBe("paragraph");
    const checks = blocks[blocks.length - 2];
    expect(checks.kind === "list" && checks.items.map((it) => it.marker)).toEqual(["✓", "✔"]);
  });

  it("supports markdown dashes and blank-line paragraphs", () => {
    expect(parseDescription("Hello there.\n\n- one\n- two")).toEqual([
      { kind: "paragraph", text: "Hello there." },
      { kind: "list", items: [
        { marker: "•", text: "one", children: [] },
        { marker: "•", text: "two", children: [] },
      ] },
    ]);
  });
});
