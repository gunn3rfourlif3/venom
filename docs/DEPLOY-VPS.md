# Deploying Xnith to `xnith.zaaka.io`

Target: the existing **Cloud VPS 6 — 6 vCPU, 12 GB RAM, 200 GB disk**, already
serving other sites. The goal is a stack that is as isolated as practical and
**cannot take your other sites down**, which is the real risk of co-hosting.

Everything below runs on the VPS over SSH unless marked otherwise. This file is
meant to be followable by someone who is not you — that is deliberate, because
on 4 November you are the single point of failure (`GOTCHAS.md` G5).

---

## 0. Before anything: take a provider snapshot

**This box carries live services.** The deploy installs Docker, adds a vhost,
changes the firewall and enables unattended upgrades. A snapshot is the
difference between "undo" and "rebuild", it costs a few minutes, and it is
the cheapest insurance in this document.

On Contabo: the instance page → Snapshots → Create snapshot. Do it before
step 1, not after something goes wrong.

**On sudo:** Contabo provisions these instances with `root` as the default
user, so there is no sudo password to find and every `sudo` below can be
dropped when logged in as root. Do **not** reset the instance credentials to
get one — a reset applies to the running instance and generally needs a
restart, which takes the live sites down. The provider's password manager
can reveal a stored password instead.

---

## 0b. Isolation model

| Concern | How |
|---|---|
| Process | Own Docker Compose project, own bridge network, own volumes |
| Resources | Hard memory and CPU limits, so a runaway query cannot starve zaaka.io |
| Network | **Postgres publishes no host port.** Reachable only on the internal Docker network |
| Ingress | App binds `127.0.0.1` only; the existing web server proxies to it |
| Filesystem | Everything under `/home/deploy/xnith`, owned by `deploy` (non-root, in `docker` and `sudo`) |
| Credentials | Own Postgres role and database, own secrets file at `0600` |
| Failure | Container restart policy is `unless-stopped`; the stack is a systemd unit |

This is container isolation, not virtualisation. Adequate for staging and for
4 November. When the provider app ships, the database moves off this box
first — see `ARCHITECTURE.md` §3, Tier 1.

---

## 1. DNS

At your DNS provider for `zaaka.io`:

```
Type   Name    Value                TTL
A      xnith   <your.vps.ipv4>      300
AAAA   xnith   <your.vps.ipv6>      300    (if the VPS has IPv6)
```

Keep TTL low until the deploy is settled, then raise it. Verify before going
further:

```bash
dig +short xnith.zaaka.io
```

---

## 2. What already owns ports 80 and 443

**Check this before anything else.** It decides which of two paths you take,
and getting it wrong takes your existing sites offline.

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

- **Something is listening** (nginx, Apache, Caddy) → **Path A**. Recommended.
  Your existing web server keeps owning TLS and proxies to the container.
  Nothing about your current sites changes.
- **Nothing is listening** → **Path B**. The stack brings its own Caddy and
  handles TLS itself.

---

## 3. Prerequisites

```bash
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo docker compose version

# The deployment runs as `deploy`, the login user created when the VPS was
# set up — already in the docker group. An earlier draft of this runbook
# created a separate `xnith` service user under /opt; that user was never
# made, and every command here referred to it. If you are rebuilding from
# scratch and `deploy` does not exist:
#
#   sudo adduser --disabled-password --gecos '' deploy
#   sudo usermod -aG docker,sudo deploy
#
sudo mkdir -p /home/deploy/xnith/backups
sudo chown -R deploy:deploy /home/deploy/xnith
```

---

## 4. Code and secrets

```bash
git clone https://github.com/gunn3rfourlif3/venom.git /home/deploy/xnith
cd /home/deploy/xnith
```

Generate the secrets file. **Never commit this; never bake it into the image.**

```bash
bash -c 'umask 077; cat > /home/deploy/xnith/deploy/.env <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 36 | tr -d /=+ | cut -c1-40)
SESSION_SECRET=$(openssl rand -base64 48 | tr -d /=+ | cut -c1-64)
NODE_ENV=production
API_PORT=8080
EOF'
sudo chmod 600 /home/deploy/xnith/deploy/.env
```

