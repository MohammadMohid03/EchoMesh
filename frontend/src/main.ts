import { SignalingClient } from './signaling';
import { PeerManager } from './webrtc';
import { MessagingLayer } from './messaging';
import { CollabEditor } from './editor';
import { CollabWhiteboard } from './whiteboard';
import { FileSharer } from './fileshare';
import { HistoryManager } from './history';
import { Exporter } from './export';
import { storage } from './storage';
import { colorForPeer, type AwarenessState } from './types';
import './style.css';

// ── Local identity ──────────────────────────────────────────────────
const peerId = 'peer-' + crypto.randomUUID().slice(0, 8);
const peerColor = colorForPeer(peerId);
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

let signaling: SignalingClient;
let peerManager: PeerManager;
let messaging: MessagingLayer;
let editor: CollabEditor;
let whiteboard: CollabWhiteboard;
let fileSharer: FileSharer;
let historyMgr: HistoryManager;
let currentRoom: string | null = null;

// ── DOM refs ────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
const nameInput = $('name-input') as HTMLInputElement;
const roomInput = $('room-input') as HTMLInputElement;
const joinBtn = $('join-btn') as HTMLButtonElement;
const leaveBtn = $('leave-btn') as HTMLButtonElement;
const statusEl = $('status');
const peerListEl = $('peer-list');
const chatInput = $('chat-input') as HTMLInputElement;
const sendBtn = $('send-btn') as HTMLButtonElement;
const messagesEl = $('messages');
const peerIdEl = $('peer-id');
const peerCountEl = $('peer-count');
const editorContainer = $('editor-container');
const whiteboardContainer = $('whiteboard-container');
const filesContainer = $('files-container');
const historyContainer = $('history-container');
const editorStatusEl = $('editor-status');
const roomHistoryEl = $('room-history');
const offlineBanner = $('offline-banner');

peerIdEl.textContent = peerId;
peerIdEl.style.color = peerColor;

// Restore name from localStorage
const savedName = localStorage.getItem('echomesh-name');
if (savedName) nameInput.value = savedName;

// ── Tab switching ───────────────────────────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panels.forEach(p => p.classList.toggle('active', p.id === `panel-${target}`));

      // When switching to whiteboard, the canvas needs to be resized
      // because it was mounted while the panel was display:none (dimensions were 0)
      if (target === 'whiteboard' && whiteboard) {
        // Small delay to let the panel become visible first
        requestAnimationFrame(() => {
          whiteboard.resize();
        });
      }
    });
  });
}
initTabs();

// ── Resizable chat panel ────────────────────────────────────────────

