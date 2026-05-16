import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import { MessagingLayer } from './messaging';
import { storage } from './storage';

// ── Sub-message types within Sync ───────────────────────────────────
const SYNC_DOC = 0;
const SYNC_AWARENESS = 1;
const AUTHORS_MAP = 'author-ranges';

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

interface AuthorRange {
  from: number;
  to: number;
}

interface RenderedAuthorRange extends AuthorRange {
  id: string;
  peerId: string;
  name: string;
  color: string;
}

type StoredAuthorRange = {
  peerId: string;
  name: string;
  color: string;
  start: number[];
  end: number[];
};

const setAuthorHighlights = StateEffect.define<RenderedAuthorRange[]>();

class AuthorLabelWidget extends WidgetType {
  private readonly name: string;
  private readonly color: string;

  constructor(
    name: string,
    color: string,
  ) {
    super();
    this.name = name;
    this.color = color;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-author-label';

    const badge = document.createElement('span');
    badge.className = 'cm-author-label-badge';
    badge.textContent = this.name;
    badge.style.backgroundColor = this.color;
    wrapper.appendChild(badge);

    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const authorHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr): DecorationSet {
    for (const effect of tr.effects) {
      if (effect.is(setAuthorHighlights)) {
        const decorations = [];
        for (const range of effect.value) {
          decorations.push(
            Decoration.mark({
              class: 'cm-author-highlight',
              attributes: {
                style: `--author-color:${range.color};background-color:${range.color}2e;border-bottom-color:${range.color};`,
                title: `${range.name} wrote this`,
              },
            }).range(range.from, range.to),
          );
          decorations.push(
            Decoration.widget({
              widget: new AuthorLabelWidget(range.name, range.color),
              side: -1,
            }).range(range.from),
          );
        }

        return Decoration.set(decorations, true);
      }
    }

    return value.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

/**
 * Collaborative editor powered by Yjs + CodeMirror 6.
 *
 * Features:
 * - Real-time sync over WebRTC DataChannels
 * - IndexedDB persistence (survives page refresh)
 * - Offline editing with CRDT merge on reconnect
 * - Remote cursor awareness with name/color
 */
export class CollabEditor {
  public doc: Y.Doc;
  public ytext: Y.Text;
  public awareness: Awareness;
  public view: EditorView | null = null;

  private messaging: MessagingLayer;
  private authorRanges: Y.Map<StoredAuthorRange>;
  private roomName: string;
  private peerId: string;
  private localName: string;
  private localColor: string;
  private docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  private awarenessUpdateHandler: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;
  private authorRangesObserver: () => void;
  private authorRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    messaging: MessagingLayer,
    roomName: string,
    peerId: string,
    name: string,
    color: string,
  ) {
    this.messaging = messaging;
    this.roomName = roomName;
    this.peerId = peerId;
    this.localName = name;
    this.localColor = color;

    // ── Yjs document ─────────────────────────────────────────────
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText('codemirror');
    this.authorRanges = this.doc.getMap<StoredAuthorRange>(AUTHORS_MAP);
    this.awareness = new Awareness(this.doc);

    // Set local awareness state (user cursor info)
    this.awareness.setLocalStateField('user', {
      name: this.localName,
      color: this.localColor,
      colorLight: this.localColor + '33',
    });

    // ── Yjs → Network: send updates to peers ─────────────────────
    this.docUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') {
        this.broadcastDocUpdate(update);
        this.scheduleSave();
      }
    };
    this.doc.on('update', this.docUpdateHandler);

    // ── Awareness → Network ──────────────────────────────────────
    this.awarenessUpdateHandler = (changes) => {
      const { added, updated, removed } = changes;
      const changedClients = added.concat(updated).concat(removed);
      if (changedClients.includes(this.doc.clientID)) {
        this.broadcastAwarenessUpdate();
      }
    };
    this.awareness.on('update', this.awarenessUpdateHandler);

    this.authorRangesObserver = () => {
      this.scheduleAuthorHighlightRender();
      this.scheduleSave();
    };
    this.authorRanges.observe(this.authorRangesObserver);