Then append the connection string, reusing the password just generated:

```bash
bash -c '
  . /home/deploy/xnith/deploy/.env
  echo "DATABASE_URL=postgres://xnith:${POSTGRES_PASSWORD}@db:5432/xnith" \
    >> /home/deploy/xnith/deploy/.env'
```

Confirm it is not world-readable:

```bash
ls -l /home/deploy/xnith/deploy/.env   # expect -rw------- deploy deploy
```

---

## 5. Dockerfile

Create `/home/deploy/xnith/Dockerfile`:

```dockerfile
# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY db ./db
# run as the node user, not root
USER node
EXPOSE 8080
CMD ["node", "dist/api/server.js"]
```

`db/` is copied in because the migrator reads the `.sql` files at runtime.

---

## 6. Compose stack

Create `/home/deploy/xnith/compose.yaml`. The resource limits are the part that
protects your other sites — do not drop them.

```yaml
name: xnith

services:
  db:
    image: postgres:16-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_DB: xnith
      POSTGRES_USER: xnith
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      # scram, and no trust for host connections
      POSTGRES_HOST_AUTH_METHOD: scram-sha-256
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256"
    # NO ports: section. Deliberate. Postgres is reachable only
    # on the xnith-internal network, never from the host or the internet.
    volumes:
      - db-data:/var/lib/postgresql/data
    networks: [internal]
    command:
      - postgres
      - -c
      - shared_buffers=1GB
      - -c
      - effective_cache_size=3GB
      - -c
      - work_mem=16MB
      - -c
      - maintenance_work_mem=256MB
      - -c
      - max_connections=100
      - -c
      - statement_timeout=30000
      - -c
      - idle_in_transaction_session_timeout=60000
      - -c
      - log_min_duration_statement=1000
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2.5"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U xnith -d xnith"]
      interval: 10s
      timeout: 5s
      retries: 6

  app:
    build: .
    restart: unless-stopped
    env_file: /home/deploy/xnith/deploy/.env
    # bound to loopback only; the host web server proxies to it (Path A)
    ports:
      - "127.0.0.1:8090:8080"
    networks: [internal]
    depends_on:
      db:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: "2"
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  db-data:

networks:
  internal:
    driver: bridge
```

Budget: 4 GB Postgres + 2 GB app = **6 GB of 12**, leaving ~6 GB for your
existing sites and the OS. CPU limits total 4.5 of 6 cores, so the box stays
responsive under load.

Bring it up:

```bash
cd /home/deploy/xnith/deploy   # compose.yaml and .env live here, not at the repo root
docker compose up -d --build
docker compose ps
```

Migrate and seed:

```bash
docker compose exec app node dist/cli/migrate.js
# only on staging — never load test seeds into production
docker compose exec app node dist/cli/seed.js
```

Create the first admin:

```bash
docker compose exec app node dist/cli/create-user.js
```

Check it answers locally:

```bash
curl -fsS http://127.0.0.1:8090/api/health   # {"ok":true,...}
```

---

## 7. Ingress

### Path A — existing nginx proxies to the container *(recommended)*

