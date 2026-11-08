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
#   --user NAME     Linux user Console runs as (default: the user who ran sudo, e.g. opc; else a new 'console' user)
#   --minecraft     set this machine up as a Minecraft host (simpler menu, Minecraft first). --standard turns it off.
#   --reconfigure   run the setup wizard again on an existing install (mode, address, port)
#   --docker [NAME] create (or update) an isolated Console in a Docker container instead. Runs side by side with
#                   the main install: its own data, port and servers. --docker-remove NAME [--purge] removes one.
#   --yes           never ask questions (use the environment variables below to set things)
# Environment
#   CF_API_TOKEN              Cloudflare token (Zone:Read + DNS:Edit). Used once, never stored or printed.
#   CONSOLE_ADMIN_PASSWORD    first install only. Otherwise a random one is generated and shown once.
#   CONSOLE_GITHUB_TOKEN, CONSOLE_GITHUB_ORG, CONSOLE_TIMEZONE, CONSOLE_ALERT_WEBHOOK, CONSOLE_BACKUP_KEEP,
#   CONSOLE_ENABLE_TERMINAL=1, CONSOLE_ENABLE_LINUX_USERS=1   first-run settings (the wizard asks for these;
#                             with --yes you can pass them here). Never overwrite what you set in the dashboard.
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
SVC_USER=""
USER_FLAG="${CONSOLE_USER:-}"
CADDY_DIR="/etc/caddy"

IP_ONLY=0
MODE_FLAG="${CONSOLE_MODE_FLAG:-}"
ASSUME_YES=0
RECONFIGURE=0
DOCKER_MODE=0
DOCKER_NAME=""
DOCKER_REMOVE=""
DOCKER_PURGE=0
DOCKER_SRC="${CONSOLE_DOCKER_SRC:-/opt/console-docker/src}"
DOCKER_ENV_DIR="${CONSOLE_DOCKER_ENV_DIR:-/etc/console-docker}"
DOCKER_IMAGE="console:local"
D_PORT=""
D_PORTS=""
D_PUBLIC=1
D_MEM=""
D_CPUS=""
WIZ_ADMIN_USER=
WIZ_GH_TOKEN=
WIZ_GH_ORG=
WIZ_TZ=
WIZ_WEBHOOK=
WIZ_KEEP=
WIZ_TERMINAL=0
WIZ_LINUX=0
WIZ_RAN=0
HAVE_TTY=0
PM=""
APT_UPDATED=0
SVC_HOME=""
PORT=3000
PUBLIC_IP=""
IS_OCI=0
ADMIN_PW=""
ADMIN_PW_PRESET=""
ADMIN_PW_NOTE=""
CF_TOKEN=""
CERT_OK=0
DNS_OK=0

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; D=$'\033[2m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; C=""; D=""; N=""; fi
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
  --user NAME     Linux user Console runs as (default: you, the user who ran sudo)
  --minecraft     set this machine up as a Minecraft host (--standard turns that off)
  --reconfigure   run the setup wizard again on an existing install
  --docker [NAME] an isolated Console in Docker (own data, own port; side by side with the main one)
  --docker-remove NAME [--purge]   remove a Docker instance (--purge also deletes its data)
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
  [ -z "$SVC_USER" ] || env_set CONSOLE_RUN_USER "$SVC_USER"
  # Minecraft mode is remembered; --standard switches it off again.
  case "$MODE_FLAG" in minecraft) env_set CONSOLE_MODE minecraft ;; standard) env_del CONSOLE_MODE ;; esac
  [ -z "$PUBLIC_IP" ] || env_set CONSOLE_PUBLIC_IP "$PUBLIC_IP"
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

# The unit for a given user. A normal login user (like opc) also needs sudo for system services and Linux-user
# management, and NoNewPrivileges would block that, so it is only kept for the locked-down 'console' user.
render_unit() { # node_bin dir env_file [user]
  local user=${4:-console}
  sed -e "s|^ExecStart=.*|ExecStart=$1 server/src/index.js|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$2|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=$3|" \
      -e "s|^User=.*|User=$user|" \
      "$2/deploy/console.service" | { if [ "$user" = console ]; then cat; else grep -v '^NoNewPrivileges='; fi; }
}

valid_username() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$1" != root ]; }

