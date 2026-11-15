import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Backward compatibility of the server's public surface. contract/mcp-contract.json is the surface as last released
 * (refresh it with `npm run contract:update` only after a release, never to make this test pass). The rules are in
 * COMPATIBILITY.md. Adding tools, prompts, optional parameters and enum values is fine; removing or narrowing is not.
 */

type Schema = {
  type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; const?: unknown;
  anyOf?: unknown; oneOf?: unknown; allOf?: unknown; additionalProperties?: unknown; [k: string]: unknown;
};
interface Contract {
  tools: { name: string; readOnly: boolean | null; input: Schema }[];
  prompts: { name: string; arguments: { name: string; required: boolean }[] }[];
}

const LOWER_BOUNDS = ["minimum", "minLength", "minItems", "exclusiveMinimum"];
const UPPER_BOUNDS = ["maximum", "maxLength", "maxItems", "exclusiveMaximum"];

/** Every way `next` accepts less than `old` did, or has become stricter, as readable lines. */
export function breaks(old: Schema, next: Schema | undefined, path: string): string[] {
  if (!next) return [`${path}: removed`];
  const out: string[] = [];
  if (old.type !== undefined && next.type !== old.type && !(old.type === "integer" && next.type === "number")) out.push(`${path}: type ${String(old.type)} -> ${String(next.type)}`);
  if (old.const !== undefined && next.const !== old.const) out.push(`${path}: fixed value changed`);
  if (!old.enum && next.enum) out.push(`${path}: now limited to a list of values`);
  if (old.enum && next.enum) for (const v of old.enum) if (!next.enum.includes(v)) out.push(`${path}: value ${JSON.stringify(v)} no longer accepted`);
  for (const k of LOWER_BOUNDS) if (typeof next[k] === "number" && (typeof old[k] !== "number" || (next[k] as number) > (old[k] as number))) out.push(`${path}: ${k} raised to ${next[k]}`);
  for (const k of UPPER_BOUNDS) if (typeof next[k] === "number" && (typeof old[k] !== "number" || (next[k] as number) < (old[k] as number))) out.push(`${path}: ${k} lowered to ${next[k]}`);
  for (const k of ["pattern", "format"]) if (next[k] !== undefined && next[k] !== old[k]) out.push(`${path}: ${k} added or changed`);
  if (old.additionalProperties !== false && next.additionalProperties === false) out.push(`${path}: extra properties no longer accepted`);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (JSON.stringify(old[k]) !== JSON.stringify(next[k])) out.push(`${path}: ${k} changed (check by hand)`);
  for (const [name, sub] of Object.entries(old.properties ?? {})) out.push(...breaks(sub, next.properties?.[name], `${path}.${name}`));
  const wasRequired = new Set(old.required ?? []);
  for (const name of next.required ?? []) if (!wasRequired.has(name)) out.push(`${path}.${name}: became required`);
  if (old.items) out.push(...breaks(old.items, next.items, `${path}[]`));
  return out;
}

async function live(): Promise<Contract> {
  const client = new Client({ name: "contract", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { PATH: process.env.PATH ?? "" } }));
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint ?? null, input: t.inputSchema as Schema }));
  const prompts = (await client.listPrompts()).prompts.map((p) => ({ name: p.name, arguments: (p.arguments ?? []).map((a) => ({ name: a.name, required: a.required ?? false })) }));
  await client.close();
  return { tools, prompts };
}

describe("breaks (the rules)", () => {
  const base: Schema = { type: "object", properties: { a: { type: "string", maxLength: 10 }, n: { type: "integer", minimum: 1, maximum: 5 }, k: { type: "string", enum: ["x", "y"] }, l: { type: "array", items: { type: "string" } } }, required: ["a"] };
  it("allows additions and loosening", () => {
    const wider: Schema = { ...base, properties: { ...base.properties, extra: { type: "string" }, a: { type: "string", maxLength: 20 }, k: { type: "string", enum: ["x", "y", "z"] } } };
    expect(breaks(base, wider, "t")).toEqual([]);
  });
  it("catches removal, type change, new required, narrowing", () => {
    const p = base.properties!;
    expect(breaks(base, { ...base, properties: { a: p.a } }, "t")).toContain("t.n: removed");
    expect(breaks(base, { ...base, properties: { ...p, a: { type: "number" } } }, "t")[0]).toMatch(/type string -> number/);
    expect(breaks(base, { ...base, required: ["a", "n"] }, "t")).toContain("t.n: became required");
    expect(breaks(base, { ...base, properties: { ...p, k: { type: "string", enum: ["x"] } } }, "t").join()).toMatch(/"y" no longer accepted/);
    expect(breaks(base, { ...base, properties: { ...p, n: { type: "integer", minimum: 2, maximum: 5 } } }, "t").join()).toMatch(/minimum raised/);
    expect(breaks(base, { ...base, properties: { ...p, l: { type: "array", items: { type: "number" } } } }, "t").join()).toMatch(/t\.l\[\]: type/);
  });
});

describe("the released surface still works", () => {
  const snapshot = JSON.parse(readFileSync("contract/mcp-contract.json", "utf8")) as Contract;
  it("keeps every tool, prompt and parameter", async () => {
    const now = await live();
    const problems: string[] = [];
    for (const old of snapshot.tools) {
      const t = now.tools.find((x) => x.name === old.name);
      if (!t) { problems.push(`tool ${old.name}: removed`); continue; }
      problems.push(...breaks(old.input, t.input, old.name));
      if (old.readOnly === true && t.readOnly !== true) problems.push(`tool ${old.name}: no longer read-only`);
    }
    for (const old of snapshot.prompts) {
      const p = now.prompts.find((x) => x.name === old.name);
      if (!p) { problems.push(`prompt ${old.name}: removed`); continue; }
      for (const a of old.arguments) if (!p.arguments.some((x) => x.name === a.name)) problems.push(`prompt ${old.name}.${a.name}: removed`);
      for (const a of p.arguments) if (a.required && !old.arguments.some((x) => x.name === a.name)) problems.push(`prompt ${old.name}.${a.name}: became required`);
    }
    expect(problems).toEqual([]);
  }, 30000);
});