Create `/etc/nginx/sites-available/xnith.zaaka.io`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name xnith.zaaka.io;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name xnith.zaaka.io;

    # certbot fills these in
    ssl_certificate     /etc/letsencrypt/live/xnith.zaaka.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xnith.zaaka.io/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # the paste endpoint writes in bulk; cap the body
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # the live path is SSE: no buffering, long timeout
    location /api/live {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/xnith.zaaka.io /etc/nginx/sites-enabled/
sudo nginx -t                         # MUST pass before reload
sudo systemctl reload nginx
sudo certbot --nginx -d xnith.zaaka.io
```

If the box runs **Apache** instead, the equivalent is `ProxyPass / http://127.0.0.1:8090/`
in a `<VirtualHost *:443>` with `ProxyPass /api/live` given
`ProxyPass ... flushpackets=on` and a long `ProxyTimeout`. The SSE location is
the part people forget; without it the live updates buffer and appear frozen.

### Path B — only if nothing owns 80/443

Add Caddy to the compose file and let it terminate TLS:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [internal]
    depends_on: [app]
    deploy:
      resources:
        limits: { memory: 256M, cpus: "0.5" }
```

`Caddyfile`:

```
xnith.zaaka.io {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
	}
	reverse_proxy app:8080 {
		flush_interval -1    # required for SSE
	}
}
```

Then remove the `ports:` mapping from `app` — Caddy reaches it over the
internal network and nothing needs a host port.

---

## 8. The daily cadence

The database lives on this box, so the scheduler must too. A cloud-side cron or
an agent session cannot reach it (`GOTCHAS.md` G8).

`/etc/systemd/system/xnith-daily.service`:

```ini
[Unit]
Description=Xnith daily source sweep
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=xnith
WorkingDirectory=/home/deploy/xnith
ExecStart=/usr/bin/docker compose exec -T app node dist/cli/daily.js
```

`/etc/systemd/system/xnith-daily.timer`:

```ini
[Unit]
Description=Run the Xnith daily sweep each morning

[Timer]
# 04:12 local. Off the hour on purpose: every other scheduled job
# on every other box runs at :00, and the feeds are slower then.
OnCalendar=*-*-* 04:12:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xnith-daily.timer
sudo systemctl list-timers xnith-daily.timer
# run it once by hand and read the output
sudo systemctl start xnith-daily.service
sudo journalctl -u xnith-daily.service -n 100 --no-pager
```

`npm run daily` runs the press sweep, the news sweep, the retention purge, then
refreshes `mv_campaign_extract`, and reports what the day produced. Optional
steps failing do not fail the run; the extract refresh failing does, because
that means the dashboard is serving yesterday's numbers.

**`Persistent=true` matters:** if the VPS is down at 04:12, the sweep runs on
next boot rather than being skipped. Each press feed carries only its ten most
recent items, so a skipped day is a permanent hole in the series.

### On your Windows machine, for local development

```powershell
schtasks /Create /TN "Xnith daily" /SC DAILY /ST 04:12 /RL HIGHEST ^
  /TR "cmd /c cd /d C:\xampp\htdocs\development\venom && npm run daily >> daily.log 2>&1"

# verify, and run it once now
schtasks /Query /TN "Xnith daily"
schtasks /Run   /TN "Xnith daily"
```

---

## 9. Backups, and a rehearsed restore

The database is the only part that cannot be rebuilt from git. **An untested
backup is not a backup** — the restore rehearsal below is the highest-value
fifteen minutes in this document.

The script lives in the repo at `deploy/backup.sh` and is deployed with
the rest of the tree — it is **not** reproduced here. An earlier version of
this runbook carried an inline copy, which drifted from the real one: the
repo's version refuses a zero-length dump and warns under 100KB, and the
copy here did neither. Read the file, do not trust a transcription of it.


```bash
sudo chmod +x /home/deploy/xnith/deploy/backup.sh
sudo chown deploy:deploy /home/deploy/xnith/deploy/backup.sh
```

A timer at 02:30, same pattern as §8.

**Configure the off-box copy.** The commented `rclone` line is the difference
between a backup and a false sense of one: if the VPS disk fails, a dump on
that disk goes with it. Any object store will do.

### Rehearse the restore — do this once, now

**The `tail -1` that used to be here was a bug**, and a dangerous one: it
was meant to pick the newest *file*, but in that position it took the last
line of the decompressed binary archive and fed that to `pg_restore`, which
fails every time with "input file does not appear to be a valid archive".
A restore procedure that cannot restore is worse than none, because it is
reached for in the one hour nobody has time to debug it. Found by rehearsing.

```bash
cd /home/deploy/xnith/deploy
LATEST=$(ls -t /home/deploy/xnith/backups/xnith-*.dump.gz | head -1)
echo "restoring $LATEST"
docker compose exec -T db dropdb -U xnith --if-exists restore_test
docker compose exec -T db createdb -U xnith restore_test
gunzip -c "$LATEST" | docker compose exec -T db pg_restore -U xnith -d restore_test

