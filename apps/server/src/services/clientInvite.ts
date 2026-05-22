// Shared invite-material generation + delivery. Used by both the admin
// "Create client" route and the staff "Invite a client" flow so the crypto
// and channel semantics stay in lockstep — a divergence here would silently
// break the portal's /invite acceptance handshake.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { effectiveUrls } from './effectiveUrls.js';

// CRYPTO: Invite-URL token layout.
//   bytes  0..16  → identifier; bcrypt-hashed into invite_token_hash for verification
//   bytes 16..48  → seed for the X25519 keypair (crypto_box_SEEDBYTES = 32)
// The whole 48-byte token is base64url-encoded into the invite URL. The portal
// re-splits it on landing, proves tokenId via bcrypt, and derives the matching
// private key from the seed so conversation keys wrapped to invite_public_key
// are readable.
export const INVITE_TOKEN_BYTES = 48;
export const INVITE_TOKEN_ID_BYTES = 16;
export const INVITE_SEED_BYTES = 32;

function splitInviteToken(token: Buffer): { tokenId: Buffer; seed: Buffer } {
  if (token.byteLength !== INVITE_TOKEN_BYTES) {
    throw new Error(`invite_token wrong length: ${token.byteLength}`);
  }
  return {
    tokenId: token.subarray(0, INVITE_TOKEN_ID_BYTES),
    seed: token.subarray(INVITE_TOKEN_ID_BYTES, INVITE_TOKEN_ID_BYTES + INVITE_SEED_BYTES),
  };
}

export interface InviteMaterial {
  token: Buffer;
  tokenHash: string;
  publicKey: string;
}

// Generates a random 48-byte invite token, bcrypt-hashes its id half, and
// derives the X25519 public key from the 32-byte seed. The caller persists
// {tokenHash, publicKey} on the external_identity row and embeds the raw
// token in the invite URL — it exists only in the URL and in the client's
// inbox; the server never sees it after the HTTP response lands.
export async function generateInviteMaterial(): Promise<InviteMaterial> {
  const token = randomBytes(INVITE_TOKEN_BYTES);
  const { tokenId, seed } = splitInviteToken(token);
  const tokenHash = await bcrypt.hash(tokenId.toString('base64'), 10);
  const { keypairFromSeed } = await import('@vibe-connect/crypto');
  const kp = await keypairFromSeed(new Uint8Array(seed));
  return { token, tokenHash, publicKey: kp.publicKey };
}

export interface SendClientInviteArgs {
  identityId: string;
  displayName: string;
  /**
   * Channel selector:
   *   - 'email'  — email only (legacy single-channel call)
   *   - 'sms'    — sms only (legacy single-channel call)
   *   - 'both'   — send via every configured channel (email AND sms, when
   *                both args.email and args.phone are present). v0.4.33+
   *                default at the reinvite endpoint so a client with both
   *                contact methods on file gets reached on whichever they
   *                check first.
   */
  via: 'email' | 'sms' | 'both';
  email: string | null;
  phone: string | null;
  token: Buffer;
  /** First name of the staff sender — surfaces in SMS and email copy when provided. */
  fromDisplayName?: string | null;
  /** Firm name for the email subject / SMS prefix. */
  firmName?: string | null;
}

/**
 * Per-channel send outcome from sendClientInvite. Returned so callers (the
 * admin reinvite endpoint, the staff invite flow) can render a per-channel
 * status pill — "email sent, sms failed" reads very differently to the
 * operator than a single "send failed" rollup. Each entry is:
 *   - 'sent'    — provider accepted the request
 *   - 'failed'  — provider rejected; `error` carries the message
 *   - 'skipped' — channel not configured (email/phone is null) or `via`
 *                  excluded it
 */
export interface SendClientInviteResult {
  email: { status: 'sent' | 'failed' | 'skipped'; error?: string };
  sms: { status: 'sent' | 'failed' | 'skipped'; error?: string };
}

