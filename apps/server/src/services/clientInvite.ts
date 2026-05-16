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
  via: 'email' | 'sms';
  email: string | null;
  phone: string | null;
  token: Buffer;
  /** First name of the staff sender — surfaces in SMS and email copy when provided. */
  fromDisplayName?: string | null;
  /** Firm name for the email subject / SMS prefix. */
  firmName?: string | null;
}

// BRIDGE: renders and dispatches the invite notification through the firm's
// configured email or SMS provider. The link carries the full 32-byte token;
// only the client (and anyone with access to the link) can derive the
// conversation-reading private key from it.
export async function sendClientInvite(args: SendClientInviteArgs): Promise<void> {
  const urlTok = args.token.toString('base64url');
  // Honors the admin-side DB override (firm_settings.portal_url) so a firm
  // can fix invite-link URLs from the Admin UI without SSH access to the
  // appliance env file.
  const { portalUrl } = await effectiveUrls();
  const link = `${portalUrl.replace(/\/$/, '')}/invite?id=${encodeURIComponent(args.identityId)}&t=${urlTok}`;
  const firm = args.firmName?.trim() || 'your firm';
  const sender = args.fromDisplayName?.trim().split(/\s+/)[0] || 'Your firm';
  if (args.via === 'email') {
    if (!args.email) throw new Error('email required to send invite via email');
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
  } else {
    if (!args.phone) throw new Error('phone required to send invite via sms');
    const { getSmsProvider } = await import('../bridges/sms/index.js');
    // TCPA: opt-in is recorded on the client's first reply, not here; this first
    // SMS carries the STOP language required by carrier rules.
    const provider = await getSmsProvider();
    await provider.sendMessage({
      to: args.phone,
      body: `${firm}: ${sender} sent you a secure message. Sign in: ${link}\nReply STOP to opt out.`,
    });
  }
}
