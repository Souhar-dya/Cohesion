"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type ChatEntry = { id: string; text: string; ts: number };
interface SignalMessage {
  type: "rtc-offer" | "rtc-answer" | "rtc-ice";
  from: string;
  to: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [peers, setPeers] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [activeTab, setActiveTab] = useState<"video" | "code">("video");
  const [runOut, setRunOut] = useState<string>("");
  const [runErr, setRunErr] = useState<string>("");
  const [runIn, setRunIn] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const codeRef = useRef(code);
  const [callActive, setCallActive] = useState(false);
  const pcMap = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    codeRef.current = code;
  }, [code]);
  const send = useCallback((o: unknown) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(o));
  }, []);
  const sendChat = () => {
    if (!input.trim()) return;
    send({ type: "chat", text: input });
    setInput("");
  };
  const codeDebounce = useRef<number | null>(null);
  const onChangeCode = (v: string) => {
    setCode(v);
    if (codeDebounce.current) clearTimeout(codeDebounce.current);
    codeDebounce.current = window.setTimeout(
      () => send({ type: "code", content: v }),
      250
    );
  };

  async function ensureLocalStream() {
    if (!localStreamRef.current) {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (localVideoRef.current)
        localVideoRef.current.srcObject = localStreamRef.current;
    }
    return localStreamRef.current;
  }
  const createPeerConnection = useCallback(
    (peerId: string, isInitiator: boolean) => {
      if (pcMap.current.has(peerId)) return pcMap.current.get(peerId)!;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcMap.current.set(peerId, pc);
      if (localStreamRef.current) {
        localStreamRef.current
          .getTracks()
          .forEach((t) => pc.addTrack(t, localStreamRef.current!));
      }
      pc.onicecandidate = (e) => {
        if (e.candidate)
          send({ type: "rtc-ice", to: peerId, candidate: e.candidate });
      };
      pc.ontrack = (e) => {
        if (remoteVideoRef.current && e.streams[0])
          remoteVideoRef.current.srcObject = e.streams[0];
      };
      if (isInitiator) {
        pc.createOffer()
          .then((o) => pc.setLocalDescription(o))
          .then(() =>
            send({ type: "rtc-offer", to: peerId, sdp: pc.localDescription })
          );
      }
      return pc;
    },
    [send]
  );
  const handleRTCSignal = useCallback(
    async (msg: SignalMessage) => {
      const { type, from } = msg;
      let pc = pcMap.current.get(from);
      if (!pc) {
        await ensureLocalStream();
        pc = createPeerConnection(from, false);
      }
      if (type === "rtc-offer" && msg.sdp) {
        await pc!.setRemoteDescription(msg.sdp);
        const answer = await pc!.createAnswer();
        await pc!.setLocalDescription(answer);
        send({ type: "rtc-answer", to: from, sdp: pc!.localDescription });
      } else if (type === "rtc-answer" && msg.sdp) {
        if (!pc!.currentRemoteDescription)
          await pc!.setRemoteDescription(msg.sdp);
      } else if (type === "rtc-ice" && msg.candidate) {
        try {
          await pc!.addIceCandidate(msg.candidate);
        } catch {}
      }
    },
    [createPeerConnection, send]
  );

  // Replace previous single-endpoint effect with resilient connector.
  useEffect(() => {
    let stopped = false;
    const endpoint = "/ws-node"; // simplified: single endpoint
    let attempt = 0;
    let retry: number | null = null;
    const connect = () => {
      if (stopped) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${location.host}${endpoint}?room=main`
      );
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        attempt = 0;
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(1000 * Math.pow(2, attempt++), 10000);
        retry = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {};
      ws.onmessage = async (ev) => {
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (data.type) {
          case "init":
            setSocketId(data.id);
            setPeers(data.peers);
            if (data.code) setCode(data.code);
            break;
          case "peer-join":
            setPeers((p) => (p.includes(data.id) ? p : [...p, data.id]));
            if (callActive && localStreamRef.current)
              createPeerConnection(data.id, true);
            break;
          case "peer-left":
            setPeers((p) => p.filter((x) => x !== data.id));
            const pc = pcMap.current.get(data.id);
            if (pc) {
              pc.close();
              pcMap.current.delete(data.id);
            }
            break;
          case "chat":
            setMessages((m) => [
              ...m.slice(-199),
              { id: data.id, text: data.text, ts: data.ts },
            ]);
            break;
          case "code":
            if (data.id !== socketId && data.content !== codeRef.current)
              setCode(data.content);
            break;
          case "rtc-offer":
          case "rtc-answer":
          case "rtc-ice":
            await handleRTCSignal(data as SignalMessage);
            break;
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callActive, createPeerConnection, handleRTCSignal]); 

  const startCall = async () => {
    if (callActive) return;
    await ensureLocalStream();
    setCallActive(true);
    peers.forEach((pid) => createPeerConnection(pid, true));
  };
  const stopCall = () => {
    setCallActive(false);
    pcMap.current.forEach((pc) => pc.close());
    pcMap.current.clear();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 20,
        maxWidth: 1400,
        margin: "0 auto",
        fontFamily: "system-ui,sans-serif",
        color: "#ddd",
        background: "transparent",
        minHeight: "100vh",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
          Cohesion Workspace
        </h1>
        <div style={{ fontSize: 12, color: connected ? "#4caf50" : "#f44336" }}>
          {connected ? "●" : "○"} {connected ? "Connected" : "Disconnected"} |
          You: {socketId.slice(0, 4) || "..."}
        </div>
      </div>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #333" }}>
        <button
          onClick={() => setActiveTab("video")}
          style={{
            background: "none",
            border: "none",
            padding: "8px 14px",
            cursor: "pointer",
            color: activeTab === "video" ? "#fff" : "#888",
            borderBottom:
              activeTab === "video"
                ? "2px solid #4da3ff"
                : "2px solid transparent",
          }}
        >
          Video
        </button>
        <button
          onClick={() => setActiveTab("code")}
          style={{
            background: "none",
            border: "none",
            padding: "8px 14px",
            cursor: "pointer",
            color: activeTab === "code" ? "#fff" : "#888",
            borderBottom:
              activeTab === "code"
                ? "2px solid #4da3ff"
                : "2px solid transparent",
          }}
        >
          Code
        </button>
      </div>
      {/* Main two-column layout: left = active tab panel, right = chat */}
      <div
        style={{
          display: "flex",
          flexGrow: 1,
          gap: 16,
          alignItems: "stretch",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: "1 1 0",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0,
          }}
        >
          {activeTab === "video" && (
            <section
              style={{
                border: "1px solid #444",
                borderRadius: 8,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                background: "#111",
                flexGrow: 1,
                minHeight: 0,
              }}
            >
              <h2 style={{ margin: "0 0 12px", fontSize: 18, color: "#fff" }}>
                Video Call
              </h2>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                }}
              >
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    flex: "1 1 280px",
                    minWidth: 260,
                    aspectRatio: "16/9",
                    background: "#000",
                    borderRadius: 6,
                  }}
                />
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  style={{
                    flex: "1 1 280px",
                    minWidth: 260,
                    aspectRatio: "16/9",
                    background: "#000",
                    borderRadius: 6,
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {!callActive && (
                  <button
                    onClick={startCall}
                    style={{
                      padding: "8px 14px",
                      background: "#333",
                      color: "#eee",
                      border: "1px solid #555",
                      borderRadius: 4,
                    }}
                  >
                    Start Call
                  </button>
                )}
                {callActive && (
                  <button
                    onClick={stopCall}
                    style={{
                      padding: "8px 14px",
                      background: "#552222",
                      color: "#eee",
                      border: "1px solid #833",
                      borderRadius: 4,
                    }}
                  >
                    End Call
                  </button>
                )}
                <span style={{ fontSize: 12, color: "#888" }}>
                  Peers:{" "}
                  {peers.length
                    ? peers.map((p) => p.slice(0, 4)).join(", ")
                    : "none"}
                </span>
              </div>
              <small style={{ marginTop: 8, color: "#666" }}>
                P2P mesh signaling via WebSocket. Public STUN only (no TURN).
              </small>
            </section>
          )}
          {activeTab === "code" && (
            <section
              style={{
                border: "1px solid #444",
                borderRadius: 8,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                background: "#111",
                flexGrow: 1,
                minHeight: 0,
              }}
            >
              <h2 style={{ margin: "0 0 12px", fontSize: 18, color: "#fff" }}>
                Collaborative Code
              </h2>
              <textarea
                value={code}
                onChange={(e) => onChangeCode(e.target.value)}
                placeholder="Type code here..."
                style={{
                  fontFamily: "monospace",
                  fontSize: 14,
                  flex: 1,
                  minHeight: 0,
                  padding: 10,
                  border: "1px solid #555",
                  borderRadius: 4,
                  resize: "none",
                  background: "#1a1a1a",
                  color: "#eee",
                  lineHeight: 1.35,
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  value={runIn}
                  onChange={(e) => setRunIn(e.target.value)}
                  placeholder="stdin (optional)"
                  style={{
                    flex: 1,
                    padding: 8,
                    border: "1px solid #555",
                    borderRadius: 4,
                    background: "#222",
                    color: "#eee",
                  }}
                />
                <button
                  disabled={running || !code.trim()}
                  onClick={async () => {
                    setRunning(true);
                    setRunOut("");
                    setRunErr("");
                    try {
                      const res = await fetch("/api/compile", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          language: "cpp",
                          code,
                          stdin: runIn,
                        }),
                      });
                      const data = await res.json();
                      if (data.ok) {
                        setRunOut(String(data.stdout || ""));
                        setRunErr(String(data.stderr || ""));
                      } else {
                        const details = data.details
                          ? `\n${String(data.details).slice(0, 400)}`
                          : "";
                        setRunErr(
                          String(data.error || "Execution failed") + details
                        );
                      }
                    } catch {
                      setRunErr("Network error");
                    } finally {
                      setRunning(false);
                    }
                  }}
                  style={{
                    padding: "8px 14px",
                    background: running ? "#444" : "#333",
                    color: "#eee",
                    border: "1px solid #555",
                    borderRadius: 4,
                    cursor: running ? "not-allowed" : "pointer",
                  }}
                >
                  {running ? "Running..." : "Run C++"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
                    stdout
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      background: "#0f0f0f",
                      color: "#bfe1bf",
                      border: "1px solid #444",
                      borderRadius: 4,
                      maxHeight: 160,
                      overflow: "auto",
                    }}
                  >
                    {runOut || ""}
                  </pre>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
                    stderr
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      background: "#0f0f0f",
                      color: "#e1bfbf",
                      border: "1px solid #444",
                      borderRadius: 4,
                      maxHeight: 160,
                      overflow: "auto",
                    }}
                  >
                    {runErr || ""}
                  </pre>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 8,
                }}
              >
                <small style={{ color: "#888" }}>
                  Last-writer-wins sync. Consider CRDT (Yjs) for production.
                </small>
                <small style={{ color: "#555" }}>Chars: {code.length}</small>
              </div>
            </section>
          )}
        </div>
        {/* Chat Panel */}
        <aside
          style={{
            width: 380,
            display: "flex",
            flexDirection: "column",
            border: "1px solid #444",
            borderRadius: 8,
            padding: 14,
            background: "#111",
          }}
        >
          <h2 style={{ margin: "0 0 10px", fontSize: 18, color: "#fff" }}>
            Chat
          </h2>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              background: "#1a1a1a",
              padding: 8,
              borderRadius: 4,
            }}
          >
            {messages.map((m) => (
              <div
                key={m.ts + m.id}
                style={{ marginBottom: 6, fontSize: 13, color: "#ccc" }}
              >
                <strong
                  style={{ color: m.id === socketId ? "#4da3ff" : "#fff" }}
                >
                  {m.id.slice(0, 4)}:
                </strong>{" "}
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              style={{
                flex: 1,
                padding: 8,
                border: "1px solid #555",
                borderRadius: 4,
                background: "#222",
                color: "#eee",
              }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChat();
              }}
              placeholder="Message..."
            />
            <button
              onClick={sendChat}
              style={{
                padding: "8px 14px",
                background: "#333",
                color: "#eee",
                border: "1px solid #555",
                borderRadius: 4,
              }}
            >
              Send
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
