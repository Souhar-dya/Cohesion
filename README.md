## Cohesion – Minimal Real‑Time Next.js

Features:

- WebSocket chat (room `main`)
- Collaborative (last-writer-wins) code editor
- Peer‑to‑peer WebRTC video call (signaling via same WebSocket)
- Run C++ snippets via a simple API wrapper over Piston (`POST /api/compile`)

Minimal file count, inline comments, only free STUN (Google) – no external paid APIs.

### Run

```bash
npm install
npm run dev
```
Open two browser windows: http://localhost:3000 to test collaboration.

To run C++:

- Switch to the Code tab, paste C++ code, optionally add stdin, and click "Run C++".
- Server calls Piston's execute API and returns stdout/stderr.

### Key Files

- `server.ts` – Next + WebSocket server (`/ws-node` endpoint)
- `src/app/page.tsx` – Single-page UI & client logic (auto reconnect + endpoint fallback)
- `src/app/api/compile/route.ts` – C++ execute endpoint using Piston

### Limitations

- In-memory volatile state (refresh clears)
- Naive whole-document code sync
- No TURN server (NAT may block media)
- No auth (all share one room)
- C++ runner is external (Piston); add auth/rate limits before exposing publicly

Add auth, DB persistence (Postgres + Prisma), CRDT (Yjs), and TURN for reliability.

---
