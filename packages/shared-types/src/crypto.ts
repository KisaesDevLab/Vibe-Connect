import type { ConversationId } from './conversations.js';

export interface WrappedKey {
  // ciphertext of the symmetric conversation key, base64
  ciphertext: string;
  // X25519 ephemeral public key used for the box, base64
  ephemeralPublicKey: string;
  // nonce, base64
  nonce: string;
}

export type WrappedKeyMap = Record<string, WrappedKey>; // key = user_key_id or client_session_id

export interface ConversationKeyRecord {
  id: string;
  conversationId: ConversationId;
  rotationVersion: number;
  wrappedKeys: WrappedKeyMap;
  createdAt: string;
}

export interface DevicePublicKey {
  id: string;
  userId: string;
  deviceId: string;
  publicKey: string;
  keyVersion: number;
}

export interface EnrollmentPayload {
  deviceId: string;
  publicKey: string;
  encryptedPrivateKey: string; // Argon2id-encrypted private key for in-browser storage
  kdfSalt: string;
  kdfParams: KdfParams;
  clientPlatform: 'tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web';
  clientVersion: string;
}

export interface KdfParams {
  opsLimit: number;
  memLimit: number;
  algorithm: 'argon2id13';
}

export interface FirmPublicKey {
  publicKey: string;
  rotationVersion: number;
}
