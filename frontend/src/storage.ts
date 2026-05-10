import { openDB, type IDBPDatabase } from 'idb';
import type { Snapshot } from './history';

const DB_NAME = 'echomesh';
const DB_VERSION = 2; // Bumped for snapshots store

// Store names
const DOCS_STORE = 'documents';
const ROOMS_STORE = 'rooms';
const SNAPSHOTS_STORE = 'snapshots';

/** Room history entry. */
export interface RoomEntry {
  /** Room name (primary key). */
  name: string;
  /** Display name used when last joined. */
  userName: string;
  /** ISO timestamp of last join. */
  lastJoined: string;
}

/**
 * Persistent storage backed by IndexedDB.
 *
 * Three object stores:
 * - `documents`:  room name → Yjs binary state (Uint8Array)
 * - `rooms`:      room name → { name, userName, lastJoined }
 * - `snapshots`:  snapshot id → { id, room, label, timestamp, state }
 */
class Storage {
  private dbPromise: Promise<IDBPDatabase>;

  constructor() {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(DOCS_STORE)) {
          db.createObjectStore(DOCS_STORE);
        }
        if (!db.objectStoreNames.contains(ROOMS_STORE)) {
          db.createObjectStore(ROOMS_STORE, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'id' });
        }
      },
    });
  }

  // ── Document persistence ──────────────────────────────────────────

  /** Save Yjs document state for a room. */
  async saveDoc(roomName: string, state: Uint8Array): Promise<void> {
    const db = await this.dbPromise;
    await db.put(DOCS_STORE, state, roomName);
  }

  /** Load saved Yjs document state for a room. Returns null if none exists. */
  async loadDoc(roomName: string): Promise<Uint8Array | null> {
    const db = await this.dbPromise;
    const data = await db.get(DOCS_STORE, roomName);
    return data ?? null;
  }

  /** Delete saved document state for a room. */
  async deleteDoc(roomName: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(DOCS_STORE, roomName);
  }

  // ── Room history ──────────────────────────────────────────────────

  /** Record a room join in history. */
  async addRoom(entry: RoomEntry): Promise<void> {
    const db = await this.dbPromise;
    await db.put(ROOMS_STORE, entry);
  }

  /** Get all room history entries, sorted by most recent. */
  async getRooms(): Promise<RoomEntry[]> {
    const db = await this.dbPromise;
    const all = await db.getAll(ROOMS_STORE);
    return all.sort(
      (a, b) => new Date(b.lastJoined).getTime() - new Date(a.lastJoined).getTime(),
    );
  }

  /** Delete a room from history. */
  async removeRoom(name: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(ROOMS_STORE, name);
  }

  // ── Snapshots ─────────────────────────────────────────────────────

  /** Save a document snapshot. */
  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const db = await this.dbPromise;
    await db.put(SNAPSHOTS_STORE, snapshot);
  }

  /** Get all snapshots for a room, sorted newest first. */
  async getSnapshots(room: string): Promise<Snapshot[]> {
    const db = await this.dbPromise;
    const all = await db.getAll(SNAPSHOTS_STORE);
    return all
      .filter(s => s.room === room)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /** Delete a snapshot by ID. */
  async deleteSnapshot(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(SNAPSHOTS_STORE, id);
  }
}

/** Singleton storage instance. */
export const storage = new Storage();
