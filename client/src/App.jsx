import { useRef, useEffect, useState } from "react";

const ACCENT = "#5fd4e0"; // アプリ全体で使う唯一のネオンアクセント
const SERVER_URL = "wss://minimo-missile-server-sg.onrender.com";

/* ============================================================
   効果音（外部音源を使わず、その場で合成する）
   ============================================================ */
let audioCtx = null;
function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function beep(freq, duration, type = "sine", gainStart = 0.12, freqEnd = null) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, ctx.currentTime + duration);
  gain.gain.setValueAtTime(gainStart, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function noiseBurst(duration, gainStart = 0.28, filterFreq = 700) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(filterFreq, ctx.currentTime);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainStart, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

let soundEnabled = true;
function setSoundEnabled(v) { soundEnabled = v; }

const sfx = {
  fire: () => { if (soundEnabled) beep(880, 0.08, "square", 0.07, 440); }, // 普通の弾
  snowFire: () => { if (soundEnabled) beep(1300, 0.12, "sine", 0.08, 1900); }, // 雪像の弾
  tpFire: () => { if (soundEnabled) beep(1100, 0.13, "sawtooth", 0.07, 260); }, // TP弾
  rocketFire: () => { if (soundEnabled) { noiseBurst(0.14, 0.16, 260); beep(140, 0.22, "sawtooth", 0.13, 70); } }, // 怪力弾
  heal: () => { if (soundEnabled) [520, 720, 940].forEach((f, i) => setTimeout(() => beep(f, 0.14, "sine", 0.09), i * 55)); }, // 加護の回復
  hit: () => { if (soundEnabled) beep(180, 0.16, "sawtooth", 0.13, 90); },
  hitEnemy: () => { if (soundEnabled) beep(260, 0.1, "sawtooth", 0.08, 130); },
  pickup: () => { if (soundEnabled) beep(660, 0.09, "sine", 0.09, 1000); },
  explosion: () => { if (soundEnabled) noiseBurst(0.35, 0.3, 700); }, // TNT
  calamityBoom: () => { if (soundEnabled) { noiseBurst(0.55, 0.34, 380); beep(85, 0.5, "sine", 0.16, 40); } }, // 厄災発生
  countdownBeep: () => { if (soundEnabled) beep(520, 0.1, "sine", 0.09); },
  countdownGo: () => { if (soundEnabled) beep(780, 0.22, "sine", 0.13, 1040); },
  win: () => { if (soundEnabled) [660, 880, 1100].forEach((f, i) => setTimeout(() => beep(f, 0.18, "sine", 0.12), i * 90)); },
  lose: () => { if (soundEnabled) [440, 330, 220].forEach((f, i) => setTimeout(() => beep(f, 0.22, "sawtooth", 0.09), i * 110)); },
  mark: () => { if (soundEnabled) beep(320, 0.14, "triangle", 0.1, 200); }, // 厄災の設置
  envoySummon: () => { if (soundEnabled) beep(700, 0.1, "triangle", 0.08, 1100); }, // 分身の派遣
  envoyFire: () => { if (soundEnabled) beep(760, 0.07, "square", 0.06, 380); }, // 分身の発射
  click: () => { if (soundEnabled) beep(500, 0.04, "square", 0.05); },
};

/**
 * 合言葉サーバー(ws)を「お見合い」だけに使い、実際のゲームデータは
 * できるだけ直接（WebRTC）でやり取りする。8秒以内に繋がらなければ
 * 中継(ws)にフォールバックする。
 * onReady(kind, transport) が一度だけ呼ばれる。kind は "p2p" | "relay"。
 */
function connectPeer(ws, isHost, onReady) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  let settled = false;

  const onSignal = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try {
      if (msg.type === "rtc-offer") {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "rtc-answer", sdp: pc.localDescription }));
      } else if (msg.type === "rtc-answer") {
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === "rtc-ice") {
        if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      console.log("[rtc] signal error", err);
    }
  };
  ws.addEventListener("message", onSignal);

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: "rtc-ice", candidate: e.candidate }));
  };
  pc.onconnectionstatechange = () => console.log("[rtc] connection state:", pc.connectionState);

  const fallbackTimer = setTimeout(() => {
    console.log("[rtc] p2p timed out, falling back to relay");
    finish("relay", ws);
  }, 8000);

  function finish(kind, transport) {
    if (settled) return;
    settled = true;
    clearTimeout(fallbackTimer);
    ws.removeEventListener("message", onSignal);
    if (kind === "relay") { try { pc.close(); } catch {} }
    onReady(kind, transport);
  }

  function wireChannel(channel) {
    channel.onopen = () => { console.log("[rtc] datachannel open"); finish("p2p", channel); };
    channel.onerror = (e) => console.log("[rtc] datachannel error", e);
  }

  if (isHost) {
    const channel = pc.createDataChannel("game");
    wireChannel(channel);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => ws.send(JSON.stringify({ type: "rtc-offer", sdp: pc.localDescription })))
      .catch((err) => console.log("[rtc] offer error", err));
  } else {
    pc.ondatachannel = (e) => wireChannel(e.channel);
  }
}

/* ============================================================
   ホーム画面
   ============================================================ */