function initResizableChat() {
  const chatEl = $('chat');
  const resizeHandle = document.createElement('div');
  resizeHandle.id = 'chat-resize-handle';
  resizeHandle.title = 'Drag to resize chat';
  chatEl.prepend(resizeHandle);

  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = chatEl.offsetHeight;
    resizeHandle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (!isResizing) return;
    const delta = startY - e.clientY;
    const newHeight = Math.max(100, Math.min(600, startHeight + delta));
    chatEl.style.height = `${newHeight}px`;
  });

  document.addEventListener('pointerup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}
initResizableChat();

// ── Online / Offline detection ──────────────────────────────────────

function updateOnlineStatus() {
  if (navigator.onLine) {
    offlineBanner.classList.add('hidden');
  } else {
    offlineBanner.classList.remove('hidden');
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ── UI helpers ──────────────────────────────────────────────────────

function setStatus(text: string, cls: 'on' | 'off' | 'wait' = 'wait') {
  statusEl.textContent = text;
  statusEl.className = `status-badge ${cls}`;
}

function setEditorStatus(synced: boolean) {
  editorStatusEl.textContent = synced ? 'Synced' : 'Local';
  editorStatusEl.className = `editor-badge ${synced ? 'synced' : 'offline'}`;
}

function addMsg(from: string, text: string, color = '#6b7394', local = false) {
  const row = document.createElement('div');
  row.className = `msg ${local ? 'msg-local' : 'msg-remote'}`;
  row.innerHTML = `<span class="msg-who" style="color:${color}">${from}</span> <span>${text}</span>`;
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function systemMsg(text: string) {
  const row = document.createElement('div');
  row.className = 'msg msg-system';
  row.innerHTML = `<span class="sys-icon">⚡</span> ${text}`;
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function refreshPeers() {
  const peers = peerManager?.getConnectedPeers() ?? [];
  const count = peers.length;
  peerCountEl.textContent = String(count);
  setEditorStatus(count > 0);

  if (count === 0) {
    peerListEl.innerHTML = '<div class="empty">Waiting for peers…</div>';
    return;
  }

  peerListEl.innerHTML = '';
  for (const id of peers) {
    const state: AwarenessState | undefined = messaging?.awareness.get(id);
    const name = state?.name || id;
    const color = state?.color || colorForPeer(id);

    const el = document.createElement('div');
    el.className = 'peer';
    el.innerHTML = `
      <span class="dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
      <span class="peer-name">${name}</span>
      <span class="peer-id-small">${id}</span>
    `;
    peerListEl.appendChild(el);
  }
}

// ── Room history ────────────────────────────────────────────────────

async function renderRoomHistory() {
  const rooms = await storage.getRooms();
  if (rooms.length === 0) {
    roomHistoryEl.innerHTML = '<div class="empty">No recent rooms</div>';
    return;
  }

  roomHistoryEl.innerHTML = '';
  for (const room of rooms.slice(0, 5)) {
    const el = document.createElement('div');
    el.className = 'history-item';
    const ago = timeAgo(room.lastJoined);
    el.innerHTML = `
      <button class="history-join" data-room="${room.name}" title="Rejoin ${room.name}">
        <span class="history-name">${room.name}</span>
        <span class="history-meta">${ago}</span>
      </button>
      <button class="history-delete" data-room="${room.name}" title="Remove">✕</button>
    `;
    roomHistoryEl.appendChild(el);
  }

  roomHistoryEl.querySelectorAll('.history-join').forEach(btn => {
    btn.addEventListener('click', () => {
      roomInput.value = (btn as HTMLElement).dataset.room!;
      joinRoom();
    });
  });

  roomHistoryEl.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const room = (btn as HTMLElement).dataset.room!;
      await storage.removeRoom(room);
      await storage.deleteDoc(room);
      renderRoomHistory();
    });
  });
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

// ── Join / Leave ────────────────────────────────────────────────────

async function joinRoom() {
  const room = roomInput.value.trim();
  if (!room) return;
  const userName = nameInput.value.trim() || peerId;
  currentRoom = room;
  location.hash = room;

  localStorage.setItem('echomesh-name', userName);
  await storage.addRoom({
    name: room,
    userName,
    lastJoined: new Date().toISOString(),
  });

  setStatus('Connecting…', 'wait');

  signaling = new SignalingClient(wsUrl, peerId);
  peerManager = new PeerManager(peerId);
  messaging = new MessagingLayer(peerManager, userName, peerColor);

  // ── Create & init collaborative editor ─────────────────────────
  editor = new CollabEditor(messaging, room, peerId, userName, peerColor);
  editorContainer.innerHTML = '';
  await editor.init(editorContainer);
  setEditorStatus(false);

  // ── Create whiteboard (shares same Yjs doc as editor) ──────────
  whiteboard = new CollabWhiteboard(editor.doc, peerId);
  whiteboardContainer.innerHTML = '';
  whiteboard.mount(whiteboardContainer);

  // ── Create file sharer ─────────────────────────────────────────
  fileSharer = new FileSharer(
    messaging,
    (_transfer) => { /* progress callback - UI updates internally */ },
    (transfer) => systemMsg(`📥 Received file: ${transfer.name}`),
  );
  filesContainer.innerHTML = '';
  fileSharer.mount(filesContainer);

  // ── Create history manager ─────────────────────────────────────
  historyMgr = new HistoryManager(editor.doc, room);
  historyContainer.innerHTML = '';
  historyMgr.mount(historyContainer);

  // ── Signaling → WebRTC ──────────────────────────────────────────
  signaling.on('peer_list', async (peers) => {
    for (const p of peers) await peerManager.createOffer(p);
  });
  signaling.on('peer_joined', (id) => systemMsg(`${id} joined the room`));
  signaling.on('peer_left', (id) => {
    peerManager.removePeer(id);
    systemMsg(`${id} left the room`);
    refreshPeers();
  });
  signaling.on('offer', (f, s) => peerManager.handleOffer(f, s));
  signaling.on('answer', (f, s) => peerManager.handleAnswer(f, s));
  signaling.on('ice', (f, c) => peerManager.handleIce(f, c));
  signaling.on('disconnected', () => {
    setStatus('Disconnected — editing locally', 'off');
    setEditorStatus(false);
  });

  // ── WebRTC → Signaling ──────────────────────────────────────────
  peerManager.onSendOffer = (to, sdp) => signaling.sendOffer(to, sdp);
  peerManager.onSendAnswer = (to, sdp) => signaling.sendAnswer(to, sdp);
  peerManager.onSendIce = (to, c) => signaling.sendIce(to, c);

  // ── Peer events ─────────────────────────────────────────────────
  peerManager.on('peer_connected', (id) => {
    const n = peerManager.getConnectedPeers().length;
    setStatus(`${n} peer(s) connected`, 'on');
    refreshPeers();
    systemMsg(`P2P connected with ${id}`);
  });
  peerManager.on('peer_disconnected', () => {
    const n = peerManager.getConnectedPeers().length;
    setStatus(n ? `${n} peer(s) connected` : `Room: ${currentRoom}`, n ? 'on' : 'wait');
    refreshPeers();
  });

  // ── Messaging events ───────────────────────────────────────────
  messaging.on('chat', (from, msg) => {
    const state = messaging.awareness.get(from);
    const name = state?.name || from;
    const color = state?.color || colorForPeer(from);
    addMsg(name, msg.text, color);
  });
  messaging.on('awareness', () => refreshPeers());
  messaging.startAwareness(5000);

  // ── Connect ────────────────────────────────────────────────────
  try {
    await signaling.connect();
    signaling.joinRoom(room);
    setStatus(`Room: ${room}`, 'wait');
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    roomInput.disabled = true;
    nameInput.disabled = true;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
    systemMsg(`You joined room "${room}" as ${userName}`);
    renderRoomHistory();
    addCopyLinkButton();
  } catch {
    setStatus('Connection failed — editing locally', 'off');
    systemMsg('Failed to connect. You can edit offline.');
  }
}

async function leaveRoom() {
  historyMgr?.destroy();
  fileSharer?.destroy();
  whiteboard?.destroy();
  await editor?.destroy();
  messaging?.destroy();
  signaling?.disconnect();
  peerManager?.destroy();
  currentRoom = null;
  location.hash = '';
  setStatus('Not connected', 'off');
  setEditorStatus(false);
  editorContainer.innerHTML = '';
  whiteboardContainer.innerHTML = '';
  filesContainer.innerHTML = '';
  historyContainer.innerHTML = '';
  peerListEl.innerHTML = '<div class="empty">Waiting for peers…</div>';
  messagesEl.innerHTML = '';
  peerCountEl.textContent = '0';
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  roomInput.disabled = false;
  nameInput.disabled = false;
  chatInput.disabled = true;
  sendBtn.disabled = true;
  renderRoomHistory();
  // Remove copy-link button
  const copyBtn = document.querySelector('.copy-link-btn');
  if (copyBtn) copyBtn.remove();
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !messaging) return;
  messaging.sendChat(text);
  const name = nameInput.value.trim() || peerId;
  addMsg(name, text, peerColor, true);
  chatInput.value = '';
}

// ── Export bindings ──────────────────────────────────────────────────

$('export-pdf').addEventListener('click', () => {
  if (!editor?.ytext) return;
  const text = editor.ytext.toString();
  const title = currentRoom ? `EchoMesh - ${currentRoom}` : 'EchoMesh Document';
  Exporter.toPDF(text, title);
});

$('export-md').addEventListener('click', () => {
  if (!editor?.ytext) return;
  const text = editor.ytext.toString();
  const title = currentRoom ? `EchoMesh - ${currentRoom}` : 'EchoMesh Document';
  Exporter.toMarkdown(text, title);
});

$('export-txt').addEventListener('click', () => {
  if (!editor?.ytext) return;
  const text = editor.ytext.toString();
  const title = currentRoom ? `EchoMesh - ${currentRoom}` : 'EchoMesh Document';
  Exporter.toText(text, title);
});

$('export-png').addEventListener('click', () => {
  if (!whiteboard) return;
  const title = currentRoom ? `EchoMesh - ${currentRoom}` : 'EchoMesh Whiteboard';
  Exporter.toPNG(whiteboard.toDataURL(), title);
});

// ── Event bindings ──────────────────────────────────────────────────
joinBtn.addEventListener('click', joinRoom);
leaveBtn.addEventListener('click', leaveRoom);
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

// ── Save before unload ──────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  editor?.saveNow();
});

