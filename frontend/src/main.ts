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
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).substring(2, 10);
}

const peerId = 'peer-' + generateId();
const peerColor = colorForPeer(peerId);

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
const passwordInput = $('password-input') as HTMLInputElement;
const serverInput = $('server-input') as HTMLInputElement;
const generateRoomBtn = $('generate-room-btn') as HTMLButtonElement;
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
const typingIndicatorEl = $('typing-indicator');
const themeToggle = $('theme-toggle') as HTMLButtonElement;
const themeIcon = themeToggle.querySelector('.theme-icon') as HTMLElement;

peerIdEl.textContent = peerId;
peerIdEl.style.color = peerColor;

type JoinAction = 'create' | 'join';

function getSignalingUrl(): string {
  const configured = normalizeSignalingUrl(serverInput.value);
  if (configured) return configured;

  const hostedDefault = normalizeSignalingUrl(import.meta.env.VITE_SIGNALING_URL ?? '');
  if (hostedDefault) return hostedDefault;

  const desktopHost = isTauriHost();
  if (desktopHost) return 'ws://127.0.0.1:8080/ws';

  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8080/ws`;
}

function normalizeSignalingUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  const withoutTrailingSlash = trimmed.replace(/\/$/, '');
  return `ws://${withoutTrailingSlash}${withoutTrailingSlash.endsWith('/ws') ? '' : '/ws'}`;
}

function isTauriHost(): boolean {
  return location.hostname === 'tauri.localhost' || location.protocol === 'tauri:';
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]';
}

function getInviteBaseUrl(signalUrl: string): string {
  const hostedWebUrl = normalizeWebAppUrl(import.meta.env.VITE_WEB_APP_URL ?? '');
  if (hostedWebUrl) return hostedWebUrl;

  if (!isTauriHost()) return `${location.origin}${location.pathname}`;

  try {
    const signal = new URL(signalUrl);
    if (!isLoopbackHost(signal.hostname)) {
      const webProtocol = signal.protocol === 'wss:' ? 'https:' : 'http:';
      return `${webProtocol}//${signal.hostname}:5173/`;
    }
  } catch { /* fall back to current app URL */ }

  return `${location.origin}${location.pathname}`;
}

function normalizeWebAppUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

type InviteData = {
  room: string;
  signal: string;
  action?: JoinAction;
};

async function createRoom(): Promise<void> {
  await joinRoom('create');
}

function buildInviteHash(room: string, signal = ''): string {
  const params = new URLSearchParams({ room });
  if (signal) params.set('signal', signal);
  return params.toString();
}

function parseInviteHash(): InviteData | null {
  const raw = location.hash.slice(1);
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const room = params.get('room');
  if (room) {
    return {
      room,
      signal: params.get('signal') ?? '',
    };
  }

  return {
    room: decodeURIComponent(raw),
    signal: '',
  };
}

// Restore preferences from localStorage
const savedName = localStorage.getItem('echomesh-name');
if (savedName) nameInput.value = savedName;
const savedSignalingUrl = localStorage.getItem('echomesh-signaling-url');
if (savedSignalingUrl) serverInput.value = savedSignalingUrl;

// Theme preference
const savedTheme = localStorage.getItem('echomesh-theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
themeIcon.textContent = savedTheme === 'light' ? '☀️' : '🌙';

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('echomesh-theme', next);
  themeIcon.textContent = next === 'light' ? '☀️' : '🌙';
});

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

function refreshTypingIndicator() {
  if (!messaging) {
    typingIndicatorEl.textContent = '';
    return;
  }

  const names = [...messaging.awareness.values()]
    .filter(state => state.typingChat)
    .map(state => state.name)
    .slice(0, 3);

  if (names.length === 0) {
    typingIndicatorEl.textContent = '';
  } else {
    typingIndicatorEl.textContent =
      names.length === 1 ? `${names[0]} is typing` : `${names.join(', ')} are typing`;
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'typing-dot';
      dot.textContent = '.';
      typingIndicatorEl.appendChild(dot);
    }
  }
}

let chatTypingTimer: ReturnType<typeof setTimeout> | null = null;

