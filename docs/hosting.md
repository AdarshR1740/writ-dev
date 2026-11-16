# Hosting Writ on the Oracle VM

Serves the web app at `https://writ-v1.duckdns.org`. Supabase stays where it is. The remote MCP server (`/mcp`) is not built yet and will be added to the
Caddy config in a later change. Files: `deploy/writ.caddy`, `deploy/deploy.sh`.

## One-time setup

1. **Check the VM is free.** Oracle console: the instance shape must say "Always Free-eligible". Set a budget alert at $1
   (Billing, Budgets).
2. **Open ports 80 and 443, in both places.**
   - Oracle console: the VM's subnet, Security List, add ingress rules for TCP 80 and 443 from 0.0.0.0/0.
   - On the VM (Ubuntu images block them): `sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT`, the same for 443, then
     `sudo netfilter-persistent save`.
3. **DuckDNS.** Add the subdomain `writ-v1` pointing at the VM's public IP (the same IP as jobdeck).
4. **Install Node 20+ and git** (no separate Caddy). Add swap first, since jobdeck leaves little free RAM and the build may run out of memory:
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
   (add `/swapfile none swap sw 0 0` to `/etc/fstab` to keep it after a reboot).
5. **Get the code.** The repo is public-or-private on GitHub; for a private one add a read-only deploy key.
   ```bash
   sudo mkdir -p /srv/writ/releases && sudo chown -R $USER /srv/writ
   git clone https://github.com/AdarshR1740/writ-dev.git /srv/writ/repo
   ```
6. **The app's settings** (public values, but kept off git so one build works anywhere):
   ```bash
   sudo mkdir -p /etc/writ
   sudo tee /etc/writ/config.js <<'EOF'
   window.__WRIT_CONFIG__ = { supabaseUrl: "https://plqzeqaswtokfsgudmld.supabase.co", supabaseAnonKey: "<anon key>" };
   EOF
   ```
   The anon key is in web/.env.local (`VITE_SUPABASE_ANON_KEY`). Never put the service-role key here.
7. **Caddy (shared with jobdeck).** Jobdeck already runs Caddy in Docker on ports 80 and 443, so Writ is added to it, not a second Caddy.
   In `~/jobdeck-v2`: add two read-only mounts to the `caddy` service's `volumes` in `docker-compose.prod.yml`
   (`/srv/writ:/srv/writ:ro` and `/etc/writ:/etc/writ:ro`), add the line `import /srv/writ/repo/deploy/*.caddy` at the end of its
   `Caddyfile`, then recreate Caddy: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps caddy` (`--no-deps` stops it from also starting jobdeck's app and database;
   a few seconds of downtime for jobdeck if it's running).
   After that, a change to `deploy/writ.caddy` only needs: `docker exec jobdeck-v2-caddy-1 caddy validate --config /etc/caddy/Caddyfile`
   then `docker exec jobdeck-v2-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
8. **Supabase auth settings** (dashboard, Authentication, URL Configuration): add `https://writ-v1.duckdns.org` as a Site URL or
   redirect URL. If the edge functions restrict origins (CORS), allow this origin too.

## Each deploy (manual, costs nothing)

Push to GitHub from your machine, then:

```bash
./deploy/deploy.sh <user>@<vm-ip>
```

It fetches `origin/main`, builds the web app in a new folder, runs the web tests, and switches over only if they pass. A failed build
leaves the old version serving. The last 3 releases are kept; to roll back, point `/srv/writ/current` at an older folder in
`/srv/writ/releases` (`ln -sfn <folder> /srv/writ/current`).

A different branch: `WRIT_BRANCH=other ./deploy/deploy.sh <user>@<vm-ip>`.

The script first updates the VM's clone, so `deploy/writ.caddy` there is current. If a deploy changed it, validate and reload Caddy
(step 7). Commit and push `deploy/` before the first clone, or the clone won't have the script.

## Hosted MCP server (for Claude chats in the browser)

