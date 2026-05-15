# Vibe File Transfer (Phase 28) — Decisions Log

All previously open questions are resolved and implemented in v1. This file is documentation of what was decided and where it lives in the build plan, not an open backlog. New questions arising during Phase 28 execution should be appended below with a date, decision, and target sub-phase.

> **Note (2026-05-13):** When the build plan was remapped onto Connect's actual stack (yarn/Knex/in-process tickers/no CLI), three implementation primitives changed without changing any of the original decisions: Q1 + Q11 now reference columns on the existing `firm_settings` singleton instead of a `firm_settings_intake` table; Q12's CLI became admin HTTP routes. The "what" stayed; only the "how" moved. See `docs/PHASE_28_ADDENDUM.md` for the rewritten plan.

---

## Resolved decisions (May 2026)

| # | Question | Decision | Implemented in |
|---|----------|----------|----------------|
| Q1 | PDF cover page on assembled output | **Yes, include.** Cover page generated as page 1 with client name, contact, submission timestamp, staff recipient, scanned-page manifest, and attached-files list. Toggleable per firm via `firm_settings.intake_include_cover_page` (default on; the column lives on the existing `firm_settings` singleton — no separate `firm_settings_intake` table). | 28.9 |
| Q2 | Staff tagging/categorization at receipt | **No.** Sessions have no tags in v1. | — |
| Q3 | Automatic retention / purge | **Yes, configurable per firm.** `auto_delete_enabled` and `auto_delete_after_days` settings; hourly purge job; per-session admin override; audit log entries survive purge. | 28.15 |
| Q4 | Gallery picker through scanner pipeline | **No.** Scanner operates on live camera only. Gallery selection routes through plain upload. | — |
| Q5 | iOS "Add to Home Screen" prompt | **No.** No install prompt or tooltip. Users who want PWA mode discover it themselves. | (removed from 28.17) |
| Q6 | Post-hoc client association | **Yes.** "Link to client" action on session detail searches existing Connect client directory; soft association via `intake_sessions.linked_connect_client_id`; reversible; no files moved, no Vault entries created. | 28.11 |
| Q7 | Resumable client session across visits | **No.** Single 4h token TTL window; closing the tab ends the session. tus resumability handles within-tab network blips. | 28.4 (unchanged from original plan) |
| Q8 | Per-staff tagline separate from bio | **No.** Bio + title only. | — |
| Q9 | Outbound webhooks on intake events | **No.** No webhook layer in v1. | — |
| Q10 | Multi-language intake page | **No.** English only. Strings still extracted to existing Connect i18n catalog under `intake.*` for future translation passes. | (cross-cutting) |
| Q11 | Channel preference when both email and phone provided | **Send to both.** Controlled by `firm_settings.intake_send_to_both_channels` (default true). | 28.10 |
| Q12 | Encryption key rotation tooling | **Yes, ship in v1.** Implemented as authenticated admin HTTP routes under `/admin/intake/rotate-key/*` (Connect has no CLI binary). Same behaviors: dry-run, resumable via `:jobId/resume`, audit-logged, verification pass, SIGTERM-aware. Maintenance mode flag (`firm_settings.intake_maintenance_mode`) blocks new uploads during rotation. | 28.16 |

---

## New questions log

> Append entries below as questions arise during Phase 28 execution. Format:
>
> **YYYY-MM-DD — Short title**
> Context. Decision (default). Target sub-phase or note as deferred to v1.1.

*(none yet)*
