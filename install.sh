#!/usr/bin/env bash
# Console: install or update everything with one command. Safe to run again any time.
#
#   curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh | sudo bash
#
# With a domain (HTTPS through Caddy, and the DNS record is created on Cloudflare for you):
#   curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh \
#     | sudo env CF_API_TOKEN=xxxx bash -s -- --domain console.example.com
#
# If you run it from a terminal it asks the questions itself, so the first form is enough.
#
# Options
#   --domain NAME   serve at https://NAME (installs Caddy for HTTPS)
#   --ip-only       no domain: serve plain http://IP:PORT (also forgets a saved domain)
#   --port N        port Console listens on (default 3000)
#   --branch NAME   git branch to install from (default main)
#   --dir PATH      where to install (default /opt/console)
#   --yes           never ask questions
# Environment
#   CF_API_TOKEN              Cloudflare token (Zone:Read + DNS:Edit). Used once, never stored or printed.
#   CONSOLE_ADMIN_PASSWORD    first install only. Otherwise a random one is generated and shown once.
#
# Works on Oracle Linux / RHEL-family (dnf) and Debian / Ubuntu (apt). Needs systemd and root.

set -Eeuo pipefail

REPO="${CONSOLE_REPO:-https://github.com/molive6316github/console}"
RAW_URL="${CONSOLE_RAW_URL:-https://raw.githubusercontent.com/molive6316github/console/main/install.sh}"
DIR="${CONSOLE_DIR:-/opt/console}"
BRANCH="${CONSOLE_BRANCH:-main}"
PORT_FLAG="${CONSOLE_PORT:-}"
DOMAIN="${CONSOLE_DOMAIN:-}"
ENV_FILE="${CONSOLE_ENV_FILE:-/etc/console.env}"
SVC_USER="console"
CADDY_DIR="/etc/caddy"

