#!/bin/sh
# Distribution-mode nginx entrypoint.
#
# Renders nginx.conf.template → /etc/nginx/nginx.conf at boot using values
# from the runtime env, then starts nginx + the cert-reload watcher.
#
# Env contract (with single-app defaults):
#   BASE_PATH        '/' | '/connect' | etc.   (default '/')
#   PORTAL_BASE_PATH '/' | '/portal' | etc.    (default '/')
#                    Independent from BASE_PATH so the portal can be
#                    deployed at a different prefix than the staff app —
#                    the appliance puts staff at vibe.<domain>/connect
#                    AND the portal at client.<domain>/ (different
#                    subdomains, different prefixes). A single shared
#                    BASE_PATH leaked the staff prefix into the portal
#                    bundle's <base href>, sending the portal SPA's
#                    asset fetches to /connect/assets/... — wrong nginx
#                    listener, SPA-fallback returned index.html as
#                    text/html, browser refused to execute, blank page.
#   TLS_MODE         'internal' | 'external'   (default 'internal')
#   HTTP_PORT        80   (default 80)
#   HTTPS_PORT       443  (default 443; ignored in TLS_MODE=external)
#   PORTAL_HTTPS_PORT 8443 (default 8443; ignored in TLS_MODE=external)
#   PORTAL_HTTP_PORT 8080 (default 8080; ignored in TLS_MODE=internal —
#                          the portal listens HTTPS-only there). In
#                          external mode an upstream TLS terminator
#                          (Caddy / Cloudflare Tunnel) maps the public
#                          client subdomain to this internal port.
#
# We pre-compute three derived values the template needs:
#   BASE_PATH_HREF        empty when BASE_PATH=/ (so <base href="/"> renders),
#                         otherwise BASE_PATH minus any trailing slash
#   PORTAL_BASE_PATH_HREF same shape, derived from PORTAL_BASE_PATH
#   TLS_MODE_INTERNAL     '1' when internal, '0' when external — used by an
#                         nginx `map` so the HTTP server block knows whether to
#                         301 to HTTPS or proxy plain HTTP to the app.
set -e

: "${BASE_PATH:=/}"
: "${PORTAL_BASE_PATH:=/}"
: "${TLS_MODE:=internal}"
: "${HTTP_PORT:=80}"
: "${HTTPS_PORT:=443}"
: "${PORTAL_HTTPS_PORT:=8443}"
: "${PORTAL_HTTP_PORT:=8080}"
# Where the staff `/desktop/` redirect points. Default is the public
# GitHub releases page; appliances on isolated networks override to a
# locally-mirrored URL. Mounted only on the staff server block — the
# portal SPA never surfaces this path.
: "${DESKTOP_DOWNLOAD_URL:=https://github.com/KisaesDevLab/Vibe-Connect/releases/latest}"

# Whitelist BASE_PATH to either '/' or '/<segment>' with optional trailing
# slash. The value flows into nginx's sub_filter substitution and the
# SPA's <base href> attribute; an operator typo like 'connect' (missing
# slash), '/Connect' (uppercase), '/my path' (whitespace), or stray
# quotes would break routing or — for the truly creative — let a
# malicious env value forge an HTML fragment. Refuse to start instead
# of papering over a config error.
#
# IMPORTANT: bash `case` uses glob, not regex. `[a-z][a-z0-9_-]*` in
# case-glob matches *any chars* after the first letter, including
# whitespace and control bytes — `/my path` previously slipped past
# this validator. The image's /bin/sh is BusyBox ash (no =~ operator),
# so we route through `grep -qE` for a real anchored ERE check.
if ! printf '%s' "${BASE_PATH}" | grep -qE '^/$|^/[a-z][a-z0-9_-]*/?$'; then
  echo "[entrypoint] invalid BASE_PATH='${BASE_PATH}' (expected '/' or '/<lowercase-name>'; no whitespace, no uppercase)" >&2
  exit 1
