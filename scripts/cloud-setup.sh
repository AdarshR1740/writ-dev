#!/usr/bin/env bash
# Set up Writ on your own Supabase cloud project, then develop against it.
#
#   ./scripts/cloud-setup.sh <project-ref>
#
# The project ref is in your project's URL: https://supabase.com/dashboard/project/<project-ref>
# Safe to run again: it applies new migrations and redeploys the functions, and it
# keeps the existing encryption secret.
#
# Needs: Node 18+. No Docker: functions are bundled on Supabase's servers (--use-api).
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-}"
if [ -z "$REF" ]; then
  echo "Usage: ./scripts/cloud-setup.sh <project-ref>"
  echo "Find the ref in your project's dashboard URL: supabase.com/dashboard/project/<project-ref>"
  exit 1
fi
SB="npx -y supabase@2"

echo "1/5 Checking you're signed in to Supabase (the first run downloads the Supabase CLI; this can take a minute)…"
if ! $SB projects list >/dev/null 2>&1; then
  echo
  echo "    You're not signed in yet. When asked, press Enter to open the browser and sign in."
  echo "    No browser? Stop with Ctrl+C, create a token at https://supabase.com/dashboard/account/tokens,"
  echo "    run: npx -y supabase@2 login --token <your-token>   then run this script again."
  echo
  $SB login
fi

echo "2/5 Linking this folder to project $REF…"
$SB link --project-ref "$REF"

echo "3/5 Applying the database migrations…"
$SB db push

echo "4/5 Setting the key-encryption secret (once) and deploying the functions…"
if $SB secrets list --project-ref "$REF" 2>/dev/null | grep -q "KEY_ENCRYPTION_SECRET"; then
  echo "    KEY_ENCRYPTION_SECRET is already set; keeping it."
else
  # Never change this later: every saved AI key and WordPress password is encrypted with it.
  $SB secrets set --project-ref "$REF" "KEY_ENCRYPTION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
  echo "    Set a new KEY_ENCRYPTION_SECRET on the project."
fi
FUNCTIONS=$(find supabase/functions -mindepth 1 -maxdepth 1 -type d ! -name '_*' -exec basename {} \; | sort | tr '\n' ' ')
# shellcheck disable=SC2086
$SB functions deploy $FUNCTIONS --project-ref "$REF" --use-api

echo "5/5 Pointing the web app at the project (web/.env.local, git-ignored)…"
ANON=$($SB projects api-keys --project-ref "$REF" -o json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const keys = JSON.parse(s);
      const k = keys.find((x) => x.name === "anon") ?? keys.find((x) => x.type === "publishable");
      process.stdout.write(k ? k.api_key : "");
    } catch { process.stdout.write(""); }
  });') || true
if [ -n "$ANON" ]; then
  printf 'VITE_SUPABASE_URL=https://%s.supabase.co\nVITE_SUPABASE_ANON_KEY=%s\n' "$REF" "$ANON" > web/.env.local
  echo "    Wrote web/.env.local."
else
  echo "    Couldn't read the project's API key. Copy web/.env.example to web/.env.local and fill in"
  echo "    the project URL and anon (public) key from Project Settings → API."
fi

[ -d web/node_modules ] || (cd web && npm install)

cat <<EOF

Done. Two settings to check once in the Supabase dashboard (Authentication → URL Configuration):
  - Site URL: http://localhost:5173 (your real address once you deploy the web app)
  - Redirect URLs: add http://localhost:5173/**
New accounts get a confirmation email on the cloud project; that's what these settings are for.

Start developing:
  cd web && npm run dev
Then open http://localhost:5173.
EOF
