#!/usr/bin/env bash
# Optional: run Writ entirely on your computer, with no cloud project: a local
# Supabase (database, sign-in, Edge Functions) in Docker, plus the web app at
# http://localhost:5173. For your Supabase cloud project, use cloud-setup.sh instead.
#
# Local mode keeps its own settings (web/.env.localdb.local), so it never
# touches the cloud settings in web/.env.local.
#
# Needs: Docker Desktop (running) and Node 18+. Nothing is deployed anywhere.
# Stop with Ctrl+C; the database keeps its data until you run:
#   npx supabase stop --no-backup
set -euo pipefail
cd "$(dirname "$0")/.."

docker info >/dev/null 2>&1 || { echo "Start Docker Desktop first, then run this again."; exit 1; }

# The secret that encrypts provider keys (git-ignored). Made once, before anything
# starts, and remade if it's missing or empty. Uses Node, which is needed anyway.
secret="$(sed -n 's/^KEY_ENCRYPTION_SECRET=//p' supabase/functions/.env 2>/dev/null || true)"
if [ -z "$secret" ]; then
  secret="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
  echo "KEY_ENCRYPTION_SECRET=$secret" > supabase/functions/.env
  echo "Created supabase/functions/.env with a new encryption secret."
fi

echo "Starting local Supabase (the first run downloads images and takes a few minutes)…"
npx -y supabase@2 start -x studio,imgproxy,logflare,vector,supavisor,realtime,storage-api,postgres-meta
# An existing local database keeps its data; apply any migrations added since it was created.
npx -y supabase@2 migration up --local

# Point the web app at the local project, in local mode's own settings file (git-ignored).
eval "$(npx -y supabase@2 status -o env | grep -E '^(API_URL|ANON_KEY)=')"
printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_ANON_KEY=%s\n' "$API_URL" "$ANON_KEY" > web/.env.localdb.local

[ -d web/node_modules ] || (cd web && npm install)

npx -y supabase@2 functions serve --env-file supabase/functions/.env &
FUNCTIONS=$!
trap 'kill $FUNCTIONS 2>/dev/null' EXIT

echo
echo "Writ is starting at http://localhost:5173"
echo "Sign up with any email; no confirmation email is needed locally."
echo
(cd web && npx vite --mode localdb --port 5173 --strictPort)
