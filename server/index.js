import { WebSocketServer } from "ws";
import http from "http";

const PORT = process.env.PORT || 8787;

// ヘルスチェック用（Renderがサーバーの生存確認に使う）
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("minimo-missile matching server is running\n");
});

const wss = new WebSocketServer({ server });

// roomId(string) -> { host: ws, guest: ws|null, rules: "perks" | "none" }
const rooms = new Map();
let nextRoomId = 1;

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function destroyRoom(roomId, exceptWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const peer of [room.host, room.guest]) {
    if (peer && peer !== exceptWs) {
      send(peer, { type: "peer-left" });
      peer.roomId = null;
    }
  }
  rooms.delete(roomId);
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  destroyRoom(ws.roomId, ws);
  ws.roomId = null;
}

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 壊れたメッセージは無視
    }

    if (msg.type === "host") {
      if (ws.roomId) leaveRoom(ws);
      const rules = msg.rules === "perks" ? "perks" : "none";
      const id = String(nextRoomId++);
      rooms.set(id, { host: ws, guest: null, rules });
      ws.roomId = id;
      send(ws, { type: "hosting", roomId: id });
      return;
    }

    if (msg.type === "list-rooms") {
      const list = [];
      for (const [id, room] of rooms) {
        if (!room.guest && room.host.readyState === room.host.OPEN) {
          list.push({ id, rules: room.rules });
        }
      }
      send(ws, { type: "room-list", rooms: list });
      return;
    }

    if (msg.type === "join-room") {
      if (ws.roomId) leaveRoom(ws);
      const id = String(msg.roomId || "");
      const room = rooms.get(id);
      if (!room || room.guest || room.host.readyState !== room.host.OPEN) {
        send(ws, { type: "join-failed" });
        return;
      }
      room.guest = ws;
      ws.roomId = id;
      send(room.host, { type: "matched", you: 0, rules: room.rules });
      send(room.guest, { type: "matched", you: 1, rules: room.rules });
      return;
    }

    if (msg.type === "leave") {
      leaveRoom(ws);
      return;
    }

    // 上記以外は、同じ部屋の相手にそのまま転送する
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const peer = room.host === ws ? room.guest : room.host;
      if (peer) send(peer, msg);
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

// 死んだ接続を定期的に掃除（無料ホスティングでの放置対策）
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`minimo-missile server listening on ${PORT}`);
});
