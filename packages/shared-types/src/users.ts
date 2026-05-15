export type UserId = string;
export type GroupId = string;
export type DeviceId = string;
export type ExternalIdentityId = string;

export type UserStatus = 'active' | 'away' | 'dnd' | 'offline';

export interface PublicUser {
  id: UserId;
  username: string;
  displayName: string;
  email: string | null;
  /**
   * E.164 phone number for out-of-band notifications (SMS fallback when the
   * user is offline). Staff self-edit via PATCH /auth/me. Never used for
   * delivering message content — metadata-only notifications per the firm
   * crypto invariants.
   */
  phone: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  isActive: boolean;
  status: UserStatus;
  lastSeenAt: string | null;
  /**
   * Phase 28 — staff has opted in to be listed on the public `/intake` page.
   * Drives the "Intake" top-level nav link in the staff app: visible only
   * when true. Flipped via PATCH /users/me/intake-card.
   */
  showOnIntakeCard: boolean;
}

export interface Group {
  id: GroupId;
  name: string;
  sortOrder: number;
  members: UserId[];
}

export type ClientPlatform = 'tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web';

export interface DeviceRecord {
  id: string;
  userId: UserId;
  deviceId: DeviceId;
  publicKey: string;
  keyVersion: number;
  clientPlatform: ClientPlatform;
  clientVersion: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export type DeviceHealthFlag = 'update_drift' | 'stale' | 'unknown_version' | 'healthy';

export interface DeviceHealthRecord extends DeviceRecord {
  displayName: string;
  username: string;
  flag: DeviceHealthFlag;
  flagExplanation: string;
  remediation: string;
}
