export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface FirmSettings {
  firmName: string;
  logoUrl: string | null;
  retentionDays: number | null; // null = keep forever
  stepUpTimeoutHours: 4 | 8 | 24 | 168 | -1;
  emailOutboundMode: 'summary' | 'content';
  emailOutboundContentPreviewChars: number;
  smsProvider: 'textlink' | 'twilio' | 'mock';
  smsMonthlyCap: number;
  emailProvider: 'mock' | 'postmark' | 'postfix';
  tlsStaffDomain: string | null;
  tlsPortalDomain: string | null;
  tlsAcmeEmail: string | null;
  tlsAcmeEnvironment: 'staging' | 'production';
  tlsChallengeType: 'http-01' | 'dns-01';
  exportExternalRequiresRecoveryPhrase: boolean;
  sidebarGroupsOrder: string[];
}

// Staff "Invite a client" — request + response for POST /clients/invite.
// Shared between apps/web (modal) and apps/server (route handler).
export interface InviteClientRequest {
  displayName: string;
  channels: {
    email: { enabled: boolean; value?: string | null };
    sms: { enabled: boolean; value?: string | null };
  };
  verification: {
    type: 'ssn' | 'ein' | 'none';
    last4?: string;
    // null = never re-verify; undefined = fall back to firm default.
    reverifyEveryHours?: 4 | 8 | 24 | 168 | null;
  };
  /**
   * Optional cross-reference to the firm's own client record (e.g. an
   * accounting system ID). Surfaced only in admin-originated invites so
   * back-office staff can link a Connect identity to the firm's books.
   */
  firmClientRef?: string | null;
}

// TLS / Let's Encrypt status surfaced to Admin → TLS tab. Never includes
// the issued private key or the sealed ACME account key — only metadata
// safe to render in the browser.
export interface TlsCertInfo {
  subject: string;
  issuer: string;
  expiresAt: string;
  daysUntilExpiry: number;
  hostnames: string[];
}

export interface TlsStatus {
  config: {
    staffDomain: string | null;
    portalDomain: string | null;
    acmeEmail: string | null;
    acmeEnvironment: 'staging' | 'production';
    challengeType: 'http-01' | 'dns-01';
    accountKeyConfigured: boolean;
  };
  cert: TlsCertInfo | null;
  lastError: string | null;
  inFlight: boolean;
  requestedAt: string | null;
}

export interface InviteClientResponse {
  externalIdentityId: string;
  invitePublicKey: string;
  deliveryStatus: {
    email: 'sent' | 'failed' | null;
    sms: 'sent' | 'failed' | null;
  };
  deliveryErrors?: { email?: string; sms?: string };
}
