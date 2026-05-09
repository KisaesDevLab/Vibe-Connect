// Phase 26 — Client Vault staff page.
//
// Two-pane layout: zone tabs + folder list (left), file list (right).
// Upload flow:
//   1. Generate per-file XChaCha20-Poly1305 key
//   2. Encrypt file body + filename under per-file key / zone key
//   3. tus POST + chunked PATCH the ciphertext
// Download flow: fetch ciphertext → unwrap per-file key → decrypt body.
//
// Decryption depends on the staff member having unwrapped their device
// secret (CryptoProvider). When the device is locked the page shows a
// gentle reminder rather than rendering empty data.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  ClientVault,
  VaultFile,
  VaultFolder,
  VaultKeyBundle,
  VaultZone,
} from '@vibe-connect/shared-types';
import { api } from '../api.js';
import { useCrypto } from '../state/crypto.js';
import { useRealtime } from '../state/realtime.js';
import {
  decryptVaultFile,
  decryptVaultFilename,
  encryptVaultFile,
  encryptVaultName,
  seedZoneKey,
  tusUploadCiphertext,
  unwrapZoneKey,
} from '../lib/vaultClient.js';
import { isPdfConvertible } from '../lib/imageToPdf.js';
import { url } from '../lib/boot.js';

interface ZoneState {
  key: Uint8Array | null;
  rotationVersion: number | null;
  unwrapError?: string | null;
}

