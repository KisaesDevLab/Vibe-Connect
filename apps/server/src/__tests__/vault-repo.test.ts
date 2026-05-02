/**
 * Phase 26.1 — Vault repository tests.
 *
 * Hits the real test DB via resetTestDb(). Asserts the load-bearing
 * zone-separation invariant directly at the repository layer:
 *   - vaultKeysRepo.byVaultIdForSession refuses staff_only rows for any
 *     `client:*` recipient, regardless of caller
 *   - vaultKeysRepo.insert / mergeWrappedAdditive throw if a client
 *     recipient appears in a staff_only wrapped_keys map
 *   - cryptoShred zeroes wrapped_keys
 *
 * Routes / services are tested separately. This file owns the
 * repository contract.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from './test-helpers.js';

let externalIdentityId: string;
let userKeyId: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const { db } = await import('../db/knex.js');
  const [eid] = await db('external_identities')
    .insert({
      email: 'vault-test@example.com',
      display_name: 'Vault Test Client',
      verification_type: 'none',
      verification_required: false,
    })
    .returning('id');
  externalIdentityId = eid.id;
  // Seeded staff (kurt) — pick any user_keys row so we have a real recipientId
  // shape (`${userId}:${deviceId}`) to use in wrapped_keys.
  const kurt = await db('users').where({ username: 'kurt' }).first('id');
  const [uk] = await db('user_keys')
    .insert({
      user_id: kurt.id,
      device_id: 'test-device-1',
      public_key: 'AAAA',
      encrypted_private_key: 'AAAA',
      kdf_params: JSON.stringify({ algo: 'argon2id', m: 65536, t: 2, p: 1 }),
      kdf_salt: 'AAAAAAAAAAAAAAAAAAAA',
      key_version: 1,
      client_platform: 'web',
    })
    .returning('id');
  userKeyId = `${kurt.id}:test-device-1`;
  // userKeyId variable holds the stable recipientId; uk.id is the row id we
  // don't otherwise reference in these tests.
  void uk;
}, 120_000);

afterAll(async () => {
  // Pool stays open for sibling test files.
});

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('vault_uploads_in_progress').del();
  await db('vault_files').del();
  await db('vault_folders').del();
  await db('vault_keys').del();
  await db('client_vaults').del();
});

describe('clientVaultsRepo', () => {
  it('upsertByExternalIdentityId is idempotent', async () => {
    const { clientVaultsRepo } = await import('../repositories/vaults.js');
    const first = await clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId);
    const second = await clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId);
    expect(second.id).toBe(first.id);
  });
});

describe('vaultKeysRepo zone-separation invariant', () => {
  async function makeVault() {
    const { clientVaultsRepo } = await import('../repositories/vaults.js');
    return clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId);
  }

  it('inserts a staff_only row with only staff recipients', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    const row = await vaultKeysRepo.insert(v.id, 'staff_only', 1, {
      [userKeyId]: 'wrapped-base64',
    });
    expect(row.zone).toBe('staff_only');
    expect(row.rotation_version).toBe(1);
    expect(row.wrapped_keys[userKeyId]).toBe('wrapped-base64');
  });

  it('refuses staff_only insert when wrapped_keys carry a client recipient', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    await expect(
      vaultKeysRepo.insert(v.id, 'staff_only', 1, {
        [userKeyId]: 'wrapped-staff',
        'client:aaaa:session:bbbb': 'wrapped-client',
      }),
    ).rejects.toThrow(/staff_only/);
  });

  it('allows shared zone with mixed staff + client recipients', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    const row = await vaultKeysRepo.insert(v.id, 'shared', 1, {
      [userKeyId]: 'wrapped-staff',
      'client:aaaa:session:bbbb': 'wrapped-client',
    });
    expect(row.wrapped_keys['client:aaaa:session:bbbb']).toBe('wrapped-client');
  });

  it('byVaultIdForSession returns staff_only rows for staff recipients', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    await vaultKeysRepo.insert(v.id, 'staff_only', 1, { [userKeyId]: 'w' });
    const rows = await vaultKeysRepo.byVaultIdForSession(v.id, userKeyId, 'staff_only');
    expect(rows).toHaveLength(1);
  });

  it('byVaultIdForSession returns [] for staff_only when caller is a client recipient', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    await vaultKeysRepo.insert(v.id, 'staff_only', 1, { [userKeyId]: 'w' });
    const rows = await vaultKeysRepo.byVaultIdForSession(
      v.id,
      'client:aaaa:session:bbbb',
      'staff_only',
    );
    expect(rows).toEqual([]);
  });

  it('byVaultIdForSession returns shared rows for client recipients', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    await vaultKeysRepo.insert(v.id, 'shared', 1, {
      [userKeyId]: 'w-staff',
      'client:aaaa:session:bbbb': 'w-client',
    });
    const rows = await vaultKeysRepo.byVaultIdForSession(
      v.id,
      'client:aaaa:session:bbbb',
      'shared',
    );
    expect(rows).toHaveLength(1);
  });

  it('mergeWrappedAdditive on staff_only refuses to add a client recipient', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    const seed = await vaultKeysRepo.insert(v.id, 'staff_only', 1, { [userKeyId]: 'w' });
    await expect(
      vaultKeysRepo.mergeWrappedAdditive(seed.id, { 'client:xx:session:yy': 'w-client' }),
    ).rejects.toThrow(/staff_only/);
  });

  it('mergeWrappedAdditive on shared adds a new client recipient', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    const seed = await vaultKeysRepo.insert(v.id, 'shared', 1, { [userKeyId]: 'w-staff' });
    const result = await vaultKeysRepo.mergeWrappedAdditive(seed.id, {
      'client:xx:session:yy': 'w-client',
    });
    expect(result.added).toEqual(['client:xx:session:yy']);
  });

  it('cryptoShred zeroes wrapped_keys for the zone', async () => {
    const { vaultKeysRepo } = await import('../repositories/vaults.js');
    const v = await makeVault();
    await vaultKeysRepo.insert(v.id, 'shared', 1, { [userKeyId]: 'w' });
    await vaultKeysRepo.insert(v.id, 'shared', 2, { [userKeyId]: 'w2' });
    const updated = await vaultKeysRepo.cryptoShred(v.id, 'shared');
    expect(updated).toBe(2);
    const remaining = await vaultKeysRepo.allVersions(v.id, 'shared');
    for (const r of remaining) {
      expect(Object.keys(r.wrapped_keys)).toHaveLength(0);
    }
  });
});

describe('vaultService IDOR guards (regression)', () => {
  /**
   * Regression: prior to this guard, any staff with access to vault A could
   * pass a fileId/folderId belonging to vault B and the service would mutate
   * it. The service now refuses to proceed unless the row's vault_id matches
   * the caller-supplied vaultId. Routes always pass the vault for the URL's
   * external_identity_id, so a stolen UUID from another client's vault is
   * rejected as 404 regardless of the caller's other access.
   */
  // beforeEach above wipes vault state but NOT external_identities — give
  // each test a fresh secondary identity via a uniquified email so repeated
  // calls don't trip the unique-on-email constraint.
  async function makeTwoVaults(): Promise<{ vaultA: string; vaultB: string }> {
    const { db } = await import('../db/knex.js');
    const { clientVaultsRepo } = await import('../repositories/vaults.js');
    const suffix = Math.random().toString(36).slice(2, 10);
    const [eb] = await db('external_identities')
      .insert({
        email: `vault-test-2-${suffix}@example.com`,
        display_name: 'Vault Test Client B',
        verification_type: 'none',
        verification_required: false,
      })
      .returning('id');
    const a = await clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId);
    const b = await clientVaultsRepo.upsertByExternalIdentityId(eb.id);
    return { vaultA: a.id, vaultB: b.id };
  }

  it('patchFile refuses fileId belonging to a different vault', async () => {
    const { db } = await import('../db/knex.js');
    const { vaultFilesRepo } = await import('../repositories/vaults.js');
    const svc = await import('../services/vaultService.js');
    const { vaultA, vaultB } = await makeTwoVaults();
    const kurt = await db('users').where({ username: 'kurt' }).first('id');
    const file = await vaultFilesRepo.insert({
      vault_id: vaultB,
      folder_id: null,
      zone: 'shared',
      filename_ciphertext: 'ENC(in-B)',
      mime_type: 'application/pdf',
      size_bytes: 1,
      storage_path: 'b.bin',
      wrapped_file_key: Buffer.from('wk'),
      content_key_version: 1,
      envelope_format: 'vault-zone-key-v1',
      scan_status: 'clean',
      uploaded_by_user_id: null,
      uploaded_by_external_identity_id: externalIdentityId,
    });
    await expect(
      svc.patchFile({
        actorUserId: kurt.id,
        actorExternalIdentityId: null,
        vaultId: vaultA,
        fileId: file.id,
        patch: { filenameCiphertext: 'ENC(renamed)' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleteFile refuses fileId belonging to a different vault', async () => {
    const { db } = await import('../db/knex.js');
    const { vaultFilesRepo } = await import('../repositories/vaults.js');
    const svc = await import('../services/vaultService.js');
    const { vaultA, vaultB } = await makeTwoVaults();
    const kurt = await db('users').where({ username: 'kurt' }).first('id');
    const file = await vaultFilesRepo.insert({
      vault_id: vaultB,
      folder_id: null,
      zone: 'shared',
      filename_ciphertext: 'ENC(in-B)',
      mime_type: 'application/pdf',
      size_bytes: 1,
      storage_path: 'b2.bin',
      wrapped_file_key: Buffer.from('wk'),
      content_key_version: 1,
      envelope_format: 'vault-zone-key-v1',
      scan_status: 'clean',
      uploaded_by_user_id: kurt.id,
      uploaded_by_external_identity_id: null,
    });
    await expect(
      svc.deleteFile({
        actorUserId: kurt.id,
        actorExternalIdentityId: null,
        vaultId: vaultA,
        fileId: file.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('patchFolder + deleteFolder refuse folderId belonging to a different vault', async () => {
    const { db } = await import('../db/knex.js');
    const { vaultFoldersRepo } = await import('../repositories/vaults.js');
    const svc = await import('../services/vaultService.js');
    const { vaultA, vaultB } = await makeTwoVaults();
    const kurt = await db('users').where({ username: 'kurt' }).first('id');
    const folder = await vaultFoldersRepo.insert({
      vault_id: vaultB,
      parent_folder_id: null,
      zone: 'shared',
      name_ciphertext: 'ENC(B-folder)',
      content_key_version: 1,
      sort_order: 0,
    });
    await expect(
      svc.patchFolder({
        actorUserId: kurt.id,
        vaultId: vaultA,
        folderId: folder.id,
        patch: { sortOrder: 5 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      svc.deleteFolder({
        actorUserId: kurt.id,
        vaultId: vaultA,
        folderId: folder.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('vaultFilesRepo + vaultFoldersRepo lifecycle', () => {
  it('inserts file under folder and lists it; soft delete hides it', async () => {
    const { clientVaultsRepo, vaultFoldersRepo, vaultFilesRepo } =
      await import('../repositories/vaults.js');
    const v = await clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId);
    const folder = await vaultFoldersRepo.insert({
      vault_id: v.id,
      parent_folder_id: null,
      zone: 'shared',
      name_ciphertext: 'ENC(SourceDocs)',
      content_key_version: 1,
      sort_order: 0,
    });
    const file = await vaultFilesRepo.insert({
      vault_id: v.id,
      folder_id: folder.id,
      zone: 'shared',
      filename_ciphertext: 'ENC(w2.pdf)',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      storage_path: 'vault-aa-bb.bin',
      wrapped_file_key: Buffer.from('wrapped-key'),
      content_key_version: 1,
      envelope_format: 'vault-zone-key-v1',
      scan_status: 'clean',
      uploaded_by_user_id: null,
      uploaded_by_external_identity_id: externalIdentityId,
    });
    expect(file.scan_status).toBe('clean');

    const live = await vaultFilesRepo.listByVaultZone(v.id, 'shared');
    expect(live).toHaveLength(1);

    await vaultFilesRepo.softDelete(file.id);
    const after = await vaultFilesRepo.listByVaultZone(v.id, 'shared');
    expect(after).toHaveLength(0);
  });
});