fi
if ! printf '%s' "${PORTAL_BASE_PATH}" | grep -qE '^/$|^/[a-z][a-z0-9_-]*/?$'; then
  echo "[entrypoint] invalid PORTAL_BASE_PATH='${PORTAL_BASE_PATH}' (expected '/' or '/<lowercase-name>'; no whitespace, no uppercase)" >&2
  exit 1
fi

# Strip trailing slashes (so '/connect/' and '/connect' produce the same
# href). Single-app '/' → '' so <base href="/"> is what the browser sees.
case "${BASE_PATH}" in
  /) BASE_PATH_HREF="" ;;
  *) BASE_PATH_HREF="$(printf '%s' "${BASE_PATH}" | sed 's:/*$::')" ;;
esac
case "${PORTAL_BASE_PATH}" in
  /) PORTAL_BASE_PATH_HREF="" ;;
  *) PORTAL_BASE_PATH_HREF="$(printf '%s' "${PORTAL_BASE_PATH}" | sed 's:/*$::')" ;;
esac

# Port values must be plain integers in the 1-65535 range — they end up in
# nginx's `listen` directive and a malformed value produces a confusing
# config-parse failure deep in nginx's startup.
for var in HTTP_PORT HTTPS_PORT PORTAL_HTTPS_PORT PORTAL_HTTP_PORT; do
  eval "val=\${$var}"
  case "$val" in
    ''|*[!0-9]*)
      echo "[entrypoint] invalid ${var}='${val}' (expected integer)" >&2
      exit 1
      ;;
  esac
  if [ "$val" -lt 1 ] || [ "$val" -gt 65535 ]; then
    echo "[entrypoint] ${var}='${val}' out of range (1..65535)" >&2
    exit 1
  fi
done

case "${TLS_MODE}" in
  internal|external) ;;
  *)
    echo "[entrypoint] invalid TLS_MODE='${TLS_MODE}' (expected internal|external)" >&2
    exit 1
    ;;
esac

export BASE_PATH BASE_PATH_HREF PORTAL_BASE_PATH PORTAL_BASE_PATH_HREF TLS_MODE HTTP_PORT HTTPS_PORT PORTAL_HTTPS_PORT PORTAL_HTTP_PORT DESKTOP_DOWNLOAD_URL

# In TLS_MODE=internal the SSL `server` blocks reference
# /etc/nginx/tls/{connect,portal}.{crt,key}. On a fresh appliance the
# in-app ACME ticker hasn't run yet (no firm install, no order), so
# those files don't exist — nginx -t hard-fails and the container
# crash-loops, locking the operator out of /install on their own
# appliance. Detect that case and bootstrap in plain-HTTP rendering
# (same shape as TLS_MODE=external) until the inotify watcher below
# sees real certs land, then re-render in internal mode and reload.
certs_present() {
  [ -s /etc/nginx/tls/connect.crt ] && [ -s /etc/nginx/tls/connect.key ] \
    && [ -s /etc/nginx/tls/portal.crt ] && [ -s /etc/nginx/tls/portal.key ]
}

