import { describe, expect, it } from "vitest";
import { cardsToCsv, parseCards } from "./cards";

describe("parseCards", () => {
  it("reads CSV with a header row", () => {
    const csv = `type,claim,detail,citation,tags,value
opinion,SMEs stall at data prep,Seen in 12 calls,internal,"supply chain, data",
data_point,Churn fell after onboarding calls,,public,churn,18%`;
    const { rows, format } = parseCards(csv);
    expect(format).toBe("csv");
    expect(rows.every((r) => r.card)).toBe(true);
    expect(rows[0].card?.tags).toEqual(["supply chain", "data"]);
    expect(rows[1].card?.value).toBe("18%");
    expect(rows[0].card?.value).toBeNull();
  });

  it("reads a JSON array and {cards: [...]}", () => {
    const one = parseCards(`[{"type":"story","claim":"x","citation":"internal"}]`);
    const two = parseCards(`{"cards":[{"type":"lesson","claim":"y","citation":"public"}]}`);
    expect(one.format).toBe("json");
    expect(one.rows[0].card?.type).toBe("story");
    expect(two.rows[0].card?.type).toBe("lesson");
  });

  it("reads one JSON array per line, including spreadsheet-quoted cells", () => {
    const text = `[{"type":"opinion","claim":"a","citation":"internal"}]
"[{""type"":""quote"",""claim"":""b"",""citation"":""public""}]"`;
    const { rows } = parseCards(text);
    expect(rows).toHaveLength(2);
    expect(rows[1].card?.type).toBe("customer_quote");
  });

  it("reports problems instead of guessing", () => {
    const { rows } = parseCards(`type,claim,citation,value
data_point,No value here,public,
mystery,Something,internal,
opinion,,maybe,`);
    expect(rows[0].problems).toContain("A data point needs a value");
    expect(rows[1].problems[0]).toMatch(/Unknown type/);
    expect(rows[2].problems).toEqual(expect.arrayContaining(["Missing claim", expect.stringMatching(/Citation/)]));
    expect(rows.every((r) => r.card === null)).toBe(true);
  });

  it("uses the fallback type when a column is missing", () => {
    const { rows } = parseCards(`claim,citation,value,unit\nOn-time rate,internal,94,%`, "data_point");
    expect(rows[0].card).toMatchObject({ type: "data_point", value: "94", unit: "%" });
  });

  it("round-trips through CSV", () => {
    const { rows } = parseCards(`[{"type":"opinion","claim":"a, with comma","citation":"internal","tags":["x","y"]}]`);
    const again = parseCards(cardsToCsv([rows[0].card!]));
    expect(again.rows[0].card).toEqual(rows[0].card);
  });
});