function setChatTyping(isTyping: boolean) {
  if (!messaging) return;
  messaging.updateLocalAwareness({ typingChat: isTyping });
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
      showJoinModal({
        room: roomInput.value,
        signal: normalizeSignalingUrl(serverInput.value),
        action: 'create',
      });
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

function markInvalid(input: HTMLInputElement): void {
  input.focus();
  input.classList.add('input-shake');
  setTimeout(() => input.classList.remove('input-shake'), 450);
}

async function joinRoom(action: JoinAction = 'join') {
  const room = roomInput.value.trim();
  const userName = nameInput.value.trim();
  const roomPassword = passwordInput.value.trim();
  if (!userName) {
    setStatus('Your name is required', 'off');
    markInvalid(nameInput);
    return;
  }
  if (!room) {
    setStatus('Room name is required', 'off');
    markInvalid(roomInput);
    return;
  }
  if (!roomPassword) {
    setStatus('Access key required', 'off');
    markInvalid(passwordInput);
    return;
  }
  currentRoom = room;
  location.hash = buildInviteHash(room, getSignalingUrl());

  localStorage.setItem('echomesh-name', userName);
  const configuredSignalingUrl = normalizeSignalingUrl(serverInput.value);
  if (configuredSignalingUrl) {
    localStorage.setItem('echomesh-signaling-url', configuredSignalingUrl);
    serverInput.value = configuredSignalingUrl;
  } else {
    localStorage.removeItem('echomesh-signaling-url');
  }
  await storage.addRoom({
    name: room,
    userName,
    lastJoined: new Date().toISOString(),
  });

  setStatus(action === 'create' ? 'Creating room...' : 'Joining room...', 'wait');

  signaling = new SignalingClient(getSignalingUrl(), peerId);
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
  signaling.on('error', (message) => {
    systemMsg(message);
    setStatus(message, 'off');
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
  messaging.on('awareness', () => {
    refreshPeers();
    refreshTypingIndicator();
  });
  messaging.startAwareness(5000);

  // ── Connect ────────────────────────────────────────────────────
  try {
    await signaling.connect();
    await signaling.joinRoom(room, roomPassword, action === 'create');
    setStatus(`Room: ${room}`, 'wait');
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    generateRoomBtn.disabled = true;
    roomInput.disabled = true;
    nameInput.disabled = true;
    passwordInput.disabled = true;
    serverInput.disabled = true;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
    systemMsg(`You joined room "${room}" as ${userName}`);
    renderRoomHistory();
    addCopyLinkButton();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed';
    setStatus(`${message} — editing locally`, 'off');
    systemMsg(`${message}. You can edit offline.`);
    historyMgr?.destroy();
    fileSharer?.destroy();
    whiteboard?.destroy();
    await editor?.destroy();
    messaging?.destroy();
    signaling?.disconnect();
    currentRoom = null;
    location.hash = '';
    editorContainer.innerHTML = '';
    whiteboardContainer.innerHTML = '';
    filesContainer.innerHTML = '';
    historyContainer.innerHTML = '';
    return;
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
  generateRoomBtn.disabled = false;
  roomInput.disabled = false;
  nameInput.disabled = false;
  passwordInput.disabled = false;
  serverInput.disabled = false;
  chatInput.disabled = true;
  sendBtn.disabled = true;
  typingIndicatorEl.textContent = '';
  renderRoomHistory();
  // Remove copy-link button
  const copyBtn = document.querySelector('.copy-link-btn');
  if (copyBtn) copyBtn.remove();
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !messaging) return;
  messaging.sendChat(text);
  setChatTyping(false);
  if (chatTypingTimer) clearTimeout(chatTypingTimer);
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
generateRoomBtn.addEventListener('click', () => void createRoom());
joinBtn.addEventListener('click', () => {
  showJoinModal({
    room: roomInput.value.trim(),
    signal: normalizeSignalingUrl(serverInput.value),
  });
});
leaveBtn.addEventListener('click', leaveRoom);
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
chatInput.addEventListener('input', () => {
  if (!messaging) return;
  const isTyping = chatInput.value.trim().length > 0;
  setChatTyping(isTyping);
  if (chatTypingTimer) clearTimeout(chatTypingTimer);
  if (isTyping) {
    chatTypingTimer = setTimeout(() => setChatTyping(false), 1800);
  }
});
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    showJoinModal({ room: roomInput.value.trim(), signal: normalizeSignalingUrl(serverInput.value) });
  }
});
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void createRoom(); });
serverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    showJoinModal({ room: roomInput.value.trim(), signal: normalizeSignalingUrl(serverInput.value) });
  }
});

