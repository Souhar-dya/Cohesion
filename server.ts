// Lightweight Node WebSocket server (ws) ensuring local dev reliability.
// Combines Next.js request handling with a custom /ws-node WebSocket path.
import { createServer, IncomingMessage } from "http";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

interface RoomState {
  clients: Map<string, WebSocket>;
  code: string;
}
const rooms = new Map<string, RoomState>();

function getRoom(name: string): RoomState {
  let r = rooms.get(name);
  if (!r) {
    r = { clients: new Map(), code: "" };
    rooms.set(name, r);
  }
  return r;
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });
  const wss = new WebSocketServer({ server, path: "/ws-node" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const roomName = url.searchParams.get("room") || "main";
    const room = getRoom(roomName);
    const id = crypto.randomUUID();
    room.clients.set(id, ws);

    function broadcast(data: unknown, excludeSelf = false) {
      const str = JSON.stringify(data);
      for (const [cid, sock] of room.clients.entries()) {
        if (excludeSelf && cid === id) continue;
        if (sock.readyState === WebSocket.OPEN) sock.send(str);
      }
    }

    ws.send(
      JSON.stringify({
        type: "init",
        id,
        code: room.code,
        peers: [...room.clients.keys()].filter((x) => x !== id),
      })
    );
    broadcast({ type: "peer-join", id }, true);

    ws.on("message", (raw: WebSocket.RawData) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof data !== "object" || !data) return;
      const d = data as Record<string, unknown>;
      switch (d.type) {
        case "chat":
          broadcast({
            type: "chat",
            id,
            text: String(d.text || ""),
            ts: Date.now(),
          }); // include sender so they see their own message
          break;
        case "code":
          room.code = String(d.content || "");
          broadcast(
            { type: "code", id, content: room.code, ts: Date.now() },
            true
          );
          break;
        case "rtc-offer":
        case "rtc-answer":
        case "rtc-ice": {
          const targetId = d.to as string | undefined;
          if (!targetId) break;
          const target = room.clients.get(targetId);
          if (target && target.readyState === WebSocket.OPEN)
            target.send(JSON.stringify({ ...d, from: id }));
          break;
        }
        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          break;
      }
    });

    ws.on("close", () => {
      room.clients.delete(id);
      broadcast({ type: "peer-left", id });
      if (room.clients.size === 0) rooms.delete(roomName);
    });
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  server.listen(port, () =>
    console.log(`> Server ready on http://localhost:${port}`)
  );
});
