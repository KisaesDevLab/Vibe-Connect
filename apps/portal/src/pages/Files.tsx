// Phase 26 — Portal Files page. Shared zone only.
//
// Step-up gate: when /portal/vault returns `stepupRequired: true`, redirects
// to /stepup. The vault disable banner re-uses the Requests-disabled posture:
// graceful empty state with a clear "your firm has Files turned off" line.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VaultFile, VaultFolder, VaultKeyBundle } from '@vibe-connect/shared-types';
import { portalApi } from '../api.js';
import { getSessionKeys } from '../state/clientSession.js';
import {
  decryptVaultFile,
  decryptVaultFilename,
  encryptVaultFile,
  tusUploadCiphertext,
  unwrapZoneKey,
} from '../lib/vaultClient.js';
import { isPdfConvertible } from '../lib/imageToPdf.js';
import { url } from '../lib/boot.js';

export function FilesPage(): JSX.Element {
  const nav = useNavigate();
  const session = useMemo(() => getSessionKeys(), []);
  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [keys, setKeys] = useState<VaultKeyBundle[]>([]);
  const [vaultDisabled, setVaultDisabled] = useState(false);
  const [zoneKey, setZoneKey] = useState<Uint8Array | null>(null);
  const [activeRotation, setActiveRotation] = useState<number | null>(null);
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  // Optional target folder for the next upload — null = vault root.
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const out = await portalApi.vault.list();
      if (out.stepupRequired) {
        nav('/stepup');
        return;
      }
      if (out.vaultDisabled) {
        setVaultDisabled(true);
        return;
      }
      setVaultDisabled(false);
      setFolders(out.folders);
      setFiles(out.files);
      setKeys(out.keys);
    } catch (e) {
      setError(`Failed to load files: ${(e as Error).message}`);
    }
  }, [nav]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll for incoming uploads from staff. Same cadence as RequestsPanel.
  useEffect(() => {
    let stopped = false;
    const POLL_MS = 15_000;
    const handle = window.setInterval(() => {
      if (stopped) return;
      if (document.visibilityState !== 'visible') return;
      void refresh();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(handle);
    };
  }, [refresh]);

  // Unwrap the active zone key. Server only returns the wrapped_keys for the
  // requesting session; we still scan all bundles in case the server hands us
  // multiple rotations and we need the latest.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      let active: { key: Uint8Array; rotationVersion: number } | null = null;
      for (const bundle of keys) {
        if (!bundle.wrappedKeys) continue;
        const k = await unwrapZoneKey(bundle.wrappedKeys, session.publicKey, session.secretKey);
        if (!k) continue;
        if (!active || bundle.rotationVersion > active.rotationVersion) {
          active = { key: k, rotationVersion: bundle.rotationVersion };
        }
      }
      if (cancelled) return;
      setZoneKey(active?.key ?? null);
      setActiveRotation(active?.rotationVersion ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [keys, session]);

  // Decrypt filenames when the zone key arrives.
  useEffect(() => {
    if (!zoneKey) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = { ...decryptedNames };
      for (const f of files) {
        if (out[f.id]) continue;
        out[f.id] = await decryptVaultFilename(f.filenameCiphertext, zoneKey);
      }
      for (const f of folders) {
        if (out[`folder:${f.id}`]) continue;
        out[`folder:${f.id}`] = await decryptVaultFilename(f.nameCiphertext, zoneKey);
      }
      if (!cancelled) setDecryptedNames(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folders, zoneKey]);

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!zoneKey || !activeRotation) {
        setError('Vault key not available — please refresh.');
        return;
      }
      setBusy(true);
      setUploadProgress({ name: file.name, pct: 0 });
      try {
        const buf = await file.arrayBuffer();
        const enc = await encryptVaultFile(file.name, buf, zoneKey, activeRotation);
        const metadata: Record<string, string> = {
          zone: 'shared',
          mimeType: file.type || 'application/octet-stream',
          filenameCiphertext: enc.filenameCiphertext,
          wrappedFileKey: enc.wrappedFileKey,
          contentKeyVersion: String(enc.contentKeyVersion),
        };
        if (targetFolderId) metadata.folderId = targetFolderId;
        await tusUploadCiphertext({
          uploadInitUrl: url('/portal/vault/uploads'),
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
    [zoneKey, activeRotation, refresh, targetFolderId],
  );

  const onDownload = useCallback(
    async (file: VaultFile) => {
      if (!zoneKey) return;
      setBusy(true);
      try {
        const ct = await portalApi.vault.download(file.id);
        const plain = await decryptVaultFile(ct, file.wrappedFileKey, zoneKey);
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
    [zoneKey, decryptedNames],
  );

  /**
   * Convert a JPEG/PNG vault file to a one-page PDF and download.
   * Decrypts via the same path as plain Download; pdf-lib is lazy-loaded.
   * Useful for clients who took a phone photo of a receipt and want to
   * hand the accountant a PDF instead of an image.
   */
  const onDownloadAsPdf = useCallback(
    async (file: VaultFile) => {
      if (!zoneKey) return;
      setBusy(true);
      try {
        const { imagesToPdf } = await import('../lib/imageToPdf.js');
        const ct = await portalApi.vault.download(file.id);
        const plain = await decryptVaultFile(ct, file.wrappedFileKey, zoneKey);
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
    [zoneKey, decryptedNames],
  );

  const onDelete = useCallback(
    async (file: VaultFile) => {
      if (!confirm('Delete this file?')) return;
      try {
        await portalApi.vault.deleteFile(file.id);
        await refresh();
      } catch (err) {
        setError(`Delete failed: ${(err as Error).message}`);
      }
    },
    [refresh],
  );

  if (vaultDisabled) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-sm text-slate-600">
        Your firm has Files turned off. Ask them to re-enable it if you need to share documents.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <header className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold text-slate-800 mr-auto">Files</h1>
        {/* Folder picker: clients can drop into folders staff have created
            (e.g. "Source Documents/"). No "+ New folder" — the portal is
            intentionally minimal; folder structure is staff-curated. */}
        {folders.length > 0 && (
          <select
            value={targetFolderId ?? ''}
            onChange={(e) => setTargetFolderId(e.target.value || null)}
            disabled={busy || !zoneKey}
            className="text-sm rounded-md border border-slate-300 px-2 py-1.5 max-w-[200px]"
            title="Where to put the next upload"
          >
            <option value="">My documents (root)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {decryptedNames[`folder:${f.id}`] ?? '(encrypted)'}
              </option>
            ))}
          </select>
        )}
        <label className="cursor-pointer text-sm">
          <input type="file" className="hidden" onChange={onUpload} disabled={busy || !zoneKey} />
          <span className="rounded-md bg-brand-600 text-white font-medium px-3 py-1.5 hover:bg-brand-700">
            Upload
          </span>
        </label>
      </header>
      {uploadProgress && (
        <div className="text-xs text-slate-600">
          Encrypting + uploading {uploadProgress.name}: {uploadProgress.pct}%
        </div>
      )}
      {error && <div className="rounded bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
      {!zoneKey && (
        <div className="text-xs text-slate-500">
          Loading your private key… If this stays, please verify your identity again.
        </div>
      )}
      {folders.length > 0 && (
        <section>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Folders</div>
          <ul className="bg-white rounded-md border border-slate-200 divide-y divide-slate-100">
            {folders.map((f) => (
              <li key={f.id} className="px-3 py-2 text-sm text-slate-800">
                {decryptedNames[`folder:${f.id}`] ?? '(encrypted)'}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Documents</div>
        {files.length === 0 ? (
          <div className="text-sm text-slate-500 bg-white rounded-md border border-slate-200 px-3 py-4">
            Nothing uploaded yet. Use the Upload button to send a document to your accountant.
          </div>
        ) : (
          <ul className="bg-white rounded-md border border-slate-200 divide-y divide-slate-100">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">
                    {decryptedNames[f.id] ?? '(encrypted)'}
                  </div>
                  <div className="text-xs text-slate-500">
                    {f.mimeType} · {prettyBytes(f.sizeBytes)} · {scanLabel(f.scanStatus)}
                  </div>
                </div>
                <button
                  type="button"
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() => void onDownload(f)}
                  disabled={busy || !zoneKey || f.scanStatus !== 'clean'}
                >
                  Download
                </button>
                {/* Phase 26: image → PDF for JPEG/PNG vault files. */}
                {isPdfConvertible(f.mimeType) && (
                  <button
                    type="button"
                    className="text-xs text-brand-700 hover:underline"
                    onClick={() => void onDownloadAsPdf(f)}
                    disabled={busy || !zoneKey || f.scanStatus !== 'clean'}
                    title="Download as PDF"
                  >
                    PDF
                  </button>
                )}
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline"
                  onClick={() => void onDelete(f)}
                  disabled={busy}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function scanLabel(status: 'pending' | 'clean' | 'infected'): string {
  if (status === 'clean') return 'scanned ✓';
  if (status === 'pending') return 'scanning…';
  return 'blocked (virus)';
}
