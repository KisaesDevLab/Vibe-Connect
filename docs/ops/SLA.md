# Support SLA during Phase 17–18 rollout

| Severity | Definition | Response | Fix target |
|----------|-----------|----------|-----------|
| Critical | Message loss, encryption failure, cannot log in, data leak | 1 hour | 24 hours |
| High | One feature broken for >1 user; admin can't perform a task | 4 hours | 3 days |
| Medium | UX friction, minor bug, cosmetic regression | 1 day | 1 week |
| Low | Polish, cleanup, nice-to-have | — | Next iteration |

## Escalation path

1. Staff reports in Vibe Connect (or `"VIBE DOWN"` email if the app itself is down).
2. Kurt triages and pings engineering.
3. Critical incidents: engineering on Zoom within 1 hour, fix pushed via Tauri updater +
   web deploy.

## Communication during incidents

- Status page stub: `https://connect.kisaes.com/status` → returns `{ "status": "ok" | "maintenance" | "degraded" }` (operator flips via env).
- Critical incidents: Kurt posts a pinned message in a firm-wide conversation.