# Who Console runs as: --user/CONSOLE_USER, else what was used last time, else whoever ran sudo, else 'console'.
pick_user() {
  local u="$USER_FLAG"
  [ -n "$u" ] || u=$(env_get CONSOLE_RUN_USER)
  if [ -z "$u" ] && [ -n "${SUDO_USER:-}" ] && valid_username "$SUDO_USER" && id "$SUDO_USER" >/dev/null 2>&1; then u="$SUDO_USER"; fi
  SVC_USER=${u:-console}
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
      --user)     [ $# -ge 2 ] || die "--user needs a value"; USER_FLAG="$2"; shift 2 ;;
      --minecraft) MODE_FLAG=minecraft; shift ;;
      --standard) MODE_FLAG=standard; shift ;;
      --reconfigure) RECONFIGURE=1; shift ;;
      --docker)   DOCKER_MODE=1; shift
                  if [ $# -gt 0 ] && [[ $1 != -* ]]; then DOCKER_NAME="$1"; shift; fi ;;
      --docker-remove) [ $# -ge 2 ] || die "--docker-remove needs a name"; DOCKER_REMOVE="$2"; shift 2 ;;
      --purge)    DOCKER_PURGE=1; shift ;;
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
  [ -z "$USER_FLAG" ] || valid_username "$USER_FLAG" || die "Bad user name: $USER_FLAG"
  [ -z "$DOCKER_NAME" ] || valid_instance "$DOCKER_NAME" || die "Docker instance names use a-z, 0-9, - and _ (max 31): $DOCKER_NAME"
  [ -z "$DOCKER_REMOVE" ] || valid_instance "$DOCKER_REMOVE" || die "Docker instance names use a-z, 0-9, - and _ (max 31): $DOCKER_REMOVE"
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


# ---- the setup wizard (only when a person is at the keyboard) ------------------------