function HomeScreen({ onStartBattle, onMatched, soundOn, setSoundOn, onOpenBtnPosition }) {
  // idle | host-rules | hosting | room-list | joining | join-failed
  const [phase, setPhase] = useState("idle");
  const [rooms, setRooms] = useState([]);
  const socketRef = useRef(null);
  const listTimerRef = useRef(null);

  const cleanupSocket = () => {
    if (listTimerRef.current) { clearInterval(listTimerRef.current); listTimerRef.current = null; }
    if (socketRef.current) {
      try { socketRef.current.close(); } catch {}
      socketRef.current = null;
    }
  };

  const startHosting = (rules) => {
    cleanupSocket();
    console.log("[home] hosting, rules =", rules);
    setPhase("hosting");
    const socket = new WebSocket(SERVER_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "host", rules }));
    };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "matched") {
        console.log("[home] matched as host, rules =", msg.rules);
        socketRef.current = null;
        onMatched(socket, true, msg.rules);
      }
    };
    socket.onerror = (e) => {
      console.log("[home] host socket error", e);
      setPhase("idle");
    };
  };

  const openRoomList = () => {
    cleanupSocket();
    console.log("[home] opening room list");
    setPhase("room-list");
    setRooms([]);
    const socket = new WebSocket(SERVER_URL);
    socketRef.current = socket;

    const requestList = () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "list-rooms" }));
    };

    socket.onopen = () => {
      requestList();
      listTimerRef.current = setInterval(requestList, 2000);
    };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "room-list") {
        setRooms(msg.rooms || []);
      } else if (msg.type === "matched") {
        console.log("[home] matched as guest, rules =", msg.rules);
        if (listTimerRef.current) { clearInterval(listTimerRef.current); listTimerRef.current = null; }
        socketRef.current = null;
        onMatched(socket, false, msg.rules);
      } else if (msg.type === "join-failed") {
        console.log("[home] join failed");
        setPhase("join-failed");
      }
    };
    socket.onerror = (e) => {
      console.log("[home] list socket error", e);
      setPhase("idle");
    };
  };

  const joinRoom = (roomId) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== socket.OPEN) return;
    if (listTimerRef.current) { clearInterval(listTimerRef.current); listTimerRef.current = null; }
    setPhase("joining");
    socket.send(JSON.stringify({ type: "join-room", roomId }));
  };

  const cancel = () => {
    cleanupSocket();
    setPhase("idle");
  };

  useEffect(() => cleanupSocket, []); // アンマウント時の後片付け

  return (
    <div
      className="fixed inset-0 flex items-center justify-center overflow-hidden px-5 py-6"
      style={{ background: "#0b0d11", fontFamily: "'Zen Kaku Gothic New', 'Noto Sans JP', sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&family=JetBrains+Mono:wght@500;700&display=swap');
        @keyframes ringSpin { to { transform: rotate(360deg); } }
        .neon-btn:active { transform: scale(0.98); }
        @media (prefers-reduced-motion: reduce) {
          .search-ring { animation: none !important; }
        }
      `}</style>

      <div className="flex max-h-full w-full max-w-sm flex-col">
        <div className="mb-8 shrink-0 text-center">
          <h1
            className="text-3xl font-bold sm:text-4xl"
            style={{ color: "#eef0f3", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
          >
            minimo-missile
          </h1>
        </div>

        <div data-scrollable className="min-h-0 flex-1 overflow-y-auto">
          {phase === "idle" && (
          <>
            <div className="mb-2 flex gap-2">
              <button
                onClick={() => setPhase("host-rules")}
                className="neon-btn flex-1 rounded-lg px-4 py-3.5 text-base font-bold transition-transform duration-100"
                style={{ background: ACCENT, color: "#0b0d11", boxShadow: "0 0 16px rgba(95,212,224,.25)" }}
              >
                ホストする
              </button>
              <button
                onClick={openRoomList}
                className="neon-btn flex-1 rounded-lg border px-4 py-3.5 text-base font-bold transition-transform duration-100"
                style={{ borderColor: "rgba(255,255,255,.2)", color: "#eef0f3", background: "#14171d" }}
              >
                参加する
              </button>
            </div>
            <button
              onClick={onStartBattle}
              className="mb-6 w-full text-center text-xs underline decoration-dotted"
              style={{ color: "#6b7178" }}
            >
              相手がいない？ BOTと対戦する
            </button>
          </>
        )}

        {phase === "host-rules" && (
          <div className="mb-6">
            <p className="mb-3 text-center text-xs" style={{ color: "#82878e" }}>この部屋のルールを選んでください</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => startHosting("none")}
                className="neon-btn rounded-lg border px-4 py-3 text-left transition-transform duration-100"
                style={{ background: "#14171d", borderColor: "rgba(255,255,255,.1)" }}
              >
                <div className="text-sm font-bold" style={{ color: "#eef0f3" }}>能力なし</div>
                <div className="mt-0.5 text-xs" style={{ color: "#82878e" }}>シンプルな対戦</div>
              </button>
              <button
                onClick={() => startHosting("perks")}
                className="neon-btn rounded-lg border px-4 py-3 text-left transition-transform duration-100"
                style={{ background: "#14171d", borderColor: "rgba(255,255,255,.1)" }}
              >
                <div className="text-sm font-bold" style={{ color: ACCENT }}>能力あり</div>
                <div className="mt-0.5 text-xs" style={{ color: "#82878e" }}>加護・雪鉄砲・TP弾・ロケットランチャーから選べる</div>
              </button>
            </div>
            <button onClick={cancel} className="mt-3 w-full text-center text-xs" style={{ color: "#6b7178" }}>
              戻る
            </button>
          </div>
        )}

        {phase === "hosting" && (
          <div className="mb-6">
            <button
              onClick={cancel}
              className="neon-btn mb-2 flex w-full items-center justify-center gap-3 rounded-lg border px-6 py-3.5 text-base font-bold transition-transform duration-100"
              style={{ borderColor: "rgba(255,255,255,.12)", color: "#c7cbd1", background: "#14171d" }}
            >
              <span
                className="search-ring inline-block h-4 w-4 rounded-full"
                style={{ border: "2px solid rgba(255,255,255,.15)", borderTopColor: ACCENT, animation: "ringSpin .8s linear infinite" }}
              />
              相手を待っています（タップでキャンセル）
            </button>
            <p className="text-center text-xs" style={{ color: "#6b7178" }}>
              相手が「参加する」から選んでくれるのを待っています
            </p>
          </div>
        )}

        {phase === "room-list" && (
          <div className="mb-6">
            <p className="mb-3 text-center text-xs" style={{ color: "#82878e" }}>参加できる部屋</p>
            {rooms.length === 0 && (
              <p className="mb-3 text-center text-xs" style={{ color: "#6b7178" }}>
                今、待機中の部屋はありません
              </p>
            )}
            <div className="flex flex-col gap-2">
              {rooms.map((r) => (
                <button
                  key={r.id}
                  onClick={() => joinRoom(r.id)}
                  className="neon-btn flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-transform duration-100"
                  style={{ background: "#14171d", borderColor: "rgba(255,255,255,.1)" }}
                >
                  <span className="text-sm font-bold" style={{ color: "#eef0f3" }}>部屋 #{r.id}</span>
                  <span className="text-xs" style={{ color: r.rules === "perks" ? ACCENT : "#82878e" }}>
                    {r.rules === "perks" ? "能力あり" : "能力なし"}
                  </span>
                </button>
              ))}
            </div>
            <button onClick={cancel} className="mt-3 w-full text-center text-xs" style={{ color: "#6b7178" }}>
              戻る
            </button>
          </div>
        )}

        {phase === "joining" && (
          <div className="mb-6">
            <button
              disabled
              className="neon-btn mb-2 flex w-full items-center justify-center gap-3 rounded-lg border px-6 py-3.5 text-base font-bold"
              style={{ borderColor: "rgba(255,255,255,.12)", color: "#c7cbd1", background: "#14171d" }}
            >
              <span
                className="search-ring inline-block h-4 w-4 rounded-full"
                style={{ border: "2px solid rgba(255,255,255,.15)", borderTopColor: ACCENT, animation: "ringSpin .8s linear infinite" }}
              />
              接続しています…
            </button>
          </div>
        )}

        {phase === "join-failed" && (
          <div className="mb-6">
            <p className="mb-3 text-center text-xs" style={{ color: "#ff9a8a" }}>
              その部屋にはもう入れませんでした（相手が先に埋まったか、いなくなったようです）
            </p>
            <button
              onClick={openRoomList}
              className="neon-btn w-full rounded-lg px-4 py-3 text-sm font-bold"
              style={{ background: ACCENT, color: "#0b0d11" }}
            >
              一覧に戻る
            </button>
          </div>
        )}
        </div>

        <div className="mt-6 w-full shrink-0">
          <div className="flex items-center justify-between rounded-lg px-4 py-3" style={{ background: "#14171d" }}>
            <span className="text-sm font-medium" style={{ color: "#c7cbd1" }}>サウンド</span>
            <button
              role="switch"
              aria-checked={soundOn}
              onClick={() => { setSoundOn((v) => { const nv = !v; setSoundEnabled(nv); if (nv) sfx.click(); return nv; }); }}
              className="relative h-6 w-11 rounded-full transition-colors duration-150"
              style={{ background: soundOn ? "rgba(95,212,224,.28)" : "rgba(255,255,255,.1)" }}
            >
              <span
                className="absolute top-1/2 h-4.5 w-4.5 -translate-y-1/2 rounded-full transition-all duration-150"
                style={{
                  left: soundOn ? "calc(100% - 1.375rem)" : "0.25rem",
                  background: soundOn ? ACCENT : "#8a8f96",
                }}
              />
            </button>
          </div>
          <button
            onClick={onOpenBtnPosition}
            className="mt-2 w-full text-center text-xs underline decoration-dotted"
            style={{ color: "#6b7178" }}
          >
            特殊ボタンの位置を設定
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   サブ能力
   ============================================================ */
const BASE_HP = 100;
const BLESSING_HP = 120;
const BLESSING_HEAL = 40;
const BLESSING_COMBO_NEEDED = 3;

const SNOW_SPEED_MULT = 1.5;
const SNOW_LIFE = 1.0;
const SNOW_FREEZE = 2.0;
const SNOW_CD = 2.0;

const TP_SPEED_MULT = 2.0;
const TP_LIFE = 1.6;
const TP_CD = 3.0;

const ROCKET_SIZE_MULT = 2.0;
const ROCKET_DMG = 32; // 通常ミサイル(16)の2倍
const ROCKET_LIFE = 2.5; // 3回当たるか2.5秒経つと消える
const TP_BONUS_DMG = 32; // 通常ミサイル(16)の2倍
const TP_BONUS_WINDOW = 2.0;
const SNOW_IMMUNE = 4.0;
const ROCKET_MAX_HITS = 3; // 1・2回目は無視して貫通、3回目で消える

const CALAMITY_CD = 4.0;
const CALAMITY_DELAY = 3.0; // 指定してから発動までの時間
const CALAMITY_DMG = 60;
const CALAMITY_HALF = 1.5; // 3x3マス分の半幅（マス単位。実際のpxはL.cell*これ）

const ENVOY_CD = 8.0;
const ENVOY_HP_COST = 16;
const ENVOY_HP = 10;
const ENVOY_DESPAWN = 0.5; // 発射してから消えるまで

const PERKS = [
  { id: "blessing", name: "カミサマノカゴ", desc: "体力120（通常の1.2倍）。ミサイルを3連続で命中させると40回復する。外すと連続記録はリセットされる。" },
  { id: "snow", name: "サッポロユキマツリ", desc: "特殊ボタンで発動（クールタイム2秒・弾速1.5倍）。命中させた相手を2秒間動けなくする。同じ相手には命中後4秒間、再度は効かない。" },
  { id: "tp", name: "ウシロノショウメン", desc: "特殊ボタンで発動（クールタイム3秒・弾速2倍）。命中地点まで自分がワープする。ワープ後2秒以内にミサイルを命中させると、通常の2倍のダメージを与えられる。" },
  { id: "rocket", name: "トッテオキノワザ", desc: "タップ発射時のみ発動。2倍サイズ・2倍ダメージの弾を放つ。障害物には3回当たるか2.5秒経つまで消えない（同じTNTには再ヒットしない）。" },
  { id: "calamity", name: "ヤクサイ", desc: "特殊ボタン長押しで発動（クールタイム4秒。タップには反応しない）。タイル3×3を指定し、3秒後にその範囲へ60ダメージ。本人は無傷で、アイテムへの影響もない。" },
  { id: "berserk", name: "カジバノバカヂカラ", desc: "受けたダメージの割合ぶんだけ、足の速さと弾のダメージが上昇し続ける。ボロボロになるほど強くなる。" },
  { id: "envoy", name: "ハジメテノオツカイ", desc: "特殊ボタンをタップした瞬間に発動（クールタイム8秒。狙いは不要）。体力を16消費し、自分そっくりの分身（体力10）を最寄りのミサイルへ向かわせる。分身はミサイルを取った瞬間に相手へ発射し、0.5秒後に消える。命中すれば与えた分の体力がそのまま戻ってくる（外すか道中で撃たれると消費した分は戻らない）。" },
];

const WEAPON_META = {
  snow: { icon: "❄", cdMax: SNOW_CD },
  tp: { icon: "⇝", cdMax: TP_CD },
  calamity: { icon: "☄", cdMax: CALAMITY_CD },
  envoy: { icon: "🏃", cdMax: ENVOY_CD },
};

/* ============================================================
   能力選択画面
   ============================================================ */
function PerkSelectScreen({ onSelect }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center overflow-hidden px-5 py-6"
      style={{ background: "#0b0d11", fontFamily: "'Zen Kaku Gothic New', 'Noto Sans JP', sans-serif" }}
    >
      <div className="w-full max-w-sm shrink-0 pt-4 text-center">
        <h2 className="mb-2 text-xl font-bold" style={{ color: "#eef0f3" }}>
          サブ能力を選択
        </h2>
        <p className="mb-6 text-xs" style={{ color: "#6b7178" }}>
          1つだけ選んで対戦に持ち込めます
        </p>
      </div>
      <div data-scrollable className="flex min-h-0 w-full max-w-sm flex-1 flex-col justify-center overflow-y-auto pb-4">
        <div className="flex flex-col gap-3">
          {PERKS.map((perk) => (
            <button
              key={perk.id}
              onClick={() => onSelect(perk.id)}
              className="rounded-lg border px-4 py-3 text-left transition-transform duration-100 active:scale-[0.98]"
              style={{ background: "#14171d", borderColor: "rgba(255,255,255,.1)" }}
            >
              <div className="text-base font-bold" style={{ color: ACCENT }}>{perk.name}</div>
              <div className="mt-1 text-xs leading-relaxed" style={{ color: "#9aa0a8" }}>{perk.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   オンライン対戦の能力選択（お互いの選択が揃うまで待つ）
   ============================================================ */
function OnlinePerkSelectScreen({ ws, onReady }) {
  const [myChoice, setMyChoice] = useState(null);
  const [peerChoice, setPeerChoice] = useState(null);

  useEffect(() => {
    const handler = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "my-perk") setPeerChoice(msg.perk);
    };
    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [ws]);

  useEffect(() => {
    if (myChoice && peerChoice) onReady(myChoice, peerChoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myChoice, peerChoice]);

  const select = (id) => {
    setMyChoice(id);
    ws.send(JSON.stringify({ type: "my-perk", perk: id }));
  };

  return (
    <div
      className="fixed inset-0 flex flex-col items-center overflow-hidden px-5 py-6"
      style={{ background: "#0b0d11", fontFamily: "'Zen Kaku Gothic New', 'Noto Sans JP', sans-serif" }}
    >
      <div className="w-full max-w-sm shrink-0 pt-4 text-center">
        <h2 className="mb-2 text-xl font-bold" style={{ color: "#eef0f3" }}>
          サブ能力を選択
        </h2>
        <p className="mb-6 text-xs" style={{ color: "#6b7178" }}>
          {myChoice ? "相手の選択を待っています…" : "1つだけ選んでください。両者が選び終わると対戦が始まります"}
        </p>
      </div>
      <div data-scrollable className="flex min-h-0 w-full max-w-sm flex-1 flex-col justify-center overflow-y-auto pb-4">
        <div className="flex flex-col gap-3">
          {PERKS.map((perk) => (
            <button
              key={perk.id}
              onClick={() => !myChoice && select(perk.id)}
              disabled={!!myChoice}
              className="rounded-lg border px-4 py-3 text-left transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
              style={{
                background: myChoice === perk.id ? "rgba(95,212,224,.12)" : "#14171d",
                borderColor: myChoice === perk.id ? ACCENT : "rgba(255,255,255,.1)",
              }}
            >
              <div className="text-base font-bold" style={{ color: ACCENT }}>{perk.name}</div>
              <div className="mt-1 text-xs leading-relaxed" style={{ color: "#9aa0a8" }}>{perk.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   対戦画面
   ============================================================ */
const WEAPON_BTN_POS_KEY = "minimo-missile:weaponBtnPos";
const DEFAULT_BTN_POS = { xFrac: 0.88, yFrac: 0.85 };
function loadWeaponBtnPos() {
  try {
    const raw = localStorage.getItem(WEAPON_BTN_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.xFrac === "number" && typeof p.yFrac === "number") return p;
    }
  } catch {}
  return { ...DEFAULT_BTN_POS };
}
function saveWeaponBtnPos(pos) {
  try { localStorage.setItem(WEAPON_BTN_POS_KEY, JSON.stringify(pos)); } catch {}
}

/* ============================================================
   特殊ボタンの位置設定画面
   ============================================================ */
function WeaponButtonPositionScreen({ onBack }) {
  const [pos, setPos] = useState(loadWeaponBtnPos);
  const areaRef = useRef(null);
  const dragging = useRef(false);

  const updateFromEvent = (e) => {
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    let xFrac = (e.clientX - rect.left) / rect.width;
    let yFrac = (e.clientY - rect.top) / rect.height;
    xFrac = clamp(xFrac, 0.08, 0.92);
    yFrac = clamp(yFrac, 0.08, 0.92);
    setPos({ xFrac, yFrac });
  };

  const onDown = (e) => { e.preventDefault(); dragging.current = true; updateFromEvent(e); e.target.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { if (dragging.current) updateFromEvent(e); };
  const onUp = () => { dragging.current = false; };

  const save = () => { saveWeaponBtnPos(pos); onBack(); };
  const reset = () => { setPos({ ...DEFAULT_BTN_POS }); saveWeaponBtnPos({ ...DEFAULT_BTN_POS }); };

  return (
    <div
      className="fixed inset-0 flex flex-col items-center overflow-hidden px-5 py-6"
      style={{ background: "#0b0d11", fontFamily: "'Zen Kaku Gothic New', 'Noto Sans JP', sans-serif" }}
    >
      <div className="w-full max-w-sm shrink-0 pt-4 text-center">
        <h2 className="mb-2 text-xl font-bold" style={{ color: "#eef0f3" }}>特殊ボタンの位置</h2>
        <p className="mb-4 text-xs" style={{ color: "#6b7178" }}>
          ドラッグして、対戦中に押しやすい位置に動かしてください
        </p>
      </div>

      <div
        ref={areaRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative w-full max-w-sm flex-1 rounded-xl border"
        style={{ borderColor: "rgba(255,255,255,.14)", background: "#14171d", touchAction: "none" }}
      >
        <div
          className="absolute flex items-center justify-center rounded-full select-none"
          style={{
            left: `${pos.xFrac * 100}%`, top: `${pos.yFrac * 100}%`,
            width: 64, height: 64, transform: "translate(-50%, -50%)",
            background: "rgba(20,23,29,.92)", border: `2px solid ${ACCENT}`,
            boxShadow: "0 0 14px rgba(95,212,224,.4)",
          }}
        >
          <span style={{ fontSize: 22, color: "#eef0f3" }}>❄</span>
        </div>
      </div>

      <div className="mt-4 flex w-full max-w-sm shrink-0 gap-2 pb-2">
        <button
          onClick={reset}
          className="flex-1 rounded-lg border px-4 py-3 text-sm font-bold"
          style={{ borderColor: "rgba(255,255,255,.2)", color: "#eef0f3", background: "#14171d" }}
        >
          初期位置に戻す
        </button>
        <button
          onClick={save}
          className="flex-1 rounded-lg px-4 py-3 text-sm font-bold"
          style={{ background: ACCENT, color: "#0b0d11" }}
        >
          保存して戻る
        </button>
      </div>
    </div>
  );
}

const C = {
  void: "#14161c",
  floor: "#262b33",
  floorAlt: "#2b313a",
  seam: "#191d24",
  wall: "#3c3428",
  wallEdge: "#d9a441",
  p1: "#ff5a4e",
  p2: "#35c8e8",
  tnt: "#e8412c",
  ammo: "#ffd23f",
  ink: "#0d0f13",
};

const COLS = 6, ROWS = 5;
const B_LIFE = 2.0;
const HIT_DMG = 16;
const EXP_MAX = 58;
const EXP_MIN = 17;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function BattleScreen({ perk, peerPerk = null, ws, isHost = true, onExit, onRematch }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gRef = useRef(null);
  const online = !!ws;
  const chanRef = useRef(null); // 実際にゲームデータを流すチャネル（P2Pか中継か）
  const [netStatus, setNetStatus] = useState("connecting"); // connecting | p2p | relay
  const netStatusRef = useRef("connecting"); // ループ内のログ表示用（stateはクロージャに古い値が残るため）
  const sendMsg = (obj) => {
    const ch = chanRef.current;
    if (!ch) return;
    try { ch.send(JSON.stringify(obj)); } catch (err) { console.log("[battle] send failed", err); }
  };
  const netInput = useRef({ moveDx: 0, moveDy: 0, aimDx: 0, aimDy: 0, aimActive: false });
  const netInputQueue = useRef([]); // ホスト用：ゲストから届いた入力を順番に積むキュー
  const audioPrev = useRef({ hp1: -1, hp2: -1, ammo1: 0, ammo2: 0, boomCount: 0, winner: undefined, envoyFiredCount: 0 });
  const lastAckSeq = useRef(0); // ホスト用：どこまで処理したか
  const inputSeq = useRef(0); // ゲスト用：自分の入力の通し番号
  const pendingInputs = useRef([]); // ゲスト用：まだホストに確認されていない入力の履歴
  const sendAccum = useRef(0);
  const netSendCount = useRef(0);
  const [disconnected, setDisconnected] = useState(false);
  const initialMaxHp = perk === "blessing" ? BLESSING_HP : BASE_HP;
  const [ui, setUi] = useState({
    hp1: initialMaxHp, hp2: BASE_HP, maxHp1: initialMaxHp, maxHp2: BASE_HP,
    ammo1: 0, ammo2: 0, winner: null, combo1: 0, weaponCd1: 0, snowImmune2: 0,
  });

  /* カウントダウン（試合開始前・再戦時にも再利用） */
  const phaseRef = useRef("countdown"); // countdown | playing
  const [phase, setPhaseState] = useState("countdown");
  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };
  const [count, setCount] = useState(3);
  const countdownIvRef = useRef(null);

  function beginCountdown() {
    if (countdownIvRef.current) clearInterval(countdownIvRef.current);
    let n = 3;
    setCount(3);
    setPhase("countdown");
    sfx.countdownBeep();
    countdownIvRef.current = setInterval(() => {
      n -= 1;
      if (n > 0) {
        setCount(n);
        sfx.countdownBeep();
      } else {
        clearInterval(countdownIvRef.current);
        countdownIvRef.current = null;
        setCount(0);
        sfx.countdownGo();
        setTimeout(() => setPhase("playing"), 550);
      }
    }, 800);
  }

  useEffect(() => {
    if (!online) beginCountdown(); // オフライン(Bot戦)は即座に開始
    // オンラインは接続(P2Pまたは中継)が確立してから開始する（下のconnectPeerのonReadyで呼ぶ）
    return () => { if (countdownIvRef.current) clearInterval(countdownIvRef.current); };
  }, []);

  /* オンライン対戦の再戦：両者が「はい」に投票したら、接続はそのままに試合だけリセットする。
     どちらかが「いいえ」か、10秒以内に投票しなければ、両者とも強制的にホームへ戻す。 */
  const [myVote, setMyVote] = useState(null); // null | true | false
  const [peerVote, setPeerVote] = useState(null);
  const [voteSeconds, setVoteSeconds] = useState(10);
  const voteTimerRef = useRef(null);
  const forcedHomeRef = useRef(false);

  function forceHome() {
    if (forcedHomeRef.current) return;
    forcedHomeRef.current = true;
    if (voteTimerRef.current) clearInterval(voteTimerRef.current);
    onExit();
  }

  function restartMatchInPlace() {
    console.log("[battle] restarting match in place");
    gRef.current = makeState();
    netInputQueue.current = [];
    lastAckSeq.current = 0;
    inputSeq.current = 0;
    pendingInputs.current = [];
    setMyVote(null);
    setPeerVote(null);
    const hostPerk = isHost ? perk : peerPerk;
    const guestPerk = isHost ? peerPerk : perk;
    const freshMaxHp = (isHost ? hostPerk : guestPerk) === "blessing" ? BLESSING_HP : BASE_HP;
    const peerMaxHp = (isHost ? guestPerk : hostPerk) === "blessing" ? BLESSING_HP : BASE_HP;
    setUi({
      hp1: freshMaxHp, hp2: peerMaxHp, maxHp1: freshMaxHp, maxHp2: peerMaxHp,
      ammo1: 0, ammo2: 0, winner: null, combo1: 0, weaponCd1: 0, snowImmune2: 0,
    });
    beginCountdown();
  }

  // 投票の10秒タイマー：勝敗が決まった瞬間に始まる
  useEffect(() => {
    if (!online || ui.winner === null) return;
    setVoteSeconds(10);
    voteTimerRef.current = setInterval(() => {
      setVoteSeconds((s) => {
        if (s <= 1) {
          clearInterval(voteTimerRef.current);
          voteTimerRef.current = null;
          // 時間切れ＝自分がまだ投票していなければ「いいえ」扱いにする
          setMyVote((cur) => {
            if (cur === null) { sendMsg({ type: "rematch-vote", vote: false }); return false; }
            return cur;
          });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (voteTimerRef.current) clearInterval(voteTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.winner, online]);

  useEffect(() => {
    if (myVote === true && peerVote === true) restartMatchInPlace();
    else if (myVote === false || peerVote === false) forceHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myVote, peerVote]);

  const voteYes = () => {
    setMyVote(true);
    sendMsg({ type: "rematch-vote", vote: true });
  };
  const voteNo = () => {
    setMyVote(false);
    sendMsg({ type: "rematch-vote", vote: false });
  };
  const requestRematch = online ? voteYes : onRematch; // オフラインBot戦は今まで通り即再戦

  // 通信が切れたら、少し見せてから強制的にホームへ戻す
  useEffect(() => {
    if (!disconnected) return;
    const t = setTimeout(() => forceHome(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnected]);

  /* 武器ボタン（雪鉄砲・TP弾専用） */
  const weaponBtnRef = useRef(null);
  const weaponDrag = useRef({ id: null, ox: 0, oy: 0, dx: 0, dy: 0 });
  const [knob, setKnob] = useState({ dx: 0, dy: 0 });
  const [weaponBtnPos] = useState(loadWeaponBtnPos);
  const [knobActive, setKnobActive] = useState(false);

  function weaponPointerDown(e) {
    e.preventDefault();
    const el = weaponBtnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    weaponDrag.current = { id: e.pointerId, ox: rect.left + rect.width / 2, oy: rect.top + rect.height / 2, dx: 0, dy: 0, moved: false };
    el.setPointerCapture?.(e.pointerId);
    setKnobActive(true);
    setKnob({ dx: 0, dy: 0 });
  }
  function weaponPointerMove(e) {
    const w = weaponDrag.current;
    if (w.id !== e.pointerId) return;
    const dx = e.clientX - w.ox, dy = e.clientY - w.oy;
    const rawLen = Math.hypot(dx, dy);
    if (rawLen > 12) w.moved = true;
    const m = 46;
    const l = rawLen || 1;
    const cl = Math.min(rawLen, m);
    const ndx = (dx / l) * (cl / m), ndy = (dy / l) * (cl / m);
    weaponDrag.current.dx = ndx;
    weaponDrag.current.dy = ndy;
    setKnob({ dx: ndx, dy: ndy });
  }
  function weaponPointerUp(e) {
    const w = weaponDrag.current;
    if (w.id !== e.pointerId) { setKnobActive(false); return; }
    setKnobActive(false);
    const dx = w.dx || 0, dy = w.dy || 0;
    const moved = w.moved;
    weaponDrag.current = { id: null, ox: 0, oy: 0, dx: 0, dy: 0, moved: false };
    setKnob({ dx: 0, dy: 0 });
    const s = gRef.current;
    if (!s || s.over !== null || phaseRef.current !== "playing") return;
    const p1 = s.players[0];
    if (p1.frozen > 0) return;

    const isCalamity = p1.perk === "calamity";
    const isEnvoy = p1.perk === "envoy";
    const dir = (!moved && !isCalamity) // 厄災はタップ（狙わない発動）を受け付けない
      ? { dx: Math.cos(p1.face), dy: Math.sin(p1.face) }
      : (moved && !isEnvoy && Math.hypot(dx, dy) > 0.2) // ハジメテノオツカイは狙い不要＝ドラッグを受け付けない
        ? { dx, dy }
        : null;
    if (!dir) return;
    if (p1.weaponCd > 0) return; // クールタイム中は何も起きない（音も鳴らさない）

    if (p1.perk === "snow") sfx.snowFire();
    else if (p1.perk === "tp") sfx.tpFire();
    else if (isCalamity) sfx.mark();
    else if (isEnvoy) sfx.envoySummon();

    if (online && !isHost) {
      sendMsg({ type: "weaponfire", dx: dir.dx, dy: dir.dy });
    } else if (isCalamity) {
      fireCalamity(s, p1, dir.dx, dir.dy);
    } else if (isEnvoy) {
      fireEnvoy(s, p1);
    } else {
      fireWeapon(s, p1, dir.dx, dir.dy);
    }
  }

  /* レイアウト（画面サイズに合わせて毎回計算） */
  const L = useRef({
    W: 1000, H: 600, cell: 100, s: 1,
    AR: { x: 0, y: 0, w: 600, h: 500 },
    PR: 19, CRATE: 62, EXPR: 118, BR: 7, SPEED: 215, BOT_SPEED: 198, BSPEED: 540,
  }).current;

  function layout() {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    L.W = cw; L.H = ch;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cell = Math.max(46, Math.min((cw - 56) / COLS, (ch - 80) / ROWS));
    L.cell = cell;
    L.s = cell / 100;
    L.AR = {
      x: Math.round((cw - cell * COLS) / 2),
      y: Math.round((ch - cell * ROWS) / 2),
      w: cell * COLS,
      h: cell * ROWS,
    };
    L.PR = 19 * L.s;
    L.CRATE = 62 * L.s;
    L.EXPR = 118 * L.s;
    L.BR = 9.5 * L.s;
    L.SPEED = 215 * L.s;
    L.BOT_SPEED = 198 * L.s;
    L.BSPEED = 540 * L.s;
    L.STICK_R = Math.max(48, 62 * L.s);
  }

  /* ---------- 状態 ---------- */
  function makeState() {
    // players[0]は常にホスト、players[1]は常にゲスト（自分がどちらかで能力を割り当てる）
    const hostPerk = isHost ? perk : peerPerk;
    const guestPerk = isHost ? peerPerk : perk;
    const p0Max = hostPerk === "blessing" ? BLESSING_HP : BASE_HP;
    const p1Max = guestPerk === "blessing" ? BLESSING_HP : BASE_HP;
    const s = {
      players: [
        { id: 0, x: L.AR.x + L.cell * 0.9, y: L.AR.y + L.AR.h - L.cell * 0.9, vx: 0, vy: 0, kx: 0, ky: 0,
          hp: p0Max, maxHp: p0Max, ammo: 0, color: C.p1, bot: false, flash: 0, face: -Math.PI / 4,
          perk: hostPerk || null, combo: 0, weaponCd: 0, frozen: 0, tpBonusT: 0, snowImmuneT: 0 },
        { id: 1, x: L.AR.x + L.AR.w - L.cell * 0.9, y: L.AR.y + L.cell * 0.9, vx: 0, vy: 0, kx: 0, ky: 0,
          hp: p1Max, maxHp: p1Max, ammo: 0, color: C.p2, bot: true, flash: 0, face: (Math.PI * 3) / 4,
          think: 0, wander: { x: 0, y: 0 }, aimHold: 0, perk: guestPerk || null, combo: 0, weaponCd: 0, frozen: 0, tpBonusT: 0, snowImmuneT: 0 },
      ],
      bullets: [], items: [], booms: [], shards: [], poofs: [], dmgPopups: [], hazards: [], clones: [],
      spawnT: 0, over: null, shake: 0, t: 0,
    };
    for (let i = 0; i < 3; i++) spawnItem(s, "tnt");
    for (let i = 0; i < 2; i++) spawnItem(s, "ammo");
    return s;
  }

  function spawnItem(s, type) {
    const pad = L.CRATE / 2 + 10 * L.s;
    const minItemDist = L.cell * 0.65;
    const minPlayerDist = L.cell * 1.1;
    let tries = 40;
    while (tries-- > 0) {
      const x = rnd(L.AR.x + pad, L.AR.x + L.AR.w - pad);
      const y = rnd(L.AR.y + pad, L.AR.y + L.AR.h - pad);
      if (s.items.some((it) => dist(it.x, it.y, x, y) < minItemDist)) continue;
      if (s.players.some((p) => dist(p.x, p.y, x, y) < minPlayerDist)) continue;
      s.items.push({ type, x, y, fuse: 0, born: s.t, kx: 0, ky: 0 });
      return;
    }
  }

  function spawnDmgPopup(s, x, y, text, color) {
    s.dmgPopups.push({
      x, y: y - L.PR * 1.2, t: 0, life: 0.9,
      vx: rnd(-24, 24) * L.s, vy: -78 * L.s,
      text, color,
    });
  }

  function damage(s, p, amt) {
    if (s.over !== null) return;
    p.hp = clamp(p.hp - amt, 0, p.maxHp);
    p.flash = 0.25;
    p.frozen = 0; // 被弾したら凍結が即解除される
    spawnDmgPopup(s, p.x, p.y, `-${Math.round(amt)}`, "#ff6a5c");
    if (p.hp <= 0) s.over = p.id === 0 ? 1 : 0;
  }

  function heal(s, p, amt) {
    p.hp = clamp(p.hp + amt, 0, p.maxHp);
    spawnDmgPopup(s, p.x, p.y, `+${Math.round(amt)}`, "#7cf03a");
  }

  /* 加護：ミサイルの当たり外れでコンボを管理 */
  function registerShotOutcome(s, ownerId, hitPlayer) {
    const p = s.players[ownerId];
    if (!p || p.perk !== "blessing") return;
    if (hitPlayer) {
      p.combo = (p.combo || 0) + 1;
      if (p.combo >= BLESSING_COMBO_NEEDED) {
        heal(s, p, BLESSING_HEAL);
        p.combo = 0;
      }
    } else {
      p.combo = 0;
    }
  }

  function explode(s, x, y) {
    s.booms.push({ x, y, t: 0, col: C.tnt });
    s.shake = Math.max(s.shake, 14 * L.s);
    for (let i = 0; i < 22; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(60, 340) * L.s;
      s.shards.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rnd(0.3, 0.7),
        c: Math.random() < 0.5 ? C.tnt : "#fff2a8" });
    }
    for (const p of s.players) {
      if (s.over !== null) break; // 決着後は爆発のノックバックも発生させない
      const d = dist(p.x, p.y, x, y);
      if (d < L.EXPR + L.PR) {
        const f = 1 - clamp(d / (L.EXPR + L.PR), 0, 1);
        damage(s, p, Math.max(EXP_MIN, EXP_MAX * f));
        const a = Math.atan2(p.y - y, p.x - x) || 0;
        p.kx += Math.cos(a) * 420 * L.s * f;
        p.ky += Math.sin(a) * 420 * L.s * f;
      }
    }
    for (const cl of s.clones) {
      if (dist(cl.x, cl.y, x, y) < L.EXPR) cl.hp = 0;
    }
    const chain = [];
    s.items = s.items.filter((it) => {
      if (dist(it.x, it.y, x, y) > L.EXPR) return true;
      if (it.type === "tnt") { chain.push(it); return false; }
      return false;
    });
    for (const it of chain) explode(s, it.x, it.y);
  }

  function fire(s, p, ax, ay, opts = {}) {
    if (!p.ammo) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    p.ammo = 0;
    p.face = Math.atan2(ay, ax);
    const isRocket = !!opts.viaTap && p.perk === "rocket";
    s.bullets.push({
      x: p.x + (ax / len) * (L.PR + L.BR + 2),
      y: p.y + (ay / len) * (L.PR + L.BR + 2),
      vx: (ax / len) * L.BSPEED,
      vy: (ay / len) * L.BSPEED,
      t: 0, owner: p.id, trail: [],
      kind: isRocket ? "rocket" : "normal",
      obstacleHits: 0,
    });
  }

  /* 雪鉄砲・TP弾：武器ボタン専用、ミサイル装弾とは無関係 */
  function fireWeapon(s, p, ax, ay) {
    if (p.perk !== "snow" && p.perk !== "tp") return;
    if (p.weaponCd > 0) return;
    const len = Math.hypot(ax, ay);
    if (len < 0.01) return;
    p.face = Math.atan2(ay, ax);
    const kind = p.perk;
    const speedMult = kind === "snow" ? SNOW_SPEED_MULT : TP_SPEED_MULT;
    p.weaponCd = kind === "snow" ? SNOW_CD : TP_CD;
    s.bullets.push({
      x: p.x + (ax / len) * (L.PR + L.BR + 2),
      y: p.y + (ay / len) * (L.PR + L.BR + 2),
      vx: (ax / len) * L.BSPEED * speedMult,
      vy: (ay / len) * L.BSPEED * speedMult,
      t: 0, owner: p.id, trail: [],
      kind, obstacleHits: 0,
    });
  }

  // 厄災：ドラッグした方向・距離をもとに、3x3マスが必ず収まる位置へスナップした的を返す
  function calamityTarget(p, dx, dy) {
    const MAX_RANGE = L.cell * 4.5;
    const tx = p.x + dx * MAX_RANGE;
    const ty = p.y + dy * MAX_RANGE;
    let cx = Math.round((tx - L.AR.x - L.cell / 2) / L.cell);
    let cy = Math.round((ty - L.AR.y - L.cell / 2) / L.cell);
    cx = clamp(cx, 1, COLS - 2);
    cy = clamp(cy, 1, ROWS - 2);
    return { x: L.AR.x + cx * L.cell + L.cell / 2, y: L.AR.y + cy * L.cell + L.cell / 2 };
  }

  function fireCalamity(s, p, dx, dy) {
    if (p.perk !== "calamity") return;
    if (p.weaponCd > 0) return;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;
    p.weaponCd = CALAMITY_CD;
    const t = calamityTarget(p, dx, dy);
    s.hazards.push({ x: t.x, y: t.y, t: 0, life: CALAMITY_DELAY, ownerId: p.id });
  }

  // ハジメテノオツカイ：最寄りのミサイルへ分身を送り出す
  function fireEnvoy(s, p) {
    if (p.perk !== "envoy") return;
    if (p.weaponCd > 0) return;
    if (p.hp <= ENVOY_HP_COST) return; // 自滅するほど体力が低ければ発動しない
    p.weaponCd = ENVOY_CD;
    p.hp = clamp(p.hp - ENVOY_HP_COST, 0, p.maxHp);
    spawnDmgPopup(s, p.x, p.y, `-${ENVOY_HP_COST}`, "#c98cff");
    s.clones.push({
      ownerId: p.id, id: p.id, x: p.x, y: p.y, hp: ENVOY_HP, maxHp: ENVOY_HP,
      fired: false, dyingT: -1, life: 0,
      face: p.face, color: p.color, flash: 0, frozen: 0, ammo: 0,
    });
  }

  /* ---------- オンライン対戦用の通信ヘルパー ---------- */
  function normPos(x, y) {
    return { nx: (x - L.AR.x) / L.AR.w, ny: (y - L.AR.y) / L.AR.h };
  }
  function denormPos(nx, ny) {
    return { x: L.AR.x + nx * L.AR.w, y: L.AR.y + ny * L.AR.h };
  }

  // ホスト側：自分の計算結果をゲストに送る用に、正規化座標のスナップショットを作る
  function serializeState(s) {
    const toN = (x, y) => normPos(x, y);
    return {
      t: s.t, over: s.over, shake: s.shake, ackSeq: lastAckSeq.current,
      players: s.players.map((p) => ({
        ...toN(p.x, p.y), hp: p.hp, maxHp: p.maxHp, ammo: p.ammo, face: p.face,
        flash: p.flash, frozen: p.frozen, perk: p.perk, combo: p.combo, weaponCd: p.weaponCd,
        snowImmuneT: p.snowImmuneT, tpBonusT: p.tpBonusT,
      })),
      bullets: s.bullets.map((b) => ({
        ...toN(b.x, b.y), owner: b.owner, kind: b.kind,
        trail: b.trail.map((t) => toN(t.x, t.y)),
      })),
      items: s.items.map((it) => ({ ...toN(it.x, it.y), type: it.type, fuse: it.fuse, born: it.born })),
      booms: s.booms.map((b) => ({ ...toN(b.x, b.y), t: b.t, col: b.col })),
      dmgPopups: s.dmgPopups.map((d) => ({
        ...toN(d.x, d.y), vx: d.vx / (L.AR.w || 1), vy: d.vy / (L.AR.h || 1),
        t: d.t, life: d.life, text: d.text, color: d.color,
      })),
      poofs: s.poofs.map((f) => ({ ...toN(f.x, f.y), t: f.t, life: f.life, size: f.size / (L.AR.w || 1), c: f.c })),
      hazards: s.hazards.map((h) => ({ ...toN(h.x, h.y), t: h.t, life: h.life, ownerId: h.ownerId })),
      clones: s.clones.map((cl) => ({ ...toN(cl.x, cl.y), ownerId: cl.ownerId, fired: cl.fired, face: cl.face })),
    };
  }

  // ゲスト側：ホストから届いたスナップショットを画面用の状態に反映する。
  // 自分(players[0])は「ホストが確認した位置＋まだ確認されていない入力の再計算」、
  // 相手(players[1])は今まで通り「届いた位置へ滑らかに近づける」目標値として扱う。
  function applySnapshot(payload) {
    const s = gRef.current;
    if (!s || !payload) return;
    s.t = payload.t;
    s.over = payload.over;
    s.shake = payload.shake || 0;

    // 相手：ホスト自身のデータ(payload.players[0])
    const peerRaw = payload.players[0];
    const peerPos = denormPos(peerRaw.nx, peerRaw.ny);
    const prevPeer = s.players[1] || {};
    const peerHasPos = prevPeer.x !== undefined;
    const peer = {
      ...prevPeer,
      id: 1,
      x: peerHasPos ? prevPeer.x : peerPos.x,
      y: peerHasPos ? prevPeer.y : peerPos.y,
      tx: peerPos.x, ty: peerPos.y,
      hp: peerRaw.hp, maxHp: peerRaw.maxHp, ammo: peerRaw.ammo, face: peerRaw.face,
      flash: peerRaw.flash, frozen: peerRaw.frozen, perk: peerRaw.perk, combo: peerRaw.combo,
      weaponCd: peerRaw.weaponCd, snowImmuneT: peerRaw.snowImmuneT, tpBonusT: peerRaw.tpBonusT,
      color: C.p2,
    };

    // 自分：ホストが計算した自分のデータ(payload.players[1])を基準に、
    // 確認済みの入力を捨てて、残り(まだホストが知らない分)だけ再計算する
    const selfRaw = payload.players[1];
    const confirmed = denormPos(selfRaw.nx, selfRaw.ny);
    const ackSeq = payload.ackSeq || 0;
    pendingInputs.current = pendingInputs.current.filter((inp) => inp.seq > ackSeq);
    const replay = { x: confirmed.x, y: confirmed.y, frozen: selfRaw.frozen };
    for (const inp of pendingInputs.current) {
      stepPlayerMove(replay, inp.mx, inp.my, inp.dt);
    }
    const prevSelf = s.players[0] || {};
    const self = {
      ...prevSelf,
      id: 0,
      x: replay.x, y: replay.y,
      face: prevSelf.face !== undefined ? prevSelf.face : selfRaw.face, // 向きはローカルの最新値を優先
      hp: selfRaw.hp, maxHp: selfRaw.maxHp, ammo: selfRaw.ammo,
      flash: selfRaw.flash, frozen: selfRaw.frozen, perk: selfRaw.perk, combo: selfRaw.combo,
      weaponCd: selfRaw.weaponCd, snowImmuneT: selfRaw.snowImmuneT, tpBonusT: selfRaw.tpBonusT,
      color: C.p1,
    };

    s.players = [self, peer];

    s.bullets = payload.bullets.map((b) => {
      const pos = denormPos(b.nx, b.ny);
      return {
        x: pos.x, y: pos.y, owner: b.owner === 0 ? 1 : 0, kind: b.kind,
        trail: (b.trail || []).map((t) => denormPos(t.nx, t.ny)),
        vx: 0, vy: 0, t: 0, obstacleHits: 0,
      };
    });

    s.items = payload.items.map((it) => {
      const pos = denormPos(it.nx, it.ny);
      return { type: it.type, x: pos.x, y: pos.y, fuse: it.fuse, born: it.born, kx: 0, ky: 0 };
    });

    s.booms = payload.booms.map((b) => {
      const pos = denormPos(b.nx, b.ny);
      return { x: pos.x, y: pos.y, t: b.t, col: b.col };
    });

    s.dmgPopups = payload.dmgPopups.map((d) => {
      const pos = denormPos(d.nx, d.ny);
      return {
        x: pos.x, y: pos.y,
        vx: (d.vx || 0) * L.AR.w, vy: (d.vy || 0) * L.AR.h,
        t: d.t, life: d.life, text: d.text, color: d.color,
      };
    });

    s.poofs = (payload.poofs || []).map((f) => {
      const pos = denormPos(f.nx, f.ny);
      return { x: pos.x, y: pos.y, vx: 0, vy: 0, t: f.t, life: f.life, size: (f.size || 0) * L.AR.w, c: f.c };
    });

    s.hazards = (payload.hazards || []).map((h) => {
      const pos = denormPos(h.nx, h.ny);
      return { x: pos.x, y: pos.y, t: h.t, life: h.life, ownerId: h.ownerId === 0 ? 1 : 0 };
    });

    s.clones = (payload.clones || []).map((cl) => {
      const pos = denormPos(cl.nx, cl.ny);
      const ownerId = cl.ownerId === 0 ? 1 : 0;
      return {
        x: pos.x, y: pos.y, ownerId, id: ownerId, fired: cl.fired, hp: 10, maxHp: 10,
        face: cl.face, color: ownerId === 0 ? C.p1 : C.p2, flash: 0, frozen: 0, ammo: 0,
      };
    });

    s.shards = [];
  }

  // ホスト・ゲスト共通で使う「入力1回分ぶんの移動」。同じ入力なら必ず同じ結果になる（予測の再現性のため）
  // カジバノバカヂカラ：失った体力の割合ぶんだけ速度・ダメージが上がる
  function berserkMult(p) {
    if (p.perk !== "berserk") return 1;
    return 1 + clamp((p.maxHp - p.hp) / p.maxHp, 0, 1);
  }

  function stepPlayerMove(p, mx, my, dt) {
    const ml = Math.hypot(mx, my);
    let nmx = mx, nmy = my;
    if (ml > 1) { nmx /= ml; nmy /= ml; }
    if (p.frozen <= 0) {
      const spd = L.SPEED * berserkMult(p);
      p.x += nmx * spd * dt;
      p.y += nmy * spd * dt;
      p.x = clamp(p.x, L.AR.x + L.PR, L.AR.x + L.AR.w - L.PR);
      p.y = clamp(p.y, L.AR.y + L.PR, L.AR.y + L.AR.h - L.PR);
    }
  }

  // ホスト側：ゲストから届いた入力を、順番通りに1つずつp2へ適用する（Botの代わり）
  function drainRemoteInput(p2) {
    const queue = netInputQueue.current;
    let processed = 0;
    while (queue.length && processed < 100) {
      const inp = queue.shift();
      stepPlayerMove(p2, inp.mx, inp.my, inp.dt);
      lastAckSeq.current = inp.seq;
      processed++;
    }
    p2.vx = 0; p2.vy = 0; // 移動はここで確定済み。共通ループ側の速度積分を二重にかけない
    const ni = netInput.current;
    const ml = Math.hypot(ni.moveDx, ni.moveDy);
    const al = Math.hypot(ni.aimDx, ni.aimDy);
    if (ni.aimActive && al > 0.2) p2.face = Math.atan2(ni.aimDy, ni.aimDx);
    else if (ml > 0.15) p2.face = Math.atan2(ni.moveDy, ni.moveDx);
  }

  function resolveTntPush(s, p) {
    const h = L.CRATE / 2;
    const rad = L.CRATE * 0.56;
    const pushSpeed = L.SPEED * 0.26;
    for (const it of s.items) {
      if (it.type !== "tnt") continue;
      const dx = it.x - p.x, dy = it.y - p.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      const minD = L.PR + rad;
      if (d >= minD) continue;
      const ux = dx / d, uy = dy / d;
      const ov = minD - d;
      it.kx = ux * pushSpeed;
      it.ky = uy * pushSpeed;
      it.x = clamp(it.x + ux * ov * 0.08, L.AR.x + h, L.AR.x + L.AR.w - h);
      it.y = clamp(it.y + uy * ov * 0.08, L.AR.y + h, L.AR.y + L.AR.h - h);
      p.x -= ux * ov * 0.92;
      p.y -= uy * ov * 0.92;
    }
  }

  function spawnPoof(s, x, y, colors, opts = {}) {
    const count = opts.count ?? 9;
    const speed = opts.speed ?? [50, 170];
    const life = opts.life ?? [0.16, 0.32];
    const size = opts.size ?? [3, 6];
    for (let i = 0; i < count; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(speed[0], speed[1]) * L.s;
      s.poofs.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0,
        life: rnd(life[0], life[1]),
        c: colors[(Math.random() * colors.length) | 0],
        size: rnd(size[0], size[1]) * L.s,
      });
    }
  }

  function spawnScale(s, born) {
    const d = 0.22;
    const age = s.t - born;
    if (age >= d) return 1;
    const t = Math.max(age, 0) / d;
    const c1 = 1.6, c3 = c1 + 1;
    const k = t - 1;
    return Math.max(0, 1 + c3 * k * k * k + c1 * k * k);
  }

  function resolveTntTnt(s) {
    const items = s.items.filter((it) => it.type === "tnt");
    const half = L.CRATE / 2;
    const rad = L.CRATE * 0.56;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const minD = rad * 2;
        if (d >= minD) continue;
        const ov = (minD - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * ov; a.y -= uy * ov;
        b.x += ux * ov; b.y += uy * ov;
        a.x = clamp(a.x, L.AR.x + half, L.AR.x + L.AR.w - half);
        a.y = clamp(a.y, L.AR.y + half, L.AR.y + L.AR.h - half);
        b.x = clamp(b.x, L.AR.x + half, L.AR.x + L.AR.w - half);
        b.y = clamp(b.y, L.AR.y + half, L.AR.y + L.AR.h - half);
      }
    }
  }

  function botThink(s, bot, foe, dt) {
    if (bot.frozen > 0) { bot.vx = 0; bot.vy = 0; return; }
    bot.think -= dt;
    bot.aimHold -= dt;
    let danger = null, dd = 1e9;
    for (const it of s.items) {
      if (it.type !== "nitro") continue;
      const d = dist(bot.x, bot.y, it.x, it.y);
      if (d < dd) { dd = d; danger = it; }
    }
    let tx = bot.x, ty = bot.y;
    if (!bot.ammo) {
      let best = null, bd = 1e9;
      for (const it of s.items) {
        if (it.type !== "ammo") continue;
        const d = dist(bot.x, bot.y, it.x, it.y);
        if (d < bd) { bd = d; best = it; }
      }
      if (best) { tx = best.x; ty = best.y; }
      else {
        if (bot.think <= 0) {
          bot.think = rnd(0.8, 1.6);
          bot.wander = { x: rnd(L.AR.x + L.PR * 3, L.AR.x + L.AR.w - L.PR * 3), y: rnd(L.AR.y + L.PR * 3, L.AR.y + L.AR.h - L.PR * 3) };
        }
        tx = bot.wander.x; ty = bot.wander.y;
      }
    } else {
      const a = Math.atan2(bot.y - foe.y, bot.x - foe.x);
      tx = foe.x + Math.cos(a) * L.cell * 2.3;
      ty = foe.y + Math.sin(a) * L.cell * 2.3;
    }
    let mx = tx - bot.x, my = ty - bot.y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    if (danger && dd < L.cell * 1.05) {
      mx += ((bot.x - danger.x) / (dd || 1)) * 1.9;
      my += ((bot.y - danger.y) / (dd || 1)) * 1.9;
      const l2 = Math.hypot(mx, my) || 1; mx /= l2; my /= l2;
    }
    if (ml < L.PR * 0.6) { mx = 0; my = 0; }
    bot.vx = mx * L.BOT_SPEED;
    bot.vy = my * L.BOT_SPEED;

    if (bot.ammo) {
      let aimx = foe.x, aimy = foe.y;
      for (const it of s.items) {
        if (it.type !== "nitro" && it.type !== "tnt") continue;
        if (dist(it.x, it.y, foe.x, foe.y) < L.cell * 0.95) { aimx = it.x; aimy = it.y; break; }
      }
      const ang = Math.atan2(aimy - bot.y, aimx - bot.x);
      bot.face = ang;
      if (bot.aimHold <= 0) {
        const d = dist(bot.x, bot.y, aimx, aimy);
        const err = rnd(-0.13, 0.13) + (d > L.cell * 3.8 ? rnd(-0.07, 0.07) : 0);
        const shot = ang + err;
        const selfRisk = s.items.some((it) => it.type === "nitro" &&
          dist(it.x, it.y, bot.x, bot.y) < L.cell * 1.3 &&
          Math.abs(Math.atan2(it.y - bot.y, it.x - bot.x) - shot) < 0.4);
        if (!selfRisk) { fire(s, bot, Math.cos(shot), Math.sin(shot)); bot.aimHold = rnd(0.35, 0.7); }
        else bot.aimHold = 0.3;
      }
    } else if (ml > L.PR) {
      bot.face = Math.atan2(my, mx);
    }
  }

  /* ---------- ループ ---------- */
  useEffect(() => {
    console.log("[battle] mount: online =", online, "isHost =", isHost, "ws readyState =", ws?.readyState);
    layout();
    gRef.current = makeState();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const ro = new ResizeObserver(() => {
      const before = L.AR;
      const oldCell = L.cell;
      layout();
      const s = gRef.current;
      if (s && oldCell) {
        const k = L.cell / oldCell;
        const remap = (o) => {
          o.x = L.AR.x + (o.x - before.x) * k;
          o.y = L.AR.y + (o.y - before.y) * k;
        };
        s.players.forEach(remap);
        s.items.forEach(remap);
        s.hazards.forEach(remap);
        s.clones.forEach(remap);
        s.bullets.forEach((b) => { remap(b); b.vx *= k; b.vy *= k; b.trail = []; });
      }
    });
    ro.observe(wrapRef.current);

    /* オンライン対戦：ホストは入力/発射イベントを受け取り、ゲストはスナップショットを受け取る */
    const handleGameMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      console.log("[battle] recv", msg.type, isHost ? "(as host)" : "(as guest)");
      const s = gRef.current;
      if (msg.type === "rematch-vote") { setPeerVote(msg.vote); return; }
      if (isHost) {
        const p2 = s.players[1];
        if (msg.type === "move") {
          netInputQueue.current.push({ seq: msg.seq, mx: msg.dx, my: msg.dy, dt: msg.dt });
          netInput.current.moveDx = msg.dx; netInput.current.moveDy = msg.dy; // 向き計算用
        }
        else if (msg.type === "aim") { netInput.current.aimDx = msg.dx; netInput.current.aimDy = msg.dy; netInput.current.aimActive = msg.active; }
        else if (msg.type === "fire") { fire(s, p2, msg.dx, msg.dy, { viaTap: msg.viaTap }); }
        else if (msg.type === "weaponfire") {
          if (p2.perk === "calamity") fireCalamity(s, p2, msg.dx, msg.dy);
          else if (p2.perk === "envoy") fireEnvoy(s, p2);
          else fireWeapon(s, p2, msg.dx, msg.dy);
        }
      } else {
        if (msg.type === "snapshot") applySnapshot(msg.payload);
      }
    };

    if (ws) {
      connectPeer(ws, isHost, (kind, transport) => {
        console.log("[battle] transport ready:", kind);
        setNetStatus(kind);
        netStatusRef.current = kind;
        transport.onmessage = handleGameMessage;
        chanRef.current = { send: (json) => transport.send(json) };
        if (kind === "p2p") {
          transport.onclose = () => { console.log("[battle] datachannel closed"); setDisconnected(true); };
        }
        beginCountdown(); // お互いの通信路が確立してからカウントダウンを開始する
      });
      ws.onclose = () => { console.log("[battle] ws closed"); setDisconnected(true); };
      ws.onerror = (e) => console.log("[battle] ws error", e);
      // P2P接続時はゲームメッセージがwsを通らなくなるため、相手退出の通知だけは別枠で監視する
      ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "peer-left") { console.log("[battle] peer-left"); setDisconnected(true); }
      });
    }

    /* タップ＝即発射／移動しながら第2の指で長押し＝照準 */
    const input = {
      move: { id: null, ox: 0, oy: 0, dx: 0, dy: 0 },
      aim: { id: null, ox: 0, oy: 0, dx: 0, dy: 0 },
    };
    const pending = new Map();
    const TAP_SLOP = 14;
    const keys = {};
    const toLogic = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (L.W / r.width), y: (e.clientY - r.top) * (L.H / r.height) };
    };

    const onDown = (e) => {
      e.preventDefault();
      const pt = toLogic(e);
      canvas.setPointerCapture?.(e.pointerId);
      pending.set(e.pointerId, { ox: pt.x, oy: pt.y, moved: false });
    };
    const onMove = (e) => {
      const rec = pending.get(e.pointerId);
      if (!rec) return;
      const pt = toLogic(e);
      const ddx = pt.x - rec.ox, ddy = pt.y - rec.oy;
      const dlen = Math.hypot(ddx, ddy);

      if (!rec.moved && dlen > TAP_SLOP) {
        rec.moved = true;
        if (input.move.id === null) {
          input.move.id = e.pointerId; input.move.ox = rec.ox; input.move.oy = rec.oy;
        } else if (input.aim.id === null) {
          input.aim.id = e.pointerId; input.aim.ox = rec.ox; input.aim.oy = rec.oy;
        }
      }
      for (const side of [input.move, input.aim]) {
        if (e.pointerId !== side.id) continue;
        let dx = pt.x - side.ox, dy = pt.y - side.oy;
        const l = Math.hypot(dx, dy), m = L.STICK_R;
        if (l > m) { dx = (dx / l) * m; dy = (dy / l) * m; }
        side.dx = dx / m; side.dy = dy / m;
      }
    };
    const onUp = (e) => {
      const s = gRef.current;
      const rec = pending.get(e.pointerId);
      pending.delete(e.pointerId);
      const p1 = s.players[0];
      const canAct = s.over === null && phaseRef.current === "playing" && p1.frozen <= 0;

      const triggerFire = (dx, dy, viaTap) => {
        if (!p1.ammo) return; // 弾切れなら何も起きない（音も鳴らさない）
        sfx[viaTap && p1.perk === "rocket" ? "rocketFire" : "fire"]();
        if (online && !isHost) sendMsg({ type: "fire", dx, dy, viaTap });
        else fire(s, p1, dx, dy, { viaTap });
      };

      if (e.pointerId === input.move.id) {
        input.move.id = null; input.move.dx = 0; input.move.dy = 0;
      } else if (e.pointerId === input.aim.id) {
        if (canAct && Math.hypot(input.aim.dx, input.aim.dy) > 0.15) {
          triggerFire(input.aim.dx, input.aim.dy, false);
        }
        input.aim.id = null; input.aim.dx = 0; input.aim.dy = 0;
      } else if (rec && !rec.moved && canAct) {
        triggerFire(Math.cos(p1.face), Math.sin(p1.face), true);
      }
    };
    const onCancel = (e) => {
      pending.delete(e.pointerId);
      if (e.pointerId === input.move.id) { input.move.id = null; input.move.dx = 0; input.move.dy = 0; }
      if (e.pointerId === input.aim.id) { input.aim.id = null; input.aim.dx = 0; input.aim.dy = 0; }
    };

    canvas.addEventListener("pointerdown", onDown, { passive: false });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    const kd = (e) => { keys[e.key.toLowerCase()] = true; };
    const ku = (e) => { keys[e.key.toLowerCase()] = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    let raf, last = performance.now();
    const step = (now) => {
      const s = gRef.current;
      let dt = Math.min((now - last) / 1000, 0.033);
      last = now;
      s.t += dt;
      const p1 = s.players[0], p2 = s.players[1];

      if (s.over === null && phaseRef.current === "playing" && (!online || isHost)) {
        for (const p of s.players) {
          if (p.weaponCd > 0) p.weaponCd = Math.max(0, p.weaponCd - dt);
          if (p.frozen > 0) p.frozen = Math.max(0, p.frozen - dt);
          if (p.tpBonusT > 0) p.tpBonusT = Math.max(0, p.tpBonusT - dt);
          if (p.snowImmuneT > 0) p.snowImmuneT = Math.max(0, p.snowImmuneT - dt);
        }

        let mx = input.move.dx, my = input.move.dy;
        if (keys["w"] || keys["arrowup"]) my -= 1;
        if (keys["s"] || keys["arrowdown"]) my += 1;
        if (keys["a"] || keys["arrowleft"]) mx -= 1;
        if (keys["d"] || keys["arrowright"]) mx += 1;
        const ml = Math.hypot(mx, my);
        if (ml > 1) { mx /= ml; my /= ml; }
        p1.vx = mx * L.SPEED * berserkMult(p1);
        p1.vy = my * L.SPEED * berserkMult(p1);

        const al = Math.hypot(input.aim.dx, input.aim.dy);
        if (al > 0.2) p1.face = Math.atan2(input.aim.dy, input.aim.dx);
        else if (ml > 0.15) p1.face = Math.atan2(my, mx);

        if (online) drainRemoteInput(p2);
        else botThink(s, p2, p1, dt);

        for (const p of s.players) {
          if (p.frozen > 0) { p.vx = 0; p.vy = 0; }
          p.kx *= Math.pow(0.0016, dt);
          p.ky *= Math.pow(0.0016, dt);
          p.x += (p.vx + p.kx) * dt;
          p.y += (p.vy + p.ky) * dt;
          p.x = clamp(p.x, L.AR.x + L.PR, L.AR.x + L.AR.w - L.PR);
          p.y = clamp(p.y, L.AR.y + L.PR, L.AR.y + L.AR.h - L.PR);
          resolveTntPush(s, p);
          p.x = clamp(p.x, L.AR.x + L.PR, L.AR.x + L.AR.w - L.PR);
          p.y = clamp(p.y, L.AR.y + L.PR, L.AR.y + L.AR.h - L.PR);
          if (p.flash > 0) p.flash -= dt;
        }

        {
          const h = L.CRATE / 2;
          for (const it of s.items) {
            if (it.type !== "tnt") continue;
            if (!it.kx && !it.ky) continue;
            it.kx *= Math.pow(0.12, dt);
            it.ky *= Math.pow(0.12, dt);
            it.x = clamp(it.x + it.kx * dt, L.AR.x + h, L.AR.x + L.AR.w - h);
            it.y = clamp(it.y + it.ky * dt, L.AR.y + h, L.AR.y + L.AR.h - h);
            if (Math.hypot(it.kx, it.ky) < 2) { it.kx = 0; it.ky = 0; }
          }
        }
        resolveTntTnt(s);

        const dpp = dist(p1.x, p1.y, p2.x, p2.y);
        if (dpp < L.PR * 2 && dpp > 0) {
          const ov = (L.PR * 2 - dpp) / 2;
          const ux = (p1.x - p2.x) / dpp, uy = (p1.y - p2.y) / dpp;
          p1.x += ux * ov; p1.y += uy * ov;
          p2.x -= ux * ov; p2.y -= uy * ov;
        }

        const toExplode = [];
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i];
          let removed = false;
          if (it.type === "ammo") {
            for (const p of s.players) {
              if (!p.ammo && dist(p.x, p.y, it.x, it.y) < L.PR + 20 * L.s) {
                p.ammo = 1; s.items.splice(i, 1); removed = true;
                spawnPoof(s, it.x, it.y, [C.ammo, "#fff1b0"], { count: 7, speed: [40, 130], life: [0.15, 0.28], size: [2, 4] });
                break;
              }
            }
            if (!removed && s.t - it.born > 6) {
              s.items.splice(i, 1);
              spawnPoof(s, it.x, it.y, [C.ammo, "#fff1b0"], { count: 6, speed: [20, 70], life: [0.2, 0.36], size: [2, 4] });
            }
          } else if (it.type === "tnt") {
            if (it.fuse > 0) {
              it.fuse -= dt;
              if (it.fuse <= 0) { s.items.splice(i, 1); toExplode.push({ x: it.x, y: it.y }); }
            } else if (s.t - it.born > 8) {
              s.items.splice(i, 1);
              spawnPoof(s, it.x, it.y, [C.tnt, "#ffd7b0"], { count: 6, speed: [20, 70], life: [0.2, 0.36], size: [2, 4] });
            }
          }
        }
        // 爆発はここ（アイテム一覧の走査が終わったあと）でまとめて起こす。
        // ループの途中でexplode()を呼ぶと、連鎖爆発でs.itemsの中身が
        // 想定より大きく減り、存在しない要素を読みに行ってフリーズしていた。
        for (const e of toExplode) explode(s, e.x, e.y);

        for (let i = s.bullets.length - 1; i >= 0; i--) {
          if (s.over !== null) break; // 同じフレーム内で決着がついたら、以降の弾は一切処理しない（勝った後の凍結事故防止）
          const b = s.bullets[i];
          b.t += dt;
          const lifeLimit = b.kind === "snow" ? SNOW_LIFE : b.kind === "tp" ? TP_LIFE : b.kind === "rocket" ? ROCKET_LIFE : B_LIFE;
          if (b.t > lifeLimit) {
            if (b.kind === "normal" || b.kind === "rocket") registerShotOutcome(s, b.owner, false);
            spawnPoof(s, b.x, b.y, b.owner === 0 ? ["#ff8a72", "#ffdcd2"] : ["#72c9ff", "#d2ecff"],
              { count: 5, speed: [30, 90], life: [0.14, 0.24], size: [2, 3] });
            s.bullets.splice(i, 1); continue;
          }
          b.trail.push({ x: b.x, y: b.y });
          if (b.trail.length > 9) b.trail.shift();

          let dead = false;
          for (let k = 0; k < 3 && !dead; k++) {
            b.x += (b.vx * dt) / 3;
            b.y += (b.vy * dt) / 3;

            if (b.kind === "tp") {
              const hitWall = b.x < L.AR.x + L.BR || b.x > L.AR.x + L.AR.w - L.BR ||
                b.y < L.AR.y + L.BR || b.y > L.AR.y + L.AR.h - L.BR;
              let landing = null;
              if (hitWall) {
                landing = { x: b.x, y: b.y };
              } else {
                for (const it of s.items) {
                  if (it.type !== "ammo" && it.type !== "tnt") continue;
                  const h2 = L.CRATE / 2 + L.BR;
                  if (Math.abs(b.x - it.x) < h2 && Math.abs(b.y - it.y) < h2) { landing = { x: it.x, y: it.y }; break; }
                }
                if (!landing) {
                  for (const p of s.players) {
                    if (p.id === b.owner) continue;
                    if (dist(b.x, b.y, p.x, p.y) < L.PR + L.BR) { landing = { x: p.x, y: p.y }; break; }
                  }
                }
              }
              if (landing) {
                const owner = s.players[b.owner];
                owner.x = clamp(landing.x, L.AR.x + L.PR, L.AR.x + L.AR.w - L.PR);
                owner.y = clamp(landing.y, L.AR.y + L.PR, L.AR.y + L.AR.h - L.PR);
                owner.tpBonusT = TP_BONUS_WINDOW;
                spawnPoof(s, owner.x, owner.y, owner.id === 0 ? ["#ff8a72", "#ffdcd2"] : ["#72c9ff", "#d2ecff"],
                  { count: 10, speed: [40, 140], life: [0.2, 0.36], size: [3, 5] });
                dead = true;
              }
              continue;
            }

            if (b.x < L.AR.x + L.BR) { b.x = L.AR.x + L.BR; b.vx *= -1; }
            if (b.x > L.AR.x + L.AR.w - L.BR) { b.x = L.AR.x + L.AR.w - L.BR; b.vx *= -1; }
            if (b.y < L.AR.y + L.BR) { b.y = L.AR.y + L.BR; b.vy *= -1; }
            if (b.y > L.AR.y + L.AR.h - L.BR) { b.y = L.AR.y + L.AR.h - L.BR; b.vy *= -1; }

            if (b.kind !== "snow") {
              for (let j = s.items.length - 1; j >= 0; j--) {
                const it = s.items[j];
                const h2 = L.CRATE / 2 + L.BR;
                const alreadyArmed = it.type === "tnt" && it.fuse > 0; // 起爆準備中は素通り（再ヒットしない）
                const hit = !alreadyArmed && Math.abs(b.x - it.x) < h2 && Math.abs(b.y - it.y) < h2;
                if (!hit) continue;
                if (it.type === "ammo") {
                  s.items.splice(j, 1);
                  spawnPoof(s, it.x, it.y, [C.ammo, "#fff1b0"], { count: 8, speed: [50, 160], life: [0.16, 0.3], size: [2, 5] });
                  if (b.kind !== "rocket" || ++b.obstacleHits >= ROCKET_MAX_HITS) dead = true;
                } else if (it.type === "tnt") {
                  if (it.fuse <= 0) it.fuse = 1.0;
                  const bl = Math.hypot(b.vx, b.vy) || 1;
                  it.kx = (b.vx / bl) * 720 * L.s;
                  it.ky = (b.vy / bl) * 720 * L.s;
                  if (b.kind !== "rocket" || ++b.obstacleHits >= ROCKET_MAX_HITS) dead = true;
                }
                break;
              }
            }
            if (dead) {
              if (b.kind === "normal" || b.kind === "rocket") registerShotOutcome(s, b.owner, false);
              break;
            }

            for (const p of s.players) {
              if (p.id === b.owner && b.t < 0.08) continue; // 発射直後のごく短い猶予（自分の位置ズレ対策）
              if (dist(b.x, b.y, p.x, p.y) < L.PR + L.BR) {
                if (b.kind === "snow") {
                  if (p.id !== b.owner) {
                    if (p.snowImmuneT <= 0) {
                      p.frozen = SNOW_FREEZE;
                      p.snowImmuneT = SNOW_IMMUNE;
                      spawnPoof(s, b.x, b.y, ["#eaffff", "#bfe9ff"], { count: 10, speed: [40, 130], life: [0.2, 0.36], size: [3, 5] });
                    }
                  }
                } else {
                  const owner = s.players[b.owner];
                  let dmg = b.kind === "rocket" ? ROCKET_DMG : HIT_DMG;
                  if (b.kind === "normal" && owner.tpBonusT > 0) {
                    dmg = TP_BONUS_DMG;
                    owner.tpBonusT = 0;
                  }
                  dmg = Math.round(dmg * berserkMult(owner));
                  damage(s, p, dmg);
                  if (b.fromClone && p.id !== owner.id) heal(s, owner, dmg); // 分身が当てた分は召喚者に戻ってくる（ノーリスク化）
                  p.ammo = 0;
                  const l = Math.hypot(b.vx, b.vy) || 1;
                  const kb = 200 * L.s * (b.kind === "rocket" ? 3 : 1);
                  p.kx += (b.vx / l) * kb;
                  p.ky += (b.vy / l) * kb;
                  s.shake = Math.max(s.shake, 5 * L.s);
                  spawnPoof(s, b.x, b.y, b.owner === 0 ? ["#ff8a72", "#ffdcd2"] : ["#72c9ff", "#d2ecff"],
                    { count: 8, speed: [60, 190], life: [0.14, 0.26], size: [2, 4] });
                  registerShotOutcome(s, b.owner, true);
                }
                dead = true;
                break;
              }
            }

            if (!dead) {
              for (const cl of s.clones) {
                if (b.kind === "snow") continue; // 雪像は分身には効かない（凍結対象ではないため）
                if (dist(b.x, b.y, cl.x, cl.y) < L.PR * 0.82 + L.BR) {
                  cl.hp = 0; // 分身はHPが低いのでほぼ一撃で消える
                  dead = true;
                  break;
                }
              }
            }
          }
          if (dead) s.bullets.splice(i, 1);
        }

        s.spawnT -= dt;
        if (s.spawnT <= 0) {
          s.spawnT = rnd(0.8, 1.4);
          const n = (t) => s.items.filter((x) => x.type === t).length;
          const ammoTarget = Math.min(2 + Math.floor(s.t / 10), 6);
          const need = [];
          if (n("ammo") < ammoTarget) need.push("ammo");
          if (n("tnt") < 3) need.push("tnt");
          if (need.length) spawnItem(s, need[(Math.random() * need.length) | 0]);
        }

        for (let i = s.hazards.length - 1; i >= 0; i--) {
          const hz = s.hazards[i];
          hz.t += dt;
          if (hz.t < hz.life) continue;
          const half = L.cell * CALAMITY_HALF;
          for (const p of s.players) {
            if (p.id === hz.ownerId) continue;
            if (Math.abs(p.x - hz.x) < half && Math.abs(p.y - hz.y) < half) {
              damage(s, p, CALAMITY_DMG);
            }
          }
          for (const cl of s.clones) {
            if (cl.ownerId === hz.ownerId) continue;
            if (Math.abs(cl.x - hz.x) < half && Math.abs(cl.y - hz.y) < half) cl.hp = 0;
          }
          s.booms.push({ x: hz.x, y: hz.y, t: 0, col: C.tnt, kind: "calamity" });
          spawnPoof(s, hz.x, hz.y, [C.tnt, "#ffd7b0", "#fff2a8"], { count: 18, speed: [50, 190], life: [0.25, 0.45], size: [3, 6] });
          s.shake = Math.max(s.shake, 16 * L.s);
          s.hazards.splice(i, 1);
        }

        for (let i = s.clones.length - 1; i >= 0; i--) {
          const cl = s.clones[i];
          if (cl.hp <= 0) {
            spawnPoof(s, cl.x, cl.y, [cl.ownerId === 0 ? C.p1 : C.p2, "#ffffff"], { count: 10, speed: [40, 130], life: [0.18, 0.32], size: [2, 4] });
            s.clones.splice(i, 1);
            continue;
          }
          cl.life += dt;
          if (cl.fired) {
            cl.dyingT += dt;
            if (cl.dyingT >= ENVOY_DESPAWN) s.clones.splice(i, 1);
            continue;
          }

          let target = null, tbd = Infinity;
          for (const it of s.items) {
            if (it.type !== "ammo") continue;
            const d = dist(cl.x, cl.y, it.x, it.y);
            if (d < tbd) { tbd = d; target = it; }
          }
          if (!target) continue; // 行き先が見つからない間は、その場で待機する

          const reach = L.PR + 20 * L.s;
          if (tbd < reach) {
            const idx = s.items.indexOf(target);
            if (idx !== -1) s.items.splice(idx, 1);
            const foe = s.players[cl.ownerId === 0 ? 1 : 0];
            const ang = Math.atan2(foe.y - cl.y, foe.x - cl.x);
            cl.face = ang;
            s.bullets.push({
              x: cl.x + Math.cos(ang) * (L.PR + L.BR + 2),
              y: cl.y + Math.sin(ang) * (L.PR + L.BR + 2),
              vx: Math.cos(ang) * L.BSPEED,
              vy: Math.sin(ang) * L.BSPEED,
              t: 0, owner: cl.ownerId, trail: [], kind: "normal", obstacleHits: 0, fromClone: true,
            });
            cl.fired = true;
            cl.dyingT = 0;
          } else {
            const dx2 = target.x - cl.x, dy2 = target.y - cl.y;
            const l2 = Math.hypot(dx2, dy2) || 1;
            cl.face = Math.atan2(dy2, dx2);
            cl.x += (dx2 / l2) * L.SPEED * dt;
            cl.y += (dy2 / l2) * L.SPEED * dt;
          }
        }
      }

      for (let i = s.booms.length - 1; i >= 0; i--) {
        s.booms[i].t += dt;
        if (s.booms[i].t > 0.45) s.booms.splice(i, 1);
      }
      for (let i = s.shards.length - 1; i >= 0; i--) {
        const f = s.shards[i];
        f.t += dt;
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.vx *= 0.94; f.vy *= 0.94;
        if (f.t > f.life) s.shards.splice(i, 1);
      }
      for (let i = s.poofs.length - 1; i >= 0; i--) {
        const f = s.poofs[i];
        f.t += dt;
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.vx *= 0.9; f.vy *= 0.9;
        if (f.t > f.life) s.poofs.splice(i, 1);
      }
      for (let i = s.dmgPopups.length - 1; i >= 0; i--) {
        const d = s.dmgPopups[i];
        d.t += dt;
        d.x += d.vx * dt; d.y += d.vy * dt;
        d.vy *= 0.94; d.vx *= 0.94;
        if (d.t > d.life) s.dmgPopups.splice(i, 1);
      }
      s.shake *= Math.pow(0.001, dt);

      // 相手キャラは毎フレーム、届いた位置(tx,ty)へ滑らかに近づける
      if (online && !isHost) {
        const p2 = s.players[1];
        if (p2.tx !== undefined) {
          const kPeer = 1 - Math.exp(-dt / 0.08);
          p2.x += (p2.tx - p2.x) * kPeer;
          p2.y += (p2.ty - p2.y) * kPeer;
        }
      }

      // オンライン対戦：ホストは状態を送信、ゲストは自分の入力を予測適用しつつ送信（どちらも約50回/秒）
      if (online) {
        sendAccum.current += dt;
        if (sendAccum.current > 0.02) {
          const tickDt = sendAccum.current;
          sendAccum.current = 0;
          try {
            if (isHost) {
              sendMsg({ type: "snapshot", payload: serializeState(s) });
            } else {
              let mx = input.move.dx, my = input.move.dy;
              if (keys["w"] || keys["arrowup"]) my -= 1;
              if (keys["s"] || keys["arrowdown"]) my += 1;
              if (keys["a"] || keys["arrowleft"]) mx -= 1;
              if (keys["d"] || keys["arrowright"]) mx += 1;
              const ml = Math.hypot(mx, my);
              if (ml > 1) { mx /= ml; my /= ml; }

              inputSeq.current += 1;
              const seq = inputSeq.current;
              const p1 = s.players[0];
              stepPlayerMove(p1, mx, my, tickDt); // 結果を待たず自分だけその場で動かす（予測）
              const al = Math.hypot(input.aim.dx, input.aim.dy);
              if (al > 0.2) p1.face = Math.atan2(input.aim.dy, input.aim.dx);
              else if (ml > 0.15) p1.face = Math.atan2(my, mx);

              pendingInputs.current.push({ seq, mx, my, dt: tickDt });
              if (pendingInputs.current.length > 200) pendingInputs.current.shift();

              sendMsg({ type: "move", seq, dx: mx, dy: my, dt: tickDt });
              sendMsg({ type: "aim", dx: input.aim.dx, dy: input.aim.dy, active: input.aim.id !== null });
            }
            netSendCount.current += 1;
            if (netSendCount.current <= 5 || netSendCount.current % 60 === 0) {
              console.log("[battle] sent #", netSendCount.current, isHost ? "snapshot" : "move/aim", "via", netStatusRef.current);
            }
          } catch (err) {
            console.log("[battle] ws.send failed", err);
          }
        }
      }

      // 効果音：前フレームとの差分から、被弾・回復・爆発・取得・勝敗を検知して鳴らす
      {
        const prevA = audioPrev.current;
        const p1a = s.players[0], p2a = s.players[1];
        if (prevA.hp1 >= 0) {
          if (p1a.hp < prevA.hp1) sfx.hit();
          else if (p1a.hp > prevA.hp1) sfx.heal();
        }
        if (prevA.hp2 >= 0) {
          if (p2a.hp < prevA.hp2) sfx.hitEnemy();
          else if (p2a.hp > prevA.hp2) sfx.heal();
        }
        if (prevA.ammo1 === 0 && p1a.ammo === 1) sfx.pickup();
        if (s.booms.length > prevA.boomCount) {
          for (let bi = prevA.boomCount; bi < s.booms.length; bi++) {
            sfx[s.booms[bi].kind === "calamity" ? "calamityBoom" : "explosion"]();
          }
        }
        if (prevA.winner === null && s.over !== null) { if (s.over === 0) sfx.win(); else sfx.lose(); }
        const envoyFiredCount = s.clones.filter((cl) => cl.fired).length;
        if (envoyFiredCount > prevA.envoyFiredCount) sfx.envoyFire();
        prevA.hp1 = p1a.hp; prevA.hp2 = p2a.hp;
        prevA.ammo1 = p1a.ammo; prevA.ammo2 = p2a.ammo;
        prevA.boomCount = s.booms.length; prevA.winner = s.over;
        prevA.envoyFiredCount = envoyFiredCount;
      }

      draw(ctx, s, input);
      setUi((u) => {
        const next = {
          hp1: p1.hp, hp2: p2.hp, maxHp1: p1.maxHp, maxHp2: p2.maxHp,
          ammo1: p1.ammo, ammo2: p2.ammo, winner: s.over,
          combo1: p1.combo || 0, weaponCd1: p1.weaponCd || 0, snowImmune2: p2.snowImmuneT || 0,
        };
        const same = u.hp1 === next.hp1 && u.hp2 === next.hp2 && u.maxHp1 === next.maxHp1 && u.maxHp2 === next.maxHp2 &&
          u.ammo1 === next.ammo1 && u.ammo2 === next.ammo2 && u.winner === next.winner &&
          u.combo1 === next.combo1 && u.weaponCd1 === next.weaponCd1 && u.snowImmune2 === next.snowImmune2;
        return same ? u : next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  /* ---------- 描画 ---------- */
  function draw(ctx, s, input) {
    const { AR, cell, s: S } = L;
    ctx.save();
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, L.W, L.H);
    const sh = s.shake;
    ctx.translate(rnd(-sh, sh), rnd(-sh, sh));

    const wt = 16 * S;
    ctx.fillStyle = C.wall;
    ctx.fillRect(AR.x - wt, AR.y - wt, AR.w + wt * 2, AR.h + wt * 2);
    ctx.strokeStyle = C.wallEdge;
    ctx.lineWidth = 3;
    ctx.strokeRect(AR.x - wt + 1.5, AR.y - wt + 1.5, AR.w + wt * 2 - 3, AR.h + wt * 2 - 3);

    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const px = AR.x + cx * cell, py = AR.y + cy * cell;
        ctx.fillStyle = (cx + cy) % 2 ? C.floor : C.floorAlt;
        ctx.fillRect(px, py, cell, cell);
        ctx.strokeStyle = C.seam;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, cell - 2, cell - 2);
        ctx.fillStyle = "rgba(255,255,255,.06)";
        const o = 10 * S;
        for (const [ox, oy] of [[o, o], [cell - o, o], [o, cell - o], [cell - o, cell - o]]) {
          ctx.beginPath();
          ctx.arc(px + ox, py + oy, 2.2 * S, 0, 7);
          ctx.fill();
        }
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(AR.x, AR.y, AR.w, AR.h);
    ctx.clip();

    for (const hz of s.hazards) {
      const half = L.cell * CALAMITY_HALF;
      const prog = clamp(hz.t / hz.life, 0, 1);
      const blinkRate = 2.5 + prog * 9; // 発動が近づくほど速く点滅
      const blink = Math.floor(hz.t * blinkRate) % 2 === 0;
      const col = hz.ownerId === 0 ? C.p1 : C.p2;
      ctx.save();
      ctx.globalAlpha = 0.16 + prog * 0.24;
      ctx.fillStyle = blink ? "#ff5a4e" : col;
      ctx.fillRect(hz.x - half, hz.y - half, half * 2, half * 2);
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = blink ? "#ffdcd2" : col;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(hz.x - half, hz.y - half, half * 2, half * 2);
      ctx.setLineDash([]);
      ctx.restore();
    }

    for (const it of s.items) {
      const pop = spawnScale(s, it.born ?? 0);
      if (it.type === "tnt") {
        const h = L.CRATE / 2;
        const blink = it.fuse > 0 && Math.floor(it.fuse * 12) % 2 === 0;
        ctx.save();
        ctx.translate(it.x, it.y);
        ctx.scale(pop, pop);
        ctx.fillStyle = blink ? "#fff0e0" : C.tnt;
        ctx.fillRect(-h, -h, L.CRATE, L.CRATE);
        ctx.strokeStyle = "#8f1d10";
        ctx.lineWidth = 5 * S;
        ctx.strokeRect(-h + 2.5 * S, -h + 2.5 * S, L.CRATE - 5 * S, L.CRATE - 5 * S);
        ctx.fillStyle = blink ? C.tnt : "#ffe9a8";
        ctx.font = `bold ${19 * S}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("TNT", 0, 1);
        ctx.restore();
      } else if (it.type === "ammo") {
        ctx.save();
        ctx.translate(it.x, it.y + Math.sin(s.t * 4) * 3 * S);
        ctx.scale(S * pop, S * pop);
        ctx.rotate(-Math.PI / 4);
        ctx.shadowColor = C.ammo;
        ctx.shadowBlur = 18;
        ctx.fillStyle = C.ammo;
        ctx.beginPath();
        ctx.moveTo(0, -17); ctx.lineTo(8, -2); ctx.lineTo(8, 13);
        ctx.lineTo(-8, 13); ctx.lineTo(-8, -2); ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#7a5a00";
        ctx.fillRect(-8, 2, 16, 4);
        ctx.restore();
      }
    }

    const p1 = s.players[0];
    if (p1.ammo && input.aim.id !== null) {
      const l = Math.hypot(input.aim.dx, input.aim.dy);
      if (l > 0.25) drawAim(ctx, p1.x, p1.y, input.aim.dx / l, input.aim.dy / l, p1.color);
    }
    if ((perk === "snow" || perk === "tp" || perk === "calamity") && weaponDrag.current.id !== null) {
      const wd = weaponDrag.current;
      const l = Math.hypot(wd.dx, wd.dy);
      if (perk === "calamity") {
        if (l > 0.15) {
          const t = calamityTarget(p1, wd.dx, wd.dy); // 実際の発動と同じく、正規化しない生の距離を使う
          const half = L.cell * CALAMITY_HALF;
          ctx.save();
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = ACCENT;
          ctx.fillRect(t.x - half, t.y - half, half * 2, half * 2);
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([9, 7]);
          ctx.strokeRect(t.x - half, t.y - half, half * 2, half * 2);
          ctx.restore();
        }
      } else if (l > 0.15) {
        if (perk === "tp") drawStraightAim(ctx, p1.x, p1.y, wd.dx / l, wd.dy / l, ACCENT);
        else drawAim(ctx, p1.x, p1.y, wd.dx / l, wd.dy / l, ACCENT);
      }
    }

    for (const b of s.bullets) {
      if (b.kind === "tp" && b.owner !== 0) continue; // 相手にはほぼ見えない
      const owner1 = b.owner === 0;
      ctx.save();
      ctx.globalAlpha = b.kind === "tp" ? 0.4 : 1;
      ctx.strokeStyle = owner1 ? "rgba(255,150,130,.55)" : "rgba(130,205,255,.55)";
      ctx.lineWidth = 4 * S;
      ctx.beginPath();
      b.trail.forEach((t, i) => (i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y)));
      ctx.stroke();

      if (b.kind === "snow") {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.shadowColor = "#cdeeff";
        ctx.shadowBlur = 14;
        ctx.strokeStyle = "#eaffff";
        ctx.lineWidth = 2.4 * S;
        const r = L.BR * 1.3;
        for (let a = 0; a < 3; a++) {
          ctx.save();
          ctx.rotate((Math.PI / 3) * a);
          ctx.beginPath();
          ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      } else {
        const rad = b.kind === "rocket" ? L.BR * ROCKET_SIZE_MULT : L.BR;
        ctx.save();
        ctx.shadowColor = owner1 ? "#ff8a72" : "#72c9ff";
        ctx.shadowBlur = b.kind === "rocket" ? 22 : 16;
        ctx.fillStyle = owner1 ? "#ffdcd2" : "#d2ecff";
        ctx.beginPath();
        ctx.arc(b.x, b.y, rad, 0, 7);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    for (const p of s.players) drawPlayer(ctx, p, s);

    for (const cl of s.clones) drawPlayer(ctx, cl, s);

    for (const b of s.booms) {
      const k = b.t / 0.45;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = "#fff6c9";
      ctx.beginPath();
      ctx.arc(b.x, b.y, L.EXPR * (0.35 + k * 0.75), 0, 7);
      ctx.fill();
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = b.col || C.tnt;
      ctx.lineWidth = 8 * S * (1 - k) + 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, L.EXPR * (0.4 + k), 0, 7);
      ctx.stroke();
      ctx.restore();
    }
    for (const f of s.shards) {
      ctx.save();
      ctx.globalAlpha = 1 - f.t / f.life;
      ctx.fillStyle = f.c;
      ctx.fillRect(f.x - 3 * S, f.y - 3 * S, 6 * S, 6 * S);
      ctx.restore();
    }
    for (const f of s.poofs) {
      const k = f.t / f.life;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = f.c;
      ctx.beginPath();
      ctx.arc(f.x, f.y, Math.max(0.5, f.size * (1 - k * 0.5)), 0, 7);
      ctx.fill();
      ctx.restore();
    }
    for (const d of s.dmgPopups) {
      const k = d.t / d.life;
      const pop = k < 0.15 ? k / 0.15 : 1;
      const alpha = k > 0.55 ? clamp(1 - (k - 0.55) / 0.45, 0, 1) : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(d.x, d.y);
      ctx.scale(0.6 + 0.4 * pop, 0.6 + 0.4 * pop);
      ctx.font = `900 ${18 * S}px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(13,15,19,.75)";
      ctx.strokeText(d.text, 0, 0);
      ctx.fillStyle = d.color;
      ctx.fillText(d.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    ctx.restore();
  }

  function drawPlayer(ctx, p, s) {
    const S = L.s;
    const frozen = p.frozen > 0;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + L.PR - 3 * S, L.PR * 0.9, L.PR * 0.4, 0, 0, 7);
    ctx.fill();

    ctx.translate(p.x, p.y);
    ctx.rotate(p.face);
    ctx.fillStyle = (p.flash > 0 || frozen) ? "#ffffff" : shade(p.color, -0.35);
    ctx.strokeStyle = frozen ? "#bfe9ff" : C.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(L.PR * 0.2, -L.PR * 0.34, L.PR * 1.35, L.PR * 0.68, L.PR * 0.2);
    ctx.fill();
    ctx.stroke();
    ctx.rotate(-p.face);

    ctx.fillStyle = (p.flash > 0 || frozen) ? "#ffffff" : p.color;
    ctx.beginPath();
    ctx.arc(0, 0, L.PR, 0, 7);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = frozen ? "#bfe9ff" : C.ink;
    ctx.stroke();

    ctx.rotate(p.face);
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.beginPath();
    ctx.arc(L.PR * 0.36, 0, L.PR * 0.3, 0, 7);
    ctx.fill();
    ctx.rotate(-p.face);

    if (p.ammo) {
      ctx.strokeStyle = C.ammo;
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -s.t * 22;
      ctx.beginPath();
      ctx.arc(0, 0, L.PR + 7 * S, 0, 7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => clamp(Math.round(v + 255 * amt), 0, 255);
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function drawAim(ctx, x, y, dx, dy, color) {
    const { AR } = L;
    let px = x, py = y, vx = dx, vy = dy;
    let remain = L.cell * 6.4, b = 0;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 7]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(px, py);
    while (remain > 0 && b <= 2) {
      let t = Infinity;
      if (vx > 0) t = Math.min(t, (AR.x + AR.w - px) / vx);
      if (vx < 0) t = Math.min(t, (AR.x - px) / vx);
      if (vy > 0) t = Math.min(t, (AR.y + AR.h - py) / vy);
      if (vy < 0) t = Math.min(t, (AR.y - py) / vy);
      const step = Math.min(t, remain);
      px += vx * step; py += vy * step;
      ctx.lineTo(px, py);
      remain -= step;
      if (step === t) {
        if (Math.abs(px - AR.x) < 1 || Math.abs(px - (AR.x + AR.w)) < 1) vx *= -1;
        else vy *= -1;
        b++;
      } else break;
    }
    ctx.stroke();
    ctx.restore();
  }

  /* TP弾は反射しないので、着弾地点までの直線だけを見せる */
  function drawStraightAim(ctx, x, y, dx, dy, color) {
    const { AR } = L;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (AR.x + AR.w - x) / dx);
    if (dx < 0) t = Math.min(t, (AR.x - x) / dx);
    if (dy > 0) t = Math.min(t, (AR.y + AR.h - y) / dy);
    if (dy < 0) t = Math.min(t, (AR.y - y) / dy);
    const ex = x + dx * t, ey = y + dy * t;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 7]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }

  const bar = (hp, maxHp, color, right) => (
    <div className={`flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
      <div className="h-2.5 w-32 sm:w-44 overflow-hidden rounded-sm bg-black/55">
        <div
          className="h-full transition-all duration-150 ease-out"
          style={{ width: `${(hp / maxHp) * 100}%`, background: color, marginLeft: right ? "auto" : 0 }}
        />
      </div>
      <span
        className="text-[11px] font-bold tabular-nums"
        style={{ color: "#eef0f3", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
      >
        {Math.max(0, Math.round(hp))}
      </span>
    </div>
  );

  const cdMax = perk === "snow" ? SNOW_CD : perk === "tp" ? TP_CD : perk === "calamity" ? CALAMITY_CD : perk === "envoy" ? ENVOY_CD : 1;
  const cdFrac = clamp((ui.weaponCd1 || 0) / cdMax, 0, 1);
  const snowImmuneFrac = clamp((ui.snowImmune2 || 0) / SNOW_IMMUNE, 0, 1);

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-[#14161c] select-none touch-none"
      style={{ height: "100dvh", width: "100vw", overscrollBehavior: "none" }}
    >
      <style>{`
        @keyframes countPop {
          0%   { transform: scale(.4); opacity: 0; }
          60%  { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .countdown-num { animation: countPop .35s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .countdown-num { animation: none; }
        }
      `}</style>

      <div ref={wrapRef} className="absolute inset-0" style={{ touchAction: "none", overscrollBehavior: "none" }}>
        <canvas ref={canvasRef} className="block" style={{ touchAction: "none" }} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <div className="flex flex-col gap-1">
          {bar(ui.hp1, ui.maxHp1, C.p1, false)}
          {perk === "blessing" && (
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-1.5 w-5 rounded-full"
                  style={{ background: i < (ui.combo1 || 0) ? ACCENT : "rgba(255,255,255,.15)" }} />
              ))}
            </div>
          )}
          {(perk === "snow" || perk === "tp" || perk === "calamity" || perk === "envoy") && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,.12)" }}>
                <div className="h-full transition-all duration-150 ease-out"
                  style={{ width: `${(1 - cdFrac) * 100}%`, background: ACCENT }} />
              </div>
              <span className="text-[9px]" style={{ color: cdFrac > 0 ? "rgba(255,255,255,.45)" : ACCENT }}>
                {cdFrac > 0 ? `${ui.weaponCd1.toFixed(1)}s` : "使用可"}
              </span>
            </div>
          )}
          {perk === "snow" && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,.12)" }}>
                <div className="h-full transition-all duration-150 ease-out"
                  style={{ width: `${(1 - snowImmuneFrac) * 100}%`, background: "#bfe9ff" }} />
              </div>
              <span className="text-[9px]" style={{ color: snowImmuneFrac > 0 ? "rgba(255,255,255,.45)" : "#bfe9ff" }}>
                {snowImmuneFrac > 0 ? `${ui.snowImmune2.toFixed(1)}s` : "攻撃可"}
              </span>
            </div>
          )}
          <span className="text-[10px]" style={{ color: ui.ammo1 ? C.ammo : "rgba(255,255,255,.3)" }}>
            {ui.ammo1 ? "装填ずみ" : "弾なし"}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1">
          {bar(ui.hp2, ui.maxHp2, C.p2, true)}
          <span className="text-[10px]" style={{ color: ui.ammo2 ? C.ammo : "rgba(255,255,255,.3)" }}>
            {ui.ammo2 ? "装填ずみ" : "弾なし"}
          </span>
        </div>
      </div>

      {(perk === "snow" || perk === "tp" || perk === "calamity" || perk === "envoy") && (
        <div
          ref={weaponBtnRef}
          role="button"
          aria-label="サブ武器を発動"
          onPointerDown={weaponPointerDown}
          onPointerMove={weaponPointerMove}
          onPointerUp={weaponPointerUp}
          onPointerCancel={weaponPointerUp}
          className="absolute flex select-none items-center justify-center rounded-full"
          style={{
            left: `${weaponBtnPos.xFrac * 100}%`, top: `${weaponBtnPos.yFrac * 100}%`,
            transform: "translate(-50%, -50%)", width: 74, height: 74,
            background: "rgba(20,23,29,.85)",
            border: "2px solid rgba(255,255,255,.25)",
            touchAction: "none",
          }}
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
            <div style={{
              position: "absolute", inset: 0,
              background: `conic-gradient(rgba(0,0,0,.6) ${cdFrac * 360}deg, transparent ${cdFrac * 360}deg)`,
            }} />
          </div>
          <span className="pointer-events-none" style={{ fontSize: 26, color: "#eef0f3" }}>
            {WEAPON_META[perk].icon}
          </span>
          {knobActive && (
            <div
              className="pointer-events-none absolute rounded-full"
              style={{
                width: 22, height: 22, background: ACCENT,
                left: `calc(50% + ${knob.dx * 26}px - 11px)`,
                top: `calc(50% + ${knob.dy * 26}px - 11px)`,
                boxShadow: `0 0 8px ${ACCENT}`,
              }}
            />
          )}
        </div>
      )}

      {online && (
        <div
          className="pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 rounded-full px-3 py-1 text-[10px]"
          style={{
            background: "rgba(0,0,0,.5)",
            color: netStatus === "p2p" ? "#8ef0a8" : netStatus === "relay" ? "#ffcf5a" : "#9aa0a8",
          }}
        >
          {netStatus === "p2p" ? "直接接続" : netStatus === "relay" ? "中継経由" : "接続中…"}
        </div>
      )}

      {phase === "countdown" && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,.45)" }}>
          {online && netStatus === "connecting" ? (
            <div className="flex flex-col items-center gap-3">
              <span
                className="search-ring inline-block h-8 w-8 rounded-full"
                style={{ border: "3px solid rgba(255,255,255,.15)", borderTopColor: ACCENT, animation: "ringSpin .8s linear infinite" }}
              />
              <div className="text-sm" style={{ color: "#c7cbd1" }}>相手との接続を確立しています…</div>
            </div>
          ) : (
            <div
              key={count}
              className={`countdown-num font-black ${count > 0 ? "text-8xl" : "text-5xl"}`}
              style={{ color: "#f3f6fb", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
            >
              {count > 0 ? count : "スタート"}
            </div>
          )}
        </div>
      )}

      {ui.winner !== null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/70">
          <div className="text-4xl font-bold" style={{ color: ui.winner === 0 ? C.p1 : C.p2 }}>
            {ui.winner === 0 ? "あなたの勝ち" : online ? "相手の勝ち" : "ボットの勝ち"}
          </div>

          {online ? (
            <>
              <div className="text-sm" style={{ color: "#c7cbd1" }}>
                もう一度プレイしますか？
                {myVote === null && <span style={{ color: ACCENT }}> （あと{voteSeconds}秒）</span>}
              </div>
              {myVote === null ? (
                <div className="flex gap-3">
                  <button
                    onClick={voteYes}
                    className="rounded-lg px-6 py-3 font-bold focus:outline-none focus:ring-2"
                    style={{ background: ACCENT, color: "#0b0d11" }}
                  >
                    はい
                  </button>
                  <button
                    onClick={voteNo}
                    className="rounded-lg border px-6 py-3 font-bold focus:outline-none focus:ring-2"
                    style={{ borderColor: "rgba(255,255,255,.25)", color: "#eef0f3", background: "transparent" }}
                  >
                    いいえ
                  </button>
                </div>
              ) : myVote === true ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: "#9aa0a8" }}>
                  <span
                    className="search-ring inline-block h-3.5 w-3.5 rounded-full"
                    style={{ border: "2px solid rgba(255,255,255,.15)", borderTopColor: ACCENT, animation: "ringSpin .8s linear infinite" }}
                  />
                  相手の返事を待っています…
                </div>
              ) : (
                <div className="text-xs" style={{ color: "#9aa0a8" }}>ホームに戻ります…</div>
              )}
            </>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={requestRematch}
                className="rounded-lg px-6 py-3 font-bold focus:outline-none focus:ring-2"
                style={{ background: ACCENT, color: "#0b0d11" }}
              >
                もう一度プレイ
              </button>
              <button
                onClick={onExit}
                className="rounded-lg border px-6 py-3 font-bold focus:outline-none focus:ring-2"
                style={{ borderColor: "rgba(255,255,255,.25)", color: "#eef0f3", background: "transparent" }}
              >
                ホームに戻る
              </button>
            </div>
          )}
        </div>
      )}

      {disconnected && ui.winner === null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/70">
          <div className="text-xl font-bold" style={{ color: "#eef0f3" }}>相手が切断しました</div>
          <div className="text-xs" style={{ color: "#9aa0a8" }}>まもなくホームに戻ります…</div>
          <button
            onClick={onExit}
            className="rounded-lg px-6 py-3 font-bold focus:outline-none focus:ring-2"
            style={{ background: ACCENT, color: "#0b0d11" }}
          >
            今すぐホームに戻る
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   アプリ本体（画面遷移）
   ============================================================ */
export default function App() {
  const [screen, setScreen] = useState("home"); // home | perks | online-perks | battle | btn-position
  const [matchId, setMatchId] = useState(0);
  const [perk, setPerk] = useState(null); // Bot対戦 or オンラインでの自分の選択
  const [peerPerk, setPeerPerk] = useState(null); // オンラインでの相手の選択
  const [netMatch, setNetMatch] = useState(null); // { ws, isHost, rules } | null
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => { setSoundEnabled(soundOn); }, [soundOn]);

  /* アプリ全体でページのスクロールを完全に止める。
     [data-scrollable] を付けた要素の中だけは、指でスクロールできるようにする。 */
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = { h: html.style.cssText, b: body.style.cssText };
    for (const el of [html, body]) {
      el.style.margin = "0";
      el.style.padding = "0";
      el.style.height = "100%";
      el.style.overflow = "hidden";
      el.style.overscrollBehavior = "none";
      el.style.touchAction = "none";
      el.style.position = "fixed";
      el.style.inset = "0";
    }

    let meta = document.querySelector('meta[name="viewport"]');
    const hadMeta = !!meta;
    const prevContent = meta?.getAttribute("content") || "";
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");

    const block = (e) => {
      if (e.target.closest("button, input, a, [role='switch'], [role='button'], [data-scrollable]")) return;
      e.preventDefault();
    };
    document.addEventListener("touchstart", block, { passive: false, capture: true });
    document.addEventListener("touchmove", block, { passive: false, capture: true });
    document.addEventListener("gesturestart", block, { passive: false, capture: true });

    return () => {
      html.style.cssText = prev.h;
      body.style.cssText = prev.b;
      if (hadMeta) meta.setAttribute("content", prevContent);
      else meta.remove();
      document.removeEventListener("touchstart", block, { capture: true });
      document.removeEventListener("touchmove", block, { capture: true });
      document.removeEventListener("gesturestart", block, { capture: true });
    };
  }, []);

  const goPerks = () => setScreen("perks");
  const choosePerk = (id) => {
    setPerk(id);
    setPeerPerk(null);
    setNetMatch(null);
    setMatchId((m) => m + 1);
    setScreen("battle");
  };
  const onMatched = (ws, isHost, rules) => {
    setNetMatch({ ws, isHost, rules });
    if (rules === "perks") {
      setScreen("online-perks");
    } else {
      setPerk(null);
      setPeerPerk(null);
      setMatchId((m) => m + 1);
      setScreen("battle");
    }
  };
  const onlinePerksReady = (myChoice, peerChoice) => {
    setPerk(myChoice);
    setPeerPerk(peerChoice);
    setMatchId((m) => m + 1);
    setScreen("battle");
  };
  const rematch = () => {
    setMatchId((m) => m + 1);
    setScreen("battle"); // Bot対戦のみ：同じ能力のまま再戦
  };
  const goHome = () => {
    if (netMatch) netMatch.ws.close();
    setNetMatch(null);
    setScreen("home");
  };

  if (screen === "home") return <HomeScreen onStartBattle={goPerks} onMatched={onMatched} soundOn={soundOn} setSoundOn={setSoundOn} onOpenBtnPosition={() => setScreen("btn-position")} />;
  if (screen === "perks") return <PerkSelectScreen onSelect={choosePerk} />;
  if (screen === "online-perks") return <OnlinePerkSelectScreen ws={netMatch.ws} onReady={onlinePerksReady} />;
  if (screen === "btn-position") return <WeaponButtonPositionScreen onBack={() => setScreen("home")} />;
  return (
    <BattleScreen
      key={matchId}
      perk={perk}
      peerPerk={peerPerk}
      ws={netMatch?.ws ?? null}
      isHost={netMatch?.isHost ?? true}
      onExit={goHome}
      onRematch={rematch}
    />
  );
}