    // ── Network → Yjs ────────────────────────────────────────────
    this.messaging.on('sync', (_peerId, data) => {
      this.handleSyncMessage(data);
    });

    // Send full state to newly connected peers
    this.messaging.peerManager.on('peer_connected', (peerId) => {
      this.sendFullStateTo(peerId);
    });
  }

  /**
   * Load persisted state from IndexedDB, then mount the editor.
   */
  async init(container: HTMLElement): Promise<void> {
    // Restore saved state
    const saved = await storage.loadDoc(this.roomName);
    if (saved) {
      Y.applyUpdate(this.doc, saved, 'local-restore');
      console.log(`[Editor] Restored ${saved.byteLength} bytes from IndexedDB`);
    }

    this.mount(container);
  }

  /**
   * Mount the CodeMirror editor into a DOM element.
   */
  private mount(container: HTMLElement): void {
    const state = EditorState.create({
      doc: this.ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({
          codeLanguages: (info) => {
            const lang = info.toLowerCase();
            if (['js', 'jsx', 'javascript'].includes(lang)) {
              return javascript({ jsx: true }).language;
            }
            if (['ts', 'tsx', 'typescript'].includes(lang)) {
              return javascript({ jsx: lang === 'tsx', typescript: true }).language;
            }
            if (lang === 'json') {
              return javascript().language;
            }
            return null;
          },
        }),
        oneDark,
        authorHighlightField,
        EditorView.updateListener.of((update) => this.handleEditorUpdate(update)),
        yCollab(this.ytext, this.awareness, { undoManager: false }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
          },
          '.cm-content': {
            padding: '12px 0',
            caretColor: '#6c5ce7',
          },
          '.cm-gutters': {
            background: '#151821',
            border: 'none',
            color: '#6b7394',
          },
          '.cm-activeLineGutter': {
            background: '#1a1e2b',
          },
          '.cm-activeLine': {
            background: '#1a1e2b44',
          },
          '.cm-ySelectionInfo': {
            padding: '2px 6px',
            borderRadius: '3px',
            fontSize: '11px',
            fontFamily: "'Inter', sans-serif",
            fontWeight: '600',
            opacity: '0.9',
            transition: 'opacity 0.3s',
          },
        }),
      ],
    });

    this.view = new EditorView({ state, parent: container });
    this.scheduleAuthorHighlightRender();
  }

  private handleEditorUpdate(update: ViewUpdate): void {
    if (!update.docChanged) return;

    const isUserInput = update.transactions.some(tr =>
      tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'),
    );
    if (!isUserInput) return;

    const ranges: AuthorRange[] = [];
    update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      if (toB > fromB) {
        ranges.push({ from: fromB, to: toB });
      }
    });

    if (ranges.length === 0) return;

    for (const range of ranges) {
      this.storeAuthorRange(range);
    }
  }

  private storeAuthorRange(range: AuthorRange): void {
    const start = Y.createRelativePositionFromTypeIndex(this.ytext, range.from, -1);
    const end = Y.createRelativePositionFromTypeIndex(this.ytext, range.to, 1);

    this.authorRanges.set(generateId(), {
      peerId: this.peerId,
      name: this.localName,
      color: this.localColor,
      start: Array.from(Y.encodeRelativePosition(start)),
      end: Array.from(Y.encodeRelativePosition(end)),
    });
  }

  private renderAuthorHighlights(): void {
    this.authorRenderTimer = null;
    if (!this.view) return;

    const rendered: RenderedAuthorRange[] = [];

    for (const [id, stored] of this.authorRanges.entries()) {
      const start = this.decodeAuthorPosition(stored.start);
      const end = this.decodeAuthorPosition(stored.end);
      if (!start || !end) continue;
      if (start.type !== this.ytext || end.type !== this.ytext) continue;

      const from = Math.max(0, Math.min(start.index, this.view.state.doc.length));
      const to = Math.max(0, Math.min(end.index, this.view.state.doc.length));
      if (to <= from) continue;

      rendered.push({
        id,
        peerId: stored.peerId,
        name: stored.name,
        color: stored.color,
        from,
        to,
      });
    }

    this.view.dispatch({
      effects: setAuthorHighlights.of(this.mergeAuthorRanges(rendered)),
    });
  }

  private mergeAuthorRanges(ranges: RenderedAuthorRange[]): RenderedAuthorRange[] {
    const sorted = [...ranges].sort((a, b) =>
      a.from - b.from ||
      a.to - b.to ||
      a.peerId.localeCompare(b.peerId),
    );
    const merged: RenderedAuthorRange[] = [];

    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.peerId === range.peerId &&
        previous.name === range.name &&
        previous.color === range.color &&
        range.from <= previous.to + 1
      ) {
        previous.to = Math.max(previous.to, range.to);
        continue;
      }

      merged.push({ ...range });
    }

    return merged;
  }

  private scheduleAuthorHighlightRender(): void {
    if (this.authorRenderTimer) return;
    this.authorRenderTimer = setTimeout(() => this.renderAuthorHighlights(), 0);
  }

  private decodeAuthorPosition(encoded: number[]): Y.AbsolutePosition | null {
    try {
      const relative = Y.decodeRelativePosition(Uint8Array.from(encoded));
      return Y.createAbsolutePositionFromRelativePosition(relative, this.doc);
    } catch {
      return null;
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  /** Debounced save — waits 500ms after last edit to batch writes. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveNow();
    }, 500);
  }

  /** Immediately persist the current document state. */
  async saveNow(): Promise<void> {
    if (this.destroyed) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    await storage.saveDoc(this.roomName, state);
  }

  // ── Sync helpers ──────────────────────────────────────────────────

  private broadcastDocUpdate(update: Uint8Array): void {
    const msg = new Uint8Array(1 + update.byteLength);
    msg[0] = SYNC_DOC;
    msg.set(update, 1);
    this.messaging.sendSync(msg);
  }

  private broadcastAwarenessUpdate(): void {
    const awarenessState = this.awareness.getLocalState();
    if (!awarenessState) return;
    const encoded = new TextEncoder().encode(JSON.stringify({
      clientID: this.doc.clientID,
      state: awarenessState,
    }));
    const msg = new Uint8Array(1 + encoded.byteLength);
    msg[0] = SYNC_AWARENESS;
    msg.set(encoded, 1);
    this.messaging.sendSync(msg);
  }

  private sendFullStateTo(peerId: string): void {
    const state = Y.encodeStateAsUpdate(this.doc);
    const msg = new Uint8Array(1 + state.byteLength);
    msg[0] = SYNC_DOC;
    msg.set(state, 1);
    this.messaging.sendSyncTo(peerId, msg);
    setTimeout(() => this.broadcastAwarenessUpdate(), 100);
  }

  private handleSyncMessage(data: Uint8Array): void {
    if (data.byteLength < 2) return;

    const subType = data[0];
    const payload = data.subarray(1);

    switch (subType) {
      case SYNC_DOC: {
        Y.applyUpdate(this.doc, payload, 'remote');
        this.scheduleSave(); // Also persist remote changes
        break;
      }
      case SYNC_AWARENESS: {
        try {
          const decoded = JSON.parse(new TextDecoder().decode(payload));
          if (decoded.clientID !== undefined && decoded.state) {
            const states = this.awareness.getStates();
            states.set(decoded.clientID, decoded.state);
            this.awareness.emit('change', [{
              added: [],
              updated: [decoded.clientID],
              removed: [],
            }, 'remote']);
          }
        } catch (e) {
          console.warn('[Editor] Failed to decode awareness:', e);
        }
        break;
      }
    }
  }

  /** Clean up everything and do a final save. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.authorRenderTimer) clearTimeout(this.authorRenderTimer);
    await this.saveNow();
    this.doc.off('update', this.docUpdateHandler);
    this.awareness.off('update', this.awarenessUpdateHandler);
    this.authorRanges.unobserve(this.authorRangesObserver);
    this.awareness.destroy();
    this.view?.destroy();
    this.doc.destroy();
  }
}
