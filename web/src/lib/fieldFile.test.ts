import { describe, it, expect } from "vitest";
import {
  buildFieldFile,
  parseFieldFile,
  fieldFilename,
  type SourceEvent,
  type SourceReg,
} from "./fieldFile";

const player = (first: string, last: string, email: string | null = null) => ({
  first_name: first,
  last_name: last,
  email,
  phone: null,
  city: null,
  state: null,
  gender: null,
  dob: null,
});

describe("buildFieldFile", () => {
  const events: SourceEvent[] = [
    { id: "e1", name: "Mixed 3.5", format: "doubles", gender: "mixed" },
    { id: "e2", name: "Men's 4.0", format: "singles", gender: "men" },
  ];

  const regsByEvent = new Map<string, SourceReg[]>([
    [
      "e1",
      [
        {
          id: "r1",
          partner_registration_id: "r2",
          status: "paid",
          seed: 1,
          player: player("Ada", "Lovelace", "ada@x.com"),
        },
        {
          id: "r2",
          partner_registration_id: "r1",
          status: "paid",
          seed: null,
          player: player("Grace", "Hopper"),
        },
        {
          id: "r3",
          partner_registration_id: null,
          status: "withdrawn",
          seed: null,
          player: player("Gone", "Away"),
        },
      ],
    ],
    [
      "e2",
      [
        {
          id: "r4",
          partner_registration_id: null,
          status: "paid",
          seed: 2,
          player: player("Alan", "Turing"),
        },
      ],
    ],
  ]);

  const file = buildFieldFile(
    "Summer Slam",
    new Date("2026-09-09T12:00:00Z"),
    events,
    regsByEvent,
  );

  it("pairs doubles partners into one team, keeping the pair's seed", () => {
    const mixed = file.events.find((e) => e.name === "Mixed 3.5");
    expect(mixed?.teams).toHaveLength(1);
    expect(mixed?.teams[0].players.map((p) => p.first_name)).toEqual([
      "Ada",
      "Grace",
    ]);
    expect(mixed?.teams[0].seed).toBe(1);
  });

  it("drops withdrawn/cancelled/refunded registrations", () => {
    const mixed = file.events.find((e) => e.name === "Mixed 3.5");
    const names = mixed?.teams.flatMap((t) => t.players.map((p) => p.first_name));
    expect(names).not.toContain("Gone");
  });

  it("keeps singles teams as one player", () => {
    const mens = file.events.find((e) => e.name === "Men's 4.0");
    expect(mens?.teams).toEqual([
      { seed: 2, players: [player("Alan", "Turing")] },
    ]);
  });

  it("round-trips through parseFieldFile", () => {
    const parsed = parseFieldFile(JSON.stringify(file));
    expect(parsed).toEqual(file);
  });
});

describe("parseFieldFile", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseFieldFile("not json")).toThrow(/valid JSON/);
  });

  it("rejects a well-formed JSON that isn't a field file", () => {
    expect(() => parseFieldFile(JSON.stringify({ hello: "world" }))).toThrow(
      /locked-field format/,
    );
  });

  it("rejects a team with a player missing a first name", () => {
    const bad = {
      formatVersion: 1,
      exportedAt: "2026-09-09T00:00:00Z",
      tournamentName: "Summer Slam",
      events: [
        {
          name: "Men's 4.0",
          format: "singles",
          gender: "men",
          teams: [{ seed: null, players: [{ first_name: "" }] }],
        },
      ],
    };
    expect(() => parseFieldFile(JSON.stringify(bad))).toThrow();
  });
});

describe("fieldFilename", () => {
  it("slugifies the tournament name and appends the date", () => {
    expect(fieldFilename("Summer Slam 2026!", new Date("2026-09-09T00:00:00Z"))).toBe(
      "field-summer-slam-2026-2026-09-09.json",
    );
  });
});
