# UFW / firewall rules — Vibe Connect appliance

Minimal rules. Everything else denied.

```bash
ufw default deny incoming
ufw default allow outgoing

# SSH — restrict to trusted admin subnets:
ufw allow from 10.0.0.0/8 to any port 22 proto tcp

# HTTP → HTTPS redirect:
ufw allow 80/tcp
ufw allow 443/tcp

# Tailscale (optional):
ufw allow in on tailscale0

ufw enable
ufw status verbose
```

## Postgres

Postgres is only reachable inside the Docker network — do NOT expose 5432. Verify with:

```bash
ss -tlnp | grep 5432
# (should only show container-local / docker bridge addresses)
```

## Outbound allowlist for email / SMS

If egress is restricted, allow:
- Postmark: `api.postmarkapp.com:443`
- Twilio:   `api.twilio.com:443`
- TextLink: `textlinksms.com:443`
- Release CDN (Tauri updater): `releases.vibeconnect.app:443`