// ── Link-join modal ─────────────────────────────────────────────────

const joinModal = $('join-modal');
const modalRoomName = $('modal-room-name');
const modalNameInput = $('modal-name-input') as HTMLInputElement;
const modalJoinBtn = $('modal-join-btn') as HTMLButtonElement;
const modalCancelBtn = $('modal-cancel-btn') as HTMLButtonElement;

function showJoinModal(room: string) {
  modalRoomName.textContent = room;
  // Pre-fill saved name
  const saved = localStorage.getItem('echomesh-name');
  if (saved) modalNameInput.value = saved;
  joinModal.classList.remove('hidden');
  modalNameInput.focus();
}

function hideJoinModal() {
  joinModal.classList.add('hidden');
}

modalJoinBtn.addEventListener('click', () => {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const name = modalNameInput.value.trim();
  if (!name) {
    modalNameInput.focus();
    modalNameInput.style.borderColor = 'var(--red)';
    setTimeout(() => modalNameInput.style.borderColor = '', 1500);
    return;
  }
  nameInput.value = name;
  roomInput.value = hash;
  hideJoinModal();
  joinRoom();
});

modalNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalJoinBtn.click();
});

modalCancelBtn.addEventListener('click', () => {
  hideJoinModal();
  location.hash = '';
});

// ── Copy invite link ────────────────────────────────────────────────

function addCopyLinkButton() {
  // Remove existing copy button if any
  const existing = document.querySelector('.copy-link-btn');
  if (existing) existing.remove();

  if (!currentRoom) return;

  const btn = document.createElement('button');
  btn.className = 'copy-link-btn';
  btn.innerHTML = '🔗 Copy invite link';
  btn.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#${currentRoom}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.innerHTML = '✅ Link copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = '🔗 Copy invite link';
        btn.classList.remove('copied');
      }, 2000);
    } catch {
      // Fallback: select and copy
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      btn.innerHTML = '✅ Link copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = '🔗 Copy invite link';
        btn.classList.remove('copied');
      }, 2000);
    }
  });

  // Insert after the status badge in the room card
  const roomCard = $('room-card');
  roomCard.appendChild(btn);
}

// ── Auto-show join modal from URL hash ──────────────────────────────
const hash = location.hash.slice(1);
if (hash) {
  // Someone opened an invite link — show the join modal
  showJoinModal(hash);
}

// ── Init ────────────────────────────────────────────────────────────
setStatus('Not connected', 'off');
setEditorStatus(false);
renderRoomHistory();
