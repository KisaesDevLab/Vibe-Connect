import type { ExternalIdentityId } from './users.js';

export type VerificationType = 'ssn' | 'ein' | 'none';

export interface ExternalIdentityRecord {
  id: ExternalIdentityId;
  email: string;
  phone: string | null;
  displayName: string;
  firmClientRef: string | null;
  verificationType: VerificationType;
  verificationRequired: boolean;
  firstInvitedAt: string;
  lastActiveAt: string | null;
}

export interface ClientSessionSummary {
  id: string;
  externalIdentityId: ExternalIdentityId;
  createdAt: string;
  verifiedUntil: string | null;
  revokedAt: string | null;
}

export interface AccessCodeSendRequest {
  identifier: string; // email OR phone
}

export interface AccessCodeVerifyRequest {
  identifier: string;
  code: string;
}

export interface StepUpVerifyRequest {
  last4: string;
}
