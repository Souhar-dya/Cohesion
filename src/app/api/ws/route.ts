// Real-time WebSocket route (Edge runtime) powering chat, code sync & WebRTC signaling.
// Uses a minimal in-memory room store (NOT for production persistence).
// Kept in a single file to avoid project bloat.
export const runtime = "edge";

type RoomState = {
  clients: Map<string, WebSocket>; // clientId -> socket
  code: string; // latest shared code snapshot
};

interface InitMessage {
  type: "init";
  id: string;
  code: string;
  peers: string[];
}

interface ChatMessage {
  type: "chat";
  id: string; // sender id
  text: string;
  ts: number;
}

interface CodeMessage {
  type: "code";
  id: string; // sender id
  content: string;
  ts: number;
}

interface PeerJoinMessage {
  type: "peer-join";
  id: string;
}
interface PeerLeftMessage {
  type: "peer-left";
  id: string;
}

// WebRTC signaling messages (forwarded unchanged) forwarded opaquely; we don't need explicit interfaces here to keep file minimal.
// Removed unused RTCOfferAnswer / RTCIce interface declarations.

// Global (per-edge-isolate) state holder
// Use globalThis with index signature typing to avoid any
interface GlobalWsState {
  rooms: Map<string, RoomState>;
}
const g = globalThis as unknown as { __WS_STATE__?: GlobalWsState };
const globalState: GlobalWsState =
  g.__WS_STATE__ || (g.__WS_STATE__ = { rooms: new Map() });

export function GET(req: Request) {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 400 });
  }

  // @ts-expect-error WebSocketPair is available in Edge runtime
  const { 0: client, 1: server } = new WebSocketPair();
  const url = new URL(req.url);
  const roomName = url.searchParams.get("room") || "main";

  let room = globalState.rooms.get(roomName);
  if (!room) {
    room = { clients: new Map(), code: "" };
    globalState.rooms.set(roomName, room);
  }

  const id = crypto.randomUUID();

  server.accept();

  function broadcast(obj: unknown, excludeSelf = false) {
    const data = JSON.stringify(obj);
    for (const [cid, ws] of room!.clients.entries()) {
      if (excludeSelf && cid === id) continue;
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  // Register client before sending init so others know
  room.clients.set(id, server);
  // Notify others of new peer
  broadcast(<PeerJoinMessage>{ type: "peer-join", id }, true);

  // Send init payload to new client
  const init: InitMessage = {
    type: "init",
    id,
    code: room.code,
    peers: Array.from(room.clients.keys()).filter((pid) => pid !== id),
  };
  server.send(JSON.stringify(init));

  server.addEventListener("message", (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((event as MessageEvent & { data: string }).data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const p = parsed as Record<string, unknown>;
    switch (p.type) {
      case "chat": {
        const msg: ChatMessage = {
          type: "chat",
          id,
          text: String(p.text || ""),
          ts: Date.now(),
        };
        broadcast(msg);
        break;
      }
      case "code": {
        room!.code = String(p.content || "");
        const msg: CodeMessage = {
          type: "code",
          id,
          content: room!.code,
          ts: Date.now(),
        };
        broadcast(msg, true);
        break;
      }
      case "rtc-offer":
      case "rtc-answer":
      case "rtc-ice": {
        const target = p.to as string | undefined;
        if (!target) return;
        const ws = room!.clients.get(target);
        if (ws) {
          ws.send(JSON.stringify({ ...p, from: id }));
        }
        break;
      }
      case "ping": {
        server.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        break;
      }
      default:
        break;
    }
  });

  server.addEventListener("close", () => {
    room!.clients.delete(id);
    broadcast(<PeerLeftMessage>{ type: "peer-left", id });
    // Clean up empty room to save memory
    if (room!.clients.size === 0) {
      globalState.rooms.delete(roomName);
    }
  });

  // Lightweight keepalive (client can just send {type:'ping'})
  // Cast options to unknown then any to satisfy TS without broad any usage elsewhere
  return new Response(null, {
    status: 101,
    /* edge runtime upgrade */ webSocket: client,
  } as unknown as ResponseInit);
}