# Render /etc/nginx/nginx.conf for the given effective mode (`internal` or
# `external`). Internal keeps the SSL server blocks; external strips them
# via the `# vibe:tls-internal-only:` marker pair. Restrict envsubst to
# our explicit list — without this, $http_accept, $proxy_add_x_forwarded_for,
# $request_uri, etc. (nginx runtime variables with leading $) would all
# get clobbered by env values that don't exist.
render_config() {
  effective_mode="$1"
  case "$effective_mode" in
    internal) TLS_MODE_INTERNAL=1 ;;
    external) TLS_MODE_INTERNAL=0 ;;
  esac
  export TLS_MODE_INTERNAL
  envsubst '${BASE_PATH} ${BASE_PATH_HREF} ${PORTAL_BASE_PATH} ${PORTAL_BASE_PATH_HREF} ${TLS_MODE} ${TLS_MODE_INTERNAL} ${HTTP_PORT} ${HTTPS_PORT} ${PORTAL_HTTPS_PORT} ${PORTAL_HTTP_PORT} ${DESKTOP_DOWNLOAD_URL}' \
    < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
  if [ "$effective_mode" = "external" ]; then
    # External mode: strip the TLS-internal HTTPS server blocks (staff +
    # portal). The remaining HTTP listeners cover staff (HTTP_PORT) and,
    # post Phase β, portal (PORTAL_HTTP_PORT) for upstream-TLS deployments.
    sed -i '/# vibe:tls-internal-only:begin/,/# vibe:tls-internal-only:end/d' /etc/nginx/nginx.conf
  else
    # Internal mode: the TLS-internal portal HTTPS block on PORTAL_HTTPS_PORT
    # is the canonical portal listener — strip the external-only plain-HTTP
    # portal block so we don't end up with two listeners trying to serve
    # the same SPA (one over HTTPS, one over plain HTTP) on the same image.
    sed -i '/# vibe:tls-external-only:begin/,/# vibe:tls-external-only:end/d' /etc/nginx/nginx.conf
  fi
}

bootstrap_fallback=0
if [ "${TLS_MODE}" = "internal" ] && ! certs_present; then
  echo "[entrypoint] internal TLS mode but certs not present in /etc/nginx/tls yet — bootstrapping in plain-HTTP fallback (will promote to HTTPS once ACME provisions)"
  bootstrap_fallback=1
  effective_mode="external"
else
  effective_mode="${TLS_MODE}"
fi

echo "[entrypoint] rendering nginx.conf with BASE_PATH=${BASE_PATH} PORTAL_BASE_PATH=${PORTAL_BASE_PATH} TLS_MODE=${TLS_MODE} effective=${effective_mode}"
render_config "${effective_mode}"
# Validate so a bad template (or marker drift) surfaces immediately
# rather than after nginx is half-started.
nginx -t

# Pure-external mode (caller asked for it explicitly) doesn't need the
# inotify watcher — /etc/nginx/tls is never populated when an upstream
# proxy terminates TLS, so there's nothing to wait for.
if [ "${TLS_MODE}" = "external" ]; then
  exec nginx -g 'daemon off;'
fi

# Internal mode (or internal-with-bootstrap-fallback): start nginx and watch
# /etc/nginx/tls. The in-app ACME ticker writes new certs there; the watcher
# either reloads (cert renewal) or promotes from fallback to TLS_MODE=internal
# (first cert arrival). Atomic .tmp + rename means we watch both `close_write`
# (direct write) and `moved_to` (rename completion).
nginx -g 'daemon off;' &
nginx_pid=$!

# Give nginx a moment to bind ports before the first inotify cycle, so a
# race during boot can't fire `nginx -s reload` before nginx is ready.
sleep 2

(
  while inotifywait -q -e close_write,moved_to,create /etc/nginx/tls/; do
    # Brief settle BEFORE checking. Without `-m`, inotifywait returns on
    # the first event and we then race a fresh watch against the writer's
    # remaining files — a multi-file ACME write (connect+portal × crt+key)
    # commonly fires once per file, but the watcher sees only the first
    # because it's not listening during the sleep+reload+rewatch window.
    # Sleeping here gives the writer a moment to finish all four files
    # before we evaluate certs_present and decide whether to promote.
    sleep 1
    echo "[tls-reloader] cert change detected"
    if [ "${bootstrap_fallback}" = "1" ] && certs_present; then
      echo "[tls-reloader] certs now present — promoting from plain-HTTP fallback to TLS_MODE=internal"
      render_config "internal"
      bootstrap_fallback=0
    fi
    if nginx -s reload 2>&1; then
      echo "[tls-reloader] reload ok"
    else
      echo "[tls-reloader] reload failed (nginx may still be starting)"
    fi
  done
) &

# If nginx exits, take the container down — docker compose will restart us.
wait "$nginx_pid"
