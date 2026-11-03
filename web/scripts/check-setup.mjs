// Runs before `npm run dev` (the "predev" script). Uses only Node built-ins, so it
// works before `npm install`, and explains what's missing instead of a cryptic error.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : null;
const problems = [];

if (!existsSync(join(web, "node_modules", "vite"))) {
  problems.push("The app's packages aren't installed. In the web folder, run:\n\n    npm install\n");
}

// Vite reads these files; any one of them (or real environment variables) can set the values.
const files = [".env", ".env.local", ...(mode ? [`.env.${mode}`, `.env.${mode}.local`] : [".env.development", ".env.development.local"])];
const values = {};
for (const f of files) {
  const p = join(web, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2];
  }
}
for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) if (process.env[k]) values[k] = process.env[k];
const placeholder = (v) => !v || v.includes("your-project") || v === "your-anon-key";
if (placeholder(values.VITE_SUPABASE_URL) || placeholder(values.VITE_SUPABASE_ANON_KEY)) {
  problems.push(
    "The app doesn't know which Supabase project to use (web/.env.local is missing or still has placeholders).\n" +
    "From the writ-dev folder, run the cloud setup once:\n\n" +
    "    Windows PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\\cloud-setup.ps1 <project-ref>\n" +
    "    macOS / Linux:       ./scripts/cloud-setup.sh <project-ref>\n\n" +
    "Or copy web/.env.example to web/.env.local and fill in the URL and anon key from\n" +
    "your project's Settings → API.\n",
  );
}

if (problems.length) {
  console.error("\nWrit can't start yet:\n");
  problems.forEach((p, i) => console.error(`${i + 1}. ${p}`));
  process.exit(1);
}
