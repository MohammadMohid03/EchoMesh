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
const SYNC_AUTHOR_HIGHLIGHT = 2;
const AUTHOR_HIGHLIGHT_TTL = 3500;

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

interface AuthorRange {
  from: number;
  to: number;
}

interface AuthorHighlight {
  id: string;
  peerId: string;
  name: string;
  color: string;
  ranges: AuthorRange[];
}

const addAuthorHighlight = StateEffect.define<AuthorHighlight>();
const clearAuthorHighlight = StateEffect.define<string>();

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
    const label = document.createElement('span');
    label.className = 'cm-author-label';
    label.textContent = this.name;
    label.style.backgroundColor = this.color;
    return label;
  }
}

const authorHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    value = value.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(clearAuthorHighlight)) {
        value = value.update({
          filter: (_from, _to, deco) => deco.spec.id !== effect.value,
        });
      }

      if (effect.is(addAuthorHighlight)) {
        const highlight = effect.value;
        const decorations = [];
        for (const [index, range] of highlight.ranges.entries()) {
          if (range.to <= range.from) continue;

          decorations.push(
            Decoration.mark({
              class: 'cm-author-highlight',
              attributes: {
                style: `background-color:${highlight.color}33;border-bottom-color:${highlight.color};`,
              },
              id: highlight.id,
            }).range(range.from, range.to),
          );

          if (index === 0) {
            decorations.push(
              Decoration.widget({
                widget: new AuthorLabelWidget(highlight.name, highlight.color),
                side: -1,
                id: highlight.id,
              }).range(range.from),
            );
          }
        }

        value = value.update({
          add: decorations,
          sort: true,
        });
      }
    }

    return value;
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
  private roomName: string;
  private peerId: string;
  private localName: string;
  private localColor: string;
  private docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  private awarenessUpdateHandler: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;
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

    this.broadcastAuthorHighlight({
      id: generateId(),
      peerId: this.peerId,
      name: this.localName,
      color: this.localColor,
      ranges,
    });
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

  private broadcastAuthorHighlight(highlight: AuthorHighlight): void {
    const encoded = new TextEncoder().encode(JSON.stringify(highlight));
    const msg = new Uint8Array(1 + encoded.byteLength);
    msg[0] = SYNC_AUTHOR_HIGHLIGHT;
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
      case SYNC_AUTHOR_HIGHLIGHT: {
        try {
          const highlight = JSON.parse(new TextDecoder().decode(payload)) as AuthorHighlight;
          if (highlight.peerId === this.peerId || !this.view) return;

          const docLength = this.view.state.doc.length;
          const ranges = highlight.ranges
            .map(range => ({
              from: Math.max(0, Math.min(range.from, docLength)),
              to: Math.max(0, Math.min(range.to, docLength)),
            }))
            .filter(range => range.to > range.from);

          if (ranges.length === 0) return;

          this.view.dispatch({
            effects: addAuthorHighlight.of({ ...highlight, ranges }),
          });

          setTimeout(() => {
            this.view?.dispatch({
              effects: clearAuthorHighlight.of(highlight.id),
            });
          }, AUTHOR_HIGHLIGHT_TTL);
        } catch (e) {
          console.warn('[Editor] Failed to decode author highlight:', e);
        }
        break;
      }
    }
  }

  /** Clean up everything and do a final save. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.saveNow();
    this.doc.off('update', this.docUpdateHandler);
    this.awareness.off('update', this.awarenessUpdateHandler);
    this.awareness.destroy();
    this.view?.destroy();
    this.doc.destroy();
  }
}
