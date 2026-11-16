# Hosting Writ on the Oracle VM

Serves the web app at `https://writ-v1.duckdns.org`. Supabase stays where it is. The remote MCP server (`/mcp`) is reserved in the
Caddyfile but not built yet. Files: `deploy/Caddyfile`, `deploy/deploy.sh`.

## One-time setup

1. **Check the VM is free.** Oracle console: the instance shape must say "Always Free-eligible". Set a budget alert at $1
   (Billing, Budgets).
2. **Open ports 80 and 443, in both places.**
   - Oracle console: the VM's subnet, Security List, add ingress rules for TCP 80 and 443 from 0.0.0.0/0.
   - On the VM (Ubuntu images block them): `sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT`, the same for 443, then
     `sudo netfilter-persistent save`.
3. **DuckDNS.** Add the subdomain `writ-v1` pointing at the VM's public IP (the same IP as jobdeck).
4. **Install Node 20+, git and Caddy** (Caddy: see caddyserver.com/docs/install#debian-ubuntu-raspbian). On a 1 GB VM add swap first,
   or the build may run out of memory:
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
7. **Caddy.** `sudo cp /srv/writ/repo/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`
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

The script first updates the VM's clone, so the Caddyfile there is current. If a deploy changed `deploy/Caddyfile`, copy it again
(step 7). Commit and push `deploy/` before the first clone, or the clone won't have the script.

## Order when a change has a migration

Migrate first, deploy the VM after. Claude will say when a change needs a migration. Migrations must work with the previous app version.

## Checks

- `https://writ-v1.duckdns.org` loads and you can sign in.
- Browser console shows no request to `localhost`; a blank sign-in usually means `/etc/writ/config.js` is wrong.