# Pure checks, unit-tested.
valid_password() { [[ $1 =~ ^[A-Za-z0-9_.@%+,:=-]{10,}$ ]]; }
valid_org()      { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; }
valid_hook()     { [[ $1 =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[^[:space:]]+$ ]] && [[ ${#1} -le 500 ]]; }
valid_tz()       { [[ $1 =~ ^[A-Za-z0-9_+/-]{1,64}$ ]] && [[ $1 != *..* ]] && [ -e "/usr/share/zoneinfo/$1" ]; }
valid_token()    { [[ $1 =~ ^[A-Za-z0-9_-]{20,255}$ ]]; }
mask_tail()      { local s=$1; if [ "${#s}" -gt 6 ]; then printf '••••%s' "${s: -4}"; else printf '••••'; fi; }

banner() {
  printf '\n%s' "$C"
  cat <<'ART'
   ___                      _
  / __|___ _ _  ___ ___| |___
 | (__/ _ \ ' \(_-</ _ \ / -_)
  \___\___/_||_/__/\___/_\___|
ART
  printf '%s  %sA friendly server manager. This takes about two minutes.%s\n' "$N" "$D" "$N"
}

WIZ_STEP=0; WIZ_TOTAL=5
step() { WIZ_STEP=$((WIZ_STEP + 1)); printf '\n%s[%s/%s]%s %s%s%s\n' "$C" "$WIZ_STEP" "$WIZ_TOTAL" "$N" "$B" "$1" "$N"; }
hint() { printf '    %s%s%s\n' "$D" "$*" "$N"; }

ask_default() { # prompt default -> value
  local a; a=$(ask "    $1 [$2]: "); printf '%s' "${a:-$2}"
}
yes_no() { # prompt default(y|n) -> 0 for yes
  local def=$2 a hintstr="y/N"; [ "$def" = y ] && hintstr="Y/n"
  a=$(ask "    $1 [$hintstr]: "); a=${a:-$def}
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

wizard() {
  local first=0 choice db
  db=$(env_get CONSOLE_DB); db=${db:-$DIR/data/console.db}
  [ -f "$db" ] || first=1
  WIZ_RAN=1
  [ "$first" -eq 1 ] && WIZ_TOTAL=5 || WIZ_TOTAL=2
  banner

  step "What is this machine for?"
  if [ -z "$MODE_FLAG" ]; then
    local saved; saved=$(env_get CONSOLE_MODE)
    echo "      1) Minecraft host   simpler menu, Minecraft tools first (players, plugins, backups)"
    echo "      2) General          any kind of server, bot, website or Docker app"
    choice=$(ask_default "Pick one" "$([ "$saved" = minecraft ] && echo 1 || echo 2)")
    case "$choice" in 1|m|M) MODE_FLAG=minecraft ;; *) MODE_FLAG=standard ;; esac
  fi
  ok "Mode: $([ "$MODE_FLAG" = minecraft ] && echo 'Minecraft host' || echo 'General')"

  if [ "$first" -eq 1 ]; then
    step "Your admin account"
    hint "You'll sign in with this. Change it any time from the Account button."
    WIZ_ADMIN_USER=$(ask_default "Username" "admin")
    valid_username "$WIZ_ADMIN_USER" || [ "$WIZ_ADMIN_USER" = admin ] || { warn "Letters, numbers, - and _ only. Using 'admin'."; WIZ_ADMIN_USER=admin; }
    if [ -z "$ADMIN_PW_PRESET" ]; then
      if yes_no "Make up a strong password for me?" y; then
        ok "I'll generate one and show it once at the end."
      else
        local p1 p2
        while :; do
          p1=$(ask_secret "    Password (10+ characters; letters, numbers, _ . @ % + , : = -): ")
          if ! valid_password "$p1"; then warn "Too short, or it has a character I can't pass safely. Try again."; continue; fi
          p2=$(ask_secret "    Type it again: ")
          [ "$p1" = "$p2" ] && break
          warn "They didn't match."
        done
        ADMIN_PW_PRESET=$p1
        ok "Password set."
      fi
    fi
  fi

  step "Where will you open it?"
  choose_mode
  if [ -z "$PORT_FLAG" ] && [ -z "$(env_get PORT)" ] && [ -z "$DOMAIN" ]; then
    local pt; pt=$(ask_default "Port" "3000")
    if [[ $pt =~ ^[0-9]+$ ]] && [ "$pt" -ge 1 ] && [ "$pt" -le 65535 ]; then PORT=$pt; else warn "That isn't a valid port. Using 3000."; fi
  fi

  if [ "$first" -eq 1 ]; then
    step "GitHub (optional)"
    hint "Lets Console install plugins from your private repos and back servers up to GitHub."
    hint "Make a token at https://github.com/settings/personal-access-tokens (Contents: read & write)."
    local t
    t=$(ask_secret "    Token (Enter to skip): ")
    if [ -n "$t" ]; then
      if valid_token "$t"; then WIZ_GH_TOKEN=$t; ok "Token saved ($(mask_tail "$t"))"; else warn "That doesn't look like a GitHub token, skipping. Add it later in Settings."; fi
    fi
    if [ -n "$WIZ_GH_TOKEN" ] || yes_no "Do you have a GitHub org or user whose repos hold your plugins?" n; then
      local o; o=$(ask "    Org or username (Enter to skip): ")
      if [ -n "$o" ]; then if valid_org "$o"; then WIZ_GH_ORG=$o; else warn "That isn't a valid GitHub name, skipping."; fi; fi
    fi

    step "Extras (all optional)"
    local tz; tz=$(timedatectl show -p Timezone --value 2>/dev/null || true)
    tz=$(ask_default "Time zone for schedules" "${tz:-UTC}")
    if valid_tz "$tz"; then WIZ_TZ=$tz; else warn "Unknown time zone, leaving it for later."; fi
    local k; k=$(ask_default "Backups to keep per server" "7")
    if [[ $k =~ ^[0-9]+$ ]] && [ "$k" -ge 1 ] && [ "$k" -le 50 ]; then WIZ_KEEP=$k; fi
    local w; w=$(ask "    Discord/Slack webhook for down alerts (Enter to skip): ")
    if [ -n "$w" ]; then if valid_hook "$w"; then WIZ_WEBHOOK=$w; ok "Alerts on"; else warn "Needs to be an https:// URL. Skipping."; fi; fi
    hint "Advanced tools give admins a shell in the browser. Leave them off unless you want them."
    if yes_no "Turn on the web terminal?" n; then WIZ_TERMINAL=1; fi
    if yes_no "Turn on Linux user management?" n; then WIZ_LINUX=1; fi
  fi

  printf '\n%s%s%s\n' "$B" "Ready to install" "$N"
  echo "    Mode:      $([ "$MODE_FLAG" = minecraft ] && echo 'Minecraft host' || echo 'General')"
  [ "$first" -eq 1 ] && echo "    Admin:     $WIZ_ADMIN_USER ($([ -n "$ADMIN_PW_PRESET" ] && echo 'your password' || echo 'generated password'))"
  echo "    Address:   $([ -n "$DOMAIN" ] && echo "https://$DOMAIN" || echo "http://${PUBLIC_IP:-<ip>}:$PORT")"
  [ -n "$WIZ_GH_TOKEN" ] && echo "    GitHub:    token $(mask_tail "$WIZ_GH_TOKEN")${WIZ_GH_ORG:+, org $WIZ_GH_ORG}"
  [ -n "$WIZ_TZ$WIZ_KEEP" ] && echo "    Schedules: ${WIZ_TZ:-default zone}, keep ${WIZ_KEEP:-7} backups"
  [ -n "$WIZ_WEBHOOK" ] && echo "    Alerts:    webhook set"
  [ "$WIZ_TERMINAL$WIZ_LINUX" != 00 ] && echo "    Advanced:  $([ "$WIZ_TERMINAL" = 1 ] && echo 'terminal ')$([ "$WIZ_LINUX" = 1 ] && echo 'linux-users')"
  echo
  yes_no "Go?" y || die "Cancelled. Nothing was changed."
}

# Hand the wizard's answers to Console through the env file; Console applies each one once, only where nothing is saved yet.
write_wizard_env() {
  [ -z "$WIZ_ADMIN_USER" ] || env_set CONSOLE_ADMIN_USER "$WIZ_ADMIN_USER"
  [ -z "$WIZ_GH_TOKEN" ] || env_set CONSOLE_GITHUB_TOKEN "$WIZ_GH_TOKEN"
  [ -z "$WIZ_GH_ORG" ] || env_set CONSOLE_GITHUB_ORG "$WIZ_GH_ORG"
  [ -z "$WIZ_TZ" ] || env_set CONSOLE_TIMEZONE "$WIZ_TZ"
  [ -z "$WIZ_KEEP" ] || env_set CONSOLE_BACKUP_KEEP "$WIZ_KEEP"
  [ -z "$WIZ_WEBHOOK" ] || env_set CONSOLE_ALERT_WEBHOOK "$WIZ_WEBHOOK"
  [ "$WIZ_TERMINAL" != 1 ] || env_set CONSOLE_ENABLE_TERMINAL 1
  [ "$WIZ_LINUX" != 1 ] || env_set CONSOLE_ENABLE_LINUX_USERS 1
  return 0
}
clear_wizard_env() {
  local k
  for k in CONSOLE_GITHUB_TOKEN CONSOLE_GITHUB_ORG CONSOLE_TIMEZONE CONSOLE_BACKUP_KEEP CONSOLE_ALERT_WEBHOOK CONSOLE_ENABLE_TERMINAL CONSOLE_ENABLE_LINUX_USERS; do env_del "$k"; done
}

# Runs a command with a spinner; shows the tail of its output only if it fails.
spin() { # message cmd args...
  local msg=$1; shift
  local log pid i=0 frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' rc=0
  log=$(mktemp)
  "$@" >"$log" 2>&1 &
  pid=$!
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s' "$C" "${frames:$((i % 10)):1}" "$N" "$msg"
      i=$((i + 1)); sleep 0.1
    done
    printf '\r\033[K'
  fi
  wait "$pid" || rc=$?
  if [ "$rc" -eq 0 ]; then ok "$msg"; else
    warn "$msg failed. Last lines:"; tail -n 20 "$log" >&2; rm -f "$log"; return "$rc"
  fi
  rm -f "$log"
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
  pick_user
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    [ "$SVC_USER" = console ] || die "The user '$SVC_USER' doesn't exist on this machine."
    useradd --system --create-home --shell /bin/bash "$SVC_USER"
    ok "Created user '$SVC_USER'"
  else
    ok "Console will run as '$SVC_USER'"
  fi
  SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6)
}

as_svc() { runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" "$@"; }

fetch_code() {
  if [ -d "$DIR/.git" ]; then
    chown -R "$SVC_USER:$(id -gn "$SVC_USER")" "$DIR"
    local before after cur
    # npm can rewrite the lockfile on the server; that's the one local change we always throw away.
    as_svc git -C "$DIR" checkout -- package-lock.json 2>/dev/null || true
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
    mkdir -p "$DIR"; chown "$SVC_USER:$(id -gn "$SVC_USER")" "$DIR"
    as_svc env GIT_TERMINAL_PROMPT=0 git clone --quiet --branch "$BRANCH" "$REPO" "$DIR" \
      || die "Couldn't download Console from $REPO"
    ok "Downloaded Console"
  fi
}

build_app() {
  spin "Installing dependencies" as_svc npm --prefix "$DIR" install --no-package-lock --no-audit --no-fund --loglevel=error
  spin "Building the dashboard" as_svc npm --prefix "$DIR" run build --silent
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
  render_unit "$(command -v node)" "$DIR" "$ENV_FILE" "$SVC_USER" > /etc/systemd/system/console.service
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
  if [ -f "$(env_get CONSOLE_DB)" ]; then env_del CONSOLE_ADMIN_PASSWORD; clear_wizard_env; fi
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
  # Websites made with Console's one-click "Website" setup live here, one small file each. Console can write
  # this folder (it is owned by the Console user) and asks Caddy to reload with sudo.
  mkdir -p "$CADDY_DIR/sites" /srv/sites
  chown "$SVC_USER:$(id -gn "$SVC_USER")" "$CADDY_DIR/sites" /srv/sites
  [ -e "$CADDY_DIR/sites/00-readme.caddy" ] || printf '# Sites created by Console go in this folder.\n' > "$CADDY_DIR/sites/00-readme.caddy"
  local sites="import $CADDY_DIR/sites/*.caddy"
  grep -qxF "$sites" "$main" || printf '%s\n' "$sites" >> "$main"
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


# ---- Docker instances: an isolated Console that runs side by side with the main one ----------------
# Handy for things you share, separate projects, testing, or keeping configs apart. Each instance has its own
# data volume, port, admin account and servers, and cannot see the host's files, services or other instances.

valid_instance() { [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]]; }
valid_ports()    { # "none" or comma-separated TCP ports
  local p; [ "$1" = none ] && return 0
  [ -n "$1" ] || return 1
  IFS=, read -ra _ps <<<"$1"
  for p in "${_ps[@]}"; do [[ $p =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || return 1; done
}
valid_limit()    { [[ $1 =~ ^[0-9]+(\.[0-9]+)?[mMgG]?$ ]]; } # memory like 2g / 512m, or cpus like 1.5
d_env_file()  { printf '%s/%s.env' "$DOCKER_ENV_DIR" "$1"; }
d_denv_get()  { local f; f=$(d_env_file "$1"); [ -f "$f" ] || return 0; grep -E "^$2=" "$f" | tail -n1 | cut -d= -f2- || true; }
d_denv_set()  { # name key value
  local f tmp; f=$(d_env_file "$1"); mkdir -p "$DOCKER_ENV_DIR"; chmod 700 "$DOCKER_ENV_DIR"; touch "$f"; chmod 600 "$f"
  if grep -qE "^$2=" "$f"; then
    tmp=$(mktemp); K="$2" V="$3" awk 'BEGIN { FS = "=" } $1 == ENVIRON["K"] { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' "$f" > "$tmp"; cat "$tmp" > "$f"; rm -f "$tmp"
  else printf '%s=%s\n' "$2" "$3" >> "$f"; fi
}
d_denv_del()  { local f tmp; f=$(d_env_file "$1"); [ -f "$f" ] || return 0; tmp=$(mktemp); grep -v -E "^$2=" "$f" > "$tmp" || true; cat "$tmp" > "$f"; rm -f "$tmp"; }

random_password() { local p; p=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 22 || true); printf '%s' "$p"; }

port_free() { # 0 when nothing listens on the TCP port (and no docker container already publishes it)
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; then return 1; fi
  if docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(:|^)$1->"; then return 1; fi
  return 0
}
next_free_port() { local p=${1:-3100}; while ! port_free "$p" && [ "$p" -lt 65000 ]; do p=$((p + 1)); done; printf '%s' "$p"; }

docker_instances() { docker ps -a --filter label=console.instance --format '{{.Label "console.instance"}}' 2>/dev/null | sort || true; }

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then return 0; fi
  if command -v docker >/dev/null 2>&1; then
    systemctl start docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 && return 0
    die "Docker is installed but not running. Try: sudo systemctl start docker"
  fi
  local go=0
  if [ "$HAVE_TTY" -eq 1 ]; then yes_no "Docker isn't installed. Install it now (Docker's official script)?" y && go=1
  elif [ "${CONSOLE_DOCKER_INSTALL:-0}" = 1 ]; then go=1; fi
  [ "$go" -eq 1 ] || die "Docker isn't installed. Install it (https://docs.docker.com/engine/install/) and run this again."
  info "Installing Docker (this takes a minute)..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Docker's installer failed. Install Docker by hand and run this again."
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker installed but isn't answering."
  ok "Installed Docker"
}

docker_build() {
  command -v git >/dev/null 2>&1 || { [ -n "$PM" ] || detect_pm; pkg_install git; }
  mkdir -p "$(dirname "$DOCKER_SRC")"
  if [ -d "$DOCKER_SRC/.git" ]; then
    git -C "$DOCKER_SRC" fetch --quiet origin "$BRANCH"
    git -C "$DOCKER_SRC" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
    git -C "$DOCKER_SRC" reset --quiet --hard "origin/$BRANCH"
  else
    rm -rf "$DOCKER_SRC"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO.git" "$DOCKER_SRC" 2>/dev/null || git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DOCKER_SRC"
  fi
  spin "Building the Console image (a few minutes the first time)" docker build -q -f "$DOCKER_SRC/deploy/Dockerfile" -t "$DOCKER_IMAGE" "$DOCKER_SRC"
}

# Questions for a NEW instance. Existing instances keep their saved settings (re-run with --reconfigure to change them).
docker_wizard() {
  local name=$DOCKER_NAME ans
  WIZ_STEP=0; WIZ_TOTAL=4
  banner
  local existing; existing=$(docker_instances | tr '\n' ' ')
  [ -z "$existing" ] || hint "Existing Docker instances: $existing"
  step "Name this instance"
  hint "Lowercase letters, numbers, - and _. Re-use a name to update that instance (its data is kept)."
  while :; do
    name=$(ask_default "Name" "${name:-sandbox}")
    valid_instance "$name" && break
    warn "Use a-z, 0-9, - and _ only."; name=""
  done
  DOCKER_NAME=$name
  if [ -f "$(d_env_file "$name")" ] && [ "$RECONFIGURE" -eq 0 ]; then
    ok "Updating the existing instance '$name'. Its data and settings stay as they are."
    return 0
  fi

  step "What is it for?"
  if [ -z "$MODE_FLAG" ]; then
    echo "      1) Minecraft host   Minecraft tools first"
    echo "      2) General          any kind of server, bot, site or app"
    ans=$(ask_default "Pick one" 2)
    case "$ans" in 1|m|M) MODE_FLAG=minecraft ;; *) MODE_FLAG=standard ;; esac
  fi
  D_PORT=$(ask_default "Dashboard port on this machine" "$(next_free_port 3100)")
  { [[ $D_PORT =~ ^[0-9]+$ ]] && [ "$D_PORT" -ge 1 ] && [ "$D_PORT" -le 65535 ]; } || { warn "Not a valid port. Using $(next_free_port 3100)."; D_PORT=$(next_free_port 3100); }
  hint "Ports your servers inside it need reachable from outside (comma-separated, or 'none')."
  D_PORTS=$(ask_default "Extra ports to publish" "$([ "$MODE_FLAG" = minecraft ] && echo 25565 || echo none)")
  valid_ports "$D_PORTS" || { warn "That isn't a list of ports. Publishing none."; D_PORTS=none; }
  if yes_no "Reachable from the internet? (No = only from this machine, e.g. through an SSH tunnel)" y; then D_PUBLIC=1; else D_PUBLIC=0; fi

  step "Its own admin account"
  WIZ_ADMIN_USER=$(ask_default "Username" "admin")
  valid_username "$WIZ_ADMIN_USER" || [ "$WIZ_ADMIN_USER" = admin ] || { warn "Letters, numbers, - and _ only. Using 'admin'."; WIZ_ADMIN_USER=admin; }
  if [ -z "$ADMIN_PW_PRESET" ]; then
    if yes_no "Make up a strong password for me?" y; then ok "I'll generate one and show it once at the end."
    else
      local p1 p2
      while :; do
        p1=$(ask_secret "    Password (10+ characters; letters, numbers, _ . @ % + , : = -): ")
        valid_password "$p1" || { warn "Too short, or it has a character I can't pass safely."; continue; }
        p2=$(ask_secret "    Type it again: ")
        [ "$p1" = "$p2" ] && break; warn "They didn't match."
      done
      ADMIN_PW_PRESET=$p1
    fi
  fi

  step "Limits and extras (all optional)"
  hint "Limits stop a runaway server in here from starving the rest of the machine."
  D_MEM=$(ask "    Memory limit, like 4g (Enter = none): ")
  if [ -n "$D_MEM" ] && ! valid_limit "$D_MEM"; then warn "Use a number with m or g, like 512m or 4g. No limit set."; D_MEM=""; fi
  D_CPUS=$(ask "    CPU limit, like 2 (Enter = none): ")
  if [ -n "$D_CPUS" ] && ! valid_limit "$D_CPUS"; then warn "Use a number like 1.5. No limit set."; D_CPUS=""; fi
  local t; t=$(ask_secret "    GitHub token for this instance (Enter to skip): ")
  if [ -n "$t" ]; then if valid_token "$t"; then WIZ_GH_TOKEN=$t; ok "Token saved ($(mask_tail "$t"))"; else warn "That doesn't look like a GitHub token. Skipping."; fi; fi

  printf '\n%sReady%s\n' "$B" "$N"
  echo "    Instance:  console-$name  (data in the Docker volume console-$name-data)"
  echo "    Dashboard: http://${PUBLIC_IP:-<this-machine>}:$D_PORT$([ "$D_PUBLIC" = 0 ] && echo '  (this machine only)')"
  echo "    Ports:     $D_PORTS"
  echo "    Limits:    ${D_MEM:-no memory limit}, ${D_CPUS:+$D_CPUS cpu(s)}${D_CPUS:-no cpu limit}"
  echo
  yes_no "Go?" y || die "Cancelled. Nothing was changed."
}

docker_write_env() { # name  (new instances only)
  local n=$1
  [ -n "$D_PORT" ] || D_PORT=${CONSOLE_DOCKER_PORT:-$(next_free_port 3100)}
  [ "${CONSOLE_DOCKER_PUBLIC:-1}" != 0 ] || D_PUBLIC=0
  [ -n "$D_PORTS" ] || D_PORTS=${CONSOLE_DOCKER_PORTS:-$([ "$MODE_FLAG" = minecraft ] && echo 25565 || echo none)}
  d_denv_set "$n" HOST 0.0.0.0
  d_denv_set "$n" PORT 3000
  d_denv_set "$n" CONSOLE_ADMIN_USER "${WIZ_ADMIN_USER:-admin}"
  if [ -z "$ADMIN_PW_PRESET" ]; then ADMIN_PW=$(random_password); ADMIN_PW_NOTE=generated
  else
    valid_password "$ADMIN_PW_PRESET" || die "CONSOLE_ADMIN_PASSWORD must be 10+ characters from A-Z a-z 0-9 _ . @ % + , : = -"
    ADMIN_PW=$ADMIN_PW_PRESET; ADMIN_PW_NOTE=preset
  fi
  d_denv_set "$n" CONSOLE_ADMIN_PASSWORD "$ADMIN_PW"
  [ "$MODE_FLAG" != minecraft ] || d_denv_set "$n" CONSOLE_MODE minecraft
  [ -z "$PUBLIC_IP" ] || d_denv_set "$n" CONSOLE_PUBLIC_IP "$PUBLIC_IP"
  [ -z "$WIZ_GH_TOKEN" ] || d_denv_set "$n" CONSOLE_GITHUB_TOKEN "$WIZ_GH_TOKEN"
  [ -z "$WIZ_GH_ORG" ] || d_denv_set "$n" CONSOLE_GITHUB_ORG "$WIZ_GH_ORG"
  d_denv_set "$n" CONSOLE_D_PORT "$D_PORT"
  d_denv_set "$n" CONSOLE_D_PORTS "$D_PORTS"
  d_denv_set "$n" CONSOLE_D_PUBLIC "$D_PUBLIC"
  d_denv_set "$n" CONSOLE_D_MEM "$D_MEM"
  d_denv_set "$n" CONSOLE_D_CPUS "$D_CPUS"
}

# The exact docker run arguments for an instance, one per line (also what the tests check).
docker_run_args() { # name
  local n=$1 port ports pub mem cpus bind p
  port=$(d_denv_get "$n" CONSOLE_D_PORT); ports=$(d_denv_get "$n" CONSOLE_D_PORTS); pub=$(d_denv_get "$n" CONSOLE_D_PUBLIC)
  mem=$(d_denv_get "$n" CONSOLE_D_MEM); cpus=$(d_denv_get "$n" CONSOLE_D_CPUS)
  bind=0.0.0.0; [ "$pub" = 0 ] && bind=127.0.0.1
  printf '%s\n' run -d --init --name "console-$n" --label "console.instance=$n" --restart unless-stopped \
    --env-file "$(d_env_file "$n")" -v "console-$n-data:/data" -p "$bind:$port:3000" \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 2048
  if [ -n "$ports" ] && [ "$ports" != none ]; then
    IFS=, read -ra _ps <<<"$ports"
    for p in "${_ps[@]}"; do printf '%s\n' -p "$bind:$p:$p"; done
  fi
  [ -z "$mem" ] || printf '%s\n' --memory "$mem"
  [ -z "$cpus" ] || printf '%s\n' --cpus "$cpus"
  printf '%s\n' "$DOCKER_IMAGE"
}

docker_start_instance() { # name
  local n=$1 args=()
  mapfile -t args < <(docker_run_args "$n")
  docker rm -f "console-$n" >/dev/null 2>&1 || true
  docker "${args[@]}" >/dev/null
}

docker_main() {
  say "Docker instance"
  ensure_docker
  if [ "$HAVE_TTY" -eq 1 ]; then docker_wizard
  else
    DOCKER_NAME=${DOCKER_NAME:-${CONSOLE_DOCKER_NAME:-sandbox}}
    valid_instance "$DOCKER_NAME" || die "Docker instance names use a-z, 0-9, - and _ (max 31): $DOCKER_NAME"
  fi
  local n=$DOCKER_NAME fresh=0
  [ -f "$(d_env_file "$n")" ] && [ "$RECONFIGURE" -eq 0 ] || fresh=1
  docker_build
  if [ "$fresh" -eq 1 ]; then
    # Keep the one-time secrets (token, first password) out of this shell's environment from here on.
    docker_write_env "$n"
  fi
  local port; port=$(d_denv_get "$n" CONSOLE_D_PORT)
  say "Starting console-$n"
  docker_start_instance "$n"
  if wait_for "http://127.0.0.1:$port/api/me" 60; then ok "console-$n is up"
  else docker logs --tail 25 "console-$n" >&2 || true; die "The container didn't start. The last log lines are above."; fi
  # One-time values are only needed on first start. Remove them, then recreate the container (its data volume stays)
  # so they don't linger in the container's own environment either.
  if [ "$fresh" -eq 1 ]; then
    local k
    d_denv_del "$n" CONSOLE_ADMIN_PASSWORD
    for k in CONSOLE_GITHUB_TOKEN CONSOLE_GITHUB_ORG; do d_denv_del "$n" "$k"; done
    docker_start_instance "$n"
    wait_for "http://127.0.0.1:$port/api/me" 60 || { docker logs --tail 25 "console-$n" >&2 || true; die "The container didn't come back after the first start."; }
  fi
  [ "$(d_denv_get "$n" CONSOLE_D_PUBLIC)" = 0 ] || open_ports "$port" $(d_denv_get "$n" CONSOLE_D_PORTS | tr ',' ' ' | sed 's/none//')
  docker_summary "$n" "$fresh"
}

docker_summary() { # name fresh
  local n=$1 fresh=$2 port ports pub host
  port=$(d_denv_get "$n" CONSOLE_D_PORT); ports=$(d_denv_get "$n" CONSOLE_D_PORTS); pub=$(d_denv_get "$n" CONSOLE_D_PUBLIC)
  host=${PUBLIC_IP:-<this-machine>}; [ "$pub" = 0 ] && host=127.0.0.1
  echo
  echo "${B}================================================================${N}"
  echo "${B}  Docker instance '$n' is running${N}"
  echo
  echo "  Open it:   http://$host:$port"
  if [ "$fresh" -eq 1 ]; then
    echo "  Sign in:   $(d_denv_get "$n" CONSOLE_ADMIN_USER)  /  $([ "$ADMIN_PW_NOTE" = generated ] && echo "$ADMIN_PW" || echo 'the password you set')"
    [ "$ADMIN_PW_NOTE" != generated ] || echo "             ^ shown once, save it now."
  else
    echo "  Sign in:   with the account you made earlier (nothing was reset)"
  fi
  [ "$pub" = 0 ] && echo "  It only listens on this machine. From your computer: ssh -L $port:127.0.0.1:$port <this-server>"
  if [ "$pub" != 0 ]; then
    echo
    if [ "$IS_OCI" -eq 1 ]; then
      echo "  Oracle blocks everything by default. In your VCN Security List add Ingress Rules (TCP):"
      echo "    port $port   (this instance's dashboard; limit the source to your own IP)"
      [ "$ports" = none ] || echo "    port(s) $ports   (what's running inside it)"
    else
      echo "  If it doesn't load, open TCP $port${ports:+ and $ports} in your cloud firewall / security group."
    fi
  fi
  echo
  echo "  Everything in it lives in the Docker volume console-$n-data. The host's files and services are not reachable from inside."
  echo "  Servers running inside stop when the container restarts (their files stay); start them again from the dashboard."
  echo "  Logs:      docker logs -f console-$n"
  echo "  Update:    run the installer again and pick Docker, same name (keeps its data)"
  echo "  Remove:    sudo bash install.sh --docker-remove $n [--purge]"
  echo "${B}================================================================${N}"
}

docker_remove() {
  local n=$DOCKER_REMOVE
  ensure_docker
  docker inspect "console-$n" >/dev/null 2>&1 || [ -f "$(d_env_file "$n")" ] || die "There's no Docker instance called '$n'."
  if [ "$HAVE_TTY" -eq 1 ]; then
    yes_no "Stop and remove the container console-$n?" n || die "Cancelled. Nothing was changed."
    [ "$DOCKER_PURGE" -eq 0 ] || yes_no "Also DELETE its data volume (all its servers, worlds and settings)? This can't be undone." n || DOCKER_PURGE=0
  fi
  docker rm -f "console-$n" >/dev/null 2>&1 || true
  rm -f "$(d_env_file "$n")"
  ok "Removed the container console-$n"
  if [ "$DOCKER_PURGE" -eq 1 ]; then docker volume rm "console-$n-data" >/dev/null 2>&1 && ok "Deleted its data volume"
  else info "Its data is kept in the volume console-$n-data (add --purge to delete that too)."; fi
}

# What to do when someone is at the keyboard: the usual install/update, or an isolated Docker instance.
pick_target() {
  local inst choice; inst=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then inst=$(docker_instances | tr '\n' ' '); fi
  echo
  echo "${B}What would you like to do?${N}"
  echo "      1) Install or update Console on this machine"
  echo "      2) Create or update an isolated Docker instance  ${D}(own data, port and servers; side by side)${N}"
  [ -z "$inst" ] || echo "      3) Remove a Docker instance  ${D}(have: $inst)${N}"
  choice=$(ask_default "Pick one" 1)
  case "$choice" in
    2) DOCKER_MODE=1 ;;
    3) if [ -n "$inst" ]; then DOCKER_REMOVE=$(ask "    Which one? "); valid_instance "$DOCKER_REMOVE" || die "Not a valid instance name."; fi ;;
  esac
}

