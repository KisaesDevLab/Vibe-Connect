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
  exportExternalRequiresRecoveryPhrase: boolean;
  sidebarGroupsOrder: string[];
}
