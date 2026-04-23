# Hardware sizing — Vibe Connect Appliance

Reference profile used during internal build: **GMKtec NucBox M6**
(Ryzen 5 / 16 GB RAM / 512 GB NVMe / 2.5 GbE).

## Supported scale

| Firm size | Concurrent staff | Clients w/ active sessions | Min CPU | Min RAM | Storage growth |
|-----------|------------------|----------------------------|---------|---------|----------------|
| Small     | ≤ 20             | ≤ 100                      | 2C/4T   | 8 GB    | ~5 GB/yr       |
| Medium    | ≤ 60             | ≤ 500                      | 4C/8T   | 16 GB   | ~20 GB/yr      |
| Large     | ≤ 150            | ≤ 2000                     | 6C/12T  | 32 GB   | ~75 GB/yr      |

Tested ceilings on the M6-class box:
- Crypto: ~0.1 ms per message decrypt (Phase 3 benchmark, ≤10 ms target).
- Realtime: 50 concurrent staff sockets broadcasting <200 ms delivery (Phase 5 load test).

## Network

- 1 Gbit/s switch minimum; 2.5 GbE preferred for firm-wide backups.
- Static internal IP for the appliance. Tailscale for off-office access.
- Firewall: UFW allows 22 (ssh), 80→301→443, 443 only. See `docs/ops/FIREWALL.md`.

## Storage layout

- `/var/lib/docker/volumes/vibe_connect_pg/` — Postgres data.
- `/var/lib/docker/volumes/vibe_connect_uploads/` — encrypted attachment ciphertext.
- `/srv/vibe-connect/.env` — env config (must be backed up).

## Ops cadence

- Docker image: pull tagged version, never `:latest` in production.
- OS patches monthly; Docker/Postgres minor upgrades quarterly.
- Run the firm-key rotation procedure (`docs/ops/UPDATE_SIGNING.md` and `THREAT_MODEL.md`)
  every 2 years or sooner on partner change.
