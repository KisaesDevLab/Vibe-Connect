# Vibe Connect — Addendum

*Companion to `vibe-connect-build-plan.md`. The main plan is locked as-built; this addendum is the authoritative source for topics the plan doesn't cover in depth. Three sections: (1) DigitalOcean droplet hosting as a supported deployment target, (2) the storage architecture reference for all deployments, and (3) admin configuration UX — a guided-setup surface designed for non-technical administrators.*

*Deferred for future addendums: DigitalOcean Marketplace 1-Click App, additional deployment targets (AWS Lightsail, Linode, Hetzner).*

---

## Scope

This addendum:

- Defines **firm-hosted cloud** (DigitalOcean droplet) as a supported deployment target
- Is the **authoritative storage architecture reference** for both on-premises and firm-hosted deployments (backend abstraction, sharded layout, S3-compatible options, retention, backups)
- Defines the **client directory visibility model** (who on staff can see which clients, how the privacy barrier is enforced, the Restricted flag for confidential engagements)
- Defines the **admin configuration UX** that makes Vibe Connect usable by firm administrators who are not IT experts (guided setup wizard, configuration screens, inline help, safety rails)
- Provides a reference **firm setup runbook** for DigitalOcean droplet deployments
- Does not introduce new phases; slots into the existing 26-phase plan, primarily extending Phases 11 (Admin UI) and 15 (appliance packaging)

## Terminology

To avoid misleading claims, use these terms consistently across docs and sales:

- **On-premises** — NucBox or equivalent hardware in the firm's physical office
- **Firm-hosted (cloud)** — droplet or equivalent VM under the firm's control, with firm-controlled keys and backups
- **Vendor-managed SaaS** — not supported; would break the trust model

Never use "self-hosted" to describe a droplet deployment. Use "firm-hosted." Self-hosted implies physical custody of the hardware.

---

## What changes in the plan

### Phase 15 — new tasks

Add to the existing Phase 15 (appliance packaging) task list:

- [ ] **Deployment targets documented:** NucBox (on-premises, default), DigitalOcean droplet (firm-hosted cloud), bare-metal Linux server, and Proxmox/ESXi VM. Each target has a one-page runbook.
- [ ] **Droplet-specific docker-compose overlay:** `docker-compose.droplet.yml` layering on top of the base compose file. Differences from NucBox default: expects DO Spaces credentials for backups (optional), disables USB-device passthrough sections not relevant to VMs, tightens memory limits to match the smallest recommended droplet size.
- [ ] **File storage backend abstraction:** implement a `FileStorage` interface with `put(key, ciphertextStream)`, `get(key) -> ciphertextStream`, `delete(key)`, `stat(key)`. Ship two implementations: `LocalFilesystemStorage` (default, writes to a Docker volume) and `S3CompatibleStorage` (DO Spaces, Backblaze B2, MinIO, AWS S3). Backend selected at boot via `FILE_STORAGE_BACKEND=local|s3` env var. All calling code goes through the interface; no direct `fs.writeFile` for attachments anywhere in the app.
- [ ] **Sharded directory layout for local storage:** attachments land at `$ATTACHMENT_ROOT/<first-2-chars-of-id>/<id>.enc` plus a sibling `.meta` file. This avoids the ~10k-files-per-directory filesystem performance cliff and gives 256 buckets (plenty for any firm's lifetime). `ATTACHMENT_ROOT` is env-configurable.
- [ ] **No attachment deduplication:** document explicitly in code comments that attachments are never deduplicated. With E2EE, identical plaintext encrypted with two different conversation keys produces different ciphertext — there is no dedup opportunity at the storage layer. A future Claude Code session trying to add it would spend effort for zero benefit and break the trust model.
- [ ] **Crypto-shredding reaper job:** weekly cron that scans `attachments` for rows whose wrapping key has been destroyed (via retention or manual deletion), deletes the ciphertext file from storage, and logs counts to the audit log. Ciphertext without its wrapping key is already unreadable, but the sweep keeps disk use honest.
- [ ] **Disk encryption guidance:** DO droplet disks are not encrypted at rest by default. Runbook documents LUKS setup during droplet provisioning for firms that want full-disk encryption, plus the simpler fallback of encrypted Postgres tablespaces + encrypted Duplicati backups.
- [ ] **DO Spaces backup target:** Duplicati config snippet targeting DO Spaces as an S3-compatible destination. Spaces credentials configured via env vars, never baked into images.
- [ ] **DO cloud firewall preset:** documented firewall rules for the three hosting shapes (Cloudflare Tunnel, direct public + Let's Encrypt, Tailscale-only). Shape A: no inbound ports open. Shape B: 443 inbound from anywhere. Shape C: no inbound except Tailscale's coordination.
- [ ] **First-boot detection:** on first boot, appliance detects environment (NucBox vs. droplet vs. generic) via a small bootstrap check and defaults the admin setup wizard to sensible values for that environment. Not blocking; just friendlier.
- [ ] **Smoke test matrix:** Phase 15 exit criteria expanded to include a clean install on a fresh $24/month droplet reaching first-staff-message in < 30 minutes, matching the NucBox criterion.

### Cross-cutting concerns — new entries

Add to the existing cross-cutting concerns section:

- **Deployment model:** Vibe Connect supports on-premises and firm-hosted cloud deployments. In both cases the firm controls keys, data, and lifecycle. Vendor-managed SaaS is not supported — that model would break the trust boundary. When discussing with prospects, use "firm-hosted" not "self-hosted" for cloud deployments to avoid misleading claims.
- **DO Spaces for backups:** when using DO droplets, prefer DO Spaces as the backup target for same-datacenter low-latency restores, with a secondary off-DO target (Backblaze B2, Wasabi, or similar) for true disaster recovery. Never use only a backup that lives inside the same provider as the primary.
- **Droplet snapshot privacy:** DO's automated droplet snapshots live on DO infrastructure. Ciphertext stays meaningless, but Postgres schemas and metadata are visible in snapshots. Firms with strict privacy requirements should disable DO snapshots and rely on Duplicati encrypted backups to Spaces + off-DO.

---

## Droplet size recommendations

| Firm size | Droplet tier | Monthly | Notes |
|---|---|---|---|
| 1–10 staff | Premium AMD 2 GB / 1 vCPU / 50 GB | $14 | Comfortable for small firm; tight if many concurrent uploads |
| 11–25 staff | Premium AMD 4 GB / 2 vCPU / 80 GB | $24 | **Recommended default.** Handles typical CPA firm with headroom. |
| 26–50 staff | Premium AMD 8 GB / 4 vCPU / 160 GB | $48 | For growing firms; comfortable for years of message history |
| 50+ staff | 16 GB / 8 vCPU / 320 GB | $96 | At this size the firm should also consider NucBox on-premises for latency |

Recommended region: **NYC3, SFO3, or ATL1** (US-based; firm picks closest to their main office). Data residency: US only for firms with US-based clients, unless a specific non-US region is needed.

Enable **automated backups** during droplet creation (+20% of droplet cost). These give 4 weekly and 4 daily restore points and save you if Duplicati backups are ever unavailable. For the recommended $24 tier, this adds $4.80/month for a total of $28.80.

---


### The rule

**Hybrid model — directory-level visibility, conversation-level privacy:**

- Every staff member can see the firm's client directory (who the clients are, who handles them, when they were last active)
- Message content is only visible to staff who are members of the specific conversation
- An admin-controllable "Restricted" flag hides specific clients from the directory for staff who aren't members of at least one conversation with them

### Why this model

CPA firms are small. Staff already know who the clients are from answering the phones, seeing tax returns, and walking past each other's desks. Hiding the client list from staff creates an impossible-to-maintain fiction while breaking operational workflows — referrals, coverage during PTO, partner oversight, and receptionist routing all depend on the directory being readable.

The actual privacy guarantee comes from end-to-end encryption. Conversations with a client are encrypted with a conversation key that only authorized members can unwrap. A staff member who can see a client's name in the directory but isn't a conversation member has no path to the message content — not through the UI, not through the API, not even with direct database access, because the conversation key was never wrapped to their device. The E2EE model does the privacy work; the directory does the operational work.

Firms who need stronger isolation for specific engagements (divorces, partner disputes, investigations where even existence is confidential) use the Restricted flag — it scopes directory visibility down to authorized staff on a per-client basis.

### Implementation notes

- **Directory view** is a separate API endpoint (`GET /clients`) that returns only metadata fields — id, display name, firm reference, assigned lead, last activity date, conversation count. No message content, no attachments, no previews. Server-enforced.
- **Conversation access** goes through a different endpoint (`GET /conversations/:id/messages`) that requires membership. The server refuses to deliver wrapped conversation keys to non-members, making server-side access control the first barrier and the encryption model the second.
- **Restricted clients** use a server-side filter: `GET /clients` excludes restricted clients where `requester IS NOT member of any conversation with client AND requester IS NOT admin`. A restricted client the requester can see has a `restricted: true` field in the response so the UI can render the lock icon.
- **Audit log** receives an entry for every `GET /clients/:id` call (directory access), every successful `conversations/:id/messages` call (content access), every join request and approval, and every admin modification to the Restricted flag. Message content never enters the audit log.

## File storage architecture

How attachments (documents, images, etc.) are stored and retrieved. Applies to both NucBox and droplet deployments; droplet-specific paths and DO Spaces config called out below.

### Trust model recap

The server never handles plaintext files. The browser encrypts each file with a per-file XChaCha20-Poly1305 key before upload; the server only ever writes and reads ciphertext. The per-file key is wrapped to the conversation key and stored in `attachments.wrapped_file_key`. The only moment plaintext exists on the server is briefly in RAM-backed tmpfs during virus scanning (Phase 19), where a ClamAV sidecar container decrypts, scans, and re-encrypts — no plaintext ever touches persistent storage.

### Storage layout

Each attachment is two files, addressed by a random 32-byte id:

- `<id>.enc` — the encrypted payload, streamed directly from the upload request body to disk
- `<id>.meta` — small JSON sidecar with the IV, authentication tag, original mime type, and original file size

Both live under `$ATTACHMENT_ROOT`, sharded into 256 buckets by the first 2 hex characters of the id to avoid filesystem slowdowns at scale:

```
$ATTACHMENT_ROOT/
├── 2f/
│   ├── 2f9a4d...e8b3.enc
│   └── 2f9a4d...e8b3.meta
├── 7c/
│   ├── 7ce8a1...44f2.enc
│   └── 7ce8a1...44f2.meta
└── ... (up to 256 directories, created lazily)
```

The `attachments.storage_path` column stores only the relative path (`2f/2f9a4d...e8b3`). Never absolute. This means a DB backup restored onto a different host lands cleanly as long as `ATTACHMENT_ROOT` is set correctly in the target environment.

### Storage backends

Two backends, selected by env var `FILE_STORAGE_BACKEND`:

**`local` (default)** — writes to a Docker volume mounted into the app container. Appropriate for NucBox appliances and small-to-medium droplet deployments. Paths:

| Deployment | Host path | Container path |
|---|---|---|
| NucBox | `/var/lib/vibe-connect/attachments/` | `/app/storage/attachments/` |
| Droplet | `/opt/vibe-connect/data/attachments/` | `/app/storage/attachments/` |
| Dev | `./data/attachments/` | `/app/storage/attachments/` |

The container path is consistent across deployments; the host path varies. Env var `ATTACHMENT_ROOT=/app/storage/attachments` inside the container.

**`s3` (opt-in)** — writes to an S3-compatible bucket instead of local disk. Appropriate for firms expecting high attachment volume, firms running multiple appliances for redundancy, or firms that want attachments stored separately from the compute host. Every call the app makes to the `FileStorage` interface routes to the bucket instead of the filesystem. `storage_path` still stores the relative key (`2f/2f9a4d...e8b3`), just interpreted as an object key rather than a filesystem path.

Supported S3-compatible providers (all tested against the same backend code):

| Provider | Best for | Monthly cost at 100 GB |
|---|---|---|
| **DigitalOcean Spaces** | Droplet deployments — same-datacenter, low-latency | $5 base + egress |
| **Backblaze B2** | Cost-conscious firms, cold-storage leaning | ~$0.60 + egress |
| **Wasabi** | No-egress-fee pricing model | ~$7 flat |
| **AWS S3** | Firms already standardized on AWS | ~$2.30 + egress |
| **MinIO** | On-prem S3 for firms running their own object storage | self-hosted |

### Configuring DO Spaces as the attachment backend

For droplet deployments that want attachments in Spaces rather than on the droplet's local disk:

1. **Create a Space** in the DO control panel. Region: same as the droplet (e.g., `nyc3`). Name: `vibe-connect-attachments-<firm>`. **File listing: Restricted.** CORS: none needed (all access is server-side).

2. **Generate Spaces access keys** at DO → API → Spaces Keys. Record the access key and secret.

3. **Set env vars in `.env`:**

```bash
FILE_STORAGE_BACKEND=s3
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_REGION=us-east-1
S3_BUCKET=vibe-connect-attachments-krueger
S3_ACCESS_KEY=<your Spaces access key>
S3_SECRET_KEY=<your Spaces secret key>
S3_FORCE_PATH_STYLE=false
```

4. **Restart the app container.** New uploads land in Spaces; existing attachments remain where they were (see migration note below).

Note that `S3_REGION=us-east-1` is correct even for a non-US Space — DO Spaces accepts this as a generic region identifier. The actual region is implied by the endpoint URL.

### Migrating between backends

Local → S3: run `scripts/migrate-storage.js --from=local --to=s3` (ships with Phase 15). Reads every attachment from disk, uploads to the bucket, updates `storage_path` if the key scheme changes (it doesn't — same sharded paths), and verifies each file is retrievable from the new backend before marking the migration complete. Takes roughly 1 minute per GB of attachments.

S3 → local: same script, `--from=s3 --to=local`. Requires enough disk on the destination.

Do not run the migration script while the app is serving traffic — stop the app container, migrate, update env vars, restart.

### Retention and crypto-shredding

When retention policy triggers destruction of a conversation (or a specific attachment), the wrapping key in `attachments.wrapped_file_key` is overwritten with zeros. The ciphertext on disk or in Spaces is now unreadable by anyone, ever — this is the crypto-shredding primitive.

The ciphertext file itself is left in place for up to 7 days as a safety margin against accidental retention triggers, then reaped by the weekly sweeper job. The sweeper:

- Queries `attachments` for rows where `wrapped_file_key IS NULL` AND `shredded_at < now() - interval '7 days'`
- Deletes the corresponding `<id>.enc` and `<id>.meta` files from the backend (filesystem `unlink` or S3 `DeleteObject`)
- Emits an audit log entry with the count of files reaped

If a bug ever causes `wrapped_file_key` to be zeroed on a row that should have been preserved, admins have 7 days to notice and restore from backup before the ciphertext is actually gone.

### Backup strategy for attachments

Attachments are the biggest data-volume item in the system (DB is small; messages are tiny; attachments are bank statements and PDFs). Backup approach differs by backend:

**Local backend:** Duplicati backs up the entire `$ATTACHMENT_ROOT` directory as part of its scheduled backup to DO Spaces + off-DO target. See Step 6 of the runbook.

**S3 backend:** **Do not** rely on DO Spaces as the only copy. Even though Spaces is more durable than a single disk, losing access to the bucket (key compromise, billing issue, DO outage) means losing attachments. Configure DO Spaces bucket replication to a secondary provider (Backblaze B2 is the standard target), OR run a nightly Duplicati job that reads from Spaces and writes encrypted copies to B2/Wasabi. Same principle as backups generally: a copy in the same provider as the primary is not a real backup.

### Storage sizing estimates

For a typical CPA firm:

| Firm size | Years of data | Typical attachment volume | Recommended starting disk |
|---|---|---|---|
| 10 staff | 3 years | 15–30 GB | 80 GB droplet (plenty of room) |
| 25 staff | 3 years | 40–80 GB | 80 GB (monitor) or 160 GB |
| 50 staff | 5 years | 150–300 GB | S3 backend, droplet disk is for logs/DB only |

Tax-season uploads (Jan–Apr) spike attachment volume. If disk usage hits 70% at any point, either resize the droplet or move to the S3 backend.

### Six things that commonly go wrong

1. **`ATTACHMENT_ROOT` not set correctly after restore.** The DB is restored into a new host where `ATTACHMENT_ROOT` points somewhere that doesn't exist. App starts, DB says "attachments are at `2f/2f9a4d...`" but filesystem is empty. Fix: set env var, move files, restart. Document in restore runbook.
2. **Permissions on the volume.** Docker volume owned by root, app container runs as non-root, file writes fail silently. Fix: `chown -R 1000:1000 /opt/vibe-connect/data/attachments/` or match your container user.
3. **Disk fills up during tax season.** Monitor hits 80% at 2 AM on April 10th, nobody notices, uploads start failing at 8 AM. Fix: disk-usage alert at 70% with a hard cutover to the S3 backend as the escape hatch.
4. **S3 credentials leaked in a backup.** Backup includes `.env` in plaintext. Fix: ensure backup encryption passphrase is set; verify backup contents don't expose credentials. Rotate keys immediately if leaked.
5. **Someone manually deletes a file from disk.** DB says the attachment exists, filesystem says no. On read, app returns a generic "unavailable" error rather than crashing. Fix: integrity checker run nightly that reports orphans in both directions (DB rows with no file, files with no DB row).
6. **Virus scanner fails open.** ClamAV container crashes, uploads queue up. Fix: explicit failure mode — if virus scanner is unavailable, uploads are rejected with a clear error, not accepted-without-scanning. Document this as a deliberate choice: unscanned upload is unacceptable for CPA data even if it means temporary upload outages.

---

## Admin configuration UX

Extends Phase 11 (Admin UI) of the main plan with the guided-setup and configuration surfaces needed for non-technical firm administrators. Target user: a firm partner or office manager who is comfortable with computers but is not an IT professional. If a task requires editing a config file, SSHing into a server, or reading documentation, it does not belong in this UX — it belongs in the runbook.

### Design principles

Ground rules that every admin screen in this section follows:

1. **Nothing is named after its underlying technology.** No screen says "VAPID keys," "SMTP endpoint," "S3-compatible bucket," or "cloudflared sidecar." Instead: "Push notifications," "Outgoing email," "Cloud document storage," "Public internet access."
2. **Every destructive action has a two-step confirmation with plain-English consequences.** Not "Are you sure?" — instead "This will permanently delete Rob Mathes. His past messages will remain visible to you, but he will no longer receive new messages. He will need to be re-invited. Type DELETE to confirm."
3. **Status is always visible, never inferred.** Every configured integration (email, SMS, storage backend, tunnel) has a green/yellow/red indicator next to its name on the main settings screen, with a plain-English explanation on hover.
4. **Defaults are safe.** Any new install has every safety feature turned on by default (SSN step-up required, virus scanning enabled, retention set to "keep forever," backups required before going live). Admin has to deliberately weaken them, and the UX pushes back when they try.
5. **Save is explicit.** No auto-save on sensitive config. Changes are staged visually with an unmissable "Save changes" bar at the bottom that appears when there are unsaved edits, disappears when saved. This prevents the "I clicked around and broke everything" failure mode.
6. **Every error message proposes a fix.** Not "Connection failed" — instead "Vibe Connect couldn't reach Postmark. This is usually caused by an incorrect server token. [Test connection] [Re-enter token] [Get help]".
7. **Destructive settings live on a separate "Danger zone" page** with its own warning banner and require the admin's password to be re-entered for each change.

### Admin navigation structure

Redesigned from Phase 11's flat tab list (`Users / Groups / Settings / Audit log / Device health`) into a grouped sidebar. The phase-11 tabs still exist; they're just reorganized under meaningful section headers with a first-time-setup checklist anchoring the top.

```
┌─────────────────────────────────────────────────┐
│ ADMIN SETTINGS                                  │
├─────────────────────────────────────────────────┤
│ ▸ Setup checklist                     3 of 8 ✓  │   ← Persistent until 100% complete
│                                                 │
│ YOUR FIRM                                       │
│   • Firm profile                                │   ← Name, logo, time zone, contact
│   • Staff & groups                              │   ← formerly Users + Groups
│   • Clients                                     │   ← External identities management
│                                                 │
│ HOW MESSAGES GET DELIVERED                      │
│   • Notifications                      ● OK     │
│   • Outgoing email                     ● Warning│
│   • Text messages                      ● Not set│
│   • Public internet access             ● OK     │
│                                                 │
│ WHERE YOUR DATA LIVES                           │
│   • Document storage                   ● OK     │
│   • Backups                            ● OK     │
│   • Data retention                              │
│                                                 │
│ SECURITY                                        │
│   • Client identity verification       ● OK     │
│   • Staff devices                               │   ← formerly Device health
│   • Audit log                                   │
│   • Recovery phrase                             │
│                                                 │
│ DANGER ZONE                                     │   ← Always last, red heading
│   • Firm-wide password reset                    │
│   • Export and destroy all data                 │
│   • Transfer ownership                          │
└─────────────────────────────────────────────────┘
```

### The setup checklist (first-time admin experience)

After first-boot admin creation, the admin lands on a setup checklist rather than an empty dashboard. Each item is a card with an explanatory paragraph, a clear call-to-action button, and a status indicator. Items can be completed in any order but ordered by recommended sequence.

**The eight-item checklist:**

1. **Set your firm's name and logo** — friendly, not required but strongly nudged. 30 seconds.
2. **Save your recovery phrase somewhere safe** — forces admin to confirm they've stored it (drag the words into order). 2 minutes. Cannot be skipped.
3. **Add your staff** — bulk CSV import, or add one at a time. Explains that each staff member will get an invitation email with instructions. 5–15 minutes.
4. **Turn on email notifications** — guided setup for Postmark (or alternate); shows what emails clients will receive. 5 minutes.
5. **Turn on text message notifications** — guided setup for TextLink or Twilio; can be skipped and returned to later. 5–30 minutes depending on 10DLC path.
6. **Choose where documents are stored** — default "On this server" is pre-selected; toggle to "In a cloud bucket (DigitalOcean Spaces)" shows the guided flow. 2–10 minutes.
7. **Set up backups** — mandatory before the checklist can complete. Forces a successful test backup + test restore before marking complete. 10 minutes.
8. **Invite your first client** — validates the whole pipeline by sending a real invite to an email address the admin controls. Admin clicks through the client portal flow themselves to verify it works. 5 minutes.

The checklist banner at the top of the admin UI stays visible on every screen until all 8 items are complete. It's not a nag — it's a safety rail. A firm with an incomplete checklist is a firm that could lose data or fail to deliver client messages.

### Configuration screen patterns

Every configuration screen uses the same three-column layout: **What it does** (plain English), **Current settings** (the controls), **Status** (green/yellow/red + last test).

**Example: Outgoing email screen**

```
┌───────────────────────────────────────────────────────────────────┐
│ Outgoing email                                          ● Warning │
├───────────────────────────────────────────────────────────────────┤
│ What this does                                                    │
│ When you send a message to a client who isn't online, Vibe       │
│ Connect emails them a notification. Your firm needs a mail       │
│ provider to send these. We recommend Postmark ($15/mo for typical │
│ CPA volume).                                                      │
│                                                                   │
│ [ Learn more about Postmark ↗ ]                                  │
│ ─────────────────────────────────────────────────────────────────│
│ Settings                                                          │
│                                                                   │
│ Provider:     [ Postmark ▾ ]                                      │
│                                                                   │
│ Server token: [ ••••••••••••••••••••••••••• ]  [ Show ]           │
│ Where to find this: Postmark → Servers → your server → API tokens │
│                                                                   │
│ From address: [ noreply@krueger-cpa.com            ]              │
│ Display name: [ Krueger CPA                        ]              │
│                                                                   │
│ Content mode:  (•) Summary only — safer, less info in email       │
│                ( ) Include message preview — higher engagement    │
│                                                                   │
│ ─────────────────────────────────────────────────────────────────│
│ Status                                                            │
│ Last test: 3 days ago — Delivered successfully                    │
│ DNS: ⚠ SPF record missing. Emails may land in spam.              │
│     [ Show me how to fix this ]                                   │
│                                                                   │
│              [ Test now ]           [ Send test to myself ]       │
└───────────────────────────────────────────────────────────────────┘

              [ Save changes ]  appears only when edited
```

The DNS warning doesn't just say "SPF missing" — clicking "Show me how to fix this" opens a modal with the exact DNS record the admin should paste into their registrar, the registrars with screenshots for the top 5 domain registrars (GoDaddy, Namecheap, Cloudflare, Google Domains, Route 53), and a "Check again" button that polls DNS propagation.

### Configuration screens in detail

**Firm profile.** Name, logo upload (drag-drop with preview), time zone (defaults from browser, with confirmation), primary admin contact email for system alerts, firm's business hours (used for "don't send SMS at 2am" rules).

**Staff & groups.** Table of staff with quick actions (Add, Deactivate, Reset password, Revoke all devices). Group management as a drag-and-drop interface — a staff member card dragged between groups. Bulk CSV import with an inline preview showing "12 users will be added to these groups" before committing.

**Clients.** The firm's shared client directory. Every staff member can see *who* the firm's clients are, but can only see conversation content for clients they are a member of. This is deliberate — CPA firms are small, staff already know the client list, and pretending otherwise makes the app worse at its job. The actual privacy barrier is the E2EE conversation key, which unassigned staff cannot unwrap.

Directory view (visible to all staff):

- Searchable table with: display name, firm reference, primary contact method (email / phone), verification type, assigned lead staff member, last activity date, conversation count
- Presence-style indicator: green dot = client has been active in the last 7 days, gray = less recent
- Filter chips: "Assigned to me," "Active this month," "No recent activity," "Paused," "Restricted"
- Clicking a row opens the client record

Client record pane:

- If the staff member is a conversation member: full conversation history (encrypted and decrypted client-side as normal)
- If the staff member is *not* a conversation member: client record shows name, firm reference, assigned lead, last activity date, conversation count — **no messages, no attachments, no message previews**. A banner reads "You are not a member of any conversation with this client. Ask [lead staff name] to add you." with a "Request to join" button that pings the lead staff member with a one-click approval
- The "Request to join" flow requires the lead staff member to approve before any conversation key is rewrapped to the requester's device. Server-enforced at the crypto layer — a request without approval cannot unwrap messages even if the UI is tricked

Admin-only controls on the client record:

- Edit display name, firm reference, email, phone
- Change SSN/EIN verification type or reset the stored last-4
- Pause conversations (client can no longer log in; staff see a paused indicator; existing messages are preserved)
- Assign lead staff member
- **Restricted flag** — when set, the client does NOT appear in the directory for staff who aren't members of at least one conversation with them. Use case: sensitive matters (divorces, partner disputes, investigations) where even the existence of the engagement is confidential. Restricted clients show up in the directory only for their assigned staff plus admins. A restricted-client indicator (small lock icon) appears next to the client name for staff who can see them, so those staff know not to mention the client around other staff.

Audit log:

- Every directory access writes an entry (actor, client_id, `action='directory_view'`, timestamp). Not message content — just the metadata access.
- Partners can filter audit log by client to see who looked at a client record, or by staff member to see their activity.
- Restricted clients get extra audit logging: any directory access attempt (including blocked ones from non-authorized staff) logs the attempt.

Export:

- "Export client list" → CSV with all directory-level fields. Does not include message counts, conversation details, or restricted-client entries if the exporting staff isn't authorized to see them.
- Export itself is audit-logged with actor + reason.

This is the **Option 3 hybrid model**: directory-level visibility for firm operations, conversation-level privacy enforced by cryptography, admin escape hatch via the restricted flag.

**Notifications.** Master switch + granular controls. Toggle urgency-override-DND globally. Push notification health status (VAPID keys configured correctly, service worker reaching devices). Test button sends a push to the admin's current browser.

**Outgoing email.** Pattern above.

**Text messages.** Admin-configured SMS notifications that let clients know a message is waiting. Screen layout:

*Header row.* Page title "Text messages" with a status pill — green "Active," amber "Warning" (e.g., paired phone offline or monthly cap approaching), gray "Not configured." One-sentence description: "When you send a message to a client who isn't online, Vibe Connect can text them a short notification with a link to sign in."

*Provider selector.* Three side-by-side selectable cards, not a dropdown:

- **TextLink** (default, marked "Recommended") — "Use a dedicated Android phone in your office to send texts. Low cost, fast setup, no carrier approval needed."
- **Twilio** — "Cloud-based. Higher throughput, no hardware needed. Requires 10DLC carrier approval (takes 2–4 weeks)."
- **Turn off text messages** — "Clients will only receive email notifications. You can turn this back on anytime."

Switching providers triggers a confirmation flow that explains consequences (migrating opt-in records, new sender number, etc.) and cannot happen mid-edit on unsaved state.

*TextLink-specific config panel* (shown only when TextLink is the active provider):

- Status row: "Phone paired & online" / "Phone offline — texts paused" / "Not paired yet"
- Paired device card: phone model + location label (e.g., "Pixel 6a — office shelf"), last check-in timestamp. Clicking opens a diagnostic modal with battery level, 24h delivery rate, signal strength, last STOP-keyword hit.
- Sending-from card: outbound phone number, carrier name, SIM plan description (e.g., "Verizon · unlimited SMS plan")
- API key field: masked by default with Show and Rotate buttons; inline help text pointing at `textlinksms.com → account → API & Hooks`
- Inline info box: "The paired phone needs to stay on, connected to Wi-Fi, and have the TextLink app running. If it goes offline, text notifications will pause until it reconnects. You will get an admin alert if this happens." With an inline "Re-pair a new device" link that opens the QR-code pairing flow.
- First-time pairing flow (when no phone paired): step-by-step wizard — (1) buy or repurpose an Android phone, (2) insert SIM with unlimited SMS plan, (3) install TextLink app from Play Store, (4) scan QR code shown in the admin UI, (5) confirm test message delivers.

*Twilio-specific config panel* (shown only when Twilio is the active provider):

- 10DLC brand status: "Not started" / "Pending" / "Approved" / "Rejected" with plain-English explanation of what each state means and what the admin needs to do
- Direct link into Twilio console at the right page
- Account SID, Auth Token, and Messaging Service SID fields (masked, with Show / Rotate)
- Phone number picker (populated from the Twilio account)
- Webhook URL field (read-only, pre-filled, with a Copy button) — admin pastes this into Twilio's inbound-webhook config

*Rules & limits card* (shown for both providers):

- "Require opt-in before texting a client" — toggle, **visibly locked on** with a "Required by law" pill. Reassures the admin that compliance is handled and prevents accidental disabling.
- "Honor STOP replies instantly" — toggle, **visibly locked on**, also labeled "Required by law"
- "Quiet hours" — toggleable; when on, shows start-time and end-time pickers (default 9 PM to 8 AM in recipient's local time) with "Urgent messages still go through" subtext
- "Monthly cap" — numeric input with a live progress bar showing "X of Y this month" in tabular numerics. When usage exceeds 80%, admin gets an email alert; at 100%, outbound SMS is paused until the next calendar month or admin raises the cap.

*Test panel card* (shown for both providers, below rules):

- Phone number input (defaults to admin's own number from profile)
- "Send test text" button, large and primary-colored
- Last-test outcome below: "Last test: 2 minutes ago — delivered in 3.1s" with green checkmark, or failure reason with red X and fix suggestion
- Uses 1 message from the monthly count; admin is warned

*Recent activity card* (shown for both providers):

- Last 5 SMS events with color-coded status dots (green = delivered, amber = skipped, gray = opted out / blocked, red = failed)
- Each row: event description ("Notified Rob Mathes of a new message", "Skipped — quiet hours active for recipient", "Susan Bounous replied STOP — opted out"), timestamp
- "View all →" link opens the full SMS audit log with filtering

*Save bar.* Appears at the bottom only when the admin has unsaved edits. Disappears on save. Save is never automatic on this screen.

*Acceptance criteria specific to this screen.*

- A firm admin who has never used TextLink before can complete full setup in < 15 minutes given only the in-app guidance
- No technical term appears unexplained (the word "10DLC" is always followed by a plain-English description, "carrier registration required for US business SMS")
- The TCPA-required toggles are locked-on and cannot be disabled under any UI path, including URL manipulation — server enforces regardless of client state
- Switching providers cannot lose the opt-in record for any existing client; migration is automatic and audit-logged
- The test panel must actually deliver an SMS end-to-end before the screen's status pill flips from "Not configured" to "Active"

**Public internet access.** This is where hosting shape is configured as a dropdown: "Cloudflare Tunnel (recommended)" / "Direct internet (advanced)" / "Tailscale only (staff internal)". Each option expands to its own guided setup with checklists. Status shows whether the configured mode is currently reachable from the outside world (an automated probe from Vibe Connect's own cloud test service, or from an admin-provided external IP).

**Document storage.** The important screen. Radio selector:

- ( ) **On this server** (default) — "Documents are stored on the same machine as Vibe Connect. This is fine for most firms up to about 40 staff. [Current usage: 8.3 GB / 80 GB]"
- ( ) **In a cloud bucket** — "Documents are stored in DigitalOcean Spaces (or another S3-compatible service) so your server disk stays light. Recommended for firms with many attachments or multiple locations. [Learn more]"

Switching between modes triggers the migration script wizard — shows estimated time, disk/cost impact, and requires a test-mode migration of the first 10 files before migrating the rest.

**Backups.** Two tracks visible side-by-side: **Primary backup** (same-provider, fast restore) and **Disaster-recovery backup** (different-provider, cold storage). Each shows: last successful run, next scheduled run, storage used, retention setting. One-click "Test restore now" that restores to a scratch directory and verifies file integrity without touching production.

**Data retention.** Defaults to "Keep forever." Changing it shows a two-step warning about crypto-shredding being irreversible. Admin must type the word "SHRED" to confirm enabling automatic retention-based deletion.

**Client identity verification.** Global defaults for the SSN/EIN step-up (enabled/disabled, re-verify interval), with a note that these are defaults and can be overridden per-client from the invite flow.

**Staff devices.** The Phase 11 device health tab, refined: table of every enrolled device with a "Trust" toggle (revoke/unrevoke), plus filters for "Update drift," "Not seen in 7 days," and "Unknown version." Bulk revoke for terminated-staff scenarios.

**Audit log.** Filterable by actor, action type, and date range. Common filters pre-saved as quick-access links ("Admin actions this week," "Failed login attempts," "External access"). Export to PDF for compliance responses.

**Recovery phrase.** Shows that the recovery phrase is stored (never shows the phrase itself on screen outside the initial setup). Has a "Re-verify my recovery phrase" flow where admin enters the 24 words and gets confirmation they have it correct — useful for annual "did I lose it?" checks. Rotation option behind 2FA.

**Danger zone.** Three actions, each requiring admin password re-entry:

- **Firm-wide password reset** — invalidates all staff sessions, forces re-login. Useful when admin suspects a compromise.
- **Export and destroy all data** — GDPR-style full export + deletion. Full 30-day cooling-off period with daily confirmation emails before anything is actually destroyed.
- **Transfer ownership** — promotes another admin to primary admin; sends the recovery phrase setup flow to the new primary. Required step when primary admin leaves the firm.

### Inline help — the "?" icons

Every form field has a small "?" icon. Hovering shows a 1–2 sentence explanation in plain English. Clicking opens a side panel with a longer explanation, screenshots, and "When you'd want this" examples. The side panel is contextual — it knows what screen you're on and links to related topics.

All help content lives in a simple markdown folder in the repo (`docs/help/<topic>.md`) and is loaded into the admin UI at build time. No external help portal, no SaaS CMS, no account required.

### Setup wizard specifics (non-technical-admin path)

When the admin chooses "In a cloud bucket" for Document storage, they're not expected to know what DigitalOcean Spaces is. The wizard:

1. **"Do you already have a cloud storage account?"** Yes/No.
2. If No: step-by-step screenshots of creating a DO Spaces account and generating keys, with a "Take me to DigitalOcean" button that opens the right page in a new tab.
3. **"Paste your access key here"** and **"Paste your secret key here"** with Show/Hide toggles.
4. **"Pick a region"** — dropdown of DO regions with human names ("New York," "San Francisco," "Amsterdam") and a "use the region closest to your firm" suggestion.
5. **"Name your bucket"** — pre-filled with `vibe-connect-<firm-slug>`, validated for availability.
6. **"Test the connection"** — uploads a tiny test file, reads it back, deletes it. Either passes (green check) or fails with a specific error + fix suggestion.
7. **"Migrate existing documents?"** — if there are any, offers the migration with estimated time and disk impact.

Same pattern for every integration: account check → credentials → region/endpoint → test → activate. The admin never sees the word "S3" or edits an env var.

### Acceptance criteria for the admin UX

Phase 11 does not ship until:

- A firm admin who has never used Vibe Connect before can complete all 8 setup checklist items in < 90 minutes of focused time, given only the in-app guidance (no external docs, no support call).
- No screen in the admin UX displays an unexplained error code, a filesystem path, an environment variable name, or a technical term that hasn't been translated to plain English.
- Every destructive action has been tested for the "slipped the mouse" scenario and cannot complete without at least one explicit confirmation step.
- A secondary admin (person 2) can understand everything person 1 configured by reading only the admin UI — no tribal knowledge, no Slack-from-the-last-admin.
- The help content has been reviewed by someone who isn't a developer for jargon and clarity.

---

## Firm setup runbook — DigitalOcean droplet

### What the firm needs before starting

- DigitalOcean account (free to create)
- Payment method on file with DO
- A domain name owned by the firm (e.g., `krueger-cpa.com`) with DNS management access
- Decision on hosting shape: **A** (Cloudflare Tunnel, recommended), **B** (direct public + Let's Encrypt), or **C** (Tailscale-only, staff-internal use)
- The Vibe Connect installer token or GitHub access (depending on distribution model)

Time to first message: **30–45 minutes** end-to-end.

---

### Step 1 — Create the droplet

In the DigitalOcean control panel:

1. **Create → Droplets**
2. **Region:** pick nearest US region to the firm's main office
3. **Image:** Ubuntu 24.04 LTS x64
4. **Size:** Premium AMD, 4 GB / 2 vCPU / 80 GB (the $24 tier)
5. **Authentication:** SSH key (preferred) or password. SSH key strongly recommended; create one with `ssh-keygen -t ed25519 -C "vibe-connect-admin"` if the firm's admin doesn't already have one, and paste the public key into DO.
6. **Hostname:** something memorable — `vibe-connect-prod` or `vibeconnect-krueger`
7. **Additional options:**
   - ✅ Enable automated backups (+20%)
   - ✅ Enable monitoring (free)
   - ✅ IPv6 (free)
8. **Create droplet.** Takes ~60 seconds to provision. Note the public IPv4 address.

### Step 2 — Initial server hardening

SSH in as root and run the following. Copy this block; it's designed to be run as-is.

```bash
# Update system
apt update && apt upgrade -y

# Create a non-root admin user
adduser vcadmin
usermod -aG sudo vcadmin

# Copy SSH key from root to the new user
rsync --archive --chown=vcadmin:vcadmin ~/.ssh /home/vcadmin

# Install Docker and compose
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker vcadmin

# Install UFW firewall (will configure based on hosting shape in Step 4)
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH

# Disable root SSH login and password auth
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Enable unattended security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

Log out of root. From here on, SSH in as `vcadmin` (`ssh vcadmin@<droplet-ip>`).

### Step 3 — Install Vibe Connect

```bash
# Create the install directory
sudo mkdir -p /opt/vibe-connect
sudo chown vcadmin:vcadmin /opt/vibe-connect
cd /opt/vibe-connect

# Pull the compose file and environment template
# (replace with actual distribution URL once published)
curl -O https://releases.vibeconnect.app/latest/docker-compose.yml
curl -O https://releases.vibeconnect.app/latest/docker-compose.droplet.yml
curl -O https://releases.vibeconnect.app/latest/.env.example
cp .env.example .env

# Generate secrets
nano .env
```

Edit `.env` and set at minimum:

```
SITE_URL=https://connect.krueger-cpa.com
PORTAL_URL=https://portal.krueger-cpa.com
SESSION_SECRET=<paste output of `openssl rand -hex 32`>
DATABASE_PASSWORD=<paste output of `openssl rand -hex 24`>
VAPID_PUBLIC_KEY=<see next command>
VAPID_PRIVATE_KEY=<see next command>
EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=<your Postmark server token>
SMS_PROVIDER=textlink
TEXTLINK_API_KEY=<your TextLink API key, or blank if deferred>

# File storage (default: local disk on the droplet)
FILE_STORAGE_BACKEND=local
ATTACHMENT_ROOT=/app/storage/attachments

# OR, to store attachments in DO Spaces instead (recommended for 25+ staff firms):
# FILE_STORAGE_BACKEND=s3
# S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
# S3_REGION=us-east-1
# S3_BUCKET=vibe-connect-attachments-krueger
# S3_ACCESS_KEY=<Spaces access key>
# S3_SECRET_KEY=<Spaces secret key>
# S3_FORCE_PATH_STYLE=false
```

See the **File storage architecture** section above for guidance on choosing between `local` and `s3` backends, and for the DO Spaces bucket setup steps.

Generate VAPID keys:
```bash
docker run --rm node:20-alpine npx web-push generate-vapid-keys
```

Paste the output into `.env`.

### Step 4 — Configure firewall and DNS based on hosting shape

**Shape A — Cloudflare Tunnel (recommended):**

```bash
# No inbound ports needed — cloudflared makes outbound connections only
# UFW already denies inbound by default; nothing further to open
ufw enable
```

Add the cloudflared sidecar to the compose file, start everything:
```bash
docker compose -f docker-compose.yml -f docker-compose.droplet.yml -f docker-compose.cloudflared.yml up -d
```

Then in the Cloudflare Zero Trust dashboard:
1. Create a tunnel named `<firm>-vibe-connect`
2. Copy the tunnel token into `TUNNEL_TOKEN` in `.env`, restart compose
3. Add public hostname `connect.<firm>.com` → HTTP service at `http://vibe-connect-app:3000`
4. Add public hostname `portal.<firm>.com` → HTTP service at `http://vibe-connect-app:3001`
5. **Critical:** add a Cache Rule matching `*.<firm>.com` with action "Bypass cache" — chat apps must never be cached by the edge
6. **Do not enable Cloudflare Access** on either hostname. Vibe Connect handles its own auth.

**Shape B — Direct public with Let's Encrypt:**

```bash
# Open HTTPS and redirect HTTP
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Point DNS A records at the droplet's public IP:
#   connect.<firm>.com  → <droplet-ip>
#   portal.<firm>.com   → <droplet-ip>
# Wait for DNS propagation (up to 5 minutes)

# Bring up Nginx with certbot sidecar
docker compose -f docker-compose.yml -f docker-compose.droplet.yml -f docker-compose.nginx.yml up -d
```

Certbot runs on first boot, provisions a Let's Encrypt cert for both hostnames, and auto-renews every 60 days.

**Shape C — Tailscale-only (staff internal):**

```bash
# No public ports
ufw enable

# Install Tailscale on the host
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --accept-routes

# Get the droplet's Tailscale IP and MagicDNS name
tailscale status
```

Bring up Vibe Connect without any public exposure:
```bash
docker compose -f docker-compose.yml -f docker-compose.droplet.yml up -d
```

Staff access the app via Tailscale MagicDNS (e.g., `http://vibeconnect-prod:3000`). Configure each staff workstation with Tailscale first. Client features are disabled at the admin level since there's no public portal.

### Step 5 — First-boot admin setup

Open the appliance URL in a browser (whichever the chosen shape provides). First-boot wizard:

1. Create the first admin account (username, password, display name)
2. Set firm name and upload firm logo
3. **Generate recovery phrase.** App displays 24 words once. Write them down on paper. Store in a sealed envelope, ideally in a fireproof safe or bank safe-deposit box. Losing this phrase means losing access to all encrypted client conversations the firm is in.
4. Confirm recovery phrase by re-entering words 5, 12, and 19 (verification step)
5. Enroll first device: browser generates device keypair, encrypts with password, uploads

Admin is in. Set up additional staff via Admin → Users → Invite.

### Step 6 — Configure backups

Duplicati is bundled in the appliance. In the admin UI, Settings → Backups:

1. **Add DO Spaces target (same-region, fast restore):**
   - Provider: S3-compatible
   - Endpoint: `nyc3.digitaloceanspaces.com` (or whichever region)
   - Bucket: `vibe-connect-backups-<firm>`
   - Access key + secret: generated in DO → Spaces → Access Keys
   - Encryption passphrase: generate and record separately from firm recovery phrase
2. **Add off-DO target (disaster recovery):**
   - Backblaze B2 or Wasabi — both cheaper than DO Spaces for cold storage
   - Same encryption passphrase
3. **Schedule:** hourly incremental, daily full, 30-day retention on DO Spaces, 1-year retention on off-DO target
4. **Test restore:** immediately after first backup completes, do a dry-run restore to `/tmp/restore-test` and verify files land. **Do not skip this step.** An untested backup is not a backup.

### Step 7 — Verify

- [ ] Admin can log in at the appliance URL
- [ ] Admin can create a second user and that user can log in from a different browser
- [ ] The two users can exchange messages (encrypted round-trip)
- [ ] Attachment upload/download works
- [ ] Uploaded attachment lands at expected storage location (check `$ATTACHMENT_ROOT/<2-char-shard>/<id>.enc` on disk for `local`, or the Spaces bucket for `s3`)
- [ ] Attachment ciphertext is unreadable on disk (`file <path>` reports binary data; `head <path>` shows no recognizable content)
- [ ] Desktop app (Tauri) installs, enrolls, and delivers notifications
- [ ] Backup to DO Spaces shows a successful run
- [ ] Test restore to `/tmp/restore-test` succeeds
- [ ] DNS resolves for both `connect.` and `portal.` hostnames (Shapes A and B)
- [ ] Cloudflare Cache Rule confirmed bypass (Shape A) — verify by checking response headers for `CF-Cache-Status: BYPASS` or `DYNAMIC`
- [ ] SSH access via key only (password login disabled)
- [ ] `ufw status` shows expected rules

---

## Operations notes

### Updating Vibe Connect

```bash
cd /opt/vibe-connect
docker compose pull
docker compose -f docker-compose.yml -f docker-compose.droplet.yml <plus whichever shape files> up -d
docker image prune -f
```

Run during low-traffic hours. Most updates are no-downtime; major version updates may require a 30–60 second restart.

### Monitoring

- **DigitalOcean monitoring graphs** (free, enabled at droplet creation) — CPU, memory, disk, bandwidth. Set alerts for >80% CPU for 5 minutes, >85% memory, >80% disk.
- **Appliance admin Device Health tab** — covers client-side update drift (see Phase 11 additions).
- **Uptime checks** — set up a free Uptime Robot or BetterStack check hitting `/health` every 5 minutes. If `/health` returns non-200, alert via email/SMS.

### Scaling up

If CPU or memory alerts fire consistently, resize the droplet:

1. Power down from DO control panel
2. Resize to next tier up (this takes ~3 minutes)
3. Power back on
4. No data loss; IP address unchanged; users won't notice other than ~5 minutes of downtime

Do not resize during business hours. Schedule for evening.

### Migrating to another provider

The whole Vibe Connect stack is a `docker-compose up -d` away from running on any Linux host. Migration:

1. Snapshot current droplet (belt-and-suspenders)
2. Create target host (new droplet, bare-metal, whatever)
3. On target, follow Steps 2 and 3 of the setup runbook
4. Duplicati restore the most recent backup into the target's volume paths
5. Bring up compose on target
6. Update DNS or Cloudflare Tunnel to point to target
7. Verify, then decommission old droplet

Realistic downtime: 15–30 minutes with planning.

---

## What this addendum does NOT cover

- **DigitalOcean Marketplace 1-Click App.** Deferred to a future addendum. Rough shape: publish a 1-Click App that pre-installs Docker, pulls the compose file, runs a guided first-boot script. Benefits: reduces setup from 30 minutes to 5 minutes and is discoverable by firms browsing DO Marketplace. Requires a publish agreement with DigitalOcean and a few weeks of work to package + get approved. Don't do this until Vibe Connect has real production users on manually-installed droplets.
- **DigitalOcean Managed Databases.** Do not use. The Postgres in the compose file is sized right, has local-disk IOPS that outperform the managed tier at this scale, and pairs cleanly with the crypto-shredding retention model. Managed Postgres would add $15–30/month and complicate backups without meaningful upside.
- **Kubernetes.** Out of scope forever. The appliance model is single-VM docker-compose by design. Any customer asking for Kubernetes deployment has different needs than Vibe Connect is built for.

---

## Decision log

- **Why Premium AMD over Regular Intel:** Premium AMD droplets have NVMe disks vs. regular SSDs, ~30% faster on Postgres and attachment I/O for the same price. No reason to pick Regular.
- **Why Ubuntu 24.04 over Debian or Alpine:** matches the NucBox appliance OS, so one support surface for the firm. Debian is fine; Alpine is not recommended because some Duplicati/Tailscale paths are better-tested on Ubuntu.
- **Why automated backups enabled by default:** they catch cases that Duplicati misses (e.g., "I accidentally ran `rm -rf` on the volume"). Cost is small; benefit is large.
- **Why DO Spaces *and* an off-DO backup:** a backup that lives in the same provider as the primary is only a backup against application-level mistakes, not against provider-level outages or account issues. Off-provider backup is cheap insurance.