// BRIDGE: renders and dispatches the invite notification through the firm's
// configured email and/or SMS provider. The link carries the full 32-byte
// token; only the client (and anyone with access to the link) can derive
// the conversation-reading private key from it.
//
// Multi-channel sends: errors on one channel never abort the other. Both
// channels are attempted; the per-channel outcome is reflected in the
// returned struct. Throws only when BOTH attempted channels fail (so the
// admin UI's outer try/catch + 200-with-sendError shape is preserved for
// "no channel succeeded" cases).
export async function sendClientInvite(
  args: SendClientInviteArgs,
): Promise<SendClientInviteResult> {
  const urlTok = args.token.toString('base64url');
  // Honors the admin-side DB override (firm_settings.portal_url) so a firm
  // can fix invite-link URLs from the Admin UI without SSH access to the
  // appliance env file.
  const { portalUrl } = await effectiveUrls();
  const link = `${portalUrl.replace(/\/$/, '')}/invite?id=${encodeURIComponent(args.identityId)}&t=${urlTok}`;
  const firm = args.firmName?.trim() || 'your firm';
  const sender = args.fromDisplayName?.trim().split(/\s+/)[0] || 'Your firm';

  const wantEmail = args.via === 'email' || args.via === 'both';
  const wantSms = args.via === 'sms' || args.via === 'both';

  const result: SendClientInviteResult = {
    email: { status: 'skipped' },
    sms: { status: 'skipped' },
  };

  if (wantEmail) {
    if (!args.email) {
      // 'email' / 'both' explicit ask + no address on file. For single-
      // channel 'email' this is a programmer error and we throw to match
      // the legacy contract. For 'both' it's expected when the client
      // only has a phone; we just mark skipped and continue to sms.
      if (args.via === 'email') {
        throw new Error('email required to send invite via email');
      }
    } else {
      try {
        const { getEmailProvider } = await import('../bridges/email/index.js');
        const provider = await getEmailProvider();
        await provider.send({
          to: args.email,
          subject: `You have a secure message from ${firm}`,
          text:
            `Hi ${args.displayName},\n\n` +
            `${sender} at ${firm} has started a secure, end-to-end encrypted message channel with you.\n\n` +
            `Open this one-time link to accept:\n${link}\n\n` +
            `When you sign in, you'll receive a 6-digit code and may be asked to verify the last 4 digits of your SSN or EIN to confirm your identity.\n\n` +
            `The link expires only when it is used or you receive a new one. Keep it private — anyone who has this link can read your messages.\n\n` +
            `If you did not expect this message, you can safely ignore it.\n\n` +
            `— ${firm}`,
        });
        result.email = { status: 'sent' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.email = { status: 'failed', error: msg };
        // Single-channel call: preserve legacy throw-on-failure contract.
        // Multi-channel: swallow so sms still gets a shot.
        if (args.via === 'email') throw err;
      }
    }
  }

  if (wantSms) {
    if (!args.phone) {
      if (args.via === 'sms') {
        throw new Error('phone required to send invite via sms');
      }
    } else {
      try {
        const { getSmsProvider } = await import('../bridges/sms/index.js');
        // TCPA: opt-in is recorded on the client's first reply, not here;
        // this first SMS carries the STOP language required by carrier rules.
        const provider = await getSmsProvider();
        await provider.sendMessage({
          to: args.phone,
          body: `${firm}: ${sender} sent you a secure message. Sign in: ${link}\nReply STOP to opt out.`,
        });
        result.sms = { status: 'sent' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.sms = { status: 'failed', error: msg };
        if (args.via === 'sms') throw err;
      }
    }
  }

  // Multi-channel: if EVERY attempted channel failed (no successes), throw
  // so the calling endpoint surfaces it the same way a single-channel
  // failure does. A mixed outcome (one sent, one failed) returns
  // successfully — the per-channel struct lets the caller render it.
  if (args.via === 'both') {
    const attemptedEmail = result.email.status !== 'skipped';
    const attemptedSms = result.sms.status !== 'skipped';
    const anySent = result.email.status === 'sent' || result.sms.status === 'sent';
    if (attemptedEmail && attemptedSms && !anySent) {
      const errs: string[] = [];
      if (result.email.error) errs.push(`email: ${result.email.error}`);
      if (result.sms.error) errs.push(`sms: ${result.sms.error}`);
      throw new Error(`all_channels_failed: ${errs.join('; ')}`);
    }
    // 'both' with nothing configured to send through is also an error —
    // the caller asked for a delivery and we did nothing.
    if (!attemptedEmail && !attemptedSms) {
      throw new Error('no_channel_configured: client has neither email nor phone on file');
    }
  }

  return result;
}
