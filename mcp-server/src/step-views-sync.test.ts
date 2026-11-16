import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** src/step-views.ts is generated from the app's stepViews.ts. If the app is next to this repo, the two must still match. */
const appFile = process.env.WRIT_APP_DIR ? `${process.env.WRIT_APP_DIR}/web/src/lib/stepViews.ts` : "../web/src/lib/stepViews.ts";

describe("the generated step rules", () => {
  it.skipIf(!existsSync(appFile))("match the app's stepViews.ts (run scripts/export-step-views.mjs if this fails)", () => {
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
    const generated = norm(readFileSync("src/step-views.ts", "utf8"));
    const source = norm(readFileSync(appFile, "utf8"));
    expect(generated.endsWith(source)).toBe(true);
    expect(generated.startsWith("// GENERATED from web/src/lib/stepViews.ts")).toBe(true);
  });
});
