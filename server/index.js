import { WebSocketServer } from "ws";
import http from "http";

const PORT = process.env.PORT || 8787;

// ヘルスチェック用（Renderがサーバーの生存確認に使う）
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("minimo-missile matching server is running\n");
});

const wss = new WebSocketServer({ server });

// 合言葉(code) -> [ws, ws] （最大2人）
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function pruneRoom(room) {
  for (let i = room.length - 1; i >= 0; i--) {
    if (room[i].readyState !== room[i].OPEN) room.splice(i, 1);
  }
}

function leaveRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const idx = room.indexOf(ws);
  if (idx !== -1) room.splice(idx, 1);
  for (const peer of room) send(peer, { type: "peer-left" });
  if (room.length === 0) rooms.delete(ws.roomCode);
  ws.roomCode = null;
}

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;
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
      const code = String(msg.code || "").trim();
      if (!code) return;
      if (ws.roomCode) leaveRoom(ws);

      // ホストは常に「新しい待機」を開始する。古い（幽霊）部屋があれば上書きする
      rooms.set(code, [ws]);
      ws.roomCode = code;
      ws.playerIndex = 0;
      send(ws, { type: "hosting" });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").trim();
      if (!code) return;
      if (ws.roomCode) leaveRoom(ws);

      const room = rooms.get(code);
      if (room) pruneRoom(room);
      if (!room || room.length !== 1) {
        send(ws, { type: "join-failed" });
        return;
      }

      room.push(ws);
      ws.roomCode = code;
      ws.playerIndex = 1;
      room.forEach((peer, i) => send(peer, { type: "matched", you: i }));
      return;
    }

    if (msg.type === "leave") {
      leaveRoom(ws);
      return;
    }

    // join/leave以外のメッセージは、種類を問わず同じ部屋の相手にそのまま転送する
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      for (const peer of room) {
        if (peer !== ws) send(peer, msg);
      }
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
