import * as Y from 'yjs';
import { storage } from './storage';

export interface Snapshot {
  id: string;
  room: string;
  label: string;
  timestamp: string;
  state: Uint8Array;
}

/**
 * Document versioning via Yjs snapshots.
 *
 * Saves named snapshots of the document to IndexedDB.
 * Supports restore (time travel) and auto-snapshots.
 */
export class HistoryManager {
  private doc: Y.Doc;
  private room: string;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private container: HTMLElement | null = null;

  constructor(doc: Y.Doc, room: string) {
    this.doc = doc;
    this.room = room;
  }

  /** Start auto-snapshotting every `intervalMs` (default 5 min). */
  startAutoSnapshot(intervalMs = 5 * 60 * 1000): void {
    this.stopAutoSnapshot();
    this.autoTimer = setInterval(() => {
      this.saveSnapshot('Auto-save');
    }, intervalMs);
  }

  stopAutoSnapshot(): void {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }

  /** Save a named snapshot. */
  async saveSnapshot(label = 'Manual save'): Promise<Snapshot> {
    const state = Y.encodeStateAsUpdate(this.doc);
    const snapshot: Snapshot = {
      id: crypto.randomUUID().slice(0, 8),
      room: this.room,
      label,
      timestamp: new Date().toISOString(),
      state,
    };
    await storage.saveSnapshot(snapshot);
    if (this.container) this.renderSnapshots();
    return snapshot;
  }

  /** Restore the document to a previous snapshot. */
  async restoreSnapshot(snapshot: Snapshot): Promise<void> {
    // Create a new doc with the snapshot state, then sync
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshot.state);

    // Clear current doc and apply snapshot state
    const update = Y.encodeStateAsUpdate(tempDoc);
    Y.applyUpdate(this.doc, update, 'restore');
    tempDoc.destroy();

    if (this.container) this.renderSnapshots();
  }

  /** Get all snapshots for this room. */
  async getSnapshots(): Promise<Snapshot[]> {
    return storage.getSnapshots(this.room);
  }

  /** Mount the history UI. */
  mount(container: HTMLElement): void {
    this.container = container;
    this.renderSnapshots();
  }

  private async renderSnapshots(): Promise<void> {
    if (!this.container) return;

    const snapshots = await this.getSnapshots();

    this.container.innerHTML = `
      <div class="hist-actions">
        <button class="btn primary hist-save-btn" title="Save snapshot now">📸 Save Snapshot</button>
      </div>
      <div class="hist-list">
        ${snapshots.length === 0
          ? '<div class="empty">No snapshots yet</div>'
          : snapshots.map(s => `
              <div class="hist-item" data-id="${s.id}">
                <div class="hist-item-info">
                  <span class="hist-label">${s.label}</span>
                  <span class="hist-time">${timeAgo(s.timestamp)}</span>
                </div>
                <div class="hist-item-actions">
                  <button class="hist-restore" data-id="${s.id}" title="Restore">↩️</button>
                  <button class="hist-delete" data-id="${s.id}" title="Delete">✕</button>
                </div>
              </div>
            `).join('')
        }
      </div>
    `;

    // Wire save button
    this.container.querySelector('.hist-save-btn')?.addEventListener('click', () => {
      const label = prompt('Snapshot name:', `Snapshot ${snapshots.length + 1}`);
      if (label) this.saveSnapshot(label);
    });

    // Wire restore/delete
    this.container.querySelectorAll('.hist-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.id!;
        const snap = snapshots.find(s => s.id === id);
        if (snap && confirm(`Restore "${snap.label}"? Current changes will merge.`)) {
          await this.restoreSnapshot(snap);
        }
      });
    });

    this.container.querySelectorAll('.hist-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.id!;
        await storage.deleteSnapshot(id);
        this.renderSnapshots();
      });
    });
  }

  destroy(): void {
    this.stopAutoSnapshot();
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
