# Firm Recovery Phrase — Shamir Secret Sharing

## What this is

The 24-word firm recovery phrase displayed once during install is the only way to
recover firm-wide conversations if every enrolled device is lost. Losing the phrase
=== permanent loss of access to every external conversation the firm was in.

For multi-partner firms, holding the phrase in one pair of hands is fragile. The
Admin → **Recovery** tab provides a client-side Shamir Secret Sharing tool that
splits the phrase into N shares and reconstructs it from any K of them.

## Math, briefly

- Shamir SSS over GF(2^8), one polynomial per byte of the 32-byte BIP-39 entropy.
- Threshold `K` ∈ [2, 255]; total `N` ∈ [K, 255].
- Any `K` shares reconstruct the secret via Lagrange interpolation at x=0.
- Fewer than `K` shares reveal **nothing** about the secret (information-theoretic).
- Share format: `V1-{hex-index}-{hex-bytes}` — versioned so we can rotate the scheme
  without breaking older shares.

Implementation: `packages/crypto/src/shamir.ts`. Test vectors:
`packages/crypto/src/__tests__/shamir.test.ts`.

## Procedure — splitting into shares

1. One firm admin (typically the managing partner who saw the phrase at install time)
   logs into the staff app.
2. Go to **Admin → Recovery**.
3. In the "Split a recovery phrase into shares" form:
   - Paste all 24 words separated by whitespace.
   - Pick threshold `K` (e.g. 2).
   - Pick total shares `N` (e.g. 3).
4. Click **Generate shares**.
5. Each share appears on its own line like `V1-01-a1b2c3…`. Copy each share and
   write it on a physical card. **Do not store two shares in the same place.**
6. Distribute the cards to partners. Suggested scheme for a 3-partner firm:
   - K=2, N=3 — any two of three can recover.
7. Close the browser tab. The displayed shares only exist in that tab's DOM.

### What leaves the browser

Nothing. The split happens entirely in JavaScript in the admin's browser. Neither
the phrase nor the shares are ever sent to the server. There is no `recovery_shares`
table by design.

## Procedure — reconstructing the phrase

If you ever need the phrase back (emergency decryption, firm-key rotation):

1. Any firm admin logs in.
2. Go to **Admin → Recovery** → "Reconstruct a phrase from shares".
3. Paste at least `K` shares, one per line.
4. Click **Reconstruct phrase**.
5. The tool validates the resulting BIP-39 checksum and displays the 24 words.
6. Use those 24 words exactly once (emergency decrypt / rotate firm key) and then
   close the tab.

If fewer than `K` valid shares are pasted, the tool silently produces the wrong
entropy and the BIP-39 checksum fails, throwing `reconstructed_phrase_invalid` — no
false positives.

## Operational recommendations

- **K should be >= 2.** Trivially, K=1 is not secret sharing. The UI rejects it.
- **K should be strictly less than N.** Otherwise losing a single share locks you
  out.
- **Don't laminate or digitize shares.** Physical paper in a sealed envelope, stored
  in personal safes or bank deposit boxes, is the intended medium.
- **Label shares with the index, not the person.** Writing "Partner Smith's share"
  on the card leaks metadata if the card is found.
- **Re-issue shares if a partner leaves.** Generate a fresh split; distribute to the
  new set. Old shares become useless once the firm key is rotated (see below).
- **Keep a sealed master copy.** Consider storing one full unsplit copy in the firm's
  attorney's safe as a last-resort backup. This trades some security for robustness;
  not required but common.

## Relationship to firm key rotation

Shamir shares only protect **the current firm recovery phrase**. If the firm key is
rotated (future feature — not yet implemented), a new phrase is generated and the
old shares become useless. Re-split the new phrase immediately on rotation.

## Disaster recovery interplay

- `docs/ops/BACKUP_RECOVERY.md` documents: backups include ciphertext + wrapped keys
  but **not** the recovery phrase.
- Restoring from backup to a fresh appliance produces a working server only if at
  least one enrolled device still has its unwrapped private key in IndexedDB. If all
  devices are wiped, you need the recovery phrase — reconstructed via Shamir — to
  decrypt.
- Without Shamir (default), losing the single partner holding the phrase = losing
  firm-wide decrypt. Shamir raises the bar to "losing N−K+1 partners' shares at once".
