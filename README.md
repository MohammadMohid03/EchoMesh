# EchoMesh

EchoMesh is a local-first, real-time collaborative workspace. It uses a small Rust signaling server to help browser clients discover each other, then moves collaboration traffic onto peer-to-peer WebRTC DataChannels.

The app includes a collaborative markdown editor, whiteboard, chat, room history, export tools, and LAN-optimized file sharing.

## Features

- Real-time room-based collaboration
- Peer-to-peer WebRTC mesh after WebSocket signaling
- Collaborative CodeMirror markdown editor powered by Yjs CRDTs
- Offline-first document persistence with IndexedDB
- Shared whiteboard backed by the same Yjs document
- Chat and presence/awareness over DataChannels
- File sharing with chunked transfers up to 1 GB
- Export to PDF, Markdown, text, and PNG
- Invite links using URL hashes
- Manual signaling test page at `/test`

## Tech Stack

- Backend: Rust, Tokio, Axum, WebSockets, DashMap, Tracing
- Frontend: Vite, TypeScript, Yjs, CodeMirror 6, WebRTC DataChannels, IndexedDB
- Signaling: WebSocket endpoint at `/ws`

## Project Structure

```text
.
├── src/                 # Rust signaling server
│   ├── main.rs          # Server entry point
│   ├── server.rs        # Axum routes and middleware
│   ├── room/            # Room and peer registry
│   └── ws/              # WebSocket message handling
├── frontend/            # Vite TypeScript client
│   ├── src/
│   │   ├── main.ts      # App wiring and UI behavior
│   │   ├── signaling.ts # WebSocket signaling client
│   │   ├── webrtc.ts    # PeerConnection/DataChannel manager
│   │   ├── editor.ts    # Yjs + CodeMirror editor
│   │   ├── whiteboard.ts
│   │   ├── fileshare.ts
│   │   ├── history.ts
│   │   ├── storage.ts
│   │   └── export.ts
│   └── package.json
├── test.html            # Manual WebSocket signaling test page
├── Cargo.toml
└── Cargo.lock
```

## Prerequisites

- Rust toolchain with Cargo
- Node.js and npm
- A modern browser with WebRTC support
- For desktop builds: Tauri system prerequisites for your OS

## Run Locally

Start the Rust signaling server:

```bash
cargo run
```

The server listens on:

```text
http://localhost:8080
ws://localhost:8080/ws
```

In a second terminal, start the frontend dev server:

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

The Vite dev server proxies `/ws` to the Rust server on port `8080`.

## Run Desktop

Install frontend dependencies, then start the Tauri app:

```bash
cd frontend
npm install
npm run desktop:dev
```

The desktop app starts an embedded signaling server on `0.0.0.0:8080` and loads the Vite frontend in a Tauri WebView. If another device should join through a specific signaling host, enter a URL like this in the **Signaling server** field:

```text
ws://192.168.1.20:8080/ws
```

Build a desktop bundle with:

```bash
cd frontend
npm run desktop:build
```

## Usage

1. Enter a display name.
2. Enter a room name.
3. Click join.
4. Share the invite link with another user on the same reachable network.
5. Collaborate in the editor, whiteboard, chat, and file sharing tabs.

For local testing, open the app in two browser windows and join the same room.

## Build

Build the frontend:

```bash
cd frontend
npm run build
```

Build the Rust server:

```bash
cargo build --release
```

## Signaling Protocol

Clients connect to `/ws` and must send a `join` message first:

```json
{
  "type": "join",
  "room": "demo-room",
  "peer_id": "peer-1234"
}
```

The server returns existing peers and relays WebRTC offers, answers, and ICE candidates. Document sync, chat, presence, whiteboard updates, and file payloads are sent peer-to-peer after the DataChannels are established.

## Notes

- The backend currently provides signaling only; it does not store documents or files.
- Desktop mode embeds the same signaling server; file payloads still move peer-to-peer over WebRTC DataChannels.
- Local document state is stored in each browser using IndexedDB.
- The default CORS configuration is permissive for development and should be restricted before production deployment.
- WebRTC connectivity may require TURN servers for users behind restrictive NATs or firewalls.