# verify it is actually a working database, not just bytes
docker compose exec -T db psql -U xnith -d restore_test -c \
  "SELECT (SELECT count(*) FROM ward)    AS wards,
          (SELECT count(*) FROM station) AS stations,
          (SELECT count(*) FROM app_user) AS users;"

docker compose exec -T db dropdb -U xnith restore_test
```

If those counts are wrong or the restore errors, **fix it today**, not on
4 November.

### 9b. The off-box copy

Everything above writes to the same disk as the database. Until a copy leaves
the machine, these dumps protect against a bad migration and not against
losing the machine.

**The workstation pulls; the server never pushes.** That direction means no
SSH server on the home machine, no port forwarded to it from the internet, no
credential for the home network stored on a public-facing box — and, the part
that matters, a compromised VPS cannot reach in and delete the copies already
pulled.

**The dump is encrypted before it leaves, and this is not a formality.** It
contains working credentials: `reporter_roster.capture_token` (live upload
links — anyone holding one can file slips as that marshal), `session.session_id`
(session cookies, stored raw and matched directly, usable until they expire),
and phone numbers across five tables. A plain `.gz` of that on any other disk
is a credential file.

`age` is used in **public-key mode**, so the server holds only the public key
and cannot read back what it has written.

#### One-time setup

**1 — On the workstation, make the keypair.** Not on the server.

```powershell
age-keygen -o $env:USERPROFILE\.ssh\xnith-backup.key
# prints: Public key: age1........
```

> **Keep a second copy of that private key somewhere that is not this
> machine** — a password manager entry, or printed in a drawer. If it is lost,
> every backup is scrap. Not difficult to recover: impossible. A disk failure
> that takes the key and the copies together leaves nothing.

**2 — On the VPS, install age and record the public key.**

```bash
sudo apt-get update && sudo apt-get install -y age
printf 'AGE_RECIPIENT=age1........\n' > /home/deploy/xnith/deploy/backup.env
chmod 600 /home/deploy/xnith/deploy/backup.env
sudo systemctl daemon-reload
sudo systemctl start xnith-backup.service
ls -l /home/deploy/xnith/backups/*.age
```

The last line is the test. No `.age` file means `AGE_RECIPIENT` was not picked
up, and `backup.sh` will have said so on stderr — check
`journalctl -u xnith-backup.service -n 20`.

**3 — On the workstation, schedule the pull.**

```powershell
# run it once by hand first, and read the output
cd C:\xampp\htdocs\development\venom\deploy
.\pull-backups.ps1

# then daily at 03:30, an hour and a half after the server's dump
$a = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\xampp\htdocs\development\venom\deploy\pull-backups.ps1"'
$t = New-ScheduledTaskTrigger -Daily -At 3:30am
Register-ScheduledTask -TaskName 'Xnith backup pull' -Action $a -Trigger $t `
  -Description 'Pulls encrypted nightly Xnith backups from the VPS'
```

The machine must be awake at 03:30. If it is not, nothing is lost — the server
keeps encrypted copies for 28 days and the next run collects whatever it
missed. What *is* a problem is the machine being off for a month, so the
script warns when the newest copy it holds is over two days old.

#### Restoring from an encrypted copy

**This procedure was rehearsed end to end, not written from memory.** The dump
was taken, encrypted, moved off-box, decrypted, restored, and the row counts
checked: 4,485 wards, 23,751 stations, 6 users, 7 roster.

On the workstation, decrypt and send it back up:

```powershell
cd $env:USERPROFILE\xnith-backups
$latest = Get-ChildItem *.dump.gz.age | Sort-Object LastWriteTime -Desc | Select -First 1
age -d -i $env:USERPROFILE\.ssh\xnith-backup.key $latest.Name > restored.dump.gz
# -> scp restored.dump.gz to the server, then the block below
```

On the server:

```bash
gunzip -f restored.dump.gz
cd /home/deploy/xnith/deploy
docker compose exec -T db dropdb -U xnith --if-exists restore_test
docker compose exec -T db createdb -U xnith restore_test
docker compose exec -T db pg_restore -U xnith -d restore_test < restored.dump

docker compose exec -T db psql -U xnith -d restore_test -c \
  "SELECT (SELECT count(*) FROM ward) AS wards,
          (SELECT count(*) FROM station) AS stations,
          (SELECT count(*) FROM app_user) AS users;"
docker compose exec -T db dropdb -U xnith restore_test
```

`pg_restore` reporting "errors ignored on restore: 3" is normal — those are
ownership statements for roles that do not exist in a scratch database. The
row counts are what decide whether the restore worked.

#### What is still not backed up

Result-slip photographs, in the `slip-store` volume. Tens of gigabytes, so
they are deliberately out of the nightly dump — but the database keeps only
the path and SHA-256 of each image, so losing that volume means those rows
point at nothing, and the one piece of evidence that cannot be re-collected is
gone. Copy it separately, at least once after election night:

```bash
docker run --rm -v xnith_slip-store:/s -v /home/deploy/xnith/backups:/b alpine \
  tar czf /b/slips-$(date -u +%Y%m%d).tar.gz -C /s .
```

---

## 10. Host hardening

```bash
# firewall: only SSH and the web
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ufw status verbose     # confirm 5432 is NOT listed

# automatic security updates
sudo apt install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades
sudo systemctl enable --now fail2ban

# SSH: keys only, no root login
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'                /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload ssh
```

Confirm Postgres is genuinely unreachable from outside — this should **fail**:

```bash
# from your own machine, not the VPS
nc -zv xnith.zaaka.io 5432
```

---

## 11. Verification checklist

Run all of it before calling the deploy done.

```bash
# 1 — TLS valid and the right host
curl -sSI https://xnith.zaaka.io | head -1

# 2 — health
curl -sS https://xnith.zaaka.io/api/health

# 3 — auth is actually required
curl -sS -o /dev/null -w '%{http_code}\n' https://xnith.zaaka.io/api/wards   # expect 401

# 4 — schema complete (the migrator verifies and names anything missing)
docker compose exec app node dist/cli/migrate.js

# 5 — logistics views answer
docker compose exec -T db psql -U xnith -d xnith -c \
  'SELECT * FROM v_logistics_rollup;'

# 6 — Postgres not exposed
sudo ss -ltnp | grep 5432 || echo 'good: no host listener on 5432'

# 7 — limits actually applied
sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'

# 8 — survives a reboot
sudo reboot
# then, once back:
curl -sS https://xnith.zaaka.io/api/health

# 9 — the other sites still work
curl -sSI https://zaaka.io | head -1
```

Item 9 is not a formality. Co-hosting means your existing sites are part of the
blast radius, and checking them is how you find out you were wrong about that.

---

## 12. Deploying a change

`compose.yaml` lives in `deploy/`, not at the repo root, and `.env` sits beside
it — Compose loads that automatically, so no `--env-file` flag is needed. Run
every compose command from `~/xnith/deploy` or it will not find the project.

```bash
cd ~/xnith && git pull
cd ~/xnith/deploy

# see what the migration would do before it does it
docker compose exec app node dist/cli/migrate.js --dry-run

docker compose up -d --build app
docker compose exec app node dist/cli/migrate.js   # skip if no new migration
curl -fsS https://xnith.zaaka.io/api/health
```

A passing health check here proves only that *a* container is serving. If the
`git pull` or the build failed, the old one is still up and will answer
`{"ok":true}` exactly as before (G33). Check that the build actually ran before
you believe the change is live.

Static files under `public/` are served from the image, so a change to
`app.js`, `app.css` or `index.html` still needs the `--build`. Hard-reload the
browser afterwards (Ctrl-F5) or you will be looking at the cached old one and
concluding the deploy failed.

**Rollback:**

```bash
cd ~/xnith && git log --oneline -5
git checkout <previous-sha>
cd ~/xnith/deploy && docker compose up -d --build app
```

Note that code rolls back and **schema does not** — the migrator never
un-applies. Write migrations additively: add a column, do not rename one; keep
the old view until nothing reads it. That discipline is what makes a rollback
at 14:00 on election day survivable.

**From 30 October: feature freeze.** Bug fixes only, and nothing at all is
deployed on 4 November.
