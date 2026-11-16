// Copies the app's step rules (web/src/lib/stepViews.ts) into src/step-views.ts, so this server describes the screens with
// the same rules the app uses.
//
//   node scripts/export-step-views.mjs        (the app repo is the parent folder; or pass its path)
//
// The source file has no imports, so it is copied as it is, under a header. Run it again whenever stepViews.ts changes in
// the app, and commit the result.

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const appRoot = process.argv[2] ?? process.env.WRIT_APP_DIR ?? path.join(here, "..", "..");
if (!fs.existsSync(path.join(appRoot, "web"))) {
  console.error("Usage: node scripts/export-step-views.mjs <path to the Writ app repo>");
  process.exit(1);
}
const source = fs.readFileSync(path.join(appRoot, "web", "src", "lib", "stepViews.ts"), "utf8").replace(/\r\n/g, "\n");
if (/^\s*import\s/m.test(source)) {
  console.error("stepViews.ts must have no imports: it is copied as it is.");
  process.exit(1);
}
const header = `// GENERATED from web/src/lib/stepViews.ts in the Writ app by scripts/export-step-views.mjs. Do not edit here:
// change it in the app, then run the script again.

`;
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "step-views.ts"), header + source);
console.log("src/step-views.ts written");
