#!/bin/sh
# Custom entrypoint: start nginx in the foreground, and run an inotifywait
# loop that reloads nginx whenever a cert file in /etc/nginx/tls/ is
# written to or replaced. The tlsAcme service writes new certs atomically
# via a .tmp + rename, so we watch `moved_to` (rename completion) and
# `close_write` (direct write by any tool).
set -e

# Kick nginx off as a background child so we can run the watcher in the
# same pid namespace. `daemon off;` keeps it in the foreground.
nginx -g 'daemon off;' &
nginx_pid=$!

# Give nginx a moment to bind ports before the first inotify cycle, so a
# race during boot can't fire `nginx -s reload` before nginx is ready.
sleep 2

(
  # -m monitor (don't exit after first event), -q quiet, -e events list.
  # inotifywait blocks until an event fires, then emits one line; we
  # throttle by sleeping 1s after each reload so an atomic rename of
  # four cert files doesn't cause four consecutive reloads.
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