export function ClientFilesPage(): JSX.Element {
  const { id: externalIdentityId } = useParams();
  const { device, getSecretKey, recipientId, isLocked } = useCrypto();
  const { socket } = useRealtime();
  const [zone, setZone] = useState<VaultZone>('shared');
  const [vault, setVault] = useState<ClientVault | null>(null);
  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [keys, setKeys] = useState<VaultKeyBundle[]>([]);
  const [zoneKeys, setZoneKeys] = useState<Record<VaultZone, ZoneState>>({
    shared: { key: null, rotationVersion: null },
    staff_only: { key: null, rotationVersion: null },
  });
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  // Target folder for the next upload — null = vault root.
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!externalIdentityId) return;
    setError(null);
    try {
      const out = await api.vault.list(externalIdentityId);
      setVault(out.vault);
      setFolders(out.folders);
      setFiles(out.files);
      setKeys(out.keys);
    } catch (e) {
      setError(`Failed to load vault: ${(e as Error).message}`);
    }
  }, [externalIdentityId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Phase 26: refetch when the server fans out a vault event for this client.
  useEffect(() => {
    if (!socket || !externalIdentityId) return;
    const handler = (e: { externalIdentityId?: string }): void => {
      if (e?.externalIdentityId === externalIdentityId) void refresh();
    };
    const rekey = (): void => void refresh();
    socket.on('vault:file-uploaded', handler);
    socket.on('vault:file-deleted', handler);
    socket.on('vault:rekey', rekey);
    return () => {
      socket.off('vault:file-uploaded', handler);
      socket.off('vault:file-deleted', handler);
      socket.off('vault:rekey', rekey);
    };
  }, [socket, externalIdentityId, refresh]);

  // Unwrap zone keys whenever the wrapped bundles change and the device is unlocked.
  useEffect(() => {
    if (!device || isLocked) return;
    const secret = getSecretKey();
    const myRecipient = recipientId();
    if (!secret || !myRecipient) return;
    let cancelled = false;
    (async () => {
      const next: Record<VaultZone, ZoneState> = {
        shared: { key: null, rotationVersion: null },
        staff_only: { key: null, rotationVersion: null },
      };
      for (const bundle of keys) {
        if (!bundle.wrappedKeys) continue;
        try {
          const k = await unwrapZoneKey(bundle.wrappedKeys, myRecipient, device.publicKey, secret);
          // Keep the highest rotation_version per zone — that's the active key.
          const cur = next[bundle.zone];
          if (!cur.rotationVersion || bundle.rotationVersion > cur.rotationVersion) {
            next[bundle.zone] = { key: k, rotationVersion: bundle.rotationVersion };
          }
        } catch (e) {
          next[bundle.zone] = {
            ...next[bundle.zone],
            unwrapError: (e as Error).message,
          };
        }
      }
      if (!cancelled) setZoneKeys(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [keys, device, getSecretKey, recipientId, isLocked]);

  // Decrypt filenames as zone keys come online.
  //
  // Race-safe caching: only memoize SUCCESSFUL decrypts. The naive version
  // wrote `'(encrypted)'` into the cache whenever the zone key wasn't ready
  // yet — but the zone-key unwrap effect (above) is a separate async pass,
  // so on first mount this effect always fires once with no key. With the
  // sentinel cached, the `if (out[id]) continue` short-circuit then skipped
  // every entry forever after — names stayed permanently "(encrypted)" until
  // a hard reload, even though the zone key was right there in state. Skip
  // without caching when the key is missing so the next pass retries.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updates: Record<string, string> = {};
      for (const f of files) {
        if (decryptedNames[f.id]) continue;
        const zk = zoneKeys[f.zone].key;
        if (!zk) continue; // try again when this zone's key arrives
        updates[f.id] = await decryptVaultFilename(f.filenameCiphertext, zk);
      }
      for (const f of folders) {
        const key = `folder:${f.id}`;
        if (decryptedNames[key]) continue;
        const zk = zoneKeys[f.zone].key;
        if (!zk) continue;
        updates[key] = await decryptVaultFilename(f.nameCiphertext, zk);
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setDecryptedNames((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // decryptedNames intentionally not in deps — we mutate-and-merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folders, zoneKeys]);

  const visibleFolders = useMemo(() => folders.filter((f) => f.zone === zone), [folders, zone]);
  const visibleFiles = useMemo(() => files.filter((f) => f.zone === zone), [files, zone]);

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!externalIdentityId) return;
      const file = e.target.files?.[0];
      if (!file) return;
      const zk = zoneKeys[zone];
      if (!zk.key || !zk.rotationVersion) {
        setError('Zone key not available — initialize this vault first.');
        return;
      }
      setBusy(true);
      setUploadProgress({ name: file.name, pct: 0 });
      try {
        const buf = await file.arrayBuffer();
        const enc = await encryptVaultFile(file.name, buf, zk.key, zk.rotationVersion);
        const metadata: Record<string, string> = {
          zone,
          mimeType: file.type || 'application/octet-stream',
          filenameCiphertext: enc.filenameCiphertext,
          wrappedFileKey: enc.wrappedFileKey,
          contentKeyVersion: String(enc.contentKeyVersion),
        };
        if (targetFolderId) metadata.folderId = targetFolderId;
        await tusUploadCiphertext({
          uploadInitUrl: url(`/clients/${externalIdentityId}/vault/uploads`),
          ciphertext: enc.ciphertext,
          metadata,
          onProgress: (bytes, total) =>
            setUploadProgress({ name: file.name, pct: Math.round((bytes / total) * 100) }),
        });
        await refresh();
      } catch (err) {
        setError(`Upload failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
        setUploadProgress(null);
        e.target.value = '';
      }
    },
    [externalIdentityId, refresh, zone, zoneKeys, targetFolderId],
  );

  /**
   * Collect every recipient that should hold a wrapped copy of a zone key:
   *   - all active staff devices (user_keys for every staff user)
   *   - firm:recovery (the partner's recovery phrase)
   *   - (shared zone only) every active portal session for this client +
   *     the invite pubkey if no session exists yet
   */
  const gatherZoneRecipients = useCallback(
    async (forZone: VaultZone): Promise<{ id: string; publicKey: string }[]> => {
      if (!externalIdentityId) return [];
      const recipients: { id: string; publicKey: string }[] = [];
      // Staff devices.
      const usersR = await api.listUsers();
      const staffUserIds = usersR.users.filter((u) => u.isActive !== false).map((u) => u.id);
      if (staffUserIds.length > 0) {
        const keysR = await api.getUserDeviceKeys(staffUserIds);
        for (const [uid, devs] of Object.entries(keysR.keys)) {
          for (const d of devs) {
            recipients.push({ id: `${uid}:${d.deviceId}`, publicKey: d.publicKey });
          }
        }
      }
      // Firm recovery.
      const firm = await api.getFirmPublicKey();
      if (firm?.publicKey) {
        recipients.push({ id: 'firm:recovery', publicKey: firm.publicKey });
      }
      // Client side — shared zone only.
      if (forZone === 'shared') {
        const sk = await api.getClientSessionKeys(externalIdentityId);
        for (const s of sk.sessions) {
          recipients.push({
            id: `client:${externalIdentityId}:session:${s.id}`,
            publicKey: s.publicKey,
          });
        }
        if (sk.invitePublicKey) {
          recipients.push({
            id: `client:${externalIdentityId}:invite`,
            publicKey: sk.invitePublicKey,
          });
        }
      }
      return recipients;
    },
    [externalIdentityId],
  );

  /**
   * One-time vault initialization: generate a fresh zone key for each zone
   * that doesn't have one yet, wrap to all recipients, persist.
   */
  const onInitialize = useCallback(async () => {
    if (!externalIdentityId) return;
    setBusy(true);
    setError(null);
    try {
      for (const z of ['shared', 'staff_only'] as const) {
        // Skip zones that already have keys (idempotent on re-click).
        const existing = keys.find((k) => k.zone === z);
        if (existing) continue;
        const recipients = await gatherZoneRecipients(z);
        if (recipients.length === 0) {
          throw new Error(`No recipients found for ${z} zone`);
        }
        const { wrappedKeys } = await seedZoneKey(recipients);
        await api.vault.rotateKeys(externalIdentityId, {
          zone: z,
          rotationVersion: 1,
          wrappedKeys,
        });
      }
      await refresh();
    } catch (err) {
      setError(`Initialize failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [externalIdentityId, keys, gatherZoneRecipients, refresh]);

  const onRenameFolder = useCallback(
    async (folder: VaultFolder) => {
      if (!externalIdentityId) return;
      const zk = zoneKeys[folder.zone];
      if (!zk.key || !zk.rotationVersion) {
        setError('Zone key not available — initialize this vault first.');
        return;
      }
      const current = decryptedNames[`folder:${folder.id}`] ?? '';
      const next = window.prompt('Rename folder', current === '(encrypted)' ? '' : current);
      if (!next?.trim() || next.trim() === current) return;
      setBusy(true);
      try {
        const nameCiphertext = await encryptVaultName(next.trim(), zk.key);
        await api.vault.patchFolder(externalIdentityId, folder.id, {
          nameCiphertext,
          contentKeyVersion: zk.rotationVersion,
        });
        // Drop the cached entry so the decrypt effect re-decrypts the new ciphertext.
        setDecryptedNames((prev) => {
          const copy = { ...prev };
          delete copy[`folder:${folder.id}`];
          return copy;
        });
        await refresh();
      } catch (err) {
        setError(`Rename failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [externalIdentityId, zoneKeys, decryptedNames, refresh],
  );

  const onDeleteFolder = useCallback(
    async (folder: VaultFolder) => {
      if (!externalIdentityId) return;
      const name = decryptedNames[`folder:${folder.id}`] ?? '(encrypted)';
      if (
        !window.confirm(
          `Delete folder "${name}"? Files inside it stay in the database but are hidden until the folder is restored.`,
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await api.vault.deleteFolder(externalIdentityId, folder.id);
        if (targetFolderId === folder.id) setTargetFolderId(null);
        await refresh();
      } catch (err) {
        setError(`Delete folder failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [externalIdentityId, decryptedNames, targetFolderId, refresh],
  );

  const onCreateFolder = useCallback(async () => {
    if (!externalIdentityId) return;
    const zk = zoneKeys[zone];
    if (!zk.key || !zk.rotationVersion) {
      setError('Zone key not available — initialize this vault first.');
      return;
    }
    const name = window.prompt(`New folder name (${zone === 'shared' ? 'Shared' : 'Staff-only'})`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const nameCiphertext = await encryptVaultName(name.trim(), zk.key);
      await api.vault.createFolder(externalIdentityId, {
        zone,
        nameCiphertext,
        contentKeyVersion: zk.rotationVersion,
      });
      await refresh();
    } catch (err) {
      setError(`Create folder failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [externalIdentityId, zone, zoneKeys, refresh]);

  /**
   * Apply the firm's vault folder template. For every entry that doesn't
   * already match an existing folder name in the target zone, encrypt the
   * substituted name and create. `{YYYY}` resolves to the current year.
   */
  const onApplyTemplate = useCallback(async () => {
    if (!externalIdentityId) return;
    setBusy(true);
    setError(null);
    try {
      const tplR = await api.getVaultTemplates();
      if (tplR.templates.length === 0) {
        setError('No firm template configured. Add entries in Admin → Settings.');
        return;
      }
      const year = new Date().getFullYear();
      // Build a name → folderId index per zone so we don't re-create.
      const existingByZone: Record<VaultZone, Set<string>> = {
        shared: new Set(),
        staff_only: new Set(),
      };
      for (const f of folders) {
        const name = decryptedNames[`folder:${f.id}`];
        if (name) existingByZone[f.zone].add(name);
      }
      let created = 0;
      let skipped = 0;
      for (const t of tplR.templates) {
        const zk = zoneKeys[t.zone];
        if (!zk.key || !zk.rotationVersion) {
          skipped += 1;
          continue;
        }
        const resolvedName = t.nameTemplate.replaceAll('{YYYY}', String(year));
        if (existingByZone[t.zone].has(resolvedName)) {
          skipped += 1;
          continue;
        }
        const nameCiphertext = await encryptVaultName(resolvedName, zk.key);
        await api.vault.createFolder(externalIdentityId, {
          zone: t.zone,
          nameCiphertext,
          contentKeyVersion: zk.rotationVersion,
        });
        existingByZone[t.zone].add(resolvedName);
        created += 1;
      }
      await refresh();
      setError(
        created > 0
          ? `Created ${created} folder(s), skipped ${skipped}.`
          : `Skipped ${skipped} (already exist).`,
      );
    } catch (err) {
      setError(`Apply template failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [externalIdentityId, folders, decryptedNames, zoneKeys, refresh]);

  const onDownload = useCallback(
    async (file: VaultFile) => {
      if (!externalIdentityId) return;
      const zk = zoneKeys[file.zone].key;
      if (!zk) {
        setError('Zone key not available — unlock your device.');
        return;
      }
      setBusy(true);
      try {
        const ct = await api.vault.download(externalIdentityId, file.id);
        const plain = await decryptVaultFile(ct, file.wrappedFileKey, zk);
        const filename = decryptedNames[file.id] || 'download.bin';
        const blob = new Blob([plain as BlobPart], {
          type: file.mimeType || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(`Download failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [externalIdentityId, decryptedNames, zoneKeys],
  );

  /**
   * Download an image vault file converted to a one-page PDF. Re-uses the
   * same decrypt path as plain Download, then runs the bytes through the
   * lazy-loaded `pdf-lib` wrapper. JPEG + PNG only — the calling row hides
   * the button for any other mime type via `isPdfConvertible`.
   */
  const onDownloadAsPdf = useCallback(
    async (file: VaultFile) => {
      if (!externalIdentityId) return;
      const zk = zoneKeys[file.zone].key;
      if (!zk) {
        setError('Zone key not available — unlock your device.');
        return;
      }
      setBusy(true);
      try {
        const { imagesToPdf } = await import('../lib/imageToPdf.js');
        const ct = await api.vault.download(externalIdentityId, file.id);
        const plain = await decryptVaultFile(ct, file.wrappedFileKey, zk);
        const pdfBytes = await imagesToPdf([
          { bytes: plain as Uint8Array, mimeType: file.mimeType },
        ]);
        const original = decryptedNames[file.id] || 'image';
        const stem = original.replace(/\.(jpe?g|png)$/i, '');
        const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${stem}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(`PDF conversion failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [externalIdentityId, decryptedNames, zoneKeys],
  );

  const onDelete = useCallback(
    async (file: VaultFile) => {
      if (!externalIdentityId) return;
      if (!confirm('Delete this file? This is a soft delete; an admin can restore.')) return;
      try {
        await api.vault.deleteFile(externalIdentityId, file.id);
        await refresh();
      } catch (err) {
        setError(`Delete failed: ${(err as Error).message}`);
      }
    },
    [externalIdentityId, refresh],
  );

  if (!externalIdentityId) {
    return <div className="p-6 text-sm text-slate-500">No client selected.</div>;
  }
  if (isLocked) {
    return (
      <div className="p-6 text-sm text-slate-600">
        Your device is locked. Unlock to view this client&apos;s files.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200">
        <h1 className="text-base font-semibold text-slate-800">Files</h1>
        <div className="flex gap-1 bg-slate-100 rounded-md p-1">
          {(['shared', 'staff_only'] as VaultZone[]).map((z) => (
            <button
              key={z}
              type="button"
              className={`text-xs px-3 py-1 rounded ${
                zone === z ? 'bg-white shadow-sm font-semibold' : 'text-slate-600'
              }`}
              onClick={() => setZone(z)}
            >
              {z === 'shared' ? 'Shared' : 'Staff-only'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Initialize: shown only when neither zone has wrapped keys yet
              for this device. First staff to open a fresh client's vault
              presses this once; everyone else has it transparent. */}
          {keys.length === 0 && (
            <button
              type="button"
              onClick={onInitialize}
              disabled={busy}
              className="text-xs rounded-md bg-amber-500 text-white font-medium px-3 py-1.5 hover:bg-amber-600 disabled:opacity-50"
              title="Generate fresh zone keys, wrap to staff devices + firm recovery + client sessions"
            >
              Initialize files
            </button>
          )}
          {keys.length > 0 && (
            <>
              <button
                type="button"
                onClick={onApplyTemplate}
                disabled={busy}
                className="text-xs rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                title="Create the firm's default folder set in this vault"
              >
                Apply template
              </button>
              <button
                type="button"
                onClick={onCreateFolder}
                disabled={busy || !zoneKeys[zone].key}
                className="text-xs rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                + New folder
              </button>
              <select
                value={targetFolderId ?? ''}
                onChange={(e) => setTargetFolderId(e.target.value || null)}
                disabled={busy}
                className="text-xs rounded-md border border-slate-300 px-2 py-1.5 max-w-[180px]"
                title="Target folder for the next upload"
              >
                <option value="">Vault root</option>
                {visibleFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {decryptedNames[`folder:${f.id}`] ?? '(encrypted)'}
                  </option>
                ))}
              </select>
              <label className="text-xs text-slate-700 cursor-pointer">
                <input type="file" className="hidden" onChange={onUpload} disabled={busy} />
                <span className="rounded-md bg-brand-600 text-white font-medium px-3 py-1.5 hover:bg-brand-700">
                  Upload
                </span>
              </label>
            </>
          )}
        </div>
      </div>
      {uploadProgress && (
        <div className="px-4 py-1 text-xs text-slate-600 border-b border-slate-100">
          Encrypting + uploading {uploadProgress.name}: {uploadProgress.pct}%
        </div>
      )}
      {error && (
        <div className="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">
          {error}
        </div>
      )}
      <div className="flex-1 grid grid-rows-[auto_1fr] md:grid-rows-1 md:grid-cols-[240px_1fr] overflow-hidden">
        <aside className="border-b md:border-b-0 md:border-r border-slate-200 overflow-auto p-2 max-h-40 md:max-h-none">
          <div className="text-xs font-semibold text-slate-500 px-2 py-1">Folders</div>
          {visibleFolders.length === 0 && (
            <div className="text-xs text-slate-400 px-2 py-1">No folders yet.</div>
          )}
          {visibleFolders.map((f) => (
            <div
              key={f.id}
              className="group flex items-center gap-1 px-2 py-1 text-sm text-slate-700 hover:bg-slate-50 rounded"
            >
              <span className="flex-1 truncate">
                {decryptedNames[`folder:${f.id}`] ?? '(encrypted)'}
              </span>
              <button
                type="button"
                onClick={() => onRenameFolder(f)}
                disabled={busy}
                className="opacity-0 group-hover:opacity-100 text-[11px] text-slate-500 hover:text-brand-700"
                title="Rename"
                aria-label="Rename folder"
              >
                ✎
              </button>
              <button
                type="button"
                onClick={() => onDeleteFolder(f)}
                disabled={busy}
                className="opacity-0 group-hover:opacity-100 text-[11px] text-slate-500 hover:text-red-700"
                title="Delete"
                aria-label="Delete folder"
              >
                ✕
              </button>
            </div>
          ))}
        </aside>
        <main className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-left px-3 py-2 font-medium">Size</th>
                <th className="text-left px-3 py-2 font-medium">Uploaded</th>
                <th className="text-left px-3 py-2 font-medium">Scan</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleFiles.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-xs text-slate-400 py-6">
                    No files in this zone yet.
                  </td>
                </tr>
              )}
              {visibleFiles.map((f) => (
                <tr key={f.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{decryptedNames[f.id] ?? '(encrypted)'}</td>
                  <td className="px-3 py-2 text-slate-500">{f.mimeType}</td>
                  <td className="px-3 py-2 text-slate-500">{prettyBytes(f.sizeBytes)}</td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(f.uploadedAt)}</td>
                  <td className="px-3 py-2">
                    <ScanBadge status={f.scanStatus} />
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline"
                      onClick={() => onDownload(f)}
                      disabled={busy || f.scanStatus !== 'clean'}
                    >
                      Download
                    </button>
                    {/* Phase 26: convert JPEG/PNG vault file to a one-page
                        PDF. Same decrypt path as Download; pdf-lib is lazy-
                        loaded the first time anyone clicks. */}
                    {isPdfConvertible(f.mimeType) && (
                      <button
                        type="button"
                        className="text-xs text-brand-700 hover:underline"
                        onClick={() => onDownloadAsPdf(f)}
                        disabled={busy || f.scanStatus !== 'clean'}
                        title="Download this image as a single-page PDF"
                      >
                        PDF
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-xs text-red-700 hover:underline"
                      onClick={() => onDelete(f)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {vault && (
            <div className="text-xs text-slate-400 px-3 py-2 border-t border-slate-100">
              Vault {vault.id.slice(0, 8)} · {visibleFiles.length} files in {zone}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ScanBadge({ status }: { status: 'pending' | 'clean' | 'infected' }): JSX.Element {
  const styles =
    status === 'clean'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'pending'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-red-50 text-red-700';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles}`}>{status}</span>;
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