IP_ONLY=0
ASSUME_YES=0
HAVE_TTY=0
PM=""
APT_UPDATED=0
SVC_HOME=""
PORT=3000
PUBLIC_IP=""
IS_OCI=0
ADMIN_PW=""
ADMIN_PW_NOTE=""
CF_TOKEN=""
CERT_OK=0
DNS_OK=0

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
say()  { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

trap 'warn "Stopped at line $LINENO. Fix what is shown above, then run the same command again. It is safe to repeat."' ERR

usage() {
  cat <<EOF
Console installer. Run as root; safe to repeat.

  curl -fsSL $RAW_URL | sudo bash
  curl -fsSL $RAW_URL | sudo env CF_API_TOKEN=xxxx bash -s -- --domain console.example.com

  --domain NAME   serve at https://NAME (installs Caddy for HTTPS)
  --ip-only       no domain: serve plain http://IP:PORT
  --port N        port Console listens on (default 3000)
  --branch NAME   git branch to install from (default main)
  --dir PATH      where to install (default /opt/console)
  --yes           never ask questions
EOF
}

# ---- small pure helpers (these are unit-tested) --------------------------------

normalize_domain() {
  local d=${1,,}
  d=${d#http://}; d=${d#https://}; d=${d%%/*}; d=${d%.}
  printf '%s' "$d"
}

valid_domain() {
  local re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  [ "${#1}" -le 253 ] && [[ $1 =~ $re ]]
}

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}

# Replace KEY=... if present, else append. Values go through the environment so
# characters like & \ / in a value can't be misread.
env_set() {
  local key=$1 val=$2 tmp
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -qE "^$key=" "$ENV_FILE"; then
    tmp=$(mktemp)
    K="$key" V="$val" awk 'BEGIN { FS = "=" } $1 == ENVIRON["K"] { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

env_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }

env_del() {
  [ -f "$ENV_FILE" ] || return 0
  local tmp; tmp=$(mktemp)
  grep -v -E "^$1=" "$ENV_FILE" > "$tmp" || true
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

# Which settings Console runs with, depending on whether there is a domain.
write_env() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE" 2>/dev/null || true
  env_set PORT "$PORT"
  env_default CONSOLE_ADMIN_USER admin
  env_default CONSOLE_DB "$DIR/data/console.db"
  env_default CONSOLE_SERVERS "$DIR/servers.json"
  if [ -n "$DOMAIN" ]; then
    # Behind Caddy: only Caddy talks to Console, over loopback, and cookies are HTTPS-only.
    env_set HOST 127.0.0.1
    env_set CONSOLE_SECURE_COOKIES 1
    env_set CONSOLE_TRUST_PROXY 1
    env_set CONSOLE_DOMAIN "$DOMAIN"
  else
    # Plain HTTP: secure-only cookies would make login impossible, so they must be off.
    env_set HOST 0.0.0.0
    env_del CONSOLE_SECURE_COOKIES
    env_del CONSOLE_TRUST_PROXY
    env_del CONSOLE_DOMAIN
  fi
  if [ "$BRANCH" = main ]; then env_del CONSOLE_UPDATE_BRANCH; else env_set CONSOLE_UPDATE_BRANCH "$BRANCH"; fi
}

render_caddyfile() { # domain port
  cat <<EOF
# Managed by the Console installer. Re-running the installer rewrites this file.
$1 {
    encode gzip
    reverse_proxy 127.0.0.1:$2
}
EOF
}

render_unit() { # node_bin dir env_file
  sed -e "s|^ExecStart=.*|ExecStart=$1 server/src/index.js|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$2|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=$3|" \
      "$2/deploy/console.service"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)   [ $# -ge 2 ] || die "--domain needs a value"; DOMAIN="$2"; shift 2 ;;
      --domain=*) DOMAIN="${1#*=}"; shift ;;
      --ip-only)  IP_ONLY=1; shift ;;
      --port)     [ $# -ge 2 ] || die "--port needs a value"; PORT_FLAG="$2"; shift 2 ;;
      --branch)   [ $# -ge 2 ] || die "--branch needs a value"; BRANCH="$2"; shift 2 ;;
      --dir)      [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
      --yes|-y)   ASSUME_YES=1; shift ;;
      -h|--help)  usage; exit 0 ;;
      *)          die "Unknown option: $1 (try --help)" ;;
    esac
  done
  if [ -n "$DOMAIN" ]; then
    DOMAIN=$(normalize_domain "$DOMAIN")
    valid_domain "$DOMAIN" || die "That doesn't look like a valid domain name: $DOMAIN"
  fi
  if [ -n "$PORT_FLAG" ]; then
    [[ $PORT_FLAG =~ ^[0-9]+$ ]] && [ "$PORT_FLAG" -ge 1 ] && [ "$PORT_FLAG" -le 65535 ] || die "Bad port: $PORT_FLAG"
  fi
  [[ $BRANCH =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "Bad branch name: $BRANCH"
  [[ $DIR =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir must be an absolute path with simple characters: $DIR"
}

# ---- questions -------------------------------------------------------------------

detect_tty() {
  if [ "$ASSUME_YES" -eq 0 ] && ( : </dev/tty ) 2>/dev/null; then HAVE_TTY=1; fi
}
ask()        { local a=""; read -r -p "$1" a </dev/tty || a=""; printf '%s' "$a"; }
ask_secret() { local a=""; read -r -s -p "$1" a </dev/tty || a=""; echo >&2; printf '%s' "$a"; }

choose_mode() {
  if [ "$IP_ONLY" -eq 1 ]; then DOMAIN=""; return; fi
  if [ -z "$DOMAIN" ]; then
    DOMAIN=$(env_get CONSOLE_DOMAIN)   # remembered from the last run
  fi
  if [ -z "$DOMAIN" ] && [ "$HAVE_TTY" -eq 1 ]; then
    echo
    echo "  A domain gives you HTTPS (safe logins, a padlock) at an address like console.example.com."
    echo "  No domain yet? Press Enter. You can run this command again later with --domain."
    local d; d=$(ask "  Domain (blank = use the server's IP for now): ")
    if [ -n "$d" ]; then
      DOMAIN=$(normalize_domain "$d")
      valid_domain "$DOMAIN" || die "That doesn't look like a valid domain name: $DOMAIN"
    fi
  fi
  if [ -n "$DOMAIN" ] && [ -z "$CF_TOKEN" ] && [ "$HAVE_TTY" -eq 1 ] && ! dns_points_to "$DOMAIN" "${PUBLIC_IP:-none}"; then
    echo
    echo "  I can create the DNS record for you if the domain is on Cloudflare."
    echo "  Make a token at https://dash.cloudflare.com/profile/api-tokens using the 'Edit zone DNS'"
    echo "  template, limited to your domain's zone, and paste it here. (Press Enter to skip and add"
    echo "  the record yourself. The token is used once and never saved.)"
    CF_TOKEN=$(ask_secret "  Cloudflare API token: ")
  fi
}

# ---- system setup ------------------------------------------------------------------

detect_pm() {
  if   command -v dnf     >/dev/null 2>&1; then PM=dnf
  elif command -v yum     >/dev/null 2>&1; then PM=yum
  elif command -v apt-get >/dev/null 2>&1; then PM=apt
  else die "Unsupported system: I need dnf, yum or apt-get."; fi
}

pkg_install() {
  if [ "$PM" = apt ]; then
    if [ "$APT_UPDATED" -eq 0 ]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  else
    "$PM" install -y -q "$@" >/dev/null
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}

install_base() {
  local missing=()
  command -v git  >/dev/null 2>&1 || missing+=(git)
  command -v tmux >/dev/null 2>&1 || missing+=(tmux)
  command -v tar  >/dev/null 2>&1 || missing+=(tar) # backups
  if [ "${#missing[@]}" -gt 0 ]; then pkg_install "${missing[@]}"; ok "Installed ${missing[*]}"; else ok "git, tmux and tar are present"; fi

  if node_ok; then
    ok "Node $(node -v) is present"
  else
    info "Installing Node 22 (this is the slow part)..."
    if [ "$PM" = apt ]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    else
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    fi
    pkg_install nodejs
    hash -r
    node_ok || die "Node 22.13 or newer is required but the install didn't give me one."
    ok "Installed Node $(node -v)"
  fi
}

ensure_user() {
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /bin/bash "$SVC_USER"
    ok "Created user '$SVC_USER'"
  else
    ok "User '$SVC_USER' exists"
  fi
  SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6)
}

as_svc() { runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" "$@"; }

fetch_code() {
  if [ -d "$DIR/.git" ]; then
    chown -R "$SVC_USER:$SVC_USER" "$DIR"
    local before after cur
    before=$(as_svc git -C "$DIR" rev-parse --short HEAD)
    cur=$(as_svc git -C "$DIR" rev-parse --abbrev-ref HEAD)
    [ "$cur" = "$BRANCH" ] || warn "$DIR is on branch '$cur' but --branch is '$BRANCH'. Updating '$cur' from '$BRANCH'."
    as_svc env GIT_TERMINAL_PROMPT=0 git -C "$DIR" fetch --quiet origin "$BRANCH" \
      || die "Couldn't download updates from $REPO. Check the server's internet access."
    as_svc git -C "$DIR" merge --ff-only --quiet FETCH_HEAD \
      || die "Couldn't fast-forward $DIR (it has local changes or its own commits). Look with: git -C $DIR status"
    after=$(as_svc git -C "$DIR" rev-parse --short HEAD)
    if [ "$before" = "$after" ]; then ok "Already on the latest version ($after)"; else ok "Updated $before -> $after"; fi
  elif [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
    die "$DIR exists but isn't a Console checkout. Move it away or choose another place with --dir."
  else
    mkdir -p "$DIR"; chown "$SVC_USER:$SVC_USER" "$DIR"
    as_svc env GIT_TERMINAL_PROMPT=0 git clone --quiet --branch "$BRANCH" "$REPO" "$DIR" \
      || die "Couldn't download Console from $REPO"
    ok "Downloaded Console"
  fi
}

build_app() {
  info "Installing dependencies and building the dashboard..."
  as_svc npm --prefix "$DIR" install --no-audit --no-fund --loglevel=error
  as_svc npm --prefix "$DIR" run build --silent
  ok "Built"
}

# First run only: make sure there's an admin password to create the account with.
prepare_admin() {
  local db; db=$(env_get CONSOLE_DB)
  if [ -f "$db" ]; then ADMIN_PW_NOTE=existing; return; fi
  if [ -n "${ADMIN_PW_PRESET:-}" ]; then
    [[ $ADMIN_PW_PRESET =~ ^[A-Za-z0-9_.@%+,:=-]{10,}$ ]] \
      || die "CONSOLE_ADMIN_PASSWORD must be 10+ characters from A-Z a-z 0-9 _ . @ % + , : = -"
    env_set CONSOLE_ADMIN_PASSWORD "$ADMIN_PW_PRESET"; ADMIN_PW_NOTE=preset
  elif [ -z "$(env_get CONSOLE_ADMIN_PASSWORD)" ]; then
    ADMIN_PW=$(node -e 'process.stdout.write(require("crypto").randomBytes(15).toString("base64url"))')
    env_set CONSOLE_ADMIN_PASSWORD "$ADMIN_PW"; ADMIN_PW_NOTE=generated
  else
    ADMIN_PW_NOTE=preset
  fi
}

http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }

wait_for() { # url seconds: 0 once the URL answers with any HTTP status
  local i=0 code
  while [ "$i" -lt "$2" ]; do
    code=$(http_code "$1")
    if [ -n "$code" ] && [ "$code" != 000 ]; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

install_service() {
  render_unit "$(command -v node)" "$DIR" "$ENV_FILE" > /etc/systemd/system/console.service
  systemctl daemon-reload
  systemctl enable console >/dev/null 2>&1
  systemctl restart console
  if wait_for "http://127.0.0.1:$PORT/api/me" 30; then
    ok "Console is up"
  else
    journalctl -u console -n 25 --no-pager >&2 || true
    die "Console didn't start. The last log lines are above."
  fi
  # The password is only needed for the very first start. Don't keep it lying around.
  if [ -f "$(env_get CONSOLE_DB)" ]; then env_del CONSOLE_ADMIN_PASSWORD; fi
}

# ---- network ------------------------------------------------------------------------

open_ports() {
  local p pos
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for p in "$@"; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
    firewall-cmd --reload >/dev/null
    ok "Opened port(s) $* in firewalld"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for p in "$@"; do ufw allow "$p/tcp" >/dev/null; done
    ok "Opened port(s) $* in ufw"
  elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -qE -- '(-j (REJECT|DROP))|(-P INPUT DROP)'; then
    for p in "$@"; do
      if ! iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
        pos=$(iptables -L INPUT --line-numbers -n 2>/dev/null | awk '$2=="REJECT"||$2=="DROP"{print $1; exit}')
        iptables -I INPUT "${pos:-1}" -p tcp --dport "$p" -j ACCEPT
      fi
    done
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1 && ok "Opened port(s) $* in iptables (saved)"
    elif command -v service >/dev/null 2>&1 && service iptables save >/dev/null 2>&1; then
      ok "Opened port(s) $* in iptables (saved)"
    else
      warn "Opened port(s) $* in iptables, but couldn't save it. It may reset on reboot."
    fi
  else
    ok "No firewall on this machine is blocking ports"
  fi
}

detect_cloud() {
  if curl -fsS -m 2 -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/ >/dev/null 2>&1; then
    IS_OCI=1
  fi
}

find_public_ip() {
  local u ip
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -4 -fsS -m 6 "$u" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ $ip =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then PUBLIC_IP=$ip; return 0; fi
  done
  return 1
}

dns_points_to() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qx "$2"; }

# ---- domain: Caddy + DNS --------------------------------------------------------------

install_caddy_binary() {
  if systemctl cat caddy.service >/dev/null 2>&1; then ok "Caddy is already installed"; return; fi
  info "Installing Caddy (the HTTPS front door)..."
  local arch tag ver file tmp expected actual
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Caddy isn't set up for this CPU type: $(uname -m)" ;;
  esac
  tmp=$(mktemp -d)
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/caddyserver/caddy/releases/latest 2>/dev/null || true)
  tag=${tag##*/}
  if [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ver=${tag#v}; file="caddy_${ver}_linux_${arch}.tar.gz"
    if ! curl -fsSL -o "$tmp/$file" "https://github.com/caddyserver/caddy/releases/download/$tag/$file" ||
       ! curl -fsSL -o "$tmp/sums" "https://github.com/caddyserver/caddy/releases/download/$tag/caddy_${ver}_checksums.txt"; then
      die "Couldn't download Caddy from GitHub."
    fi
    expected=$(awk -v f="$file" '$2==f {print $1}' "$tmp/sums")
    if [ "${#expected}" -eq 128 ]; then actual=$(sha512sum "$tmp/$file" | awk '{print $1}')
    else actual=$(sha256sum "$tmp/$file" | awk '{print $1}'); fi
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "Caddy download failed its checksum. Not installing it."
    tar -xzf "$tmp/$file" -C "$tmp" caddy
  else
    warn "Couldn't work out the latest Caddy version, using the official download service instead."
    curl -fsSL -o "$tmp/caddy" "https://caddyserver.com/api/download?os=linux&arch=$arch" \
      || die "Couldn't download Caddy."
  fi
  install -m 0755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"

  id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  mkdir -p "$CADDY_DIR"
  cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy web server
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  ok "Installed Caddy $(/usr/local/bin/caddy version | awk '{print $1}')"
}

reload_or_start_caddy() {
  systemctl enable caddy >/dev/null 2>&1
  if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
}

configure_caddy() {
  mkdir -p "$CADDY_DIR"
  render_caddyfile "$DOMAIN" "$PORT" > "$CADDY_DIR/console.caddy"
  # Our site lives in its own file, pulled in by one import line. Any other sites in the Caddyfile are untouched.
  local main="$CADDY_DIR/Caddyfile" line="import $CADDY_DIR/console.caddy"
  [ -f "$main" ] || : > "$main"
  grep -qxF "$line" "$main" || printf '\n%s\n' "$line" >> "$main"
  if ! caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config "$main" --adapter caddyfile >&2 || true
    die "Caddy didn't accept the generated config (shown above)."
  fi
  reload_or_start_caddy
  ok "Caddy is serving $DOMAIN"
}

drop_caddy_site() { # switching back to IP-only mode
  if [ -f "$CADDY_DIR/console.caddy" ]; then
    rm -f "$CADDY_DIR/console.caddy"; : > "$CADDY_DIR/console.caddy"
    if systemctl is-active --quiet caddy; then systemctl reload caddy || true; fi
  fi
}

setup_dns() {
  if dns_points_to "$DOMAIN" "$PUBLIC_IP"; then DNS_OK=1; ok "$DOMAIN already points at $PUBLIC_IP"; return; fi
  if [ -z "$PUBLIC_IP" ]; then warn "Couldn't work out this server's public IP, so I can't create the DNS record."; return; fi
  if [ -n "$CF_TOKEN" ]; then
    local out
    if out=$(CF_API_TOKEN="$CF_TOKEN" node "$DIR/scripts/cf-dns.mjs" "$DOMAIN" "$PUBLIC_IP" 2>&1); then
      ok "Cloudflare: $out"
      info "Waiting for DNS to show up (up to 90 seconds)..."
      local i=0
      while [ "$i" -lt 18 ]; do
        if dns_points_to "$DOMAIN" "$PUBLIC_IP"; then DNS_OK=1; ok "$DOMAIN now resolves to $PUBLIC_IP"; return; fi
        sleep 5; i=$((i + 1))
      done
      warn "The record is created but this server can't see it yet. That's normal, it can take a few minutes."
    else
      warn "Cloudflare said: $out"
    fi
  fi
  if [ "$DNS_OK" -eq 0 ]; then
    echo
    echo "  Add this DNS record where your domain's DNS is managed:"
    echo "      Type: A      Name: $DOMAIN      Value: ${PUBLIC_IP}      Proxy: OFF (DNS only / grey cloud)"
    echo "  Caddy keeps retrying by itself, so HTTPS turns on as soon as the record exists."
  fi
}

setup_domain() {
  say "Domain: $DOMAIN"
  setup_dns
  configure_caddy
  open_ports 80 443
  info "Getting an HTTPS certificate (up to 90 seconds)..."
  if wait_for "https://$DOMAIN/api/me" 90; then CERT_OK=1; ok "HTTPS works: https://$DOMAIN"
  else warn "HTTPS isn't answering yet. Usually that means DNS hasn't spread, or ports 80/443 aren't open in your cloud firewall. Watch it: journalctl -u caddy -f"; fi
}

# ---- final report ----------------------------------------------------------------------

print_summary() {
  local sha url ports src
  sha=$(as_svc git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
  if [ -n "$DOMAIN" ]; then url="https://$DOMAIN"; else url="http://${PUBLIC_IP:-<your-server-ip>}:$PORT"; fi
  echo
  echo "${B}================================================================${N}"
  echo "${B}  Console is installed${N}  (version $sha)"
  echo
  echo "  Open it:   $url"
  case "$ADMIN_PW_NOTE" in
    generated) echo "  Sign in:   $(env_get CONSOLE_ADMIN_USER)  /  $ADMIN_PW"
               echo "             ^ shown once, save it now. Change it from the Account button." ;;
    preset)    echo "  Sign in:   $(env_get CONSOLE_ADMIN_USER)  /  the password you set" ;;
    existing)  echo "  Sign in:   with your existing account (nothing was reset)" ;;
  esac
  if [ -z "$DOMAIN" ]; then
    echo
    echo "  ${Y}This is plain HTTP, so your password crosses the internet unencrypted.${N}"
    echo "  Limit the firewall rule to your own IP, or run this command again with --domain"
    echo "  to get HTTPS."
  fi
  ports=$PORT; src="YOUR.IP.ADDRESS/32"
  if [ -n "$DOMAIN" ]; then ports="80 and 443"; src="0.0.0.0/0"; fi
  echo
  if [ "$IS_OCI" -eq 1 ]; then
    echo "  One thing only you can do (Oracle blocks everything by default):"
    echo "    Oracle Cloud console > Networking > Virtual Cloud Networks > your VCN > Security Lists"
    echo "    > Add Ingress Rules:  Source CIDR $src   Protocol TCP   Destination port $ports"
  else
    echo "  If the page doesn't load, open TCP $ports in your cloud provider's firewall / security group."
  fi
  if [ -n "$DOMAIN" ] && [ "$CERT_OK" -eq 0 ]; then
    echo
    echo "  HTTPS isn't live yet (see the note above). It switches on by itself once DNS and the ports are right."
  fi
  echo
  echo "  Update later:  click Updates in the dashboard, or run this again:"
  echo "                 curl -fsSL $RAW_URL | sudo bash"
  echo "  Your servers:  edit $DIR/servers.json, then: sudo systemctl restart console"
  echo "  Logs:          sudo journalctl -u console -f"
  echo "${B}================================================================${N}"
}

# ---- main ----------------------------------------------------------------------------------

main() {
  # The script may be arriving on stdin (curl | bash). Make sure no command below can swallow the rest of it.
  exec </dev/null
  # Secrets from the environment: take them, then keep them away from every child process.
  CF_TOKEN="${CF_API_TOKEN:-}";             unset CF_API_TOKEN
  ADMIN_PW_PRESET="${CONSOLE_ADMIN_PASSWORD:-}"; unset CONSOLE_ADMIN_PASSWORD

  parse_args "$@"
  [ "$(id -u)" -eq 0 ] || die "Run this as root:  curl -fsSL $RAW_URL | sudo bash"
  [ -d /run/systemd/system ] || die "This needs a Linux with systemd (Oracle Linux, Ubuntu, Debian, ...)."
  detect_pm
  detect_tty
  detect_cloud
  find_public_ip || warn "Couldn't look up this server's public IP."

  say "Console installer"
  PORT=${PORT_FLAG:-$(env_get PORT)}; PORT=${PORT:-3000}
  choose_mode
  if [ -n "$DOMAIN" ]; then info "Mode: HTTPS at https://$DOMAIN"; else info "Mode: plain HTTP on port $PORT (no domain)"; fi

  say "Installing what's needed"
  install_base
  ensure_user
  if [ -n "$DOMAIN" ]; then install_caddy_binary; fi

  say "Getting the latest Console"
  fetch_code
  build_app

  say "Configuring"
  write_env
  prepare_admin
  ok "Wrote $ENV_FILE"

  say "Starting Console"
  install_service

  if [ -n "$DOMAIN" ]; then
    setup_domain
  else
    say "Network"
    drop_caddy_site
    open_ports "$PORT"
  fi

  print_summary
}

# Tests load this file with CONSOLE_INSTALL_SOURCE_ONLY=1 to reach the helper functions without running anything.
# Keep `main "$@"` as the very last line that runs: bash reads piped scripts as it goes.
if [ "${CONSOLE_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then
  main "$@"
fi
