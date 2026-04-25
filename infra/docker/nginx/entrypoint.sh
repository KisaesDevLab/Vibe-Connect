#!/bin/sh
# Distribution-mode nginx entrypoint.
#
# Renders nginx.conf.template → /etc/nginx/nginx.conf at boot using values
# from the runtime env, then starts nginx + the cert-reload watcher.
#
# Env contract (with single-app defaults):
#   BASE_PATH        '/' | '/connect' | etc.   (default '/')
#   TLS_MODE         'internal' | 'external'   (default 'internal')
#   HTTP_PORT        80   (default 80)
#   HTTPS_PORT       443  (default 443; ignored in TLS_MODE=external)
#   PORTAL_HTTPS_PORT 8443 (default 8443; ignored in TLS_MODE=external)
#
# We pre-compute two derived values the template needs:
#   BASE_PATH_HREF      empty when BASE_PATH=/ (so <base href="/"> renders),
#                       otherwise BASE_PATH minus any trailing slash
#   TLS_MODE_INTERNAL   '1' when internal, '0' when external — used by an
#                       nginx `map` so the HTTP server block knows whether to
#                       301 to HTTPS or proxy plain HTTP to the app.
set -e

: "${BASE_PATH:=/}"
: "${TLS_MODE:=internal}"
: "${HTTP_PORT:=80}"
: "${HTTPS_PORT:=443}"
: "${PORTAL_HTTPS_PORT:=8443}"

# Whitelist BASE_PATH to either '/' or '/<segment>'. The value flows into
# nginx's sub_filter substitution and the SPA's <base href> attribute; an
# operator typo like 'connect' (missing slash) or stray quotes would break
# routing or — for the truly creative — let a malicious env value forge an
# HTML fragment. Refuse to start instead of papering over a config error.
case "${BASE_PATH}" in
  /) ;;
  /[a-z][a-z0-9_-]*) ;;
  /[a-z][a-z0-9_-]*/) ;;
  *)
    echo "[entrypoint] invalid BASE_PATH='${BASE_PATH}' (expected '/' or '/<lowercase-name>')" >&2
    exit 1
    ;;
esac

# Strip trailing slashes (so '/connect/' and '/connect' produce the same
# href). Single-app '/' → '' so <base href="/"> is what the browser sees.
case "${BASE_PATH}" in
  /) BASE_PATH_HREF="" ;;
  *) BASE_PATH_HREF="$(printf '%s' "${BASE_PATH}" | sed 's:/*$::')" ;;
esac

# Port values must be plain integers in the 1-65535 range — they end up in
# nginx's `listen` directive and a malformed value produces a confusing
# config-parse failure deep in nginx's startup.
for var in HTTP_PORT HTTPS_PORT PORTAL_HTTPS_PORT; do
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
  internal) TLS_MODE_INTERNAL=1 ;;
  external) TLS_MODE_INTERNAL=0 ;;
  *)
    echo "[entrypoint] invalid TLS_MODE='${TLS_MODE}' (expected internal|external)" >&2
    exit 1
    ;;
esac

export BASE_PATH BASE_PATH_HREF TLS_MODE TLS_MODE_INTERNAL HTTP_PORT HTTPS_PORT PORTAL_HTTPS_PORT

echo "[entrypoint] rendering nginx.conf with BASE_PATH=${BASE_PATH} TLS_MODE=${TLS_MODE}"
# Restrict envsubst to our explicit list — without this, $http_accept,
# $proxy_add_x_forwarded_for, $request_uri, etc. (nginx runtime variables
# with leading $) would all get clobbered by env values that don't exist.
envsubst '${BASE_PATH} ${BASE_PATH_HREF} ${TLS_MODE} ${TLS_MODE_INTERNAL} ${HTTP_PORT} ${HTTPS_PORT} ${PORTAL_HTTPS_PORT}' \
  < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# In external TLS mode there are no certs on disk to watch — drop the inotify
# loop entirely so the container doesn't tail an empty/non-existent dir.
if [ "${TLS_MODE}" = "external" ]; then
  # External mode: HTTPS server blocks in the rendered config still listen
  # if certs are present (defense-in-depth for an operator who DID populate
  # /etc/nginx/tls), but the watcher is unnecessary because no in-app ACME
  # is rotating anything. Validate the config first so a bad template
  # surfaces immediately rather than after nginx is half-started.
  nginx -t
  exec nginx -g 'daemon off;'
fi

# Internal TLS mode: in-app ACME drops new certs into /etc/nginx/tls; reload
# nginx whenever a file lands there. Atomic .tmp + rename means we watch
# both `close_write` (direct write) and `moved_to` (rename completion).
nginx -t
nginx -g 'daemon off;' &
nginx_pid=$!

# Give nginx a moment to bind ports before the first inotify cycle, so a
# race during boot can't fire `nginx -s reload` before nginx is ready.
sleep 2

(
  while inotifywait -q -e close_write,moved_to,create /etc/nginx/tls/; do
    echo "[tls-reloader] cert change detected, reloading nginx"
    if nginx -s reload 2>&1; then
      echo "[tls-reloader] reload ok"
    else
      echo "[tls-reloader] reload failed (nginx may still be starting)"
    fi
    sleep 1
  done
) &

# If nginx exits, take the container down — docker compose will restart us.
wait "$nginx_pid"
