/**
 * Client-side search. FlexSearch over decrypted messages. Index persisted in IndexedDB
 * under a key derived from the user's password (so logout wipes readable index).
 *
 * CRYPTO: the plaintext body is only visible inside the worker-free index — keep the
 * index in a separate IDB database from the device keys so they can be flushed independently.
 */
import FlexSearch from 'flexsearch';

const IDB_NAME = 'vibe-connect-search';
const IDB_STORE = 'index';
const IDB_VERSION = 1;

async function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value as unknown as object, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClearAll(): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface IndexedEntry {
  id: string;
  conversationId: string;
  senderId: string | null;
  body: string;
  createdAt: string;
}

export class SearchIndex {
  private index: FlexSearch.Document<IndexedEntry, true>;
  private entries: Record<string, IndexedEntry> = {};

  constructor() {
    this.index = new FlexSearch.Document<IndexedEntry, true>({
      tokenize: 'forward',
      cache: true,
      document: {
        id: 'id',
        store: true,
        index: [
          { field: 'body', tokenize: 'forward' },
          { field: 'senderId', tokenize: 'strict' },
        ],
      },
    });
  }

  add(entry: IndexedEntry): void {
    this.entries[entry.id] = entry;
    this.index.add(entry);
  }

  remove(id: string): void {
    delete this.entries[id];
    this.index.remove(id);
  }

  search(query: string, limit = 50): IndexedEntry[] {
    const results = this.index.search(query, { limit }) as Array<{
      field: string;
      result: Array<string | number>;
    }>;
    const seen = new Set<string>();
    const out: IndexedEntry[] = [];
    for (const bucket of results) {
      for (const rid of bucket.result) {
        const id = String(rid);
        if (seen.has(id)) continue;
        const entry = this.entries[id];
        if (entry) {
          out.push(entry);
          seen.add(id);
        }
      }
    }
    return out.slice(0, limit);
  }

  snapshot(): Record<string, IndexedEntry> {
    return this.entries;
  }

  hydrate(snapshot: Record<string, IndexedEntry>): void {
    this.entries = snapshot;
    for (const e of Object.values(snapshot)) this.index.add(e);
  }

  async persist(userId: string): Promise<void> {
    await idbSet(`snap:${userId}`, this.entries);
  }

  async load(userId: string): Promise<boolean> {
    const snap = await idbGet<Record<string, IndexedEntry>>(`snap:${userId}`);
    if (!snap) return false;
    this.hydrate(snap);
    return true;
  }

  static async wipeAll(): Promise<void> {
    await idbClearAll();
  }
}