Writers add `https://writ-v1.duckdns.org/mcp` as a custom connector in claude.ai and sign in with their Writ account. Claude gets its own
token (Supabase's OAuth server), separate from the app's sign-in; the server only accepts tokens issued to the OAuth app below.

1. **Deploy once** so `/srv/writ/current/mcp-server/dist` exists (`./deploy/deploy.sh <user>@<vm-ip>`).
2. **Supabase OAuth app** (dashboard, Authentication, OAuth Apps): create one named "Claude", redirect URIs
   `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. Keep "Allow Dynamic OAuth Apps" off.
   Set **Token Endpoint Auth Method** to `client_secret_post`: claude.ai sends the secret in the request body, and with the default
   `client_secret_basic` Supabase refuses it (`invalid_credentials`, HTTP 400 on `/auth/v1/oauth/token`).
   Note its client ID and secret.
3. **Settings file** `/srv/writ/mcp.env` (mode 600, never in git):
   ```
   PORT=3100
   HOST=0.0.0.0
   WRIT_PUBLIC_URL=https://writ-v1.duckdns.org
   WRIT_SUPABASE_URL=https://plqzeqaswtokfsgudmld.supabase.co
   WRIT_SUPABASE_ANON_KEY=<anon key>
   WRIT_OAUTH_CLIENT_IDS=<the OAuth app's client ID>
   ```
   `HOST=0.0.0.0` is needed so Caddy's container can reach it. Oracle's security list and the VM firewall only let 22, 80 and 443 in
   from outside, so port 3100 stays private. After step 5, check from your own machine that `http://<vm-ip>:3100/healthz` does not answer.
4. **Service:**
   ```bash
   mkdir -p ~/.config/systemd/user && cp /srv/writ/repo/deploy/writ-mcp.service ~/.config/systemd/user/
   chmod 600 /srv/writ/mcp.env && loginctl enable-linger $USER
   systemctl --user daemon-reload && systemctl --user enable --now writ-mcp
   curl -s http://127.0.0.1:3100/healthz
   ```
   Later deploys restart it automatically. The unit asks for a 400 MB memory cap; a user service may ignore it. Check with
   `systemctl --user show -p MemoryMax writ-mcp` (it should not say `infinity`), and if it does, watch `free -m` instead.
   Logs: `journalctl --user -u writ-mcp -n 50`.
5. **Let Caddy's container reach it.** In `~/jobdeck-v2/docker-compose.prod.yml`, under the `caddy` service add
   `extra_hosts: ["host.docker.internal:host-gateway"]`, then recreate it (same command as step 7 above). On the VM allow the Docker
   networks to reach port 3100, then save the rule:
   it must sit above the firewall's `REJECT` rule or it does nothing. Find that rule's line number with
   `sudo iptables -L INPUT -n --line-numbers` (it was 5 here), then
   `sudo iptables -I INPUT <that number> -s 172.16.0.0/12 -p tcp --dport 3100 -j ACCEPT && sudo netfilter-persistent save`.
   Reload Caddy to pick up the `/mcp` routes (validate and reload, step 7).
6. **Check:** `curl -i https://writ-v1.duckdns.org/mcp -X POST` answers `401` with a `www-authenticate` header, and
   `curl https://writ-v1.duckdns.org/.well-known/oauth-protected-resource/mcp` answers with JSON.
7. **Add it in claude.ai:** Settings, Connectors, add custom connector, URL `https://writ-v1.duckdns.org/mcp`. Under advanced settings
   enter the OAuth app's client ID and secret. Sign in and press Allow on the Writ page.

## Order when a change has a migration

Migrate first, deploy the VM after. Claude will say when a change needs a migration. Migrations must work with the previous app version.

## Checks

- `https://writ-v1.duckdns.org` loads and you can sign in.
- Browser console shows no request to `localhost`; a blank sign-in usually means `/etc/writ/config.js` is wrong.
