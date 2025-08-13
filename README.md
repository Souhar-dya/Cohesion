## Cohesion – Minimal Real‑Time Next.js 

Features:

- WebSocket chat (room `main`)
- Collaborative (last-writer-wins) code editor
- Peer‑to‑peer WebRTC video call (signaling via same WebSocket)

Minimal file count, inline comments, only free STUN (Google) – no external paid APIs.

### Run

```bash
npm install
npm run dev
```

Open two browser windows: http://localhost:3000 to test collaboration.

### Key Files

- `server.ts` – Next + WebSocket server (`/ws-node` endpoint)
- `src/app/page.tsx` – Single-page UI & client logic (auto reconnect + endpoint fallback)

### Limitations

- In-memory volatile state (refresh clears)
- Naive whole-document code sync
- No TURN server (NAT may block media)
- No auth (all share one room)



Add auth, DB persistence (Postgres + Prisma), CRDT (Yjs), and TURN for reliability.

---

Enjoy! 🎯