# ---- final report ----------------------------------------------------------------------

is_mc_mode() { [ "$MODE_FLAG" = minecraft ] || { [ "$MODE_FLAG" != standard ] && [ "$(env_get CONSOLE_MODE)" = minecraft ]; }; }

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
    echo "    > Add Ingress Rules:"
    echo "        Source CIDR $src   Protocol TCP   Destination port $ports   (the dashboard)"
    if is_mc_mode; then echo "        Source CIDR 0.0.0.0/0   Protocol TCP   Destination port 25565   (Minecraft players)"; fi
  else
    echo "  If the page doesn't load, open TCP $ports in your cloud provider's firewall / security group."
    if is_mc_mode; then echo "  Players need TCP 25565 open there too."; fi
  fi
  if is_mc_mode; then
    echo
    echo "  Next: open Create > Minecraft, pick a version, accept the EULA, and press Start."
    echo "        Players join at ${PUBLIC_IP:-<your-server-ip>}:25565"
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
  detect_pm
  detect_tty
  detect_cloud
  find_public_ip || warn "Couldn't look up this server's public IP."

  # Someone at the keyboard with no flags gets the choice, even on a machine that's already installed.
  if [ "$HAVE_TTY" -eq 1 ] && [ "$DOCKER_MODE" -eq 0 ] && [ -z "$DOCKER_REMOVE" ] && [ "$RECONFIGURE" -eq 0 ] && [ -z "$DOMAIN" ] && [ "$IP_ONLY" -eq 0 ]; then
    pick_target
  fi
  if [ -n "$DOCKER_REMOVE" ]; then docker_remove; return 0; fi
  if [ "$DOCKER_MODE" -eq 1 ]; then docker_main; return 0; fi
  [ -d /run/systemd/system ] || die "This needs a Linux with systemd (Oracle Linux, Ubuntu, Debian, ...)."

  PORT=${PORT_FLAG:-$(env_get PORT)}; PORT=${PORT:-3000}
  local first_run=0; [ -f "$(env_get CONSOLE_DB || true)" ] || [ -f "$DIR/data/console.db" ] || first_run=1
  if [ "$HAVE_TTY" -eq 1 ] && { [ "$first_run" -eq 1 ] || [ "$RECONFIGURE" -eq 1 ]; }; then
    wizard
  else
    say "Console installer"
    choose_mode
  fi
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
  write_wizard_env
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
  if is_mc_mode; then say "Minecraft"; open_ports 25565; fi

  print_summary
}

# Tests load this file with CONSOLE_INSTALL_SOURCE_ONLY=1 to reach the helper functions without running anything.
# Keep `main "$@"` as the very last line that runs: bash reads piped scripts as it goes.
if [ "${CONSOLE_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then
  main "$@"
fi