// ── Save before unload ──────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  editor?.saveNow();
});

// ── Link-join modal ─────────────────────────────────────────────────

const joinModal = $('join-modal');
const modalRoomName = $('modal-room-name');
const modalRoomLabel = joinModal.querySelector('.modal-room-label') as HTMLElement;
const modalRoomField = $('modal-room-field');
const modalRoomInput = $('modal-room-input') as HTMLInputElement;
const modalNameInput = $('modal-name-input') as HTMLInputElement;
const modalPasswordInput = $('modal-password-input') as HTMLInputElement;
const modalJoinBtn = $('modal-join-btn') as HTMLButtonElement;
const modalCancelBtn = $('modal-cancel-btn') as HTMLButtonElement;
let pendingJoinInvite: InviteData | null = null;

function showJoinModal(invite: InviteData) {
  pendingJoinInvite = invite;
  const room = invite.room.trim();
  modalRoomLabel.textContent = invite.action === 'create'
    ? 'Reopening local room'
    : room ? 'Joining room' : 'Choose a room';
  modalRoomName.textContent = room || 'Room details';
  modalRoomInput.value = room;
  modalRoomField.classList.toggle('hidden', Boolean(room));
  // Pre-fill saved name
  const saved = localStorage.getItem('echomesh-name');
  if (saved) modalNameInput.value = saved;
  modalPasswordInput.value = '';
  if (invite.signal) serverInput.value = invite.signal;
  joinModal.classList.remove('hidden');
  (room ? (modalNameInput.value ? modalPasswordInput : modalNameInput) : modalRoomInput).focus();
}

function hideJoinModal() {
  joinModal.classList.add('hidden');
  pendingJoinInvite = null;
}

modalJoinBtn.addEventListener('click', () => {
  const invite = pendingJoinInvite ?? parseInviteHash();
  if (!invite) return;
  const room = (invite.room || modalRoomInput.value).trim();
  const name = modalNameInput.value.trim();
  const password = modalPasswordInput.value.trim();
  if (!room) {
    modalRoomField.classList.remove('hidden');
    modalRoomInput.focus();
    modalRoomInput.style.borderColor = 'var(--red)';
    setTimeout(() => modalRoomInput.style.borderColor = '', 1500);
    return;
  }
  if (!name) {
    modalNameInput.focus();
    modalNameInput.style.borderColor = 'var(--red)';
    setTimeout(() => modalNameInput.style.borderColor = '', 1500);
    return;
  }
  if (!password) {
    modalPasswordInput.focus();
    modalPasswordInput.style.borderColor = 'var(--red)';
    setTimeout(() => modalPasswordInput.style.borderColor = '', 1500);
    return;
  }
  nameInput.value = name;
  passwordInput.value = password;
  roomInput.value = room;
  if (invite.signal) serverInput.value = invite.signal;
  hideJoinModal();
  joinRoom(invite.action ?? 'join');
});

modalNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalJoinBtn.click();
});
modalPasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalJoinBtn.click();
});
modalRoomInput.addEventListener('keydown', (e) => {
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
  const room = currentRoom;

  const btn = document.createElement('button');
  btn.className = 'copy-link-btn';
  btn.textContent = 'Copy secure invite';
  btn.innerHTML = '🔗 Copy invite link';
  btn.textContent = 'Copy secure invite';
  btn.addEventListener('click', async () => {
    const signal = getSignalingUrl();
    const hash = buildInviteHash(room, signal);
    const url = `${getInviteBaseUrl(signal)}#${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.innerHTML = '✅ Link copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = '🔗 Copy invite link';
        btn.classList.remove('copied');
        btn.textContent = 'Copy secure invite';
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
        btn.textContent = 'Copy secure invite';
      }, 2000);
    }
  });

  // Insert after the status badge in the room card
  const roomCard = $('room-card');
  roomCard.appendChild(btn);
}

// ── Auto-show join modal from URL hash ──────────────────────────────
const invite = parseInviteHash();
if (invite) {
  // Someone opened an invite link — show the join modal
  showJoinModal(invite);
}

// ── Init ────────────────────────────────────────────────────────────
setStatus('Not connected', 'off');
setEditorStatus(false);
renderRoomHistory();
