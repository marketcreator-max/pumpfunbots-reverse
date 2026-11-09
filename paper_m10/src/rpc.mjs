import WebSocket from "ws";
import { PUBLIC_ENDPOINTS } from "./constants.mjs";
import { redact } from "./redact.mjs";
import { backoffMs } from "./util.mjs";
import { SILENCE_MS } from "./watchdog.mjs";

export function resolveSolEndpoints(env = process.env) {
  if (env.RPC_URL) {
    const http = env.RPC_URL;
    const ws = env.WS_URL || http.replace(/^http/i, "ws");
    return { name: "env", http, ws };
  }
  if (env.HELIUS_API_KEY) {
    const key = env.HELIUS_API_KEY;
    return {
      name: "env:HELIUS_API_KEY",
      http: `https://mainnet.helius-rpc.com/?api-key=${key}`,
      ws: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
    };
  }
  return { name: "public-mainnet", ...PUBLIC_ENDPOINTS[0] };
}

export async function solRpc(url, method, params, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  if (body.error) throw new Error(redact(JSON.stringify(body.error)));
  return body.result;
}

export function subscribeSolLogs({ wsUrl, wsUrls, mentions, onLogs, onStatus, logger, createSocket }) {
  const urls = wsUrls?.length ? wsUrls : [wsUrl];
  let attempt = 0;
  let urlIndex = 0;
  let stopped = false;
  let timer = null;
  const sockets = new Set();
  let lastRx = Date.now();

  const beat = setInterval(() => {
    if (stopped) return;
    const sock = [...sockets].at(-1);
    if (!sock || sock.readyState !== 1) return;
    if (Date.now() - lastRx >= SILENCE_MS) {
      logger?.warn("sol feed silence 20s, forcing reconnect");
      try { sock.close(); } catch { /* already closing */ }
      return;
    }
    try { sock.ping(); } catch { /* socket is closing */ }
  }, 10_000);

  const open = () => {
    if (stopped) return;
    const url = urls[urlIndex % urls.length];
    let opened = false;
    let sawClose = false;
    const socket = createSocket ? createSocket(url) : new WebSocket(url);
    sockets.add(socket);
    socket.on("pong", () => { lastRx = Date.now(); });
    socket.addEventListener("open", () => {
      opened = true;
      lastRx = Date.now();
      attempt = 0;
      onStatus?.({ state: "open" });
      let id = 1;
      for (const mention of mentions) {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: id++,
          method: "logsSubscribe",
          params: [{ mentions: [mention] }, { commitment: "confirmed" }],
        }));
      }
    });
    socket.addEventListener("message", (event) => {
      lastRx = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.error) {
        logger?.warn(`sol logs error: ${redact(JSON.stringify(message.error))}`);
        return;
      }
      if (message.method === "logsNotification") onLogs(message.params);
    });
    socket.addEventListener("close", () => {
      if (sawClose) return;
      sawClose = true;
      onStatus?.({ state: "closed" });
      if (stopped) return;
      if (!opened) urlIndex++;
      const wait = backoffMs(attempt++);
      logger?.info(`sol feed reconnect in ${wait}ms`);
      timer = setTimeout(open, wait);
    });
    socket.addEventListener("error", () => {
      logger?.warn("sol feed socket error");
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      } catch { /* already closing */ }
    });
  };
  open();
  return {
    noteActivity() {
      lastRx = Date.now();
    },
    forceReconnect() {
      logger?.warn("sol feed forced reconnect");
      for (const sock of sockets) {
        try { sock.close(); } catch { /* ignore */ }
      }
    },
    stop() {
      stopped = true;
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      for (const sock of sockets) {
        try { sock.close(); } catch { /* ignore */ }
      }
      sockets.clear();
    },
  };
}
