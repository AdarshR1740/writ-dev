import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASES, LONG_FORM, normalise, presetFor, stagesFor, validate } from "./recipes";

const TEMPLATES = [
  "tl_blog", "tl_linkedin", "longform_blog", "promo_social", "short_social", "case_study",
  "instagram_caption", "instagram_carousel", "linkedin_carousel", "x_thread", "short_video_script", "video_script",
  "newsletter", "webinar_outline", null,
];

describe("recipes", () => {
  it("every preset passes its own dependency rules", () => {
    for (const key of TEMPLATES) expect(validate(presetFor(key)), String(key)).toEqual([]);
    for (const b of Object.values(BASES)) expect(validate(b.recipe)).toEqual([]);
  });

  it("matches the database default", () => {
    // The newest migration that defines default_recipe() is the one in force.
    const dir = new URL("../../../supabase/migrations/", import.meta.url);
    const latest = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
      .filter((f) => /function public\.default_recipe\(\)/.test(readFileSync(new URL(f, dir), "utf8"))).pop();
    const sql = readFileSync(new URL(latest!, dir), "utf8");
    const json = sql.match(/select '(\{"base":"long_form".*?\})'::jsonb/s)?.[1];
    expect(json, "default_recipe() not found").toBeTruthy();
    expect(JSON.parse(json!)).toEqual(LONG_FORM);
  });

  it("enforces dependencies", () => {
    const r = presetFor("tl_linkedin");
    r.research.enabled = false;
    r.analysis.enabled = true;
    r.checks.seo = true;
    r.brief.keyword = false;
    const paths = validate(r).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["analysis.enabled", "checks.seo", "checks.fact"]));
  });

  it("skips stages a recipe switches off", () => {
    expect(stagesFor(LONG_FORM)).toEqual(["contract", "research", "outline", "writing", "done"]);
    expect(stagesFor(presetFor("short_social"))).toEqual(["research", "writing", "done"]);
    expect(stagesFor(presetFor("tl_linkedin"))).toEqual(["contract", "research", "writing", "done"]);
  });

  it("fills gaps in older saved recipes from the base preset", () => {
    const r = normalise({ base: "short_form", checks: { grammar: false } });
    expect(r.checks.grammar).toBe(false);
    expect(r.checks.fact).toBe(true);
    expect(r.outline.mode).toBe("off");
  });

  it("every template in the picker has a preset of its own", async () => {
    const { FORMAT_TEMPLATES } = await import("./sections");
    for (const t of FORMAT_TEMPLATES) expect(TEMPLATES).toContain(t.key);
  });

  it("presets don't share objects", () => {
    const a = presetFor("tl_linkedin");
    a.checks.grammar = false;
    expect(presetFor("tl_linkedin").checks.grammar).toBe(true);
  });
});
