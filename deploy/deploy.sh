#!/usr/bin/env bash
# Run on the VM (or from your machine: ./deploy/deploy.sh user@host). Updates /srv/writ to origin/main,
# builds the web app and the MCP server, and switches over only if the build and its tests pass. Nothing runs by itself:
# this costs nothing until you start it.
set -euo pipefail

# From your machine: update the VM's clone first (so this script and the Caddyfile are current), then run it there.
if [ "${1:-}" ]; then
  exec ssh "$1" "git -C /srv/writ/repo pull --quiet --ff-only && WRIT_BRANCH=${WRIT_BRANCH:-main} bash /srv/writ/repo/deploy/deploy.sh"
fi

REPO=/srv/writ/repo
RELEASES=/srv/writ/releases
CURRENT=/srv/writ/current
BRANCH="${WRIT_BRANCH:-main}"

cd "$REPO"
git fetch --quiet origin "$BRANCH"
NEW=$(git rev-parse "origin/$BRANCH")
OLD=""
[ -L "$CURRENT" ] && OLD=$(basename "$(readlink -f "$CURRENT")")
if [ "$NEW" = "$OLD" ]; then echo "Already on ${NEW:0:7}."; exit 0; fi

DIR="$RELEASES/$NEW"
rm -rf "$DIR"
git worktree prune
git worktree add --detach "$DIR" "$NEW" >/dev/null
trap 'echo "Deploy failed; ${OLD:+still serving ${OLD:0:7}.}${OLD:-nothing is being served yet.}"; git worktree remove --force "$DIR" 2>/dev/null || true' ERR

echo "Building ${NEW:0:7}..."
( cd "$DIR/web" && npm ci --no-audit --no-fund && npm test && npm run build )
( cd "$DIR/mcp-server" && npm ci --no-audit --no-fund && npm test )

ln -sfn "$DIR" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
trap - ERR
# The hosted MCP server, if it has been set up on this machine (docs/hosting.md): restart it on the new version.
if systemctl --user cat writ-mcp >/dev/null 2>&1; then systemctl --user restart writ-mcp && echo "Restarted the MCP server."; fi
# Keep the last 3 releases for rollback (switch /srv/writ/current back to one of them).
SERVING=$(readlink -f "$CURRENT")
ls -1dt "$RELEASES"/*/ | tail -n +4 | while read -r d; do
  [ "$(readlink -f "$d")" = "$SERVING" ] || git worktree remove --force "$d" 2>/dev/null || true
done
echo "Now serving ${NEW:0:7}."
