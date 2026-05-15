// Phase 28.8 — IndexedDB persistence for the multi-page scan batch.
//
// Walk-up clients capturing 5+ pages get a free "browser refresh during
// review restores everything" property as long as their session id is
// still in the URL. We persist a per-session record of `pages` (each
// holding the original Blob + its thumbnail data URL + an opaque id) so
// the ScanBatch component can hydrate on mount.
//
// Why not localStorage: it's synchronous, blocks on write, doesn't store
// Blobs without base64 round-trip. IDB stores Blobs natively and writes
// off the main thread.
//
// Why no `idb` library: 90 lines of native API beats a dep. Keeps the
// intake bundle small (one of the 28-series goals).

const DB_NAME = 'vibe-intake';
const DB_VERSION = 1;
const STORE = 'scan-batches';

export interface ScanPage {
  /** Random per-page id; survives reorders. */
  id: string;
  /** Original captured/cropped JPEG. The upload pipe consumes this as a
   *  File once the user clicks Done. */
  blob: Blob;
  /** Small data URL rendered in the thumbnail grid. */
  thumb: string;
  /** Wall-clock when captured — informational only. */
  capturedAt: number;
}

interface ScanBatchRecord {
  sessionId: string;
  pages: ScanPage[];
  /** Wall-clock of last write — used to expire stale batches at load. */
  updatedAt: number;
}

/** Records older than this are treated as stale at load time and
 *  silently dropped. Matches the 4h upload-token TTL on the server; a
 *  user who comes back after that needs a fresh session anyway. */
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'sessionId' });
      }
    };
    req.onerror = () => reject(req.error ?? new Error('idb_open_failed'));
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let outcome: T | undefined;
    let err: Error | null = null;
    fn(store)
      .then((v) => {
        outcome = v;
      })
      .catch((e) => {
        err = e as Error;
      });
    tx.oncomplete = () => {
      if (err) reject(err);
      else resolve(outcome as T);
    };
    tx.onerror = () => reject(tx.error ?? new Error('idb_tx_failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb_tx_aborted'));
  });
}

/** Save (or overwrite) the page list for a session. */
export async function saveScanBatch(sessionId: string, pages: ScanPage[]): Promise<void> {
  if (!sessionId) return;
  try {
    await withStore('readwrite', async (store) => {
      store.put({ sessionId, pages, updatedAt: Date.now() } satisfies ScanBatchRecord);
    });
  } catch {
    // IDB unavailable (private-mode Safari with restricted storage) is
    // recoverable — the in-memory state still drives the UI; we just
    // lose refresh persistence. Don't propagate the error.
  }
}

/** Load the page list for a session, or null if nothing's stored / stale. */
export async function loadScanBatch(sessionId: string): Promise<ScanPage[] | null> {
  if (!sessionId) return null;
  try {
    return await withStore('readonly', async (store) => {
      return new Promise<ScanPage[] | null>((resolve, reject) => {
        const req = store.get(sessionId);
        req.onsuccess = () => {
          const rec = req.result as ScanBatchRecord | undefined;
          if (!rec) {
            resolve(null);
            return;
          }
          if (Date.now() - rec.updatedAt > STALE_AFTER_MS) {
            resolve(null);
            return;
          }
          resolve(rec.pages);
        };
        req.onerror = () => reject(req.error ?? new Error('idb_get_failed'));
      });
    });
  } catch {
    return null;
  }
}

/** Drop the page list — call on submit success and on explicit discard. */
export async function clearScanBatch(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await withStore('readwrite', async (store) => {
      store.delete(sessionId);
    });
  } catch {
    /* swallow */
  }
}
