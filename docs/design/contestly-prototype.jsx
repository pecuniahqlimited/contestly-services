import { useState, useEffect, useRef, createContext, useContext } from "react";
import {
  Home as HomeIcon, Compass, Plus, Bell, User, Flame, Users, Trophy, ChevronLeft, ChevronRight,
  Send, Smile, Lock, Globe, Check, X, Share2, Gift, BadgeCheck, Clock, Search, Heart, AtSign,
  Image as ImageIcon, LayoutGrid, Smartphone, Wallet, BellRing, Swords, Zap, ArrowRight, ShieldCheck, Target, Sparkles, Crown, TrendingUp, Timer, Mic, MessageCircle, Play, RefreshCw, Pencil, Wand2, Flag, Eye, EyeOff, GripVertical, Link2, FileText, Upload, Paperclip,
} from "lucide-react";

/* =========================================================
   Brand — sampled from the Contestly logo
   ========================================================= */
const B = {
  blue: "#0B64FC", blueDeep: "#0A4FC7", blueSoft: "#EAF1FF", blueMid: "#C9DBFF",
  green: "#04D68B", greenDeep: "#03A96E", greenSoft: "#E3FBF1",
  navy: "#05193E", ink: "#0F2452", text2: "#5B6B8A", text3: "#8F9BB5",
  bg: "#F5F7FB", card: "#FFFFFF", line: "#E4E9F2", soft: "#EEF2F8",
  red: "#F0445D", redSoft: "#FFE9EC", amber: "#FFB020",
  // "pop" variants: same hues, pushed for the dark arena surfaces
  electric: "#3D8BFF", lime: "#2BFFB0", navyDeep: "#030F28", glow: "0 0 24px rgba(4,214,139,0.45)",
};
const naira = (n) => "₦" + Number(n).toLocaleString("en-NG");

/** Logo mark drawn as SVG so it scales crisply. Blue C, green tick. */
function Mark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Contestly">
      <path d="M78 26 A38 38 0 1 0 78 74" fill="none" stroke={B.blue} strokeWidth="18" strokeLinecap="round" />
      <path d="M44 52 L56 64 L82 34" fill="none" stroke={B.green} strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Wordmark({ size = 26, light }) {
  return (
    <span className="f-display" style={{ fontSize: size, fontWeight: 700, letterSpacing: "-0.03em", color: light ? "#fff" : B.navy }}>
      Contest<span style={{ color: light ? B.blueMid : B.blue }}>ly</span>
    </span>
  );
}

/* =========================================================
   Game configuration — Payout Challenge is N stages.
   Everything below renders from this array; add or remove
   entries and the ladder, intro, progress bar and results
   follow. In production this is admin-configured.
   ========================================================= */
const PAYOUT = {
  entryCoins: 100,
  decisionSeconds: 8,
  stages: [
    { type: "Pattern", hint: "What comes next?", q: "3, 6, 12, 24, …", a: ["36", "48", "42", "30"], c: 1, prize: 300, seconds: 15 },
    { type: "Scramble", hint: "Unscramble the word", q: "N A K S A", a: ["KASAN", "SANKA", "AKANS", "NASAK"], c: 1, prize: 800, seconds: 15 },
    { type: "Word hunt", hint: "Which word is hidden here?", q: "G A S U Y A M E", a: ["SUYA", "AMALA", "GARI", "EBA"], c: 0, prize: 2000, seconds: 15 },
    { type: "Trivia", hint: "General knowledge", q: "Which river meets the Niger at Lokoja?", a: ["Benue", "Kaduna", "Ogun", "Cross"], c: 0, prize: 5000, seconds: 12 },
    { type: "Sudden death", hint: "One question. No second chances.", q: "In what year did Nigeria become a republic?", a: ["1960", "1963", "1966", "1979"], c: 1, prize: 12000, seconds: 10 },
  ],
};
/** Question formats the engine can produce. Hosts pick a mix; each format has its own answer UI and scoring. */
const FORMATS = [
  ["single", "Pick one", "Classic: one right answer"],
  ["multi", "Pick all that apply", "Two or more right answers; partial credit"],
  ["order", "Put in order", "Arrange items; scored on position"],
  ["match", "Match pairs", "Map each item to its pair"],
  ["image", "Picture round", "A photo, then pick one"],
];
const PARTY_QS = [
  { type: "single", q: "Which city is Nigeria's federal capital?", a: ["Lagos", "Abuja", "Kano", "Ibadan"], c: 1, seconds: 12, explain: "Abuja replaced Lagos as capital in December 1991, chosen for its central location and neutrality." },
  { type: "image", img: "🏟️", caption: "Opened 1972, hosted the 1973 All-Africa Games", q: "Which stadium is this?", a: ["National Stadium, Lagos", "Moshood Abiola Stadium", "Teslim Balogun Stadium", "Ahmadu Bello Stadium"], c: 0 },
  { type: "multi", q: "Which of these are Nigerian states? Pick all that apply.", a: ["Ekiti", "Accra", "Nasarawa", "Kumasi"], c: [0, 2] },
  { type: "order", q: "Put these in order, earliest first.", items: ["Independence", "Return to civilian rule (1999)", "Civil war begins", "Capital moves to Abuja"], c: [0, 2, 3, 1] },
  { type: "match", q: "Match the city to its nickname.", left: ["Lagos", "Enugu", "Calabar"], right: ["Coal City", "Canaan City", "Centre of Excellence"], c: [2, 0, 1] },
];
const REPLACEMENT_Q = { type: "single", q: "What is the capital of Oyo State?", a: ["Ibadan", "Ogbomosho", "Oyo", "Iseyin"], c: 0, replacement: true };
const FLAG_REASONS = ["Wrong answer", "More than one right answer", "Unclear wording", "Out of date", "Inappropriate"];

const DAILY_QS = [
  { q: "Which Nigerian city is called the Coal City?", a: ["Enugu", "Jos", "Kaduna", "Benin"], c: 0 },
  { q: "What is the largest planet in our solar system?", a: ["Saturn", "Neptune", "Jupiter", "Mars"], c: 2 },
  { q: "Who wrote Things Fall Apart?", a: ["Wole Soyinka", "Chinua Achebe", "Chimamanda Adichie", "Ben Okri"], c: 1 },
  { q: "How many players are on a football team on the pitch?", a: ["9", "10", "11", "12"], c: 2 },
  { q: "Which ocean borders Lagos?", a: ["Indian", "Atlantic", "Pacific", "Arctic"], c: 1 },
];
const DAILY_FRIENDS = [["kemi", 5, "18.2s"], ["ada", 4, "21.0s"], ["tunde", 4, "26.4s"], ["zainab", 3, "19.9s"]];
const MISSIONS_INIT = [
  { id: "m1", title: "Play today's challenge", reward: 50, done: 0, total: 1, type: "daily" },
  { id: "m2", title: "Join 2 parties this week", reward: 150, done: 1, total: 2, type: "weekly" },
  { id: "m3", title: "Clear stage 3 of the Payout Challenge", reward: 200, done: 0, total: 1, type: "weekly" },
  { id: "m4", title: "Invite a friend who plays", reward: 200, done: 0, total: 1, type: "weekly" },
];
const TICKER = [["kemi", "cleared stage 3 of the Payout Challenge"], ["tunde", "opened Friday night football"], ["ada", "scored 4/5 on today's challenge"], ["beats", "is hosting a 10-seat party, 3 left"], ["segun", "hit a 5-day streak"], ["zainab", "beat Chidi in a rematch"]];

/* =========================================================
   Demo data
   ========================================================= */
const PEOPLE = {
  tunde: { name: "Tunde Bakare", handle: "tunde", color: "#0B64FC", bio: "I host a party every Friday night.", followers: 2400, following: 212, streak: 23, parties: 148, wins: 41, best: 12000, h2h: [1, 2], cats: ["Football", "General knowledge"] },
  ada: { name: "Ada Obi", handle: "ada.o", color: "#7C3AED", bio: "Law student. Trivia is my cardio.", followers: 981, following: 340, streak: 8, parties: 96, wins: 22, best: 5000, h2h: [0, 1], cats: ["Afrobeats", "History"] },
  kemi: { name: "Kemi Adeyemi", handle: "kemz", color: "#04D68B", bio: "Nollywood encyclopedia.", followers: 5100, following: 180, streak: 41, parties: 301, wins: 88, best: 12000, h2h: [0, 3], cats: ["Nollywood", "Reality TV"] },
  segun: { name: "Segun Ola", handle: "segunola", color: "#F0445D", bio: "Engineer by day, quiz goat by night.", followers: 412, following: 95, streak: 4, parties: 57, wins: 19, best: 2000, h2h: [2, 0], cats: ["Tech", "Maths"] },
  zainab: { name: "Zainab Musa", handle: "zee", color: "#FFB020", bio: "Streaks are a lifestyle.", followers: 3300, following: 410, streak: 12, parties: 133, wins: 30, best: 5000, h2h: [1, 1], cats: ["Geography", "Fashion"] },
  chidi: { name: "Chidi Eze", handle: "chidi.e", color: "#0EA5E9", bio: "DJ. I know every Afrobeats B-side.", followers: 760, following: 260, streak: 2, parties: 72, wins: 15, best: 2000, h2h: [0, 0], cats: ["Afrobeats", "Hip hop"] },
  beats: { name: "Afrobeats Weekly", handle: "afrobeatsweekly", color: "#05193E", brand: true, bio: "Official account. Weekly music parties with our community.", followers: 112000, following: 40, parties: 210, paidOut: 3450000, cats: ["Afrobeats", "Hip hop"] },
  jollof: { name: "Jollof Republic", handle: "jollofrepublic", color: "#F97316", brand: true, bio: "Official account. Free lunch parties every weekday at 1pm.", followers: 48000, following: 12, parties: 64, paidOut: 1280000, cats: ["Food"] },
  n1: { name: "New player", handle: "newplayer", color: "#6B7A99", followers: 0, following: 0, parties: 0, wins: 0, best: 0, h2h: [0, 0], cats: [] },
  n2: { name: "New player", handle: "newplayer2", color: "#8A6BD1", followers: 0, following: 0, parties: 0, wins: 0, best: 0, h2h: [0, 0], cats: [] },
  n3: { name: "New player", handle: "newplayer3", color: "#4F9DDE", followers: 0, following: 0, parties: 0, wins: 0, best: 0, h2h: [0, 0], cats: [] },
  quiz: { name: "Naija Quiz Club", handle: "naijaquiz", color: "#0B64FC", brand: true, bio: "Official account. Nigeria's biggest quiz community.", followers: 67000, following: 88, parties: 380, paidOut: 5100000, cats: ["General knowledge", "History"] },
};
const INTERESTS = ["Afrobeats", "Football", "Nollywood", "General knowledge", "History", "Science", "Tech", "Fashion", "Food", "Geography", "Brain teasers", "Reality TV", "Maths", "Hip hop"];
const PARTIES_INIT = [
  { id: "p1", title: "Afrobeats 2010s throwback", host: "beats", cat: "Afrobeats", entry: 200, players: ["kemi", "zainab", "chidi", "ada"], count: 7, max: 10, funding: "pooled", split: [60, 30, 10], visibility: "public", startsIn: 4, cover: "#7C3AED" },
  { id: "p2", title: "Friday night football", host: "tunde", cat: "Football", entry: 500, players: ["tunde", "segun", "chidi"], count: 3, max: 6, funding: "pooled", split: [70, 30], visibility: "public", startsIn: 12, cover: "#0B64FC" },
  { id: "p3", title: "Jollof Republic lunch break", host: "jollof", cat: "Food", entry: 0, players: ["ada", "kemi", "tunde", "segun"], count: 31, max: 50, funding: "host", hostPool: 20000, prize: { type: "experience", label: "Lunch for two at Jollof Republic", value: 20000 }, split: [100], visibility: "public", startsIn: 25, cover: "#F97316" },
  { id: "p4", title: "Nollywood legends", host: "kemi", cat: "Nollywood", entry: 300, players: ["kemi", "ada"], count: 6, max: 8, funding: "pooled", split: [100], visibility: "public", startsIn: 7, cover: "#04D68B" },
];
const FEED_INIT = [
  { id: "f1", who: "kemi", text: "walked away with ₦2,000 at stage 3 of the Payout Challenge", time: "2m", likes: 14 },
  { id: "f2", who: "tunde", text: "is hosting Friday night football", party: "p2", time: "8m", likes: 6 },
  { id: "f3", who: "beats", text: "opened a party: Afrobeats 2010s throwback", party: "p1", time: "20m", likes: 231 },
  { id: "f4", who: "zainab", text: "is on a 12-day streak", time: "1h", likes: 22 },
];
const NOTIFS_INIT = [
  { id: "n1", who: "ada", text: "mentioned you in Afrobeats 2010s throwback: “@you bet you can't beat me”", time: "1m", go: { screen: "lobby", party: "p1" }, unread: true },
  { id: "n2", who: "tunde", text: "invited you to Friday night football", time: "6m", go: { screen: "lobby", party: "p2" }, unread: true },
  { id: "n3", who: "quiz", text: "started following you", time: "1h", follow: true, unread: true },
  { id: "n4", who: "kemi", text: "is live in Nollywood legends. 2 seats left.", time: "3h", go: { screen: "lobby", party: "p4" } },
];
const STICKERS = ["🔥", "😂", "🫡", "👀", "💸", "🏆", "🙌🏾", "😤", "🤣", "😭", "💀", "🙏🏾", "👏🏾", "🎉", "😮", "🤔"];
/** Shared chat composer: text with @mentions, emoji, hold-to-record voice notes. Used in party chat and DMs. */
function VoiceBubble({ m, mine }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => { if (!playing) return; const t = setTimeout(() => setPlaying(false), m.seconds * 1000); return () => clearTimeout(t); }, [playing]);
  const bars = Array.from({ length: 22 }, (_, i) => 6 + ((i * 7919) % 14));
  return (
    <button onClick={() => setPlaying(!playing)} className="rounded-2xl px-3 py-2 flex items-center gap-2" style={{ background: mine ? B.blue : "#fff", color: mine ? "#fff" : B.ink, boxShadow: mine ? "none" : `0 0 0 1px ${B.line}`, borderBottomRightRadius: mine ? 6 : 16, borderBottomLeftRadius: mine ? 16 : 6, minWidth: 180 }}>
      <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: mine ? "rgba(255,255,255,0.2)" : B.blueSoft }}>{playing ? <span className="w-2.5 h-2.5 rounded-sm" style={{ background: mine ? "#fff" : B.blue }} /> : <Play size={13} color={mine ? "#fff" : B.blue} fill={mine ? "#fff" : B.blue} />}</span>
      <span className="flex items-end gap-0.5 h-5">{bars.map((h, i) => <span key={i} className={playing ? "bar" : ""} style={{ width: 2, height: h, background: mine ? "rgba(255,255,255,0.85)" : B.blue, borderRadius: 1, animationDelay: `${i * 0.05}s` }} />)}</span>
      <span className="text-xs font-semibold tabular-nums">{m.seconds}s</span>
    </button>
  );
}
function Composer({ onSend, members = [], placeholder = "Say something" }) {
  const { openProfile } = useApp();
  const [text, setText] = useState(""); const [emoji, setEmoji] = useState(false); const [rec, setRec] = useState(0);
  const recRef = useRef(null);
  const mentionQ = /@(\w*)$/.exec(text);
  const mentionList = mentionQ ? members.filter((id) => PEOPLE[id]?.handle.startsWith(mentionQ[1].toLowerCase())) : [];
  const send = (payload) => { onSend(payload); setText(""); setEmoji(false); };
  const startRec = () => { setRec(1); recRef.current = setInterval(() => setRec((r) => r + 1), 1000); };
  const stopRec = () => { clearInterval(recRef.current); if (rec > 0) send({ voice: true, seconds: Math.max(1, rec) }); setRec(0); };
  return (
    <>
      {mentionQ && mentionList.length > 0 && <div className="mx-4 mb-1 rounded-2xl overflow-hidden" style={{ background: "#fff", boxShadow: "0 6px 24px rgba(5,25,62,0.15)" }}>{mentionList.map((id) => <button key={id} onClick={() => setText(text.replace(/@\w*$/, `@${PEOPLE[id].handle} `))} className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm" style={{ color: B.navy }}><Avatar id={id} size={24} /><b>{PEOPLE[id].name}</b><span style={{ color: B.text3 }}>@{PEOPLE[id].handle}</span></button>)}</div>}
      {emoji && <div className="mx-4 mb-1 rounded-2xl p-2 grid grid-cols-8 gap-1" style={{ background: "#fff", boxShadow: `0 0 0 1px ${B.line}` }}>{STICKERS.map((e) => <button key={e} onClick={() => (text ? setText(text + e) : send({ sticker: e }))} className="text-2xl h-10 rounded-xl active:scale-90">{e}</button>)}</div>}
      <div className="px-4 pt-2 pb-2 flex items-center gap-2" style={{ background: B.bg }}>
        {rec > 0 ? (
          <div className="flex-1 flex items-center gap-3 rounded-full px-4 py-2.5" style={{ background: B.redSoft }}><span className="w-2.5 h-2.5 rounded-full pulse" style={{ background: B.red }} /><span className="text-sm font-semibold tabular-nums" style={{ color: B.red }}>0:{String(rec).padStart(2, "0")}</span><span className="flex-1 text-xs" style={{ color: B.text2 }}>Recording… release to send</span></div>
        ) : (<>
          <button aria-label="Emoji" onClick={() => setEmoji(!emoji)} className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: emoji ? B.navy : "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}` }}><Smile size={20} color={emoji ? "#fff" : B.ink} /></button>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && send({ text })} placeholder={placeholder} className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none min-w-0" style={{ background: "#fff", color: B.navy, boxShadow: `inset 0 0 0 1.5px ${B.line}` }} />
        </>)}
        {text.trim() ? <button aria-label="Send" onClick={() => send({ text })} className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: B.blue }}><Send size={18} color="#fff" /></button>
          : <button aria-label="Hold to record a voice note" onMouseDown={startRec} onMouseUp={stopRec} onMouseLeave={() => rec && stopRec()} onTouchStart={startRec} onTouchEnd={stopRec} className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 select-none" style={{ background: rec ? B.red : B.blue, transform: rec ? "scale(1.15)" : "none", transition: "transform .15s" }}><Mic size={18} color="#fff" /></button>}
      </div>
    </>
  );
}
const seedChat = (p) => [
  { id: 1, who: p.players[0], text: "Who's ready? 😤" },
  { id: 2, who: p.players[1] || p.host, sticker: "🔥" },
  { id: 3, who: p.players[2] || p.host, text: `@${PEOPLE[p.players[0]]?.handle || "host"} you're going down this time` },
];
const potOf = (p) => (p.funding === "host" ? (p.prize?.value ?? p.hostPool) : p.entry * p.count);
const isCash = (p) => !p.prize || p.prize.type === "cash";
/** What the winner gets, as a short string. Cash shows the amount; anything else shows what the brand defined. */
const prizeLabel = (p) => (isCash(p) ? naira(potOf(p)) : p.prize.label);
const fmtCount = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
const followersOf = (id) => Object.keys(PEOPLE).filter((x) => x !== id && !PEOPLE[x].brand).slice(0, 5);
const followingOf = (id) => Object.keys(PEOPLE).filter((x) => x !== id).reverse().slice(0, 6);

/* =========================================================
   App context + hooks
   ========================================================= */
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

function useCountdown(seconds, onDone, active = true) {
  const [t, setT] = useState(seconds);
  const cb = useRef(onDone); cb.current = onDone;
  const fired = useRef(false);
  useEffect(() => { if (!active) return; const id = setInterval(() => setT((x) => Math.max(0, x - 1)), 1000); return () => clearInterval(id); }, [active]);
  useEffect(() => { if (t === 0 && active && !fired.current) { fired.current = true; cb.current(); } }, [t, active]);
  return t;
}

/* =========================================================
   Primitives
   ========================================================= */
const initials = (name) => name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
function Avatar({ id, size = 40, ring, me }) {
  const { user } = useApp();
  const p = me ? { name: user.name || "You", color: B.blue } : PEOPLE[id] || { name: "?", color: B.text3 };
  return (
    <div className="flex items-center justify-center rounded-full shrink-0 f-display" aria-hidden
      style={{ width: size, height: size, background: p.color, color: "#fff", fontSize: size * 0.38, fontWeight: 700, boxShadow: ring ? `0 0 0 2px ${B.card}, 0 0 0 4px ${ring}` : "none" }}>
      {initials(p.name)}
    </div>
  );
}
function Name({ id, bold = true }) {
  const p = PEOPLE[id]; if (!p) return null;
  return <span className="inline-flex items-center gap-1" style={{ fontWeight: bold ? 600 : 500 }}>{p.name}{p.brand && <BadgeCheck size={14} color={B.blue} fill={B.blueSoft} />}</span>;
}
function Btn({ children, onClick, tone = "blue", full, small, disabled, icon }) {
  const tones = {
    blue: { background: B.blue, color: "#fff" },
    green: { background: B.green, color: B.navy },
    navy: { background: B.navy, color: "#fff" },
    soft: { background: B.blueSoft, color: B.blueDeep },
    white: { background: "#fff", color: B.navy },
    line: { background: "transparent", color: B.ink, boxShadow: `inset 0 0 0 1.5px ${B.line}` },
    danger: { background: B.redSoft, color: B.red },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`font-semibold rounded-2xl transition active:scale-95 focus:outline-none inline-flex items-center justify-center gap-2 ${full ? "w-full" : ""}`}
      style={{ ...tones[tone], padding: small ? "8px 14px" : "14px 18px", fontSize: small ? 13 : 15, opacity: disabled ? 0.45 : 1 }}>
      {icon}{children}
    </button>
  );
}
function Chip({ active, children, onClick }) {
  return (
    <button onClick={onClick} className="rounded-full font-semibold whitespace-nowrap transition active:scale-95"
      style={{ padding: "8px 14px", fontSize: 13, background: active ? B.navy : "#fff", color: active ? "#fff" : B.ink, boxShadow: active ? "none" : `inset 0 0 0 1.5px ${B.line}` }}>
      {children}
    </button>
  );
}
function TopBar({ title, right, onBack, light }) {
  const { back } = useApp();
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
      <button onClick={onBack || back} aria-label="Back" className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: light ? "rgba(255,255,255,0.15)" : B.soft }}>
        <ChevronLeft size={20} color={light ? "#fff" : B.ink} />
      </button>
      <div className="flex-1 font-semibold text-base truncate" style={{ color: light ? "#fff" : B.navy }}>{title}</div>
      {right}
    </div>
  );
}
function H({ children, size = 28, color = B.navy, className = "" }) {
  return <div className={`f-display ${className}`} style={{ fontSize: size, lineHeight: 1.12, color, fontWeight: 700, letterSpacing: "-0.025em" }}>{children}</div>;
}
function Sub({ children, color = B.text2, className = "", style = {} }) { return <p className={`text-sm ${className}`} style={{ color, lineHeight: 1.5, ...style }}>{children}</p>; }
function Screen({ children, pad = true }) { return <div className={`flex-1 overflow-y-auto ${pad ? "px-5" : ""}`} style={{ scrollbarWidth: "none" }}>{children}</div>; }
function Card({ children, className = "", style = {}, onClick }) {
  const Tag = onClick ? "button" : "div";
  return <Tag onClick={onClick} className={`rounded-3xl ${onClick ? "text-left w-full active:scale-95 transition" : ""} ${className}`} style={{ background: B.card, boxShadow: "0 1px 2px rgba(5,25,62,0.04), 0 0 0 1px " + B.line, ...style }}>{children}</Tag>;
}
function Progress({ step, total }) {
  return <div className="flex gap-1.5 px-5 pt-4">{Array.from({ length: total }).map((_, i) => <div key={i} className="h-1 flex-1 rounded-full" style={{ background: i < step ? B.blue : B.line }} />)}</div>;
}
function Input({ focusRing, className = "", style = {}, ...props }) {
  return <input {...props} className={`w-full rounded-2xl px-4 py-3.5 font-medium outline-none ${className}`} style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${focusRing || B.line}`, color: B.navy, ...style }} />;
}
function Sheet({ children, onClose }) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" style={{ background: "rgba(5,25,62,0.45)" }} onClick={onClose}>
      <div className="rounded-t-3xl p-5 pb-8 slide-up" style={{ background: "#fff" }} onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: B.line }} />{children}
      </div>
    </div>
  );
}
/** The N-stage ladder, rendered from PAYOUT.stages. Used on Home, intro, and in-run progress. */
function Ladder({ current = -1, held = -1, compact }) {
  return (
    <div className="flex items-center">
      {PAYOUT.stages.map((s, i) => {
        const cleared = i <= held; const active = i === current; const last = i === PAYOUT.stages.length - 1;
        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="rounded-full flex items-center justify-center shrink-0 f-display" style={{ width: compact ? 26 : 32, height: compact ? 26 : 32, fontSize: compact ? 11 : 12, fontWeight: 700, background: cleared ? B.green : active ? B.blue : last ? B.navy : B.soft, color: cleared || active || last ? "#fff" : B.text2, boxShadow: active ? `0 0 0 4px ${B.blueSoft}` : "none" }}>
              {cleared ? <Check size={compact ? 13 : 15} strokeWidth={3} /> : i + 1}
            </div>
            {!last && <div className="flex-1 h-0.5 mx-1" style={{ background: i < held + 1 && held >= 0 ? B.green : B.line }} />}
          </div>
        );
      })}
    </div>
  );
}

/* =========================================================
   Onboarding — a 90-second party that reads your archetype
   ========================================================= */
/** Round 1: picks about you (no right answer, but answer in time for points). Round 2: quick trivia (correct + speed). */
const WARMUP_QS = [
  { key: "interest", multi: true, q: "Saturday night. Where are you? Pick all that apply.", hint: "Tap everything that fits · 2 or more", a: [["⚽", "At the match", ["Football"]], ["🎶", "Front row, Afrobeats", ["Afrobeats", "Hip hop"]], ["🎬", "Nollywood marathon", ["Nollywood", "Reality TV"]], ["🧩", "Quiz night", ["Brain teasers", "General knowledge"]], ["🍛", "Cooking for everyone", ["Food"]], ["💻", "Building something", ["Tech", "Science"]]], bots: { kemi: 2, tunde: 0 } },
  { key: "why", q: "You'd rather…", hint: "Be honest", a: [["🏆", "Beat my friends", "competitor"], ["🎉", "Host the game night", "host"], ["💸", "Walk away with cash", "grinder"], ["🫶🏾", "Just vibe with people", "fan"]], bots: { kemi: 0, tunde: 1 } },
];
const BRAND_QS = [
  { key: "interest", multi: true, q: "What does your brand do? Pick all that apply.", hint: "Tap everything that fits · 1 or more", min: 1, a: [["👗", "Fashion", ["Fashion"]], ["🍛", "Food & drink", ["Food"]], ["🎶", "Music & events", ["Afrobeats", "Hip hop"]], ["💻", "Tech", ["Tech"]], ["💄", "Beauty", ["Fashion"]], ["🎬", "Film & TV", ["Nollywood", "Reality TV"]]], bots: { kemi: 1, tunde: 0 } },
  { key: "why", q: "Why host parties?", hint: "Be honest", a: [["🚀", "Launch something", "launch"], ["📣", "Reach new fans", "reach"], ["🎁", "Reward customers", "reward"], ["🫶🏾", "For the culture", "culture"]], bots: { kemi: 1, tunde: 2 } },
];
/** Round 2 trivia; correct answers score, faster scores more. */
const WARMUP_TRIVIA = [
  { q: "Which city is Nigeria's federal capital?", a: ["Lagos", "Abuja", "Kano", "Ibadan"], c: 1 },
  { q: "How many states does Nigeria have?", a: ["30", "34", "36", "37"], c: 2 },
  { q: "Which ocean borders Lagos?", a: ["Indian", "Atlantic", "Pacific", "Arctic"], c: 1 },
];
const REWARD_TIERS = [[800, 500], [500, 400], [200, 300], [0, 200]]; // [min points, coins]
const NEWCOMERS = ["n1", "n2", "n3"];
const WHY = [
  { id: "competitor", label: "Beat my friends", icon: Swords, color: B.blue },
  { id: "host", label: "Play with my people", icon: Users, color: "#7C3AED" },
  { id: "grinder", label: "Win real cash", icon: Zap, color: B.greenDeep },
  { id: "fan", label: "Just vibes", icon: Sparkles, color: "#F97316" },
];
const INTEREST_ICONS = { Afrobeats: "🎶", Football: "⚽", Nollywood: "🎬", "General knowledge": "🧠", History: "📜", Science: "🔬", Tech: "💻", Fashion: "👗", Food: "🍛", Geography: "🌍", "Brain teasers": "🧩", "Reality TV": "📺", Maths: "➗", "Hip hop": "🎤" };

function useCountUp(target, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => { let raf; const t0 = performance.now(); const tick = (t) => { const k = Math.min(1, (t - t0) / ms); setV(Math.round(target * (1 - Math.pow(1 - k, 3)))); if (k < 1) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [target]);
  return v;
}
function Confetti() {
  const bits = Array.from({ length: 28 });
  return <div className="absolute inset-0 pointer-events-none overflow-hidden">{bits.map((_, i) => <span key={i} className="absolute confetti" style={{ left: `${(i * 37) % 100}%`, top: -10, width: 8, height: 12, background: [B.blue, B.green, B.amber, "#fff", "#7C3AED"][i % 5], animationDelay: `${(i % 7) * 0.12}s`, transform: `rotate(${i * 23}deg)` }} />)}</div>;
}

/** 1. Welcome. Three real entry states: direct, invite to a free party (guest allowed), invite to a staked party (sign-up required). */
function Welcome() {
  const { go, entry, parties, setUser, user, setJoined } = useApp();
  const inv = entry.kind === "invite" ? parties.find((p) => p.id === entry.party) : null;
  const staked = inv && (inv.entry > 0 || isCash(inv));
  const joinAsGuest = () => { setUser({ ...user, guest: true, name: user.name || "Guest", handle: "" }); go("guestName", { party: inv.id }); };
  return (
    <div className="flex-1 flex flex-col relative overflow-hidden" style={{ background: `radial-gradient(120% 70% at 50% 0%, rgba(11,100,252,0.5), transparent 60%), ${B.navyDeep}` }}>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
        <div className="pop"><Mark size={inv ? 64 : 96} /></div>
        <div className="mt-4"><Wordmark size={inv ? 28 : 40} light /></div>
        {inv ? (
          <div className="mt-6 w-full max-w-xs rounded-3xl p-4 text-left slide-up" style={{ background: inv.cover }}>
            <div className="flex items-center gap-2"><Avatar id={inv.host} size={28} ring={inv.cover} /><span className="text-xs font-semibold text-white"><Name id={inv.host} /> invited you</span></div>
            <div className="mt-3 f-display text-white" style={{ fontSize: 22, lineHeight: 1.15 }}>{inv.title}</div>
            <div className="mt-2 flex items-center justify-between text-xs text-white opacity-90"><span>{inv.count}/{inv.max} in · starts in {inv.startsIn}m</span><span>{inv.entry ? `${naira(inv.entry)} entry` : "Free entry"}{!isCash(inv) ? ` · prize: ${inv.prize.label}` : inv.entry ? ` · pot ${naira(potOf(inv))}` : ""}</span></div>
            <div className="mt-3 flex -space-x-2">{inv.players.slice(0, 4).map((id) => <Avatar key={id} id={id} size={26} ring={inv.cover} />)}</div>
          </div>
        ) : (<>
          <Sub className="mt-4 max-w-xs" color="#fff" style={{ fontSize: 17, lineHeight: 1.4 }}>Live quiz parties with your friends, and solo challenges when it's just you.</Sub>
          <div className="mt-8 flex flex-col gap-2 w-full max-w-xs text-left">
            {[[Users, "Party", "Host or join a live round. Everyone answers at once."], [Zap, "Payout Challenge", "A ladder of puzzles. Climb as far as you dare."], [MessageCircle, "Your people", "Follow friends, chat, rematch, keep a streak."]].map(([I, t, d], i) => (
              <div key={t} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 slide-up" style={{ background: "rgba(255,255,255,0.07)", animationDelay: `${0.1 + i * 0.08}s` }}><div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(43,255,176,0.15)" }}><I size={17} color={B.lime} /></div><div className="min-w-0"><div className="text-sm font-semibold text-white">{t}</div><div className="text-xs" style={{ color: B.blueMid }}>{d}</div></div></div>
            ))}
          </div>
        </>)}
      </div>
      <div className="px-5 pb-8 flex flex-col gap-2">
        {inv ? (staked ? (<>
          <Btn full tone="green" onClick={() => go("whoPlays")}>{inv.entry ? `Sign up and join · ${naira(inv.entry)}` : "Sign up to play for the prize"}</Btn>
          <div className="text-center text-xs" style={{ color: B.blueMid }}>{inv.entry ? "This party has a stake, so you need an account to put yours in." : "There's money on the line, so winners need an account to get paid."}</div>
        </>) : (<>
          <Btn full tone="green" onClick={joinAsGuest}>Join as a guest</Btn>
          <button onClick={() => go("whoPlays")} className="text-sm font-semibold py-2" style={{ color: B.blueMid }}>Sign up first {!isCash(inv) && inv.prize ? "to be eligible for the prize" : "to keep your score"}</button>
        </>)) : <Btn full tone="green" onClick={() => go("whoPlays")}>Jump in</Btn>}
        <button onClick={() => go("phone")} className="text-sm font-semibold py-2" style={{ color: B.blueMid }}>I have an account</button>
      </div>
    </div>
  );
}

/** Guest: one name, straight into the lobby. No account, no coins, no prizes. */
function GuestName() {
  const { go, user, setUser, params, setJoined } = useApp();
  const [name, setName] = useState("");
  return (
    <>
      <TopBar title="" />
      <Screen>
        <H>What should we call you?</H>
        <Sub className="mt-2">Just for this party. No account needed.</Sub>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="mt-6 text-lg" />
        <Card className="mt-6 p-4 text-sm" style={{ background: B.blueSoft, boxShadow: "none", color: B.navy }}>As a guest you can play and chat. Your score isn't saved and you can't win prizes. Sign up any time to keep it all.</Card>
      </Screen>
      <div className="p-5"><Btn full disabled={name.trim().length < 2} onClick={() => { setUser({ ...user, guest: true, name: name.trim(), handle: "" }); setJoined((j) => [...j, params.party]); go("lobby", { party: params.party }); }}>Join the party</Btn></div>
    </>
  );
}

/** 1b. Who's playing: a person or a brand. Decides the warm-up picks and the post-onboarding path. */
function WhoPlays() {
  const { go, setUser, user } = useApp();
  const pick = (isBrand) => { setUser({ ...user, isBrand, guest: false }); setTimeout(() => go("warmup"), 350); };
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navyDeep }}>
      <TopBar light title="" />
      <div className="px-6 pt-4"><H size={30} color="#fff">Who's playing?</H><Sub className="mt-2" color={B.blueMid}>Brands host parties and give away prizes. People play in them.</Sub></div>
      <div className="flex-1 flex flex-col gap-3 p-5 justify-center">
        <button onClick={() => pick(false)} className="rounded-3xl p-5 text-left relative overflow-hidden active:scale-95 transition slide-up" style={{ background: `linear-gradient(160deg, ${B.electric}, ${B.blueDeep})`, minHeight: 150 }}>
          <div className="absolute -right-6 -bottom-6 w-28 h-28 rounded-full" style={{ background: "rgba(255,255,255,0.14)" }} />
          <div className="flex -space-x-2">{["kemi", "tunde", "ada"].map((id) => <Avatar key={id} id={id} size={32} ring={B.blueDeep} />)}</div>
          <div className="mt-4 f-display text-white" style={{ fontSize: 24 }}>Just me</div><div className="text-sm text-white opacity-90">Play live rounds with friends.</div>
        </button>
        <button onClick={() => pick(true)} className="rounded-3xl p-5 text-left relative overflow-hidden active:scale-95 transition slide-up" style={{ background: `linear-gradient(160deg, #F97316, #C2410C)`, minHeight: 150, animationDelay: ".08s" }}>
          <div className="absolute -right-6 -bottom-6 w-28 h-28 rounded-full" style={{ background: "rgba(255,255,255,0.14)" }} />
          <div className="flex -space-x-2">{["jollof", "beats", "quiz"].map((id) => <Avatar key={id} id={id} size={32} ring="#C2410C" />)}</div>
          <div className="mt-4 f-display text-white flex items-center gap-2" style={{ fontSize: 24 }}>A brand <BadgeCheck size={20} color="#fff" /></div><div className="text-sm text-white opacity-90">Host parties. Give away cash, products or experiences.</div>
        </button>
      </div>
    </div>
  );
}

/** 2. Warm-up party. Round 1: picks about you, timed. Round 2: three trivia, correct + fast scores. */
function PickRound({ item, onPick, seconds = 12 }) {
  const [picked, setPicked] = useState(null);
  const [multi, setMulti] = useState([]);
  const [bots, setBots] = useState({});
  const startRef = useRef(Date.now());
  useEffect(() => { const a = setTimeout(() => setBots((b) => ({ ...b, kemi: item.bots.kemi })), 1400); const b = setTimeout(() => setBots((x) => ({ ...x, tunde: item.bots.tunde })), 2600); return () => { clearTimeout(a); clearTimeout(b); }; }, []);
  const elapsed = () => (Date.now() - startRef.current) / 1000;
  const finish = (val) => onPick(val, elapsed());
  const t = useCountdown(seconds, () => finish(item.multi ? multi : -1), picked === null);
  const choose = (i) => {
    if (item.multi) return setMulti((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i]));
    if (picked !== null) return; setPicked(i); setTimeout(() => finish(i), 800);
  };
  const isOn = (i) => (item.multi ? multi.includes(i) : picked === i);
  const min = item.min ?? 2;
  return (
    <div className="flex-1 flex flex-col px-5">
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs font-semibold rounded-full px-3 py-1" style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}>{item.hint}</span>
        <span className="f-display text-lg" style={{ color: t <= 3 ? B.red : "#fff" }}>{t}s</span>
      </div>
      <div className="h-1 rounded-full mt-3" style={{ background: "rgba(255,255,255,0.12)" }}><div className="h-full rounded-full" style={{ width: `${(t / seconds) * 100}%`, background: t <= 3 ? B.red : B.green, transition: "width 1s linear" }} /></div>
      <div className="flex-1 flex flex-col justify-center"><div className="f-display text-2xl text-white" style={{ lineHeight: 1.2 }}>{item.q}</div></div>
      <div className={`grid gap-2 pb-5 ${item.multi ? "grid-cols-2" : "grid-cols-1"}`}>
        {item.a.map(([emoji, label], i) => { const mine = isOn(i); const who = [bots.kemi === i && "kemi", bots.tunde === i && "tunde"].filter(Boolean); return (
          <button key={i} onClick={() => choose(i)} className={`rounded-2xl px-3 text-left font-semibold flex items-center gap-2 active:scale-95 transition ${item.multi ? "py-3" : "py-3.5 px-4"}`} style={{ background: mine ? B.green : "rgba(255,255,255,0.1)", color: mine ? B.navy : "#fff", opacity: !item.multi && picked !== null && !mine ? 0.5 : 1 }}>
            {item.multi && <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: mine ? B.navy : "rgba(255,255,255,0.15)" }}>{mine && <Check size={13} color={B.lime} strokeWidth={3} />}</span>}
            <span className="text-lg">{emoji}</span><span className="flex-1 text-sm leading-tight">{label}</span>
            {!item.multi && <div className="flex -space-x-2">{who.map((id) => <div key={id} className="pop"><Avatar id={id} size={22} ring={mine ? B.green : B.navy} /></div>)}</div>}
            {!item.multi && mine && who.length ? <span className="text-xs font-bold rounded-full px-2 py-0.5" style={{ background: B.navy, color: B.lime }}>same!</span> : null}
          </button>); })}
        {item.multi && <div className="col-span-2"><Btn full tone="green" disabled={multi.length < min} onClick={() => finish(multi)}>{multi.length < min ? `Pick ${min - multi.length} more` : `That's me · ${multi.length} picked`}</Btn></div>}
      </div>
    </div>
  );
}
function Warmup() {
  const { go, setWhy, setUser, user } = useApp();
  const QS = user.isBrand ? BRAND_QS : WARMUP_QS;
  const [i, setI] = useState(0);
  const onPick = (val) => {
    const item = QS[i];
    if (item.key === "interest" && Array.isArray(val)) setUser((u) => ({ ...u, interests: [...new Set(val.flatMap((k) => item.a[k][2]))] }));
    if (item.key === "why" && !Array.isArray(val) && val >= 0) setWhy(item.a[val][2]);
    if (i + 1 >= QS.length) return go("coins");
    setI(i + 1);
  };
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navy }}>
      <div className="flex items-center gap-3 px-5 pt-4">
        <div className="flex-1 min-w-0"><div className="text-xs font-semibold" style={{ color: B.lime }}>ABOUT YOU · {i + 1} OF {QS.length}</div><div className="text-sm font-semibold text-white">Two quick picks. Kemi and Tunde are picking too.</div></div>
        <div className="flex -space-x-2"><Avatar id="kemi" size={28} ring={B.navy} /><Avatar id="tunde" size={28} ring={B.navy} /></div>
      </div>
      <div className="px-5 mt-3 flex gap-1">{QS.map((_, k) => <div key={k} className="flex-1 h-1 rounded-full" style={{ background: k < i ? B.green : k === i ? B.electric : "rgba(255,255,255,0.12)" }} />)}</div>
      <PickRound key={i} item={QS[i]} onPick={onPick} />
    </div>
  );
}

/** Bridge: now that we know what they're here for, say exactly what the next round earns and what it's for. */
function CoinsBridge() {
  const { go, why, user } = useApp();
  const forWhat = user.isBrand ? "your first party pot" : why === "grinder" ? "your first Payout Challenge run" : why === "host" ? "your first party" : "your first party";
  const icon = user.isBrand ? Gift : why === "grinder" ? Zap : Users;
  const I = icon;
  const lane = user.interests[0];
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navyDeep }}>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="w-24 h-24 rounded-full flex items-center justify-center pop" style={{ background: "rgba(43,255,176,0.15)" }}><I size={44} color={B.lime} /></div>
        <H size={30} color="#fff" className="mt-6">{user.isBrand ? "Now bag coins for your first pot." : why === "grinder" ? "Now bag coins for your first Payout run." : "Now bag coins for your first party."}</H>
        <Sub className="mt-3 max-w-xs" color={B.blueMid}>3 quick-fire questions{lane ? ` on ${lane}` : ""}. Right and fast earns more. Up to 500 coins, enough for {user.isBrand ? "a starter pot" : why === "grinder" ? `${Math.floor(500 / PAYOUT.entryCoins)} runs` : "a couple of parties"}.</Sub>
        <div className="mt-6 flex gap-2">{REWARD_TIERS.slice(0, 3).map(([min, c], k) => <div key={min} className="rounded-2xl px-3 py-2 text-center" style={{ background: "rgba(255,255,255,0.07)" }}><div className="f-display text-white">{c}</div><div className="text-xs" style={{ color: B.blueMid }}>{min}+ pts</div></div>)}</div>
      </div>
      <div className="px-5 pb-8"><Btn full tone="green" onClick={() => go("quickfire")} icon={<Zap size={16} />}>Let's go</Btn></div>
    </div>
  );
}

/** Quick fire: three timed questions. Solo, or in a shared round if others are onboarding right now. */
function QuickFire() {
  const { go, setWarmup, warmupLive, user } = useApp();
  const [i, setI] = useState(0); const [pts, setPts] = useState(0); const [correct, setCorrect] = useState(0);
  const [others, setOthers] = useState(() => NEWCOMERS.map((id) => ({ id, pts: 0 })));
  useEffect(() => { if (!warmupLive) return; const id = setInterval(() => setOthers((o) => o.map((x) => ({ ...x, pts: x.pts + (Math.random() < 0.6 ? Math.round(60 + Math.random() * 120) : 0) }))), 2500); return () => clearInterval(id); }, [warmupLive]);
  const speedPts = (t, max) => Math.max(0, Math.round(100 * (1 - Math.min(t, max) / max)));
  const onTrivia = (ok, t) => {
    const gained = ok ? 150 + speedPts(t, 10) : 0; const np = pts + gained; const nc = correct + (ok ? 1 : 0);
    if (i + 1 >= WARMUP_TRIVIA.length) { setWarmup({ pts: np, correct: nc, others: others.map((o) => ({ ...o, pts: o.pts + Math.round(Math.random() * 200) })) }); return go("warmupResult"); }
    setPts(np); setCorrect(nc); setI(i + 1);
  };
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navy }}>
      <div className="flex items-center gap-3 px-5 pt-4">
        <div className="flex-1 min-w-0"><div className="text-xs font-semibold" style={{ color: B.lime }}>QUICK FIRE · COINS ROUND</div><div className="text-sm font-semibold text-white">{warmupLive ? `${NEWCOMERS.length + 1} new players in your round` : `Bagging coins for ${user.isBrand ? "your first pot" : "your first game"}`} · {pts} pts</div></div>
        {warmupLive && <div className="flex -space-x-2">{others.map((o) => <Avatar key={o.id} id={o.id} size={28} ring={B.navy} />)}</div>}
      </div>
      {warmupLive && <div className="px-5 mt-2 flex gap-2">{others.map((o) => <span key={o.id} className="text-xs rounded-full px-2 py-0.5" style={{ background: "rgba(255,255,255,0.08)", color: o.pts > pts ? B.amber : B.blueMid }}>{o.pts} pts</span>)}</div>}
      <div className="px-5 mt-3 flex gap-1">{WARMUP_TRIVIA.map((_, k) => <div key={k} className="flex-1 h-1 rounded-full" style={{ background: k < i ? B.green : k === i ? B.electric : "rgba(255,255,255,0.12)" }} />)}</div>
      <TimedQuestion key={i} item={WARMUP_TRIVIA[i]} seconds={10} onDone={onTrivia} label={`${i + 1} of ${WARMUP_TRIVIA.length}`} />
    </div>
  );
}
/** QuestionRound that also reports elapsed time. */
function TimedQuestion(props) {
  const startRef = useRef(Date.now());
  return <QuestionRound {...props} onDone={(ok) => props.onDone(ok, (Date.now() - startRef.current) / 1000)} />;
}

/** 3. Result: solo reward tiers, or a live leaderboard when others onboarded at the same time. */
function WarmupResult() {
  const { go, user, why, warmup, warmupLive, setWarmup } = useApp();
  const w = warmup || { pts: 0, correct: 0, others: [] };
  const board = warmupLive ? [...w.others, { id: "me", pts: w.pts }].sort((a, b) => b.pts - a.pts) : null;
  const rank = board ? board.findIndex((b) => b.id === "me") : -1;
  const coins = warmupLive ? [500, 400, 300, 200][Math.min(rank, 3)] : (REWARD_TIERS.find(([min]) => w.pts >= min) || REWARD_TIERS[3])[1];
  const shown = useCountUp(coins, 1200);
  useEffect(() => { setWarmup((x) => ({ ...(x || {}), coins })); }, []);
  const QS = user.isBrand ? BRAND_QS : WARMUP_QS;
  const whyLabel = (QS[1].a.find((a) => a[2] === why) || [])[1];
  const tags = [...user.interests.slice(0, 3), whyLabel];
  const nextTier = REWARD_TIERS.filter(([min]) => min > w.pts).pop();
  return (
    <div className="flex-1 flex flex-col relative" style={{ background: B.green }}>
      <Confetti />
      <Screen>
        <div className="pt-8 text-center">
          <div className="flex justify-center -space-x-3 pop">{warmupLive ? board.slice(0, 3).map((b) => b.id === "me" ? <Avatar key="me" me size={60} ring={B.green} /> : <Avatar key={b.id} id={b.id} size={52} ring={B.green} />) : <Avatar me size={72} ring={B.green} />}</div>
          <H size={30} className="mt-4">{warmupLive ? (rank === 0 ? "You topped your round." : `You came ${["1st", "2nd", "3rd", "4th"][rank]} of ${board.length}.`) : `${w.correct}/${WARMUP_TRIVIA.length} right · ${w.pts} points`}</H>
          <Sub className="mt-1" color={B.navy}>{warmupLive ? `${w.correct}/${WARMUP_TRIVIA.length} right, ${w.pts} points. Everyone in the round gets paid.` : nextTier ? `${nextTier[0] - w.pts} more points would have paid ${nextTier[1]} coins.` : "Top tier. Fast and right on everything."}</Sub>
        </div>
        {warmupLive && (
          <Card className="mt-5 overflow-hidden">
            {board.map((b, i) => (
              <div key={b.id} className="flex items-center gap-3 px-4 py-2.5" style={{ borderTop: i ? `1px solid ${B.line}` : "none", background: b.id === "me" ? B.blueSoft : "#fff" }}>
                <span className="w-5 f-display text-sm" style={{ color: i === 0 ? B.amber : B.text3 }}>{i + 1}</span>{b.id === "me" ? <Avatar me size={28} /> : <Avatar id={b.id} size={28} />}
                <span className="flex-1 text-sm font-semibold" style={{ color: B.navy }}>{b.id === "me" ? "You" : "New player"}</span><span className="text-xs" style={{ color: B.text2 }}>{b.pts} pts</span><span className="text-xs font-bold" style={{ color: B.greenDeep }}>+{[500, 400, 300, 200][Math.min(i, 3)]}</span>
              </div>
            ))}
          </Card>
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">{tags.filter(Boolean).map((t, i) => <span key={t} className="slide-up rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(255,255,255,0.45)", color: B.navy, animationDelay: `${i * 0.1}s` }}>{t}</span>)}</div>
        <div className="mt-5 mx-auto rounded-3xl px-6 py-4 flex items-center gap-4" style={{ background: B.navy, width: "fit-content" }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(43,255,176,0.15)" }}><Gift size={24} color={B.lime} /></div>
          <div className="text-left"><div className="f-display text-white" style={{ fontSize: 30 }}>+{shown}</div><div className="text-xs font-semibold" style={{ color: B.blueMid }}>{user.isBrand ? "coins toward your first pot" : why === "grinder" ? `coins · ${Math.floor(coins / PAYOUT.entryCoins)} Payout runs` : "coins for your first parties"}</div></div>
        </div>
        <div className="h-4" />
      </Screen>
      <div className="px-5 pb-8 flex flex-col gap-2">
        <Btn full tone="navy" onClick={() => go("phone")}>{user.isBrand ? "Keep my coins and brand profile" : "Keep my coins and profile"}</Btn>
        <div className="text-center text-xs font-medium" style={{ color: B.navy, opacity: 0.7 }}>Takes 10 seconds. Phone number only.</div>
      </div>
    </div>
  );
}

/** 4. Phone + code: one job each, keypad already open. */
function PhoneScreen() {
  const { go, user, setUser, warmup } = useApp();
  const ok = user.phone.replace(/\D/g, "").length >= 10;
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"];
  const type = (k) => setUser({ ...user, phone: k === "⌫" ? user.phone.slice(0, -1) : (user.phone + k).slice(0, 10) });
  return (
    <>
      <TopBar title="" />
      <Screen>
        <H>Keep your {warmup?.coins ?? 300} coins and your score.</H>
        <div className="mt-6 flex gap-2 items-center">
          <div className="rounded-2xl px-4 py-4 font-semibold" style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}`, color: B.navy }}>🇳🇬 +234</div>
          <div className="flex-1 rounded-2xl px-4 py-4 f-display text-xl tracking-wider" style={{ background: "#fff", boxShadow: `inset 0 0 0 2px ${ok ? B.green : B.line}`, color: user.phone ? B.navy : B.text3 }}>{user.phone || "803 000 0000"}</div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-6">{keys.map((k, i) => <button key={i} disabled={k === ""} onClick={() => type(k)} className="h-14 rounded-2xl text-xl font-semibold active:scale-95" style={{ background: k === "" ? "transparent" : "#fff", color: B.navy }}>{k}</button>)}</div>
      </Screen>
      <div className="p-5"><Btn full disabled={!ok} onClick={() => go("otp")}>Text me a code</Btn></div>
    </>
  );
}
function OtpScreen() {
  const { go, setWallet, addTxn } = useApp();
  const [code, setCode] = useState("");
  const claimed = useRef(false);
  const { warmup, user } = useApp();
  useEffect(() => { if (code.length === 4 && !claimed.current) { claimed.current = true; const c = warmup?.coins ?? 300; setWallet((w) => ({ ...w, bonus: w.bonus + c })); addTxn({ label: "Warm-up party winnings", amount: c, kind: "bonus" }); setTimeout(() => go(user.isBrand ? "profile" : "people"), 350); } }, [code]);
  return (
    <>
      <TopBar title="" />
      <Screen>
        <H>Enter the code</H><Sub className="mt-2">Sent to +234 {user.phone}</Sub>
        <div className="mt-6 flex gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="w-14 h-16 rounded-2xl flex items-center justify-center f-display text-2xl" style={{ background: "#fff", color: B.navy, boxShadow: `inset 0 0 0 2px ${code.length === i ? B.blue : B.line}` }}>{code[i] || ""}</div>)}</div>
        <div className="grid grid-cols-3 gap-2 mt-8">{[1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((k, i) => <button key={i} disabled={k === ""} onClick={() => setCode(k === "⌫" ? code.slice(0, -1) : (code + k).slice(0, 4))} className="h-14 rounded-2xl text-xl font-semibold active:scale-95" style={{ background: k === "" ? "transparent" : "#fff", color: B.navy }}>{k}</button>)}</div>
      </Screen>
    </>
  );
}

/** 6. Interests: a tile wall, picks bounce into a row at the top. */
function InterestsScreen() {
  const { reset, user, setUser } = useApp();
  const toggle = (i) => setUser({ ...user, interests: user.interests.includes(i) ? user.interests.filter((x) => x !== i) : [...user.interests, i] });
  return (
    <>
      <TopBar title="" />
      <div className="px-5"><H>Your lanes</H></div>
      <div className="px-5 mt-3 flex gap-2 h-12 items-center">
        {[0, 1, 2].map((k) => user.interests[k] ? <div key={k} className="pop rounded-full px-3 py-2 text-sm font-semibold flex items-center gap-1.5" style={{ background: B.navy, color: "#fff" }}>{INTEREST_ICONS[user.interests[k]]} {user.interests[k]}</div> : <div key={k} className="w-20 h-9 rounded-full" style={{ boxShadow: `inset 0 0 0 1.5px ${B.line}` }} />)}
        {user.interests.length > 3 && <span className="text-xs font-semibold" style={{ color: B.text2 }}>+{user.interests.length - 3}</span>}
      </div>
      <Screen>
        <div className="grid grid-cols-3 gap-2 mt-3 mb-4">
          {INTERESTS.map((i) => { const on = user.interests.includes(i); return (
            <button key={i} onClick={() => toggle(i)} className="rounded-2xl p-3 text-left active:scale-95 transition" style={{ background: on ? B.blue : "#fff", boxShadow: on ? "none" : `inset 0 0 0 1.5px ${B.line}`, minHeight: 84 }}>
              <div className="text-2xl">{INTEREST_ICONS[i]}</div><div className="mt-2 text-xs font-semibold leading-tight" style={{ color: on ? "#fff" : B.navy }}>{i}</div>
            </button>); })}
        </div>
      </Screen>
      <div className="p-5"><Btn full disabled={user.interests.length < 1} onClick={() => reset("me")}>Save</Btn></div>
    </>
  );
}

/** 7. Your people: contacts orbit you; brands in your lanes are pre-followed. */
function PeopleScreen() {
  const { go, user, following, setFollowing, toggleFollow, openProfile } = useApp();
  const contacts = ["tunde", "ada", "segun", "chidi"];
  const brands = ["beats", "jollof", "quiz"].filter((b) => PEOPLE[b].cats.some((c) => user.interests.includes(c))).concat(["beats", "jollof", "quiz"]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
  const seeded = useRef(false);
  useEffect(() => { if (!seeded.current) { seeded.current = true; setFollowing((f) => [...new Set([...f, ...brands])]); } }, []);
  const allOn = contacts.every((c) => following.includes(c));
  return (
    <>
      <TopBar title="" right={<button className="text-sm font-semibold px-2" style={{ color: B.text2 }} onClick={() => go("profile")}>Skip</button>} />
      <div className="px-5"><H>{contacts.length} of your contacts are here</H></div>
      <div className="relative mx-auto mt-4" style={{ width: 220, height: 180 }}>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"><Avatar me size={64} ring={B.blue} /></div>
        {contacts.map((id, i) => { const a = (i / contacts.length) * Math.PI * 2 - Math.PI / 2; const on = following.includes(id); return (
          <button key={id} onClick={() => toggleFollow(id)} className="absolute drift" style={{ left: 110 + Math.cos(a) * 80 - 24, top: 90 + Math.sin(a) * 65 - 24, animationDelay: `${i * 0.1}s`, opacity: on ? 1 : 0.45 }}>
            <div className="relative"><Avatar id={id} size={48} ring={on ? B.green : "#fff"} />{on && <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: B.green }}><Check size={12} color={B.navy} strokeWidth={3} /></span>}</div>
          </button>); })}
      </div>
      <div className="px-5 mt-2"><Btn full tone={allOn ? "soft" : "blue"} onClick={() => setFollowing(allOn ? following.filter((x) => !contacts.includes(x)) : [...new Set([...following, ...contacts])])}>{allOn ? "Following all 4" : "Follow all"}</Btn></div>
      <Screen>
        <div className="mt-5 text-xs font-semibold" style={{ color: B.text3 }}>BRANDS THAT HOST IN YOUR LANES</div>
        {brands.map((id) => (
          <div key={id} className="flex items-center gap-3 py-2.5">
            <button onClick={() => openProfile(id)} className="flex items-center gap-3 flex-1 min-w-0 text-left"><Avatar id={id} size={40} /><div className="min-w-0"><div className="text-sm truncate" style={{ color: B.navy }}><Name id={id} /></div><div className="text-xs" style={{ color: B.text2 }}>{PEOPLE[id].cats.join(" · ")} · {fmtCount(PEOPLE[id].followers)} followers</div></div></button>
            <button onClick={() => toggleFollow(id)} className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: following.includes(id) ? B.blue : B.soft }}>{following.includes(id) ? <BellRing size={16} color="#fff" /> : <Bell size={16} color={B.text2} />}</button>
          </div>
        ))}
        <div className="h-4" />
      </Screen>
      <div className="p-5"><Btn full onClick={() => go("profile")}>Continue</Btn></div>
    </>
  );
}

/** 8. Name and face: one screen, avatar cycles on tap, handle previewed as a chat tag. */
function ProfileScreen() {
  const { go, user, setUser, entry, reset, joinParty, parties, wallet } = useApp();
  const palette = [B.blue, "#7C3AED", B.greenDeep, "#F97316", B.red, B.navy];
  const [ci, setCi] = useState(0);
  return (
    <>
      <TopBar title="" />
      <Screen>
        <H>{user.isBrand ? "Brand name and logo" : "Name and face"}</H>
        <div className="mt-6 flex flex-col items-center">
          <button onClick={() => setCi((ci + 1) % palette.length)} className="relative active:scale-95 transition">
            <div className="rounded-full flex items-center justify-center f-display text-white pop" key={ci} style={{ width: 92, height: 92, background: palette[ci], fontSize: 34 }}>{initials(user.name || "You")}</div>
            <span className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#fff", boxShadow: `0 0 0 1.5px ${B.line}` }}><ImageIcon size={14} color={B.navy} /></span>
          </button>
          <div className="text-xs mt-2" style={{ color: B.text3 }}>Tap to change colour, or add a photo</div>
        </div>
        <Input value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value, handle: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") })} placeholder={user.isBrand ? "Brand name" : "Your name"} className="mt-6 text-lg" autoFocus />
        <div className="mt-3 flex items-center rounded-2xl px-4" style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}` }}>
          <AtSign size={16} color={B.text3} /><input value={user.handle} onChange={(e) => setUser({ ...user, handle: e.target.value.toLowerCase() })} placeholder="username" className="flex-1 py-3.5 pl-1 font-medium outline-none" style={{ color: B.navy }} />{user.handle.length > 2 && <Check size={18} color={B.green} />}
        </div>
        {user.handle.length > 2 && <div className="mt-4 flex gap-2 items-end slide-up"><Avatar id="kemi" size={26} /><div className="rounded-2xl px-3 py-2 text-sm" style={{ background: "#fff", color: B.ink, boxShadow: `0 0 0 1px ${B.line}`, borderBottomLeftRadius: 6 }}><b style={{ color: B.blue }}>@{user.handle}</b> rematch tonight? 😤</div></div>}
      </Screen>
      <div className="p-5"><Btn full disabled={user.handle.length < 3} onClick={() => { if (user.isBrand) return go("brandSetup"); if (entry.kind === "invite") { const p = parties.find((x) => x.id === entry.party); if (wallet.bonus + wallet.cash >= p.entry) joinParty(p); reset("lobby", { party: entry.party }); } else reset("home"); }}>{user.isBrand ? "Continue" : entry.kind === "invite" ? "Done · join the party" : "Done · go to home"}</Btn></div>
    </>
  );
}

/** 9b. Brand verification: what's still needed before the badge, and what they can do meanwhile. */
function BrandSetup() {
  const { user, setUser, reset, toast } = useApp();
  const items = [["rc", "Business registration", "CAC RC or BN number", ShieldCheck], ["logo", "Logo", "Square PNG, replaces your initials", ImageIcon], ["site", "Website or Instagram", "So players can check you're real", Globe], ["email", "Business email", "For prize confirmations and disputes", AtSign], ["bank", "Payout account", "Only needed if you give away cash", Wallet]];
  const done = user.verification || {};
  const count = items.filter(([k]) => done[k]).length; const required = items.filter(([k]) => k !== "bank").every(([k]) => done[k]);
  const mark = (k) => { setUser({ ...user, verification: { ...done, [k]: true } }); toast(k === "rc" ? "RC number saved. We check it against CAC." : "Saved"); };
  return (
    <>
      <TopBar title="" onBack={() => reset("home")} right={<span className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: required ? B.greenSoft : "#FFF4D6", color: required ? B.greenDeep : "#B7791F" }}>{required ? "Under review · 1–2 days" : `${count}/${items.length} done`}</span>} />
      <Screen>
        <div className="flex items-center gap-3"><Avatar me size={56} /><div><div className="text-lg font-semibold flex items-center gap-1.5" style={{ color: B.navy }}>{user.name}<BadgeCheck size={18} color={B.text3} /></div><div className="text-xs" style={{ color: B.text2 }}>@{user.handle} · Verification pending</div></div></div>
        <H size={24} className="mt-5">Get the blue tick.</H>
        <Sub className="mt-1">You can host parties now with coins. Cash and product prizes unlock once you're verified.</Sub>
        <Card className="mt-4 overflow-hidden">
          {items.map(([k, t, sub, I], i) => (
            <div key={k} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: done[k] ? B.green : B.blueSoft }}>{done[k] ? <Check size={16} color={B.navy} strokeWidth={3} /> : <I size={16} color={B.blue} />}</div>
              <div className="flex-1 min-w-0"><div className="text-sm font-semibold" style={{ color: B.navy }}>{t}{k === "bank" && <span className="ml-1 text-xs font-medium" style={{ color: B.text3 }}>optional</span>}</div><div className="text-xs" style={{ color: B.text2 }}>{sub}</div></div>
              {!done[k] && <Btn small tone="soft" onClick={() => mark(k)}>Add</Btn>}
            </div>
          ))}
        </Card>
        <Card className="mt-3 p-4">
          <div className="flex items-center justify-between"><div className="text-sm font-semibold" style={{ color: B.navy }}>Team</div><span className="text-xs" style={{ color: B.text3 }}>{1 + (user.team || []).length} {1 + (user.team || []).length === 1 ? "person" : "people"}</span></div>
          <Sub className="mt-1">Anyone on the team can host for {user.name}. Parties show the brand as host, and we keep who set each one up.</Sub>
          <div className="mt-3 flex items-center gap-2"><Avatar me size={28} /><span className="text-sm flex-1" style={{ color: B.navy }}>You · Owner</span></div>
          {(user.team || []).map((t) => <div key={t} className="mt-2 flex items-center gap-2"><Avatar id={t} size={28} /><span className="text-sm flex-1" style={{ color: B.navy }}>{PEOPLE[t].name} · Host</span></div>)}
          <div className="mt-3 flex gap-2"><Input placeholder="@username or phone" className="flex-1 py-2.5 text-sm" /><Btn small tone="soft" onClick={() => { setUser({ ...user, team: [...(user.team || []), ["ada", "segun", "chidi"][(user.team || []).length % 3]] }); toast("Invite sent"); }}>Invite</Btn></div>
        </Card>
        <Card className="mt-3 p-4" style={{ background: "#FFF7ED", boxShadow: "none" }}><div className="text-sm font-semibold" style={{ color: B.navy }}>Prizes don't have to be cash</div><Sub className="mt-1">Define anything: a product, a voucher, a day's shopping, dinner for two. You set the item, its value and how it's delivered. We handle the winner, the proof and the nudges.</Sub></Card>
        <div className="h-4" />
      </Screen>
      <div className="p-5 flex flex-col gap-2">
        <Btn full onClick={() => reset("create", { brandFirst: true })} icon={<Plus size={16} />}>Set up your first party</Btn>
        <Btn full tone="line" onClick={() => reset("home")}>{required ? "Done, go to home" : "Finish this later"}</Btn>
      </div>
    </>
  );
}


function FollowRow({ id, compact }) {
  const { following, toggleFollow, openProfile } = useApp();
  const on = following.includes(id); const p = PEOPLE[id];
  return (
    <div className="flex items-center gap-3 py-2.5">
      <button onClick={() => openProfile(id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
        <Avatar id={id} size={compact ? 38 : 44} />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate" style={{ color: B.navy }}><Name id={id} /></div>
          <div className="text-xs" style={{ color: B.text2 }}>@{p.handle} · {fmtCount(p.followers)} followers</div>
        </div>
      </button>
      <Btn small tone={on ? "soft" : "blue"} onClick={() => toggleFollow(id)}>{on ? "Following" : "Follow"}</Btn>
    </div>
  );
}

/* =========================================================
   Shell: tab bar + wallet pill
   ========================================================= */
function TabBar() {
  const { screen, reset, notifs } = useApp();
  const unread = notifs.filter((n) => n.unread).length;
  const { dms } = useApp();
  const tabs = [{ id: "home", icon: HomeIcon, label: "Home" }, { id: "discover", icon: Compass, label: "Parties" }, { id: "create", icon: Plus }, { id: "chats", icon: MessageCircle, label: "Chats", badge: Object.keys(dms).length + unread }, { id: "me", icon: User, label: "Me" }];
  return (
    <div className="flex items-end justify-around px-2 pt-2 pb-4" style={{ background: "#fff", borderTop: `1px solid ${B.line}` }}>
      {tabs.map((t) => t.id === "create" ? (
        <button key={t.id} aria-label="Start a party" onClick={() => reset("create")} className="w-14 h-14 -mt-6 rounded-full flex items-center justify-center active:scale-95" style={{ background: B.blue, boxShadow: "0 8px 20px rgba(11,100,252,0.35)" }}><Plus size={26} color="#fff" strokeWidth={2.6} /></button>
      ) : (
        <button key={t.id} onClick={() => reset(t.id)} className="relative flex flex-col items-center gap-0.5 w-14">
          <t.icon size={22} color={screen === t.id ? B.blue : B.text3} strokeWidth={screen === t.id ? 2.4 : 2} />
          <span className="font-semibold" style={{ color: screen === t.id ? B.blue : B.text3, fontSize: 11 }}>{t.label}</span>
          {t.badge > 0 && <span className="absolute -top-1 right-2 w-5 h-5 rounded-full font-bold flex items-center justify-center" style={{ background: B.red, color: "#fff", fontSize: 10 }}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
function WalletPill({ dark }) {
  const { wallet, go } = useApp();
  return (
    <button onClick={() => go("wallet")} className="flex items-center gap-2 rounded-full pl-3 pr-3 py-1.5" style={{ background: dark ? "rgba(255,255,255,0.08)" : "#fff", boxShadow: dark ? "inset 0 0 0 1px rgba(255,255,255,0.12)" : `inset 0 0 0 1.5px ${B.line}` }}>
      <span className="text-sm font-semibold" style={{ color: dark ? "#fff" : B.blue }}>{wallet.bonus} coins</span>
      <span className="w-px h-4" style={{ background: dark ? "rgba(255,255,255,0.15)" : B.line }} />
      <span className="text-sm font-semibold" style={{ color: dark ? B.lime : B.greenDeep }}>{naira(wallet.cash)}</span>
    </button>
  );
}

/* =========================================================
   Social proof + progression primitives
   ========================================================= */
function Ticker() {
  const { openProfile } = useApp();
  const items = [...TICKER, ...TICKER];
  return (
    <div className="overflow-hidden" style={{ maskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)" }}>
      <div className="flex gap-6 ticker whitespace-nowrap" style={{ width: "max-content" }}>
        {items.map(([who, t], i) => (
          <button key={i} onClick={() => openProfile(who)} className="flex items-center gap-2 text-xs font-medium" style={{ color: B.blueMid }}>
            <Avatar id={who} size={18} /><b className="text-white">{PEOPLE[who].name.split(" ")[0]}</b> {t}
          </button>
        ))}
      </div>
    </div>
  );
}
function LevelRing({ xp, size = 44 }) {
  const { user } = useApp();
  const level = Math.floor(xp / 500) + 1; const pct = (xp % 500) / 500;
  const r = (size - 6) / 2; const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.15)" strokeWidth="3" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={B.green} strokeWidth="3" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round" style={{ transition: "stroke-dashoffset .6s" }} />
      </svg>
      <div className="absolute inset-1.5 rounded-full flex items-center justify-center f-display text-white" style={{ background: B.blue, fontSize: size * 0.32 }}>{initials(user.name || "You")}</div>
      <div className="absolute -bottom-1 -right-1 rounded-full px-1.5 f-display" style={{ background: B.green, color: B.navy, fontSize: 10, lineHeight: "16px" }}>L{level}</div>
    </div>
  );
}
function MissionRow({ m, dark }) {
  const pct = Math.min(1, m.done / m.total); const done = m.done >= m.total;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: done ? B.green : dark ? "rgba(255,255,255,0.08)" : B.blueSoft }}>{done ? <Check size={18} color={B.navy} strokeWidth={3} /> : <Target size={18} color={dark ? B.lime : B.blue} />}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate" style={{ color: dark ? "#fff" : B.navy }}>{m.title}</div>
        <div className="mt-1 h-1 rounded-full" style={{ background: dark ? "rgba(255,255,255,0.1)" : B.soft }}><div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: B.green }} /></div>
      </div>
      <div className="text-xs font-semibold shrink-0" style={{ color: done ? B.green : dark ? B.blueMid : B.text2 }}>{done ? "Claimed" : `+${m.reward} coins`}</div>
    </div>
  );
}
function useResetCountdown() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);
  const d = new Date(now); const end = new Date(d); end.setHours(24, 0, 0, 0);
  const mins = Math.max(0, Math.floor((end - d) / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/* =========================================================
   Home — the arena
   ========================================================= */
function Home() {
  const { go, parties: allParties, following, streak, seatsLeft, xp, dailyDone, dailyScore, wallet, user, archetype, openProfile, noParties, joined, toast } = useApp();
  const parties = noParties ? [] : allParties;
  const [mode, setMode] = useState(archetype === "grinder" ? "payout" : "party");
  const resets = useResetCountdown();
  const top = PAYOUT.stages[PAYOUT.stages.length - 1].prize;
  const friends = following.filter((f) => PEOPLE[f] && !PEOPLE[f].brand);
  const inParties = friends.filter((f) => parties.some((p) => p.players.includes(f) || p.host === f));
  const lane = user.interests[0];
  const laneParties = parties.filter((p) => user.interests.includes(p.cat));
  const laneBrand = following.find((f) => PEOPLE[f]?.brand && PEOPLE[f].cats.some((c) => user.interests.includes(c)));

  // The Party card never promotes one party. It talks about the mode, your people, and what to do now.
  const party = {
    competitor: { eyebrow: `${PEOPLE.kemi.name.split(" ")[0]} leads you ${PEOPLE.kemi.h2h[1]}–${PEOPLE.kemi.h2h[0]} this week`, title: "Settle it.", sub: inParties.length ? `${PEOPLE[inParties[0]].name.split(" ")[0]} is in a party right now.` : "Pick a rival, set the stakes, invite the crowd.", cta: ["Challenge Kemi", () => go("create", { with: "kemi" })], alt: parties.length ? ["Find a party", () => go("discover")] : ["Invite friends", () => go("me")] },
    host: { eyebrow: `${Math.max(friends.length, 4)} of your people are around`, title: "Get your people together.", sub: "You set the pot, the split and who's in. Everyone gets an alert.", cta: ["Start a party", () => go("create")], alt: parties.length ? ["Find a party", () => go("discover")] : ["Invite friends", () => go("me")] },
    grinder: { eyebrow: parties.length ? `${parties.length} parties open` : "Nothing open right now", title: "Play with friends when you fancy it.", sub: "Pooled pots, best score wins. Your coins work here too.", cta: parties.length ? ["Find a party", () => go("discover")] : ["Start one", () => go("create")], alt: ["Start one", () => go("create")] },
    fan: { eyebrow: lane ? `${lane} this week` : "Your lanes", title: laneBrand ? `${PEOPLE[laneBrand].name} hosts tonight.` : `${lane || "Your"} parties, your people.`, sub: laneParties.length ? `${laneParties.length} ${lane} ${laneParties.length === 1 ? "party" : "parties"} open now.` : `We'll alert you when a ${lane || "lane"} party opens.`, cta: laneParties.length ? [`Find ${lane} parties`, () => go("discover")] : ["Start one", () => go("create")], alt: ["Start one", () => go("create")] },
  }[archetype];
  if (user.isBrand) { const v = user.verification || {}; const verified = ["rc", "logo", "site", "email"].every((k) => v[k]); party.eyebrow = verified ? "Verified brand" : "Verification pending"; party.title = "Host your first party."; party.sub = "Cash, a product or an experience. You set it, players compete for it, we handle the winner."; party.cta = ["Start a party", () => go("create", { brandFirst: true })]; party.alt = verified ? ["See your parties", () => go("discover")] : ["Finish verification", () => go("brandSetup")]; }
  const empty = parties.length === 0;
  const filling = parties.find((p) => p.count / p.max >= 0.6 && p.startsIn <= 10);
  // Parties the user is already in, soonest first. The Party card becomes "your next party" when there is one.
  const mine = parties.filter((p) => joined.includes(p.id) || p.host === "me").sort((a, b) => a.startsIn - b.startsIn);
  const nextMine = mine[0];
  const joinedState = !nextMine ? null : nextMine.status === "live" ? "live" : nextMine.startsIn <= 2 ? "starting" : nextMine.startsIn <= 15 ? "soon" : "later";
  const [reminded, setReminded] = useState(false);

  return (
    <div className="flex-1 flex flex-col" style={{ background: `radial-gradient(120% 60% at 50% -10%, ${mode === "party" ? "rgba(11,100,252,0.55)" : "rgba(4,214,139,0.35)"}, transparent 60%), ${B.navyDeep}`, transition: "background .4s" }}>
      <div className="flex items-center gap-3 px-5 pt-4">
        <button onClick={() => go("me")}><LevelRing xp={xp} size={40} /></button>
        <button onClick={() => go("leaderboard")} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(255,255,255,0.08)", color: dailyDone ? B.lime : B.amber }}><Flame size={13} fill="currentColor" />{streak}</button>
        <div className="flex-1" />
        <button onClick={() => go("chats", { tab: "Activity" })} aria-label="Activity" className="relative w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.08)" }}><Bell size={16} color="#fff" /><span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full" style={{ background: B.red, boxShadow: `0 0 0 2px ${B.navyDeep}` }} /></button>
        <WalletPill dark />
      </div>

      <div className="mx-5 mt-4 rounded-full p-1 flex" style={{ background: "rgba(255,255,255,0.08)" }}>
        {[["party", user.isBrand ? "Host" : "Party", Users], ...(user.isBrand ? [] : [["payout", "Payout", Zap]])].map(([id, label, I]) => (
          <button key={id} onClick={() => setMode(id)} className="flex-1 rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 transition" style={{ background: mode === id ? "#fff" : "transparent", color: mode === id ? B.navy : B.blueMid }}><I size={15} />{label}</button>
        ))}
      </div>

      <div className="flex-1 flex flex-col px-5 pt-3 pb-3 min-h-0">
        {mode === "party" && nextMine && !user.isBrand ? (
          <div key={"mine" + nextMine.id + joinedState} className="flex-1 rounded-3xl p-5 flex flex-col relative overflow-hidden slide-up" style={{ background: joinedState === "live" || joinedState === "starting" ? `linear-gradient(170deg, ${B.greenDeep}, #056B47)` : `linear-gradient(170deg, ${B.electric}, ${B.blueDeep})`, boxShadow: joinedState === "live" || joinedState === "starting" ? "0 20px 50px rgba(4,214,139,0.35)" : "0 20px 50px rgba(11,100,252,0.35)" }}>
            <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold rounded-full px-2.5 py-1 flex items-center gap-1.5 text-white" style={{ background: "rgba(0,0,0,0.2)" }}><span className={`w-1.5 h-1.5 rounded-full ${joinedState !== "later" ? "pulse" : ""}`} style={{ background: joinedState === "later" ? B.blueMid : B.lime }} />{joinedState === "live" ? "LIVE NOW" : joinedState === "starting" ? "STARTING" : "YOU'RE IN"}</span>
              <span className="text-xs font-semibold text-white opacity-90">{nextMine.host === "me" ? "You're hosting" : <span className="inline-flex items-center gap-1">by <Name id={nextMine.host} bold={false} /></span>}</span>
            </div>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              {joinedState === "later" ? (
                <div className="flex -space-x-3 mb-4">{[...new Set([nextMine.host !== "me" && nextMine.host, ...nextMine.players])].filter(Boolean).slice(0, 4).map((id, i) => <div key={id} className="drift" style={{ animationDelay: `${i * 0.15}s` }}><Avatar id={id} size={52} ring={B.blueDeep} /></div>)}</div>
              ) : (
                <div className="mb-3 f-display text-white tabular-nums" style={{ fontSize: 56, lineHeight: 1 }}>{joinedState === "live" ? "GO" : `${String(nextMine.startsIn).padStart(2, "0")}:${["58", "31", "07"][nextMine.startsIn % 3]}`}</div>
              )}
              <H size={joinedState === "later" ? 28 : 24} color="#fff">{nextMine.title}</H>
              <div className="mt-2 text-sm text-white opacity-90 max-w-xs">{joinedState === "live" ? `${nextMine.count} playing. Jump in before the next question.` : joinedState === "starting" ? `${nextMine.count} in the room. Get in now.` : joinedState === "soon" ? `Starts in ${nextMine.startsIn} min · ${nextMine.count}/${nextMine.max} in · ${isCash(nextMine) ? "pot " + naira(potOf(nextMine)) : nextMine.prize.label}` : `Starts in ${nextMine.startsIn} min · ${nextMine.count}/${nextMine.max} in. ${nextMine.players.filter((x) => following.includes(x)).length ? `${PEOPLE[nextMine.players.find((x) => following.includes(x))].name.split(" ")[0]} is in.` : "Bring your people."}`}</div>
            </div>
            {joinedState === "later" && <div className="mb-2 grid grid-cols-2 gap-2"><button onClick={() => { setReminded(true); toast(reminded ? "Reminder off" : "We'll ping you 5 minutes before"); setReminded(!reminded); }} className="rounded-2xl px-3 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 text-white" style={{ background: reminded ? "rgba(43,255,176,0.25)" : "rgba(0,0,0,0.22)" }}>{reminded ? <BellRing size={14} color={B.lime} /> : <Bell size={14} />}{reminded ? "Reminder on" : "Remind me"}</button><button onClick={() => go("lobby", { party: nextMine.id })} className="rounded-2xl px-3 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 text-white" style={{ background: "rgba(0,0,0,0.22)" }}><Share2 size={14} />Invite</button></div>}
            <Btn full tone={joinedState === "later" ? "white" : "navy"} onClick={() => go(joinedState === "live" ? "partyGame" : "lobby", { party: nextMine.id })} icon={joinedState === "live" ? <Play size={16} fill="currentColor" /> : joinedState === "starting" ? <Zap size={16} /> : <MessageCircle size={16} />}>{joinedState === "live" ? "Join the round" : joinedState === "starting" ? "Enter the room" : "Open the lobby"}</Btn>
            {mine.length > 1 ? <button onClick={() => go("chats", { tab: "Parties" })} className="mt-2 text-xs font-semibold text-white opacity-90 py-1">+{mine.length - 1} more {mine.length - 1 === 1 ? "party" : "parties"} you're in</button> : <button onClick={() => go("discover")} className="mt-2 text-xs font-semibold text-white opacity-90 py-1">Find another party</button>}
          </div>
        ) : mode === "party" ? (
          <div key={"party" + archetype} className="flex-1 rounded-3xl p-5 flex flex-col relative overflow-hidden slide-up" style={{ background: `linear-gradient(170deg, ${B.electric}, ${B.blueDeep})`, boxShadow: "0 20px 50px rgba(11,100,252,0.35)" }}>
            <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold rounded-full px-2.5 py-1 flex items-center gap-1.5 text-white" style={{ background: "rgba(0,0,0,0.2)" }}>{empty ? <span className="w-1.5 h-1.5 rounded-full" style={{ background: B.amber }} /> : <span className="w-1.5 h-1.5 rounded-full pulse" style={{ background: B.lime }} />}{empty ? "No parties open" : `${parties.length} open now`}</span>
              <span className="text-xs font-semibold text-white opacity-90">{party.eyebrow}</span>
            </div>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <div className="flex -space-x-3 mb-4">{(inParties.length ? inParties : friends.length ? friends : ["kemi", "tunde", "ada", "zainab"]).slice(0, 4).map((id, i) => <div key={id} className="drift relative" style={{ animationDelay: `${i * 0.15}s` }}><Avatar id={id} size={52} ring={B.blueDeep} />{inParties.includes(id) && <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full" style={{ background: B.lime, boxShadow: `0 0 0 2px ${B.blueDeep}` }} />}</div>)}</div>
              <H size={30} color="#fff">{party.title}</H>
              <div className="mt-2 text-sm text-white opacity-90 max-w-xs">{party.sub}</div>
            </div>
            {filling && !user.isBrand && <button onClick={() => go("lobby", { party: filling.id })} className="mb-2 w-full rounded-2xl px-3 py-2 flex items-center gap-2 text-left" style={{ background: "rgba(0,0,0,0.22)" }}><span className="w-1.5 h-1.5 rounded-full pulse shrink-0" style={{ background: B.lime }} /><span className="flex-1 text-xs text-white truncate"><b>{filling.title}</b> is filling up · {filling.max - filling.count} seats · {filling.startsIn}m</span><ArrowRight size={14} color="#fff" /></button>}
            <Btn full tone="white" onClick={party.cta[1]} icon={party.cta[0].startsWith("Challenge") ? <Swords size={16} /> : party.cta[0].startsWith("Start") ? <Plus size={16} /> : null}>{party.cta[0]}</Btn>
            <button onClick={party.alt[1]} className="mt-2 text-xs font-semibold text-white opacity-90 py-1">{party.alt[0]}</button>
          </div>
        ) : (
          <div key="payout" className="flex-1 rounded-3xl p-5 flex flex-col relative overflow-hidden slide-up" style={{ background: `linear-gradient(170deg, #0B2A5C, ${B.navy})`, boxShadow: `inset 0 0 0 1px rgba(43,255,176,0.3), 0 20px 50px rgba(4,214,139,0.2)` }}>
            <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full" style={{ background: "rgba(4,214,139,0.15)", filter: "blur(16px)" }} />
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold rounded-full px-2.5 py-1" style={{ background: "rgba(43,255,176,0.15)", color: B.lime }}>{seatsLeft} seats left this week</span>
              <span className="text-xs font-semibold" style={{ color: B.blueMid }}>{archetype === "grinder" ? "your best: stage 1" : `${PAYOUT.entryCoins} coins to enter`}</span>
            </div>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <div className="text-xs font-semibold tracking-wide" style={{ color: B.lime }}>{PAYOUT.stages.length} STAGES · WALK AWAY ANY TIME</div>
              <H size={26} color="#fff" className="mt-3">{archetype === "grinder" ? "Beat your best: stage 2." : "How far can you climb?"}</H>
              <div className="text-xs font-semibold mt-1" style={{ color: B.blueMid }}>Puzzles get harder each stage. Prizes go up to {naira(top)}.</div>
              <div className="mt-5 w-full"><Ladder held={archetype === "grinder" ? 0 : -1} current={archetype === "grinder" ? 1 : -1} /></div>
            </div>
            <Btn full tone="green" onClick={() => go("payoutIntro")} icon={<Zap size={16} />}>Take a seat</Btn>
            <div className="mt-2 text-center text-xs font-semibold" style={{ color: B.blueMid }}>{wallet.bonus} coins = {Math.floor(wallet.bonus / PAYOUT.entryCoins)} runs</div>
          </div>
        )}

        {/* Today's challenge as a quest marker */}
        <button onClick={() => go(dailyDone ? "dailyResult" : "daily", dailyDone ? { score: dailyScore, time: "20.4s" } : {})} className="mt-3 rounded-2xl px-4 py-2.5 flex items-center gap-3 text-left active:scale-95 transition" style={{ background: dailyDone ? "rgba(255,255,255,0.06)" : B.green }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: dailyDone ? "rgba(43,255,176,0.15)" : "rgba(255,255,255,0.3)" }}>{dailyDone ? <Check size={16} color={B.lime} strokeWidth={3} /> : <Sparkles size={16} color={B.navy} />}</div>
          <div className="flex-1 min-w-0 text-sm font-semibold" style={{ color: dailyDone ? "#fff" : B.navy }}>{dailyDone ? `Today's challenge · ${dailyScore}/${DAILY_QS.length} · new in ${resets}` : `Today's challenge · ${PEOPLE[DAILY_FRIENDS[0][0]].name.split(" ")[0]} leads with ${DAILY_FRIENDS[0][1]}/${DAILY_QS.length}`}</div>
          <div className="flex -space-x-2">{DAILY_FRIENDS.slice(0, 3).map(([id]) => <Avatar key={id} id={id} size={22} ring={dailyDone ? B.navyDeep : B.green} />)}</div>
        </button>

        {/* Friends: three lines of what they did. Tappable. Scrolls if there's more. */}
        <div className="mt-3 flex items-center justify-between px-1"><span className="text-xs font-semibold" style={{ color: B.blueMid }}>Friends</span><button onClick={() => go("chats", { tab: "Activity" })} className="text-xs font-semibold" style={{ color: B.lime }}>All</button></div>
        <div className="mt-1 flex flex-col gap-1">
          {[["kemi", "cleared stage 3 of the Payout Challenge", "2m", () => openProfile("kemi")], inParties.length ? [inParties[0], `is in ${parties.find((p) => p.players.includes(inParties[0]) || p.host === inParties[0])?.title}`, "now", () => go("lobby", { party: parties.find((p) => p.players.includes(inParties[0]) || p.host === inParties[0]).id })] : ["tunde", "beat Segun 3–1 in a rematch", "40m", () => openProfile("tunde")], ["ada", `scored ${DAILY_FRIENDS[1][1]}/${DAILY_QS.length} on today's challenge`, "1h", () => go("daily")]].map(([id, t, time, fn], i) => (
            <button key={i} onClick={fn} className="flex items-center gap-2.5 px-1 py-1 text-left"><Avatar id={id} size={24} /><span className="flex-1 text-xs truncate" style={{ color: "#fff" }}><b>{PEOPLE[id].name.split(" ")[0]}</b> {t}</span><span className="text-xs" style={{ color: B.blueMid }}>{time}</span></button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Messages: one-to-one chat between people. Text, emoji, voice notes. Same composer as party chat. */
function Messages() {
  const { go, dms, params, parties, joined, chats } = useApp();
  const [tab, setTab] = useState(params.tab || "Messages");
  const rows = Object.entries(dms).sort((a, b) => (b[1].at(-1)?.id || 0) - (a[1].at(-1)?.id || 0));
  const myParties = parties.filter((p) => joined.includes(p.id) || ["p1", "p2"].includes(p.id));
  return (
    <>
      <div className="px-5 pt-4 pb-2"><H size={26}>Chats</H></div>
      <div className="px-5 flex gap-2">{["Messages", "Parties", "Activity"].map((t) => <Chip key={t} active={tab === t} onClick={() => setTab(t)}>{t}</Chip>)}</div>
      {tab === "Activity" && <ActivityBody />}
      {tab === "Parties" && <Screen><Card className="mt-3 overflow-hidden">{myParties.map((p, i) => { const last = (chats[p.id] || []).at(-1); return (
        <button key={p.id} onClick={() => go("lobby", { party: p.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}><div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center" style={{ background: p.cover }}><Users size={16} color="#fff" /></div><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate" style={{ color: B.navy }}>{p.title}</div><div className="text-xs truncate" style={{ color: B.text2 }}>{last ? (last.system ? last.text : last.sticker || last.text || "🎤 Voice note") : `${p.count} in · starts in ${p.startsIn}m`}</div></div><span className="text-xs" style={{ color: B.text3 }}>{p.startsIn}m</span></button>); })}</Card></Screen>}
      {tab === "Messages" && <Screen>
        <Card className="mt-3 overflow-hidden">
          {rows.length ? rows.map(([id, thread], i) => { const last = thread.at(-1); return (
            <button key={id} onClick={() => go("thread", { id })} className="w-full flex items-center gap-3 px-4 py-3 text-left" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}>
              <Avatar id={id} size={40} /><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate" style={{ color: B.navy }}><Name id={id} /></div><div className="text-xs truncate" style={{ color: B.text2 }}>{last?.voice ? `🎤 Voice note · ${last.seconds}s` : last?.sticker || last?.text}</div></div><span className="text-xs" style={{ color: B.text3 }}>{last?.time || "now"}</span>
            </button>); }) : <div className="p-6 text-center text-sm" style={{ color: B.text2 }}>No messages yet. Open someone's profile and tap Message.</div>}
        </Card>
      </Screen>}
    </>
  );
}
function Thread() {
  const { params, dms, sendDm, openProfile, go } = useApp();
  const id = params.id; const msgs = dms[id] || []; const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length]);
  return (
    <>
      <TopBar title="" right={<Btn small tone="soft" onClick={() => go("create", { with: id })} icon={<Swords size={14} />}>Challenge</Btn>} />
      <button onClick={() => openProfile(id)} className="px-5 pb-3 flex items-center gap-3 text-left"><Avatar id={id} size={40} /><div><div className="text-sm font-semibold" style={{ color: B.navy }}><Name id={id} /></div><div className="text-xs" style={{ color: B.text2 }}>@{PEOPLE[id].handle} · {PEOPLE[id].h2h ? `${PEOPLE[id].h2h[0]}–${PEOPLE[id].h2h[1]} head to head` : "brand"}</div></div></button>
      <Screen>
        <div className="py-3 flex flex-col gap-2.5">
          {msgs.map((m) => { const mine = m.who === "me"; return (
            <div key={m.id} className={`flex gap-2 items-end ${mine ? "flex-row-reverse" : ""}`}>
              {mine ? <Avatar me size={26} /> : <Avatar id={id} size={26} />}
              {m.voice ? <VoiceBubble m={m} mine={mine} /> : m.sticker ? <div className="text-5xl pop">{m.sticker}</div> : <div className="max-w-xs rounded-2xl px-3 py-2 text-sm" style={{ background: mine ? B.blue : "#fff", color: mine ? "#fff" : B.ink, borderBottomRightRadius: mine ? 6 : 16, borderBottomLeftRadius: mine ? 16 : 6, boxShadow: mine ? "none" : `0 0 0 1px ${B.line}` }}>{m.text}</div>}
            </div>); })}
          <div ref={endRef} />
        </div>
      </Screen>
      <Composer onSend={(payload) => sendDm(id, payload)} placeholder={`Message ${PEOPLE[id].name.split(" ")[0]}`} />
      <div className="pb-3" style={{ background: B.bg }} />
    </>
  );
}

/* In-app nudge: what a push notification carries, shown as a banner when the app is open. Fired by the same events the worker will own. */
function Nudge() {
  const { nudge, setNudge, go } = useApp();
  useEffect(() => { if (!nudge) return; const t = setTimeout(() => setNudge(null), 6000); return () => clearTimeout(t); }, [nudge]);
  if (!nudge) return null;
  return (
    <button onClick={() => { setNudge(null); go(nudge.go.screen, nudge.go); }} className="absolute left-3 right-3 top-3 z-50 rounded-2xl p-3 flex items-center gap-3 text-left slide-up" style={{ background: "rgba(5,25,62,0.96)", boxShadow: "0 12px 30px rgba(5,25,62,0.35)" }}>
      {nudge.who ? <Avatar id={nudge.who} size={36} /> : <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(43,255,176,0.15)" }}><Mark size={22} /></div>}
      <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-white truncate">{nudge.title}</div><div className="text-xs truncate" style={{ color: B.blueMid }}>{nudge.body}</div></div>
      <span className="text-xs font-semibold rounded-full px-2.5 py-1 shrink-0" style={{ background: B.green, color: B.navy }}>{nudge.cta}</span>
    </button>
  );
}

/* Leaderboard: friends by default, global behind a tab. Reached from the streak chip. */
function Leaderboard() {
  const { openProfile, go, xp } = useApp();
  const [tab, setTab] = useState("Friends");
  const rows = tab === "Friends" ? [["kemi", 1840], ["ada", 1210], ["tunde", 980], ["zainab", 760], ["segun", 410]] : [["quiz", 9120], ["kemi", 1840], ["beats", 1500], ["ada", 1210], ["chidi", 1100]];
  return (
    <>
      <TopBar title="This week" />
      <div className="px-5 flex gap-2"><Chip active={tab === "Friends"} onClick={() => setTab("Friends")}>Friends</Chip><Chip active={tab === "Everyone"} onClick={() => setTab("Everyone")}>Everyone</Chip></div>
      <Screen>
        <Card className="mt-3 overflow-hidden">
          {rows.map(([id, pts], i) => { const h = PEOPLE[id].h2h; return (
            <div key={id} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}>
              <span className="w-5 f-display text-sm" style={{ color: i === 0 ? B.amber : B.text3 }}>{i + 1}</span>
              <button onClick={() => openProfile(id)} className="flex items-center gap-2 flex-1 min-w-0 text-left"><Avatar id={id} size={34} /><div className="min-w-0"><div className="text-sm font-semibold truncate" style={{ color: B.navy }}><Name id={id} /></div>{h && <div className="text-xs" style={{ color: h[0] < h[1] ? B.red : B.greenDeep }}>{h[0]}–{h[1]} vs you</div>}</div></button>
              <span className="text-xs font-semibold" style={{ color: B.text2 }}>{pts.toLocaleString()}</span>
              {!PEOPLE[id].brand && <button onClick={() => go("create", { with: id })} aria-label="Challenge" className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: B.blueSoft }}><Swords size={14} color={B.blue} /></button>}
            </div>); })}
          <div className="flex items-center gap-3 px-4 py-3" style={{ borderTop: `1px solid ${B.line}`, background: B.blueSoft }}><span className="w-5 f-display text-sm" style={{ color: B.blue }}>{tab === "Friends" ? 6 : 214}</span><Avatar me size={34} /><span className="flex-1 text-sm font-semibold" style={{ color: B.navy }}>You</span><span className="text-xs font-semibold" style={{ color: B.blue }}>{xp} · resets Sunday</span></div>
        </Card>
        <Sub className="mt-3 mb-6" color={B.text3}>Points come from every Payout stage you clear and every party you finish in the top half.</Sub>
      </Screen>
    </>
  );
}

/* =========================================================
   Today's Challenge — free daily, same for everyone
   ========================================================= */
function Daily() {
  const { go, completeDaily } = useApp();
  const [i, setI] = useState(0); const [score, setScore] = useState(0); const startRef = useRef(Date.now());
  const done = (ok) => { const sc = score + (ok ? 1 : 0); if (i + 1 >= DAILY_QS.length) { const time = ((Date.now() - startRef.current) / 1000).toFixed(1) + "s"; completeDaily(sc); go("dailyResult", { score: sc, time }); } else { setScore(sc); setI(i + 1); } };
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navyDeep }}>
      <div className="flex items-center gap-3 px-5 pt-4">
        <div className="flex-1"><div className="text-xs font-semibold tracking-wide" style={{ color: B.lime }}>TODAY'S CHALLENGE</div><div className="text-sm font-semibold text-white">Beat {PEOPLE[DAILY_FRIENDS[0][0]].name.split(" ")[0]}'s {DAILY_FRIENDS[0][1]}/{DAILY_QS.length}</div></div>
        <div className="text-xs font-semibold rounded-full px-3 py-1" style={{ background: B.green, color: B.navy }}>{score} correct</div>
      </div>
      <div className="px-5 mt-3 flex gap-1">{DAILY_QS.map((_, k) => <div key={k} className="flex-1 h-1 rounded-full" style={{ background: k < i ? B.green : k === i ? B.electric : "rgba(255,255,255,0.12)" }} />)}</div>
      <QuestionRound key={i} item={DAILY_QS[i]} seconds={12} onDone={done} label={`${i + 1} of ${DAILY_QS.length}`} />
    </div>
  );
}
function DailyResult() {
  const { params, reset, openShare, following, openProfile, go } = useApp();
  const board = [...DAILY_FRIENDS.map(([id, s, t]) => ({ id, s, t })), { id: "me", s: params.score, t: params.time }].sort((a, b) => b.s - a.s || parseFloat(a.t) - parseFloat(b.t));
  const rank = board.findIndex((b) => b.id === "me"); const won = rank === 0;
  const resets = useResetCountdown();
  return (
    <div className="flex-1 flex flex-col" style={{ background: won ? B.green : B.bg }}>
      <Screen>
        <div className="pt-10 text-center">
          <div className="w-20 h-20 mx-auto rounded-full flex items-center justify-center pop" style={{ background: won ? "rgba(255,255,255,0.35)" : B.navy }}>{won ? <Crown size={36} color={B.navy} /> : <Sparkles size={36} color={B.lime} />}</div>
          <H size={32} className="mt-4">{params.score}/{DAILY_QS.length} in {params.time}</H>
          <Sub className="mt-1" color={won ? B.navy : B.text2}>{won ? "Top of your crew today. Streak extended, +50 coins." : `#${rank + 1} among friends. Streak extended, +50 coins. New questions in ${resets}.`}</Sub>
        </div>
        <Card className="mt-6 overflow-hidden">
          {board.map((b, i) => (
            <div key={b.id} onClick={() => b.id !== "me" && openProfile(b.id)} className={`flex items-center gap-3 px-4 py-3 ${b.id !== "me" ? "cursor-pointer" : ""}`} style={{ borderTop: i ? `1px solid ${B.line}` : "none", background: b.id === "me" ? B.blueSoft : "#fff" }}>
              <div className="w-6 f-display text-sm" style={{ color: i === 0 ? B.amber : B.navy }}>{i + 1}</div>
              {b.id === "me" ? <Avatar me size={32} /> : <Avatar id={b.id} size={32} />}
              <div className="flex-1 text-sm font-semibold" style={{ color: B.navy }}>{b.id === "me" ? "You" : PEOPLE[b.id].name}</div>
              <div className="text-xs font-semibold" style={{ color: B.text2 }}>{b.s}/{DAILY_QS.length} · {b.t}</div>
            </div>
          ))}
        </Card>
        <Card className="mt-3 p-4 flex items-center gap-3">
          <Avatar id={board.find((b) => b.id !== "me").id} size={40} />
          <div className="flex-1 text-sm" style={{ color: B.navy }}><b>Settle it properly.</b><Sub>Challenge {PEOPLE[board.find((b) => b.id !== "me").id].name.split(" ")[0]} to a party for real stakes.</Sub></div>
          <Btn small onClick={() => go("create", { with: board.find((b) => b.id !== "me").id })} icon={<Swords size={14} />}>Go</Btn>
        </Card>
        <div className="h-4" />
      </Screen>
      <div className="p-5 flex flex-col gap-2">
        <Btn full tone={won ? "navy" : "blue"} onClick={() => openShare({ kind: "win", text: `I scored ${params.score}/${DAILY_QS.length} on today's Contestly challenge. Can you beat it?` })} icon={<Share2 size={16} />}>Dare your friends</Btn>
        <Btn full tone={won ? "white" : "line"} onClick={() => reset("home")}>Back to home</Btn>
      </div>
    </div>
  );
}

/* =========================================================
   Parties: discover, card, create
   ========================================================= */
function PartyCard({ p, onHide }) {
  const { go, following } = useApp();
  const filling = p.count / p.max >= 0.6 && p.startsIn <= 10;
  return (
    <Card onClick={() => go("lobby", { party: p.id })} className="p-4 relative">
      {filling && <span className="absolute -top-2 left-4 text-xs font-bold rounded-full px-2 py-0.5 flex items-center gap-1" style={{ background: B.red, color: "#fff", fontSize: 10 }}><span className="w-1.5 h-1.5 rounded-full bg-white pulse" />FILLING UP</span>}
      {onHide && <span role="button" onClick={(e) => { e.stopPropagation(); onHide(p); }} className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center" style={{ background: B.soft }} aria-label="Not interested"><X size={13} color={B.text2} /></span>}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center" style={{ background: p.cover }}><Users size={20} color="#fff" /></div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate" style={{ color: B.navy }}>{p.title}</div>
          <div className="text-xs mt-0.5 flex items-center gap-1" style={{ color: B.text2 }}>by <Name id={p.host} bold={false} />{following.includes(p.host) && <span className="ml-1 rounded-full px-1.5 font-semibold" style={{ background: B.blueSoft, color: B.blueDeep }}>following</span>}</div>
        </div>
        <span className={`text-xs font-semibold rounded-full px-2 py-1 flex items-center gap-1 shrink-0 ${onHide ? "mr-8" : ""}`} style={{ background: B.soft, color: B.ink }}><Clock size={12} />{p.startsIn}m</span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex gap-4">
          <div><span style={{ color: B.text3 }}>Entry </span><b style={{ color: B.navy }}>{p.entry ? naira(p.entry) : "Free"}</b></div>
          <div><span style={{ color: B.text3 }}>{isCash(p) ? "Pot " : "Prize "}</span><b style={{ color: B.greenDeep }}>{prizeLabel(p)}</b></div>
        </div>
        <div className="flex items-center gap-2"><div className="flex -space-x-1.5">{p.players.slice(0, 3).map((id) => <Avatar key={id} id={id} size={20} ring="#fff" />)}</div><b style={{ color: B.navy }}>{p.count}/{p.max}</b></div>
      </div>
      <div className="mt-2 h-1 rounded-full" style={{ background: B.soft }}><div className="h-full rounded-full" style={{ width: `${(p.count / p.max) * 100}%`, background: B.blue }} /></div>
    </Card>
  );
}
function Discover() {
  const { parties: all, following, user, toast } = useApp();
  const [filter, setFilter] = useState("For you"); const [q, setQ] = useState("");
  const [hidden, setHidden] = useState([]);
  const hide = (p) => { setHidden((h) => [...h, p.id]); toast(`Fewer ${p.cat} parties for you`); };
  const parties = all.filter((p) => !hidden.includes(p.id));
  let list = parties;
  if (filter === "Following") list = list.filter((p) => following.includes(p.host) || p.players.some((x) => following.includes(x)));
  if (filter === "Brands") list = list.filter((p) => PEOPLE[p.host]?.brand);
  if (filter === "Starting soon") list = [...list].sort((a, b) => a.startsIn - b.startsIn);
  if (filter === "Free entry") list = list.filter((p) => p.entry === 0);
  if (filter === "For you") list = [...list].sort((a, b) => (user.interests.includes(b.cat) ? 1 : 0) - (user.interests.includes(a.cat) ? 1 : 0));
  if (q) list = list.filter((p) => (p.title + p.cat).toLowerCase().includes(q.toLowerCase()));
  const suggest = Object.keys(PEOPLE).filter((id) => !following.includes(id)).slice(0, 4);
  return (
    <>
      <div className="px-5 pt-4"><H size={26}>Parties</H></div>
      <div className="px-5 mt-3"><div className="flex items-center gap-2 rounded-2xl px-4" style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}` }}><Search size={18} color={B.text3} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parties, people, brands" className="flex-1 py-3 outline-none text-sm font-medium" style={{ color: B.navy }} /></div></div>
      <div className="flex gap-2 px-5 mt-3 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>{["For you", "Following", "Brands", "Free entry", "Starting soon"].map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{f}</Chip>)}</div>
      <Screen>
        <div className="flex flex-col gap-3 mt-3">{list.length ? list.map((p) => <PartyCard key={p.id} p={p} onHide={hide} />) : <Card className="p-6 text-center"><div className="font-semibold" style={{ color: B.navy }}>Nothing here yet</div><Sub className="mt-1">Follow more people, or start a party yourself.</Sub></Card>}</div>
        {suggest.length > 0 && <Card className="mt-5 mb-6 px-4 py-2"><div className="text-xs font-semibold pt-2" style={{ color: B.text3 }}>PEOPLE AND BRANDS TO FOLLOW</div>{suggest.map((id) => <FollowRow key={id} id={id} compact />)}</Card>}
      </Screen>
    </>
  );
}
function CreateParty() {
  const { reset, createParty, wallet, params, user, toast } = useApp();
  const rival = params.with && PEOPLE[params.with];
  const funded = !!params.funded; // onboarding "Host" first move: we fund the first ₦2,000 pot
  const brandFirst = !!params.brandFirst;
  const [step, setStep] = useState(1);
  const [d, setD] = useState({ invite: params.with || null, title: rival ? `${user.name || "Me"} vs ${rival.name.split(" ")[0]}` : funded ? `${user.name || "My"}'s first party` : "", brief: rival ? `${user.interests[0] || "General knowledge"}, me vs ${rival.name.split(" ")[0]}, make it spicy` : "", files: [], level: 1, secs: 12, qCount: 10, formats: FORMATS.map((f) => f[0]), hostMode: brandFirst ? "curate" : "sealed", entry: funded ? 0 : 200, max: 6, funding: funded || brandFirst ? "host" : "pooled", hostPool: funded ? 2000 : 5000, prizeType: "cash", prizeLabel: "", prizeValue: 10000, split: [70, 30], visibility: "public", cover: funded ? "#7C3AED" : brandFirst ? "#F97316" : B.blue });
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const LEVELS = [["😌", "Easy"], ["🙂", "Mixed"], ["😤", "Hard"], ["💀", "Brutal"]];
  const nonCash = d.funding === "host" && d.prizeType !== "cash";
  const pot = d.funding === "host" ? (nonCash ? d.prizeValue : d.hostPool) : d.entry * d.max;
  const curate = d.hostMode === "curate";
  const STEPS = ["About", "Dial it in", "Your role", "Stakes", "Doors", "Forge"];
  const canNext = [null, d.title.length > 2 && ((d.brief || "").trim().length > 8 || d.files.length > 0), d.formats.length > 0, true, !(nonCash && d.prizeLabel.length < 3), true][step] !== false;

  // Forge: the generation everyone sees. Sealed hides content; curate reveals it.
  const [forge, setForge] = useState({ phase: "idle", done: 0, stage: 0 });
  const STAGES = [["Reading", d.files.length ? `Reading ${d.files[0]}` : "Reading what you wrote"], ["Drafting", `Drafting ${d.qCount} questions`], ["Checking", "Checking facts against two sources"], ["Dedupe", "Removing duplicates and lookalikes"], ["Balance", `Balancing difficulty: ${LEVELS[d.level][1].toLowerCase()}`]];
  const startForge = () => {
    setForge({ phase: "running", done: 0, stage: 0 });
    const per = 420; let n = 0;
    const tick = setInterval(() => { n += 1; setForge((f) => ({ ...f, done: Math.min(d.qCount, n), stage: Math.min(STAGES.length - 1, Math.floor((n / d.qCount) * STAGES.length)) })); if (n >= d.qCount) { clearInterval(tick); setTimeout(() => setForge((f) => ({ ...f, phase: "done" })), 500); } }, per);
  };
  useEffect(() => { if (step === 6 && forge.phase === "idle") startForge(); }, [step]);
  const DRAFT = [["Which Nigerian state is known as the Centre of Excellence?", "Lagos", "single"], ["Put these in order, earliest first.", "Independence · Civil war · Abuja", "order"], ["Which of these are Nigerian states?", "Ekiti, Nasarawa", "multi"], ["Which stadium is this?", "National Stadium, Lagos", "image"], ["Match the city to its nickname.", "Lagos → Centre of Excellence", "match"], ["Which river meets the Niger at Lokoja?", "Benue", "single"], ["In what year did Nigeria adopt the naira?", "1973", "single"], ["Who was Nigeria's first president?", "Nnamdi Azikiwe", "single"], ["Jollof rice is traditionally cooked with which base?", "Tomato and pepper", "single"], ["Which ocean borders Lagos?", "Atlantic", "single"]];
  const [approved, setApproved] = useState(() => DRAFT.map(() => true));
  const fmtIcon = { single: "①", multi: "☑", order: "⇅", match: "⇄", image: "🖼" };

  const Poster = ({ compact }) => (
    <div className="rounded-3xl p-4 relative overflow-hidden" style={{ background: `linear-gradient(160deg, ${d.cover}, ${B.navyDeep})`, minHeight: compact ? 96 : 140 }}>
      <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
      <div className="flex items-center gap-2"><Avatar me size={22} ring={d.cover} /><span className="text-xs font-semibold text-white opacity-90">{user.name || "You"}{curate ? " · hosting" : " · hosting & playing"}</span></div>
      <div className="mt-2 f-display text-white" style={{ fontSize: compact ? 18 : 22, lineHeight: 1.15 }}>{d.title || "Your party"}</div>
      {!compact && <div className="mt-1 text-xs text-white opacity-80 truncate">{(d.brief || "").slice(0, 60) || "Type what it's about below"}{d.files.length ? ` · 📎 ${d.files[0]}` : ""}</div>}
      <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-white"><span className="rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.25)" }}>{d.qCount} Qs · {LEVELS[d.level][0]} {LEVELS[d.level][1]}</span><span className="rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.25)" }}>{d.secs}s</span><span className="rounded-full px-2 py-0.5 flex items-center gap-1" style={{ background: "rgba(0,0,0,0.25)" }}><Wand2 size={10} />AI</span></div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col" style={{ background: `radial-gradient(120% 60% at 50% -10%, ${d.cover}66, transparent 60%), ${B.navyDeep}` }}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <button onClick={() => (step > 1 ? setStep(step - 1) : reset("home"))} aria-label="Back" className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.1)" }}><ChevronLeft size={20} color="#fff" /></button>
        <div className="flex-1 flex gap-1">{STEPS.map((t, i) => <div key={t} className="flex-1 h-1.5 rounded-full" style={{ background: i < step ? B.lime : "rgba(255,255,255,0.15)" }} />)}</div>
        <span className="text-xs font-semibold" style={{ color: B.blueMid }}>{STEPS[step - 1]}</span>
      </div>
      <Screen>
        {step === 1 && (<>
          <H size={26} color="#fff" className="mt-3">Build your party</H>
          <div className="mt-3"><Poster /></div>
          {funded && <div className="mt-3 rounded-2xl p-3 flex items-center gap-3 text-sm" style={{ background: "rgba(124,58,237,0.25)", color: "#fff" }}><Gift size={20} color="#D8B4FE" /><div className="flex-1">Your first <b>₦2,000 pot</b> is on us.</div></div>}
          {rival && <div className="mt-3 rounded-2xl p-3 flex items-center gap-3 text-sm" style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}><Avatar id={params.with} size={30} /><div className="flex-1"><b>{rival.name}</b> gets an invite when you publish.</div><Swords size={18} color={B.lime} /></div>}
          <input value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="Name it" className="mt-4 w-full rounded-2xl px-4 py-3.5 f-display text-lg outline-none text-white" style={{ background: "rgba(255,255,255,0.08)", boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.12)" }} />
          <div className="mt-3 rounded-2xl" style={{ background: "rgba(255,255,255,0.08)", boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.12)" }}>
            <textarea value={d.brief} onChange={(e) => set("brief", e.target.value)} placeholder="What's it about? Type anything: a topic, a vibe, a chapter, in-jokes, 'Afrobeats 2010–2015 for people who were there'…" rows={4} className="w-full rounded-2xl px-4 pt-3 pb-2 text-sm outline-none resize-none bg-transparent text-white" />
            <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
              {d.files.map((f) => <span key={f} className="text-xs font-semibold rounded-full pl-2 pr-1 py-1 flex items-center gap-1" style={{ background: "rgba(43,255,176,0.18)", color: B.lime }}><FileText size={12} />{f}<button onClick={() => set("files", d.files.filter((x) => x !== f))} className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.25)" }}><X size={10} /></button></span>)}
              <button onClick={() => set("files", [...d.files, ["Nigeria-history-notes.pdf", "Q3-brand-brief.pdf", "menu-2026.pdf"][d.files.length % 3]])} className="text-xs font-semibold rounded-full px-2.5 py-1 flex items-center gap-1 text-white" style={{ background: "rgba(255,255,255,0.12)" }}><Paperclip size={12} />Add a PDF or doc</button>
            </div>
          </div>
          {(d.brief.trim().length > 8 || d.files.length > 0) && <div className="mt-3 flex items-start gap-2 text-xs slide-up" style={{ color: B.blueMid }}><Wand2 size={14} color={B.lime} className="mt-0.5 shrink-0" /><span>Got it: <b className="text-white">{(d.brief.split(/[.,\n]/)[0] || d.files[0]).slice(0, 50)}</b>{d.files.length ? <> from <b className="text-white">{d.files.join(", ")}</b></> : null}. Nigeria, adults, fun.</span></div>}
          <div className="h-4" />
        </>)}

        {step === 2 && (<>
          <H size={26} color="#fff" className="mt-3">Dial it in</H>
          <div className="mt-4 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div className="text-xs font-semibold" style={{ color: B.blueMid }}>DIFFICULTY</div>
            <div className="mt-3 flex items-center justify-between">{LEVELS.map(([e, l], i) => <button key={l} onClick={() => set("level", i)} className="flex flex-col items-center gap-1 transition" style={{ transform: d.level === i ? "scale(1.15)" : "none", opacity: d.level === i ? 1 : 0.5 }}><span style={{ fontSize: 34 }}>{e}</span><span className="text-xs font-semibold text-white">{l}</span></button>)}</div>
            <div className="mt-3 h-2 rounded-full relative" style={{ background: "rgba(255,255,255,0.12)" }}><div className="h-full rounded-full" style={{ width: `${((d.level + 1) / 4) * 100}%`, background: `linear-gradient(90deg, ${B.green}, ${B.amber}, ${B.red})`, transition: "width .25s" }} /></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="text-xs font-semibold" style={{ color: B.blueMid }}>PACE</div>
              <div className="mt-2 relative mx-auto" style={{ width: 92, height: 92 }}>
                <svg width="92" height="92" className="-rotate-90"><circle cx="46" cy="46" r="38" stroke="rgba(255,255,255,0.12)" strokeWidth="8" fill="none" /><circle cx="46" cy="46" r="38" stroke={B.lime} strokeWidth="8" fill="none" strokeDasharray={2 * Math.PI * 38} strokeDashoffset={2 * Math.PI * 38 * (1 - d.secs / 20)} strokeLinecap="round" style={{ transition: "stroke-dashoffset .3s" }} /></svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="f-display text-white text-xl">{d.secs}s</span></div>
              </div>
              <div className="mt-2 flex justify-between">{[8, 12, 15, 20].map((n) => <button key={n} onClick={() => set("secs", n)} className="w-8 h-8 rounded-full text-xs font-semibold" style={{ background: d.secs === n ? B.lime : "rgba(255,255,255,0.1)", color: d.secs === n ? B.navy : "#fff" }}>{n}</button>)}</div>
            </div>
            <div className="rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="text-xs font-semibold" style={{ color: B.blueMid }}>QUESTIONS</div>
              <div className="mt-2 f-display text-white text-center" style={{ fontSize: 44, lineHeight: 1 }}>{d.qCount}</div>
              <div className="text-center text-xs" style={{ color: B.blueMid }}>≈ {Math.ceil((d.qCount * (d.secs + 4)) / 60)} min</div>
              <div className="mt-2 grid grid-cols-2 gap-1">{[5, 10, 15, 20].map((n) => <button key={n} onClick={() => set("qCount", n)} className="rounded-xl py-1.5 text-xs font-semibold" style={{ background: d.qCount === n ? B.lime : "rgba(255,255,255,0.1)", color: d.qCount === n ? B.navy : "#fff" }}>{n}</button>)}</div>
            </div>
          </div>
          <div className="mt-3 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div className="flex items-center justify-between"><span className="text-xs font-semibold" style={{ color: B.blueMid }}>FORMATS</span><span className="text-xs" style={{ color: B.blueMid }}>{d.formats.length === FORMATS.length ? "Everything" : `${d.formats.length} of ${FORMATS.length}`}</span></div>
            <div className="mt-3 grid grid-cols-5 gap-2">{FORMATS.map(([id, label]) => { const on = d.formats.includes(id); return <button key={id} onClick={() => { const next = on ? d.formats.filter((x) => x !== id) : [...d.formats, id]; if (next.length) set("formats", next); }} className="rounded-2xl py-3 flex flex-col items-center gap-1 transition active:scale-95" style={{ background: on ? B.lime : "rgba(255,255,255,0.08)", color: on ? B.navy : "#fff", opacity: on ? 1 : 0.6 }}><span style={{ fontSize: 20 }}>{fmtIcon[id]}</span><span className="font-semibold text-center leading-tight" style={{ fontSize: 10 }}>{label}</span></button>; })}</div>
          </div>
          <div className="h-4" />
        </>)}

        {step === 3 && (<>
          <H size={26} color="#fff" className="mt-3">Are you playing?</H>
          <Sub className="mt-1" color={B.blueMid}>Whoever sees the questions can't play them.</Sub>
          <div className="mt-5 flex flex-col gap-3">
            {[["sealed", "🎮", "I'm playing", "The questions stay sealed. You see them when everyone does.", B.blue], ["curate", "🎙️", "I'm the host", "You check every question before the party. You don't play.", "#7C3AED"]].map(([v, e, t, sub, c]) => (
              <button key={v} onClick={() => set("hostMode", v)} className="rounded-3xl p-5 text-left relative overflow-hidden active:scale-95 transition" style={{ background: d.hostMode === v ? `linear-gradient(160deg, ${c}, ${B.navyDeep})` : "rgba(255,255,255,0.06)", boxShadow: d.hostMode === v ? `0 0 0 2px ${B.lime}` : "none", minHeight: 120 }}>
                <div className="absolute -right-6 -bottom-6 w-28 h-28 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
                <div className="flex items-center gap-3"><span style={{ fontSize: 36 }}>{e}</span><div><div className="f-display text-white" style={{ fontSize: 22 }}>{t}</div><div className="text-sm text-white opacity-80">{sub}</div></div></div>
                {d.hostMode === v && <div className="mt-3 flex items-center gap-2 text-xs font-semibold" style={{ color: B.lime }}><Check size={14} strokeWidth={3} />{v === "sealed" ? "Sealed set, fact-checked, flaggable in play" : "You'll approve, swap or edit each one"}</div>}
              </button>
            ))}
          </div>
          <div className="h-4" />
        </>)}

        {step === 4 && (<>
          <H size={26} color="#fff" className="mt-3">Set the stakes</H>
          <div className="mt-4 flex rounded-full p-1" style={{ background: "rgba(255,255,255,0.08)" }}>{[["pooled", "Everyone chips in"], ["host", "I'll put up the prize"]].map(([v, t]) => <button key={v} onClick={() => setD({ ...d, funding: v, entry: v === "host" ? 0 : d.entry || 200 })} className="flex-1 rounded-full py-2.5 text-sm font-semibold" style={{ background: d.funding === v ? "#fff" : "transparent", color: d.funding === v ? B.navy : B.blueMid }}>{t}</button>)}</div>
          {d.funding === "pooled" ? (<>
            <div className="mt-4 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="text-xs font-semibold" style={{ color: B.blueMid }}>ENTRY</div>
              <div className="mt-3 flex items-end justify-between gap-1">{[100, 200, 500, 1000, 2000].map((v, i) => <button key={v} onClick={() => set("entry", v)} className="flex-1 flex flex-col items-center gap-1 active:scale-95 transition" style={{ opacity: d.entry === v ? 1 : 0.5 }}><div className="flex flex-col-reverse gap-0.5">{Array.from({ length: i + 1 }).map((_, k) => <span key={k} className="block rounded-full" style={{ width: 28, height: 7, background: d.entry === v ? B.amber : "rgba(255,255,255,0.3)" }} />)}</div><span className="text-xs font-semibold text-white">{naira(v)}</span></button>)}</div>
            </div>
            <div className="mt-3 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="flex items-center justify-between"><span className="text-xs font-semibold" style={{ color: B.blueMid }}>SEATS</span><span className="f-display text-white">{d.max}</span></div>
              <div className="mt-3 flex flex-wrap gap-1.5">{Array.from({ length: 20 }).map((_, i) => <button key={i} onClick={() => set("max", [4, 6, 10, 20].find((n) => n > i) || 20)} className="rounded-full" style={{ width: 24, height: 24, background: i < d.max ? (i === 0 ? B.lime : "rgba(255,255,255,0.35)") : "rgba(255,255,255,0.08)" }} />)}</div>
              <div className="mt-2 flex gap-1.5">{[4, 6, 10, 20, 50].map((n) => <button key={n} onClick={() => set("max", n)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: d.max === n ? B.lime : "rgba(255,255,255,0.1)", color: d.max === n ? B.navy : "#fff" }}>{n}</button>)}</div>
            </div>
            <div className="mt-3 rounded-3xl p-4 flex items-center gap-4" style={{ background: `linear-gradient(160deg, ${B.greenDeep}, #056B47)` }}><div><div className="text-xs font-semibold text-white opacity-80">POT IF FULL</div><div className="f-display text-white" style={{ fontSize: 32 }}>{naira(d.entry * d.max)}</div></div><div className="flex-1 flex flex-wrap gap-1 justify-end">{[["Winner takes all", [100]], ["70 / 30", [70, 30]], ["60 / 30 / 10", [60, 30, 10]]].map(([t, v]) => <button key={t} onClick={() => set("split", v)} className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: d.split.join() === v.join() ? "#fff" : "rgba(0,0,0,0.2)", color: d.split.join() === v.join() ? B.navy : "#fff" }}>{t}</button>)}</div></div>
          </>) : (<>
            <div className="mt-4 grid grid-cols-3 gap-2">{[["cash", "💸", "Cash"], ["product", "🛍️", "A product"], ["experience", "✨", "An experience"]].map(([v, e, t]) => <button key={v} onClick={() => setD({ ...d, prizeType: v, split: v === "cash" ? d.split : [100] })} className="rounded-3xl p-4 flex flex-col items-center gap-1 active:scale-95 transition" style={{ background: d.prizeType === v ? B.lime : "rgba(255,255,255,0.08)", color: d.prizeType === v ? B.navy : "#fff" }}><span style={{ fontSize: 30 }}>{e}</span><span className="text-xs font-semibold">{t}</span></button>)}</div>
            {nonCash ? (<>
              <input value={d.prizeLabel} onChange={(e) => set("prizeLabel", e.target.value)} placeholder={d.prizeType === "product" ? "e.g. Ankara two-piece, any size" : "e.g. Dinner for two at our Lekki spot"} className="mt-3 w-full rounded-2xl px-4 py-3.5 text-sm outline-none text-white" style={{ background: "rgba(255,255,255,0.08)", boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.12)" }} />
              <div className="mt-3 flex gap-2">{[5000, 10000, 25000, 50000].map((v) => <button key={v} onClick={() => set("prizeValue", v)} className="flex-1 rounded-2xl py-2 text-xs font-semibold" style={{ background: d.prizeValue === v ? B.lime : "rgba(255,255,255,0.1)", color: d.prizeValue === v ? B.navy : "#fff" }}>~{naira(v)}</button>)}</div>
              <div className="mt-2 text-xs" style={{ color: B.blueMid }}>One winner. You deliver; we confirm with them. Needs a verified brand account to publish.</div>
            </>) : (<div className="mt-3 flex gap-2">{[2000, 5000, 10000].map((v) => <button key={v} onClick={() => set("hostPool", v)} className="flex-1 rounded-2xl py-3 f-display" style={{ background: d.hostPool === v ? B.lime : "rgba(255,255,255,0.1)", color: d.hostPool === v ? B.navy : "#fff" }}>{naira(v)}</button>)}</div>)}
            <div className="mt-3 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}><div className="flex items-center justify-between"><span className="text-xs font-semibold" style={{ color: B.blueMid }}>SEATS · FREE ENTRY</span><span className="f-display text-white">{d.max}</span></div><div className="mt-2 flex gap-1.5">{[6, 10, 20, 50, 100].map((n) => <button key={n} onClick={() => set("max", n)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: d.max === n ? B.lime : "rgba(255,255,255,0.1)", color: d.max === n ? B.navy : "#fff" }}>{n}</button>)}</div></div>
          </>)}
          <div className="h-4" />
        </>)}

        {step === 5 && (<>
          <H size={26} color="#fff" className="mt-3">Open the doors</H>
          <div className="mt-4 grid grid-cols-2 gap-3">{[["public", Globe, "Public", "In Parties. Followers get a ping."], ["private", Lock, "Private", "Invite link only."]].map(([v, I, t, s]) => <button key={v} onClick={() => set("visibility", v)} className="rounded-3xl p-4 text-left active:scale-95 transition" style={{ background: d.visibility === v ? B.lime : "rgba(255,255,255,0.06)", color: d.visibility === v ? B.navy : "#fff" }}><I size={22} /><div className="f-display mt-3" style={{ fontSize: 20 }}>{t}</div><div className="text-xs mt-0.5 opacity-80">{s}</div></button>)}</div>
          <div className="mt-4 text-xs font-semibold" style={{ color: B.blueMid }}>COVER</div>
          <div className="mt-2"><Poster compact /></div>
          <div className="mt-3 flex gap-2 items-center">{[B.blue, "#7C3AED", B.greenDeep, "#F97316", B.red, "#0EA5E9"].map((c) => <button key={c} aria-label="colour" onClick={() => set("cover", c)} className="w-10 h-10 rounded-full active:scale-95 transition" style={{ background: c, boxShadow: d.cover === c ? `0 0 0 3px ${B.navyDeep}, 0 0 0 5px ${B.lime}` : "none" }} />)}<button className="ml-auto h-10 px-3 rounded-2xl text-xs font-semibold flex items-center gap-1 text-white" style={{ background: "rgba(255,255,255,0.1)" }}><ImageIcon size={14} />Photo</button></div>
          <div className="h-4" />
        </>)}

        {step === 6 && (<>
          <div className="mt-3"><Poster compact /></div>
          <div className="mt-4 flex items-center justify-between">
            <div><div className="f-display text-white" style={{ fontSize: 22 }}>{forge.phase === "done" ? (curate ? "Your deck is ready" : "Deck forged and sealed") : "Forging your deck"}</div><div className="text-xs mt-0.5" style={{ color: B.blueMid }}>{forge.phase === "done" ? (curate ? `${approved.filter(Boolean).length} of ${d.qCount} approved. Tap a card to toggle it.` : `${d.qCount} questions. Nobody sees them until the first one drops, you included.`) : STAGES[forge.stage][1] + "…"}</div></div>
            <div className="f-display text-white text-xl tabular-nums">{forge.done}/{d.qCount}</div>
          </div>
          <div className="mt-2 flex gap-1">{STAGES.map(([t], i) => <span key={t} className="flex-1 text-center text-xs font-semibold rounded-full py-0.5" style={{ background: i < forge.stage || forge.phase === "done" ? B.lime : i === forge.stage ? "rgba(43,255,176,0.25)" : "rgba(255,255,255,0.08)", color: i < forge.stage || forge.phase === "done" ? B.navy : "#fff", fontSize: 10 }}>{t}</span>)}</div>
          <div className="mt-4 grid grid-cols-5 gap-2">
            {Array.from({ length: d.qCount }).map((_, i) => { const ready = i < forge.done; const q = DRAFT[i % DRAFT.length]; const fmt = d.formats[i % d.formats.length]; const on = approved[i];
              return curate && ready ? (
                <button key={i} onClick={() => setApproved((a) => a.map((x, k) => (k === i ? !x : x)))} className="rounded-xl flex flex-col items-center justify-center pop" style={{ aspectRatio: "3/4", background: on ? B.lime : "rgba(255,255,255,0.08)", color: on ? B.navy : "#fff", boxShadow: on ? "none" : `inset 0 0 0 1.5px ${B.red}` }}><span style={{ fontSize: 18 }}>{fmtIcon[q[2]]}</span><span className="f-display text-xs mt-1">{i + 1}</span></button>
              ) : (
                <div key={i} className={`rounded-xl flex flex-col items-center justify-center ${ready ? "pop" : ""}`} style={{ aspectRatio: "3/4", background: ready ? `linear-gradient(160deg, ${d.cover}, ${B.navyDeep})` : "rgba(255,255,255,0.05)", boxShadow: ready ? `inset 0 0 0 1.5px rgba(255,255,255,0.25)` : "inset 0 0 0 1px rgba(255,255,255,0.08)" }}>{ready ? <><Lock size={14} color="#fff" /><span className="text-white f-display text-xs mt-1">{i + 1}</span><span style={{ color: B.blueMid, fontSize: 10 }}>{fmtIcon[fmt]}</span></> : <span className="w-1.5 h-1.5 rounded-full pulse" style={{ background: "rgba(255,255,255,0.3)" }} />}</div>
              ); })}
          </div>
          {curate && forge.phase === "done" && (
            <div className="mt-4 flex flex-col gap-2">
              {DRAFT.slice(0, d.qCount).map((q, i) => (
                <div key={i} className="rounded-2xl p-3 flex items-start gap-3" style={{ background: "rgba(255,255,255,0.06)", opacity: approved[i] ? 1 : 0.45 }}>
                  <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 f-display text-xs" style={{ background: approved[i] ? B.lime : "rgba(255,255,255,0.1)", color: approved[i] ? B.navy : "#fff" }}>{i + 1}</span>
                  <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-white">{q[0]}</div><div className="text-xs mt-0.5" style={{ color: B.blueMid }}>{fmtIcon[q[2]]} {FORMATS.find((f) => f[0] === q[2])[1]} · Answer: {q[1]} · <span style={{ color: B.lime }}>verified</span></div></div>
                  <div className="flex flex-col gap-1"><button onClick={() => setApproved((a) => a.map((x, k) => (k === i ? !x : x)))} className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: approved[i] ? B.lime : "rgba(255,255,255,0.1)" }}><Check size={14} color={approved[i] ? B.navy : "#fff"} strokeWidth={3} /></button><button onClick={() => toast("Swapped for another verified question")} className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.1)" }}><RefreshCw size={13} color="#fff" /></button></div>
                </div>
              ))}
            </div>
          )}
          {forge.phase === "done" && (
            <div className="mt-4 rounded-3xl p-4" style={{ background: "rgba(255,255,255,0.06)" }}>
              {[["Entry", d.funding === "host" ? "Free" : naira(d.entry)], [nonCash ? "Prize" : "Pot if full", nonCash ? d.prizeLabel : naira(pot)], ["Seats", `${d.max}${curate ? " · you host" : " · you included"}`], ["Doors", d.visibility === "public" ? "Public" : "Private link"], ...(rival ? [["Invited", rival.name]] : [])].map(([k, v]) => <div key={k} className="flex justify-between text-sm py-1"><span style={{ color: B.blueMid }}>{k}</span><span className="font-semibold text-white">{v}</span></div>)}
            </div>
          )}
          <div className="h-4" />
        </>)}
      </Screen>
      <div className="p-5">
        {step < 6 ? <Btn full tone="green" disabled={!canNext} onClick={() => setStep(step + 1)} icon={step === 5 ? <Wand2 size={16} /> : null}>{step === 5 ? "Forge the questions" : "Next"}</Btn>
          : <Btn full tone="green" disabled={forge.phase !== "done" || (!nonCash && !funded && d.funding === "host" && wallet.cash < d.hostPool) || (curate && approved.filter(Boolean).length < 3)} onClick={() => createParty({ ...d, cat: user.interests[0] || "General knowledge", sponsored: funded, prize: nonCash ? { type: d.prizeType, label: d.prizeLabel, value: d.prizeValue } : undefined })} icon={forge.phase === "done" ? <Zap size={16} /> : <RefreshCw size={16} className="spin" />}>{forge.phase !== "done" ? "Forging…" : !nonCash && !funded && d.funding === "host" && wallet.cash < d.hostPool ? "Not enough cash for this pot" : nonCash && user.isBrand && !(user.verification?.rc) ? "Publish (live once verified)" : "Open the party"}</Btn>}
      </div>
    </div>
  );
}

/* =========================================================
   Lobby with chat
   ========================================================= */
function Lobby() {
  const { params, parties, joined, joinParty, go, chats, sendChat, openShare, toggleFollow, following, wallet, openProfile, user } = useApp();
  const p = parties.find((x) => x.id === params.party);
  const [confirm, setConfirm] = useState(false);
  const endRef = useRef(null);
  const msgs = chats[p.id] || []; const isIn = joined.includes(p.id);
  const members = [...new Set([p.host, ...p.players])].filter((id) => PEOPLE[id]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length]);
  const byHandle = (h) => Object.keys(PEOPLE).find((k) => PEOPLE[k].handle === h);
  const renderText = (t) => t.split(/(@[\w.]+)/g).map((part, i) => { if (!part.startsWith("@")) return part; const id = byHandle(part.slice(1)); return id ? <button key={i} onClick={() => openProfile(id)} className="font-semibold" style={{ color: B.blue }}>{part}</button> : <b key={i} style={{ color: B.blue }}>{part}</b>; });
  return (
    <>
      <div style={{ background: p.cover }}>
        <TopBar light title="" right={<button onClick={() => openShare({ kind: "invite", party: p })} aria-label="Invite" className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.15)" }}><Share2 size={18} color="#fff" /></button>} />
        <div className="px-5 pb-4">
          <div className="f-display text-xl text-white leading-tight">{p.title}</div>
          <div className="text-xs text-white opacity-90 mt-1 flex items-center gap-1">by <button onClick={() => openProfile(p.host)} className="underline"><Name id={p.host} bold={false} /></button>
            {p.host !== "me" && PEOPLE[p.host] && !following.includes(p.host) && <button onClick={() => toggleFollow(p.host)} className="ml-1 rounded-full px-2 py-0.5 font-semibold" style={{ background: "#fff", color: B.navy }}>Follow</button>}
          </div>
        </div>
      </div>
      {user.guest && <div className="px-5 py-2 flex items-center gap-2 text-xs" style={{ background: "#FFF4D6", color: "#8A5A00" }}><User size={14} /><span className="flex-1">Playing as a guest, <b>{user.name}</b>. Score not saved{!isCash(p) && p.prize ? ", not eligible for the prize" : ""}.</span><button onClick={() => go("whoPlays")} className="font-semibold underline">Sign up</button></div>}
      <div className="px-5 py-3 grid grid-cols-3 gap-2 text-center" style={{ background: "#fff", borderBottom: `1px solid ${B.line}` }}>
        <div className="min-w-0"><div className="text-xs" style={{ color: B.text3 }}>{isCash(p) ? "Pot" : "Prize"}</div><div className="font-semibold truncate" style={{ color: B.greenDeep }} title={prizeLabel(p)}>{isCash(p) ? prizeLabel(p) : "🎁 " + p.prize.label}</div></div>
        <div><div className="text-xs" style={{ color: B.text3 }}>Seats</div><div className="font-semibold" style={{ color: B.navy }}>{p.count}/{p.max}</div></div>
        <div><div className="text-xs" style={{ color: B.text3 }}>Starts in</div><div className="font-semibold" style={{ color: B.navy }}>{p.startsIn} min</div></div>
      </div>
      <div className="flex items-center gap-2 px-5 py-2.5" style={{ background: "#fff" }}>
        <div className="flex -space-x-2">{isIn && <Avatar me size={28} ring="#fff" />}{members.slice(0, 5).map((id) => <button key={id} onClick={() => openProfile(id)}><Avatar id={id} size={28} ring="#fff" /></button>)}</div>
        <div className="text-xs font-medium flex-1" style={{ color: B.text2 }}>{p.players.filter((x) => following.includes(x)).length > 0 ? `${p.players.filter((x) => following.includes(x)).length} you follow are in` : `${p.count} players in`}</div>
        <div className="text-xs font-semibold rounded-full px-2 py-1 flex items-center gap-1" style={{ background: B.soft, color: B.ink }}><Wand2 size={11} />AI questions{p.hostPlays === false ? " · host-reviewed" : " · sealed"}</div>
      </div>
      <Screen>
        <div className="py-3 flex flex-col gap-2.5">
          {msgs.map((m) => {
            if (m.system) return <div key={m.id} className="text-center text-xs font-medium py-1" style={{ color: B.text3 }}>{m.text}</div>;
            const mine = m.who === "me";
            return (
              <div key={m.id} className={`flex gap-2 items-end ${mine ? "flex-row-reverse" : ""}`}>
                {mine ? <Avatar me size={26} /> : <button onClick={() => openProfile(m.who)}><Avatar id={m.who} size={26} /></button>}
                {m.voice ? <VoiceBubble m={m} mine={mine} /> : m.sticker ? <div className="text-5xl pop">{m.sticker}</div> : (
                  <div className="max-w-xs rounded-2xl px-3 py-2 text-sm" style={{ background: mine ? B.blue : "#fff", color: mine ? "#fff" : B.ink, borderBottomRightRadius: mine ? 6 : 16, borderBottomLeftRadius: mine ? 16 : 6, boxShadow: mine ? "none" : `0 0 0 1px ${B.line}` }}>
                    {!mine && <button onClick={() => openProfile(m.who)} className="block text-xs font-semibold mb-0.5" style={{ color: B.text3 }}>@{PEOPLE[m.who]?.handle}</button>}{renderText(m.text)}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </Screen>
      <Composer onSend={(payload) => sendChat(p.id, payload)} members={members} placeholder="Say something. Type @ to tag" />
      <div className="px-4 pb-4 pt-1 flex gap-2" style={{ background: B.bg }}>
        {user.guest ? (<><Btn tone="line" onClick={() => go("whoPlays")}>Sign up</Btn><div className="flex-1"><Btn full tone="green" onClick={() => go("partyGame", { party: p.id })}>Start now (demo)</Btn></div></>)
          : !isIn ? <Btn full onClick={() => setConfirm(true)}>{p.entry ? `Join for ${naira(p.entry)}` : "Join free"}</Btn> : (<><Btn tone="line" onClick={() => openShare({ kind: "invite", party: p })}>Invite</Btn><div className="flex-1"><Btn full tone="green" onClick={() => go("partyGame", { party: p.id })}>Start now (demo)</Btn></div></>)}
      </div>
      {confirm && (
        <Sheet onClose={() => setConfirm(false)}>
          <H size={22}>Join {p.title}?</H>
          <div className="mt-4 rounded-2xl p-4 text-sm flex flex-col gap-2" style={{ background: B.bg, color: B.navy }}>
            <div className="flex justify-between"><span style={{ color: B.text2 }}>Entry</span><b>{p.entry ? naira(p.entry) : "Free"}</b></div>
            <div className="flex justify-between"><span style={{ color: B.text2 }}>Paid from</span><b>Coins first, then cash</b></div>
            <div className="flex justify-between gap-4"><span style={{ color: B.text2 }}>{isCash(p) ? "Prizes" : "Prize"}</span><b className="text-right">{isCash(p) ? p.split.map((s, i) => `${["1st", "2nd", "3rd"][i]} ${s}%`).join(", ") : `${p.prize.label} (worth ~${naira(p.prize.value)})`}</b></div>
            <div className="flex justify-between"><span style={{ color: B.text2 }}>If it doesn't start</span><b>Full refund</b></div>
          </div>
          <div className="mt-4">{wallet.bonus + wallet.cash >= p.entry ? <Btn full onClick={() => { joinParty(p); setConfirm(false); }}>Pay and join</Btn> : <Btn full tone="green" onClick={() => { setConfirm(false); go("wallet"); }}>Top up to join</Btn>}</div>
        </Sheet>
      )}
    </>
  );
}

/* =========================================================
   Question round (shared) + Party game + result
   ========================================================= */
function QuestionRound({ item, seconds = 12, onDone, label, big }) {
  const [picked, setPicked] = useState(null);
  const finish = (i) => { if (picked !== null) return; setPicked(i); setTimeout(() => onDone(i === item.c), 900); };
  const t = useCountdown(seconds, () => finish(-1), picked === null);
  return (
    <div className="flex-1 flex flex-col px-5">
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs font-semibold rounded-full px-3 py-1" style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}>{label}</span>
        <span className="f-display text-lg" style={{ color: t <= 3 ? B.red : "#fff" }}>{t}s</span>
      </div>
      <div className="h-1 rounded-full mt-3" style={{ background: "rgba(255,255,255,0.12)" }}><div className="h-full rounded-full" style={{ width: `${(t / seconds) * 100}%`, background: t <= 3 ? B.red : B.green, transition: "width 1s linear" }} /></div>
      <div className="flex-1 flex flex-col justify-center">
        {item.hint && <div className="text-sm font-medium mb-2" style={{ color: B.blueMid }}>{item.hint}</div>}
        <div className={`f-display ${big ? "text-3xl tracking-wide" : "text-2xl"}`} style={{ color: "#fff", lineHeight: 1.2 }}>{item.q}</div>
      </div>
      <div className="grid grid-cols-1 gap-2 pb-6">
        {item.a.map((opt, i) => { const show = picked !== null; const bg = show ? (i === item.c ? B.green : i === picked ? B.red : "rgba(255,255,255,0.06)") : "rgba(255,255,255,0.1)"; return (
          <button key={i} onClick={() => finish(i)} className="rounded-2xl px-4 py-4 text-left font-semibold flex items-center justify-between active:scale-95 transition" style={{ background: bg, color: show && i === item.c ? B.navy : "#fff" }}>{opt}{show && i === item.c && <Check size={18} />}{show && i === picked && i !== item.c && <X size={18} />}</button>); })}
      </div>
    </div>
  );
}
/** One party question, any format. Server-timed; this is the client view only. */
function PartyQuestion({ item, seconds = 15, onDone, label, onFlag, flagged, voided }) {
  const [picked, setPicked] = useState(null); // single/image: index; multi: array; order: array of idx; match: array
  const [order, setOrder] = useState(() => (item.type === "order" ? item.items.map((_, i) => i) : []));
  const [pairs, setPairs] = useState(() => (item.type === "match" ? item.left.map(() => null) : []));
  const [sel, setSel] = useState(null);
  const [multi, setMulti] = useState([]);
  const [locked, setLocked] = useState(false);
  const startRef = useRef(Date.now());
  const submit = (val) => { if (locked) return; setLocked(true); setPicked(val); const score = grade(val); const elapsed = (Date.now() - startRef.current) / 1000; setTimeout(() => onDone(score, Array.isArray(val) ? -2 : val, elapsed), 700); };
  const grade = (val) => {
    if (val === null || val === undefined || val === -1) return 0;
    if (item.type === "single" || item.type === "image") return val === item.c ? 1 : 0;
    if (item.type === "multi") { const right = item.c.filter((c) => val.includes(c)).length; const wrong = val.filter((v) => !item.c.includes(v)).length; return Math.max(0, (right - wrong) / item.c.length); }
    if (item.type === "order") return val.filter((v, i) => v === item.c[i]).length / item.c.length;
    if (item.type === "match") return val.filter((v, i) => v === item.c[i]).length / item.c.length;
    return 0;
  };
  const t = useCountdown(seconds, () => submit(item.type === "multi" ? multi : item.type === "order" ? order : item.type === "match" ? pairs : picked ?? -1), !locked && !voided);
  const move = (idx, dir) => setOrder((o) => { const n = [...o]; const j = idx + dir; if (j < 0 || j >= n.length) return o; [n[idx], n[j]] = [n[j], n[idx]]; return n; });
  const fmt = FORMATS.find((f) => f[0] === item.type)?.[1] || "Pick one";
  const optStyle = (on, correct, wrong) => ({ background: locked ? (correct ? B.green : wrong ? B.red : "rgba(255,255,255,0.06)") : on ? B.lime : "rgba(255,255,255,0.1)", color: (locked && correct) || (!locked && on) ? B.navy : "#fff" });
  return (
    <div className="flex-1 flex flex-col px-5 relative">
      {voided && <div className="absolute inset-x-5 top-16 z-20 rounded-2xl p-4 text-center pop" style={{ background: B.amber, color: B.navy }}><div className="font-semibold text-sm">Question voided</div><div className="text-xs mt-0.5">{voided} of {voided + 3} players flagged it. Nobody scores it. A replacement is added at the end.</div></div>}
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs font-semibold rounded-full px-3 py-1 flex items-center gap-1.5" style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}>{label}<span style={{ color: B.blueMid }}>· {fmt}</span></span>
        <div className="flex items-center gap-2">
          <button onClick={onFlag} aria-label="Flag this question" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: flagged ? B.amber : "rgba(255,255,255,0.12)" }}><Flag size={14} color={flagged ? B.navy : "#fff"} /></button>
          <span className="f-display text-lg" style={{ color: t <= 3 ? B.red : "#fff" }}>{t}s</span>
        </div>
      </div>
      <div className="h-1 rounded-full mt-3" style={{ background: "rgba(255,255,255,0.12)" }}><div className="h-full rounded-full" style={{ width: `${(t / seconds) * 100}%`, background: t <= 3 ? B.red : B.green, transition: "width 1s linear" }} /></div>
      <div className="flex-1 flex flex-col justify-center min-h-0">
        {item.type === "image" && <div className="mx-auto mb-3 rounded-2xl flex flex-col items-center justify-center" style={{ width: 200, height: 120, background: "rgba(255,255,255,0.08)" }}><span style={{ fontSize: 56 }}>{item.img}</span><span className="text-xs mt-1" style={{ color: B.blueMid }}>{item.caption}</span></div>}
        <div className="f-display text-xl text-white" style={{ lineHeight: 1.2 }}>{item.q}</div>
        {item.replacement && <div className="mt-1 text-xs" style={{ color: B.lime }}>Replacement question</div>}
      </div>
      <div className="pb-5">
        {(item.type === "single" || item.type === "image") && (<><div className="grid grid-cols-2 gap-2">{item.a.map((opt, i) => { const on = picked === i; return <button key={i} onClick={() => !locked && setPicked(i)} className="rounded-2xl px-3 py-4 text-left font-semibold flex items-center gap-2 active:scale-95 transition" style={{ background: on ? B.lime : ["rgba(11,100,252,0.55)", "rgba(249,115,22,0.55)", "rgba(124,58,237,0.55)", "rgba(4,214,139,0.45)"][i % 4], color: on ? B.navy : "#fff", boxShadow: on ? `0 0 0 3px ${B.lime}` : "none", minHeight: 64 }}><span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 f-display text-xs" style={{ background: on ? B.navy : "rgba(0,0,0,0.25)", color: on ? B.lime : "#fff" }}>{"ABCD"[i]}</span><span className="text-sm leading-tight">{opt}</span>{on && <Check size={16} className="ml-auto" strokeWidth={3} />}</button>; })}</div><div className="mt-2"><Btn full tone="green" disabled={locked || picked === null} onClick={() => submit(picked)}>{locked ? "Locked" : picked === null ? "Tap an answer" : "Lock in"}</Btn><div className="mt-1 text-center text-xs" style={{ color: B.blueMid }}>{!locked && picked !== null ? "Tap another to change. Locks when time runs out." : ""}</div></div></>)}
        {item.type === "multi" && (<><div className="grid grid-cols-2 gap-2">{item.a.map((opt, i) => { const on = multi.includes(i); return <button key={i} onClick={() => !locked && setMulti((m) => (on ? m.filter((x) => x !== i) : [...m, i]))} className="rounded-2xl px-3 py-3 text-left font-semibold flex items-center gap-2 active:scale-95 transition" style={optStyle(on, locked && item.c.includes(i), locked && on && !item.c.includes(i))}><span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: on || (locked && item.c.includes(i)) ? B.navy : "rgba(255,255,255,0.15)" }}>{(on || (locked && item.c.includes(i))) && <Check size={13} color={B.lime} strokeWidth={3} />}</span><span className="text-sm">{opt}</span></button>; })}</div><div className="mt-2"><Btn full tone="green" disabled={locked || !multi.length} onClick={() => submit(multi)}>Lock in · {multi.length} picked</Btn></div></>)}
        {item.type === "order" && (<><div className="flex flex-col gap-2">{order.map((idx, pos) => { const right = locked && item.c[pos] === idx; return <div key={idx} className="rounded-2xl px-3 py-2.5 flex items-center gap-2 font-semibold" style={{ background: locked ? (right ? B.green : B.red) : "rgba(255,255,255,0.1)", color: locked && right ? B.navy : "#fff" }}><span className="w-6 f-display text-sm" style={{ color: locked && right ? B.navy : B.blueMid }}>{pos + 1}</span><span className="flex-1 text-sm">{item.items[idx]}</span>{!locked && <><button onClick={() => move(pos, -1)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.12)" }}>↑</button><button onClick={() => move(pos, 1)} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.12)" }}>↓</button></>}</div>; })}</div><div className="mt-2"><Btn full tone="green" disabled={locked} onClick={() => submit(order)}>Lock in</Btn></div></>)}
        {item.type === "match" && (<><div className="grid grid-cols-2 gap-2">{item.left.map((l, i) => { const paired = pairs[i]; const right = locked && paired === item.c[i]; return <button key={l} onClick={() => !locked && setSel(i)} className="rounded-2xl px-3 py-2.5 text-left text-sm font-semibold flex items-center gap-2" style={{ background: locked ? (right ? B.green : B.red) : sel === i ? B.lime : "rgba(255,255,255,0.1)", color: (locked && right) || sel === i ? B.navy : "#fff" }}><span className="flex-1">{l}</span>{paired !== null && <span className="text-xs opacity-80 flex items-center gap-1"><Link2 size={11} />{item.right[paired]}</span>}</button>; })}
          {item.right.map((r, j) => { const used = pairs.includes(j); return <button key={r} onClick={() => { if (locked || sel === null) return; setPairs((p) => { const n = p.map((x) => (x === j ? null : x)); n[sel] = j; return n; }); setSel(null); }} className="rounded-2xl px-3 py-2.5 text-left text-sm font-semibold" style={{ background: used ? "rgba(43,255,176,0.2)" : "rgba(255,255,255,0.1)", color: "#fff", opacity: sel === null && !used ? 0.8 : 1 }}>{r}</button>; })}</div><div className="mt-1 text-xs" style={{ color: B.blueMid }}>Tap a city, then its nickname.</div><div className="mt-2"><Btn full tone="green" disabled={locked || pairs.includes(null)} onClick={() => submit(pairs)}>Lock in</Btn></div></>)}
      </div>
    </div>
  );
}
function PartyGame() {
  const { params, parties, go, toast, chats, sendChat, following, user } = useApp();
  const p = parties.find((x) => x.id === params.party);
  const isHost = p.host === "me";
  const roster = [...new Set([...(p.players || []), ...(p.host !== "me" && PEOPLE[p.host] && !PEOPLE[p.host].brand ? [p.host] : []), "segun", "chidi"])].filter((id) => PEOPLE[id]).slice(0, 7);
  const [qs, setQs] = useState(PARTY_QS); const [i, setI] = useState(0);
  const [phase, setPhase] = useState("question"); // question → reveal → board → question…
  const [scores, setScores] = useState(() => Object.fromEntries(["me", ...roster].map((id) => [id, 0])));
  const [prevRank, setPrevRank] = useState({});
  const [last, setLast] = useState(null); // { pts, correct, pick, dist, noAnswer, elapsed }
  const [flagSheet, setFlagSheet] = useState(false); const [flags, setFlags] = useState({}); const [voidedAt, setVoidedAt] = useState(null); const [voidCount, setVoidCount] = useState(0);
  const [showExplain, setShowExplain] = useState(false);
  const item = qs[i];
  const rank = (sc) => Object.entries(sc).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const standings = rank(scores);

  // Question answered (or timed out): score it, simulate the room, move to reveal.
  const onAnswered = (quality, pick, elapsed) => {
    const speed = Math.max(0, 1 - elapsed / (item.seconds || 12));
    const pts = voidedAt === i ? 0 : Math.round(quality * (100 + 100 * speed));
    const others = Object.fromEntries(roster.map((id) => { const good = Math.random() < 0.55; return [id, good ? Math.round(100 + 100 * Math.random()) : 0]; }));
    const n = roster.length + 1; const optCount = item.a ? item.a.length : 4;
    const dist = Array.from({ length: optCount }, () => 0); let noAns = 0;
    roster.forEach((id) => { if (Math.random() < 0.12) noAns += 1; else dist[others[id] ? (item.c?.[0] ?? item.c ?? 0) : Math.floor(Math.random() * optCount)] += 1; });
    if (item.type === "single" || item.type === "image") { if (pick === -1 || pick === null) noAns += 1; else dist[pick] += 1; }
    setPrevRank(Object.fromEntries(standings.map((id, k) => [id, k])));
    setScores((s) => { const ns = { ...s, me: s.me + pts }; roster.forEach((id) => { ns[id] = s[id] + others[id]; }); return ns; });
    setLast({ pts, correct: quality >= 0.999, partial: quality > 0 && quality < 0.999, pick, dist, noAnswer: noAns, elapsed, n });
    setPhase("reveal");
  };
  const next = () => { if (i + 1 >= qs.length) go("partyResult", { party: p.id, score: scores.me, total: qs.length, voided: voidCount, board: standings }); else { setI(i + 1); setPhase("question"); setShowExplain(false); } };
  const flag = (reason) => { setFlagSheet(false); setFlags((f) => ({ ...f, [i]: reason })); setTimeout(() => { setVoidedAt(i); setVoidCount((c) => c + 1); setQs((q) => [...q, REPLACEMENT_Q]); toast("3 others flagged it too. Voided and replaced."); }, 900); };
  const msgs = (chats[p.id] || []).filter((m) => !m.system).slice(-3);

  return (
    <div className="flex-1 flex flex-col relative" style={{ background: phase === "board" ? `radial-gradient(120% 60% at 50% -10%, rgba(4,214,139,0.35), transparent 60%), ${B.navyDeep}` : B.navy }}>
      {/* Header: party, pot, your rank, AI tag */}
      <div className="flex items-center gap-3 px-5 pt-4">
        <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-white truncate">{p.title}</div><div className="text-xs flex items-center gap-1" style={{ color: B.blueMid }}>{isCash(p) ? `Pot ${naira(potOf(p))}` : p.prize.label} · {roster.length + 1} playing · <Wand2 size={11} /> AI</div></div>
        <div className="text-xs font-semibold rounded-full px-3 py-1 flex items-center gap-1.5" style={{ background: B.green, color: B.navy }}><Crown size={12} />#{standings.indexOf("me") + 1} · {scores.me}</div>
      </div>
      <div className="px-5 mt-3 flex gap-1">{qs.map((_, k) => <div key={k} className="flex-1 h-1 rounded-full" style={{ background: k < i ? B.green : k === i ? B.electric : "rgba(255,255,255,0.12)" }} />)}</div>

      {phase === "question" && (
        <PartyQuestion key={i} item={item} seconds={item.seconds || 12} onDone={onAnswered} label={`${i + 1} of ${qs.length}`} onFlag={() => !flags[i] && setFlagSheet(true)} flagged={!!flags[i]} voided={voidedAt === i ? 4 : 0} />
      )}

      {phase === "reveal" && last && (
        <RevealScreen item={item} last={last} isHost={isHost} onNext={next} onExplain={() => setShowExplain(true)} onFlag={() => !flags[i] && setFlagSheet(true)} flagged={!!flags[i]} voided={voidedAt === i} onDone={() => setPhase("board")} />
      )}

      {phase === "board" && (
        <BoardScreen standings={standings} scores={scores} prevRank={prevRank} isHost={isHost} onNext={next} lastQ={i + 1 >= qs.length} msgs={msgs} onSend={(payload) => sendChat(p.id, payload)} roster={roster} />
      )}

      {showExplain && <Sheet onClose={() => setShowExplain(false)}><H size={20}>Why</H><Sub className="mt-2">{item.explain || "Lokoja sits at the confluence of the Niger and Benue rivers, which is why it was chosen as the first administrative capital of Nigeria in 1914."}</Sub><div className="mt-3 text-xs flex items-center gap-1" style={{ color: B.text3 }}><Wand2 size={12} />AI-generated, fact-checked against two sources.</div></Sheet>}
      {flagSheet && (
        <Sheet onClose={() => setFlagSheet(false)}>
          <H size={20}>What's wrong with it?</H>
          <Sub className="mt-1">If enough players agree, the question is voided for everyone and replaced. Your answer still counts if it isn't.</Sub>
          <div className="mt-4 flex flex-col gap-2">{FLAG_REASONS.map((r) => <button key={r} onClick={() => flag(r)} className="rounded-2xl px-4 py-3 text-left text-sm font-semibold" style={{ background: B.bg, color: B.navy }}>{r}</button>)}</div>
        </Sheet>
      )}
    </div>
  );
}

/** Reveal: the answer, your pick, how the room answered, your points. Host can move on after a 3s floor. */
function RevealScreen({ item, last, isHost, onNext, onExplain, onFlag, flagged, voided, onDone }) {
  const secs = 6;
  const t = useCountdown(secs, onDone);
  const opts = item.a || (item.type === "order" ? item.items : item.left);
  const correctIdx = Array.isArray(item.c) ? item.c : [item.c];
  const total = Math.max(1, last.dist.reduce((a, b) => a + b, 0) + last.noAnswer);
  const mine = last.pick;
  return (
    <div className="flex-1 flex flex-col px-5">
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs font-semibold rounded-full px-3 py-1 flex items-center gap-1.5" style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}>Answer</span>
        <div className="flex items-center gap-2">
          <button onClick={onFlag} aria-label="Flag" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: flagged ? B.amber : "rgba(255,255,255,0.12)" }}><Flag size={14} color={flagged ? B.navy : "#fff"} /></button>
          <span className="f-display text-lg text-white">{t}s</span>
        </div>
      </div>
      <div className="h-1 rounded-full mt-3" style={{ background: "rgba(255,255,255,0.12)" }}><div className="h-full rounded-full" style={{ width: `${(t / secs) * 100}%`, background: B.lime, transition: "width 1s linear" }} /></div>

      {/* Verdict */}
      <div className={`mt-4 rounded-3xl p-4 flex items-center gap-3 pop`} style={{ background: voided ? B.amber : last.correct ? B.green : last.partial ? "#FFF4D6" : B.redSoft }}>
        <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(0,0,0,0.12)" }}>{voided ? <Flag size={20} color={B.navy} /> : last.correct ? <Check size={22} color={B.navy} strokeWidth={3} /> : last.partial ? <span className="f-display" style={{ color: B.navy }}>½</span> : <X size={22} color={B.red} strokeWidth={3} />}</div>
        <div className="flex-1 min-w-0"><div className="f-display text-lg" style={{ color: voided ? B.navy : last.correct || last.partial ? B.navy : B.red }}>{voided ? "Voided" : last.correct ? `Correct · +${last.pts}` : last.partial ? `Partly · +${last.pts}` : mine === -1 || mine === null ? "No answer" : "Not this one"}</div><div className="text-xs" style={{ color: B.navy, opacity: 0.75 }}>{voided ? "Nobody scores this one. Replacement added." : last.correct ? `${last.elapsed.toFixed(1)}s · speed bonus included` : last.partial ? "Partial credit for what you got right" : "0 points this round"}</div></div>
        {item.explain !== null && <button onClick={onExplain} aria-label="Why" className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(0,0,0,0.12)" }}><span className="f-display text-sm" style={{ color: B.navy }}>i</span></button>}
      </div>

      <div className="mt-3 text-sm font-semibold text-white" style={{ lineHeight: 1.3 }}>{item.q}</div>

      {/* Distribution */}
      <div className="mt-3 flex flex-col gap-2">
        {opts.slice(0, 4).map((opt, k) => { const isC = correctIdx.includes(k); const isMine = mine === k; const share = last.dist[k] / total; return (
          <div key={k} className="rounded-2xl px-3 py-2 relative overflow-hidden" style={{ background: "rgba(255,255,255,0.06)", boxShadow: isMine ? `inset 0 0 0 2px ${isC ? B.lime : B.red}` : "none" }}>
            <div className="absolute inset-y-0 left-0 rounded-2xl grow-bar" style={{ width: `${Math.max(4, share * 100)}%`, background: isC ? "rgba(4,214,139,0.45)" : "rgba(255,255,255,0.08)" }} />
            <div className="relative flex items-center gap-2 text-sm"><span className="flex-1 font-semibold text-white truncate">{typeof opt === "string" ? opt : String(opt)}</span>{isMine && <span className="text-xs font-bold rounded-full px-2 py-0.5" style={{ background: isC ? B.lime : B.red, color: isC ? B.navy : "#fff" }}>Your pick</span>}{isC && !isMine && <Check size={14} color={B.lime} strokeWidth={3} />}<span className="text-xs font-semibold tabular-nums w-10 text-right" style={{ color: B.blueMid }}>{Math.round(share * 100)}%</span></div>
          </div>); })}
        {last.noAnswer > 0 && <div className="text-xs" style={{ color: B.blueMid }}>{last.noAnswer} didn't answer</div>}
      </div>
      <div className="flex-1" />
      <div className="pb-5 pt-3">{isHost ? <Btn full tone="white" disabled={t > secs - 3} onClick={onDone} icon={<ArrowRight size={16} />}>{t > secs - 3 ? `Standings in ${t - (secs - 3)}…` : "Show standings"}</Btn> : <div className="text-center text-xs" style={{ color: B.blueMid }}>Standings in {t}s</div>}</div>
    </div>
  );
}

/** Leaderboard between questions: top 5 ladder animates from previous rank; you pinned if outside; chat open here only. */
function BoardScreen({ standings, scores, prevRank, isHost, onNext, lastQ, msgs, onSend, roster }) {
  const secs = 7;
  const t = useCountdown(secs, onNext);
  const top = standings.slice(0, 5); const myRank = standings.indexOf("me");
  const ROW = 52;
  const [open, setOpen] = useState(false);
  const name = (id) => (id === "me" ? "You" : PEOPLE[id].name.split(" ")[0]);
  const delta = (id) => { const pr = prevRank[id]; const nr = standings.indexOf(id); return pr === undefined ? 0 : pr - nr; };
  return (
    <div className="flex-1 flex flex-col px-5 relative">
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs font-semibold rounded-full px-3 py-1 flex items-center gap-1.5" style={{ background: "rgba(43,255,176,0.15)", color: B.lime }}><Crown size={12} />Standings</span>
        <span className="text-xs font-semibold" style={{ color: B.blueMid }}>{lastQ ? "Final" : `Next question in ${t}s`}</span>
      </div>
      <div className="mt-4 relative" style={{ height: ROW * Math.min(5, standings.length) }}>
        {standings.map((id, r) => { const d = delta(id); const shown = r < 5; return (
          <div key={id} className="absolute left-0 right-0 flex items-center gap-3 rounded-2xl px-3" style={{ top: shown ? r * ROW : (prevRank[id] ?? 5) * ROW, height: ROW - 6, background: id === "me" ? "rgba(43,255,176,0.18)" : "rgba(255,255,255,0.06)", opacity: shown ? 1 : 0, transition: "top .7s cubic-bezier(.2,.9,.3,1), opacity .4s", boxShadow: r === 0 ? `inset 0 0 0 1.5px ${B.amber}` : "none" }}>
            <span className="w-5 f-display text-sm" style={{ color: r === 0 ? B.amber : B.blueMid }}>{r + 1}</span>
            {id === "me" ? <Avatar me size={30} /> : <Avatar id={id} size={30} />}
            <span className="flex-1 text-sm font-semibold text-white truncate">{name(id)}</span>
            {d !== 0 && <span className="text-xs font-bold" style={{ color: d > 0 ? B.lime : "#FF8A9B" }}>{d > 0 ? `▲${d}` : `▼${-d}`}</span>}
            <span className="f-display text-white tabular-nums">{scores[id]}</span>
          </div>); })}
      </div>
      {myRank >= 5 && <div className="mt-2 flex items-center gap-3 rounded-2xl px-3 py-2" style={{ background: "rgba(43,255,176,0.18)", boxShadow: `inset 0 0 0 1.5px ${B.lime}` }}><span className="w-5 f-display text-sm" style={{ color: B.lime }}>{myRank + 1}</span><Avatar me size={30} /><span className="flex-1 text-sm font-semibold text-white">You</span>{delta("me") !== 0 && <span className="text-xs font-bold" style={{ color: delta("me") > 0 ? B.lime : "#FF8A9B" }}>{delta("me") > 0 ? `▲${delta("me")}` : `▼${-delta("me")}`}</span>}<span className="f-display text-white">{scores.me}</span><span className="text-xs" style={{ color: B.blueMid }}>· {scores[standings[4]] - scores.me + 1} to top 5</span></div>}
      <div className="flex-1" />
      {/* Live-stream style chat: last three float above a pinned composer. Only open on this screen. */}
      <div className="pb-2">
        <div className="flex flex-col gap-1 mb-2">{msgs.map((m, k) => <div key={m.id} className="flex items-center gap-2 slide-up" style={{ opacity: 0.55 + k * 0.22 }}>{m.who === "me" ? <Avatar me size={22} /> : <Avatar id={m.who} size={22} />}<span className="text-xs text-white truncate">{m.voice ? "🎤 voice note" : m.sticker ? <span className="text-lg">{m.sticker}</span> : m.text}</span></div>)}</div>
        <div className="-mx-4"><Composer onSend={onSend} members={roster} placeholder="Say it now, before the next one" /></div>
        {isHost && <div className="px-0 pt-1"><Btn full tone="white" onClick={onNext} icon={<ArrowRight size={16} />}>{lastQ ? "Show results" : "Next question"}</Btn></div>}
      </div>
    </div>
  );
}
function PartyResult() {
  const { params, parties, reset, openShare, rematch, following, openProfile, setWallet, addTxn, user, go } = useApp();
  const p = parties.find((x) => x.id === params.party);
  const others = [["ada", 2, "7.2s"], ["kemi", 3, "8.9s"], ["segun", 1, "6.1s"], ["chidi", 2, "9.4s"]];
  const total = params.total || PARTY_QS.length;
  const board = params.board ? params.board.map((id) => ({ id, s: id === "me" ? params.score : Math.max(0, params.score - 40 - params.board.indexOf(id) * 55 + 120), t: `${(5 + Math.random() * 5).toFixed(1)}s` })).sort((a, b) => b.s - a.s) : [...others.map(([id, s, t]) => ({ id, s, t })), { id: "me", s: params.score, t: "6.8s" }].sort((a, b) => b.s - a.s || parseFloat(a.t) - parseFloat(b.t));
  const rank = board.findIndex((b) => b.id === "me"); const pot = potOf(p);
  const prize = isCash(p) && p.split[rank] ? Math.floor((pot * p.split[rank]) / 100) : 0;
  const wonItem = !isCash(p) && rank === 0 ? p.prize : null;
  const credited = useRef(false);
  useEffect(() => { if (prize && !credited.current) { credited.current = true; setWallet((w) => ({ ...w, cash: w.cash + prize })); addTxn({ label: `Won in ${p.title}`, amount: prize, kind: "cash" }); } }, []);
  const notFollowed = board.filter((b) => b.id !== "me" && !following.includes(b.id));
  return (
    <div className="flex-1 flex flex-col" style={{ background: prize || wonItem ? B.green : B.bg }}>
      <Screen>
        <div className="pt-10 text-center">
          <div className="w-20 h-20 mx-auto rounded-full flex items-center justify-center pop" style={{ background: prize || wonItem ? "rgba(255,255,255,0.35)" : B.soft }}>{wonItem ? <Gift size={36} color={B.navy} /> : <Trophy size={36} color={prize ? B.navy : B.text3} />}</div>
          <H size={32} className="mt-4">{wonItem ? `You won ${wonItem.label}` : prize ? `You won ${naira(prize)}` : `You came ${rank + 1}${["st", "nd", "rd"][rank] || "th"}`}</H>
          <Sub className="mt-1" color={prize || wonItem ? B.navy : B.text2}>{wonItem ? `From ${PEOPLE[p.host]?.name || "the host"}. We've messaged you both to arrange it. Worth about ${naira(wonItem.value)}.` : prize ? "Added to your cash. Withdraw any time." : `${params.score} points over ${total} questions. Run it back?`}</Sub>
        </div>
        <Card className="mt-6 overflow-hidden">
          {board.map((b, i) => (
            <div key={b.id} onClick={() => b.id !== "me" && openProfile(b.id)} className={`flex items-center gap-3 px-4 py-3 ${b.id !== "me" ? "cursor-pointer" : ""}`} style={{ borderTop: i ? `1px solid ${B.line}` : "none", background: b.id === "me" ? B.blueSoft : "#fff" }}>
              <div className="w-6 f-display text-sm" style={{ color: B.navy }}>{i + 1}</div>
              {b.id === "me" ? <Avatar me size={32} /> : <Avatar id={b.id} size={32} />}
              <div className="flex-1 text-sm font-semibold" style={{ color: B.navy }}>{b.id === "me" ? "You" : PEOPLE[b.id].name}</div>
              <div className="text-xs" style={{ color: B.text3 }}>{b.s} pts</div>
              {isCash(p) ? p.split[i] && <div className="text-xs font-semibold" style={{ color: B.greenDeep }}>{naira(Math.floor((pot * p.split[i]) / 100))}</div> : i === 0 && <Gift size={14} color={B.greenDeep} />}
            </div>
          ))}
        </Card>
        {params.voided > 0 && <div className="mt-3 flex items-center gap-2 rounded-2xl px-4 py-3 text-xs" style={{ background: "#FFF4D6", color: "#8A5A00" }}><Flag size={14} />{params.voided} question{params.voided > 1 ? "s" : ""} voided by player flags and replaced. The engine has retired {params.voided > 1 ? "them" : "it"}.</div>}
        {user.guest && <Card className="mt-3 p-4" style={{ background: B.navy, boxShadow: "none" }}><div className="text-sm font-semibold text-white">Keep this result.</div><Sub className="mt-1" color={B.blueMid}>Sign up to save your score, earn coins for the next party and be eligible for prizes.</Sub><div className="mt-3"><Btn full tone="green" onClick={() => go("whoPlays")}>Sign up · 10 seconds</Btn></div></Card>}
        {notFollowed.length > 0 && <Card className="mt-3 px-4 py-2"><div className="text-xs font-semibold pt-2" style={{ color: B.text3 }}>FOLLOW WHO YOU JUST PLAYED</div>{notFollowed.slice(0, 2).map((b) => <FollowRow key={b.id} id={b.id} compact />)}</Card>}
        <div className="h-4" />
      </Screen>
      <div className="p-5 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2"><Btn tone="white" onClick={() => openShare({ kind: "win", text: prize ? `I just won ${naira(prize)} in ${p.title}` : `I came ${rank + 1} in ${p.title}` })}>Share</Btn><Btn tone="navy" onClick={() => rematch(p)}>Rematch</Btn></div>
        <Btn tone={prize ? "white" : "line"} full onClick={() => reset("home")}>Back to home</Btn>
      </div>
    </div>
  );
}

/* =========================================================
   Payout Challenge: intro → N stages with decisions → result
   ========================================================= */
function PayoutIntro() {
  const { go, wallet, seatsLeft, setWallet, addTxn } = useApp();
  const enough = wallet.bonus >= PAYOUT.entryCoins;
  const start = () => { setWallet((w) => ({ ...w, bonus: w.bonus - PAYOUT.entryCoins })); addTxn({ label: "Payout Challenge entry", amount: -PAYOUT.entryCoins, kind: "bonus" }); go("payoutGame"); };
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.bg }}>
      <TopBar title="" />
      <Screen>
        <div className="flex items-center gap-2"><Zap size={20} color={B.greenDeep} /><span className="text-sm font-semibold" style={{ color: B.greenDeep }}>PAYOUT CHALLENGE</span></div>
        <H size={32} className="mt-2">{PAYOUT.stages.length} stages. Your call at every one.</H>
        <Sub className="mt-2">Clear a stage to hold its prize. Then choose: walk away with it, or risk it for the next one.</Sub>
        <Card className="mt-5 overflow-hidden">
          {PAYOUT.stages.map((s, i) => { const last = i === PAYOUT.stages.length - 1; return (
            <div key={i} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? `1px solid ${B.line}` : "none", background: last ? B.navy : "#fff" }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center f-display text-sm shrink-0" style={{ background: last ? B.green : B.blueSoft, color: last ? B.navy : B.blue }}>{i + 1}</div>
              <div className="flex-1"><div className="text-sm font-semibold" style={{ color: last ? "#fff" : B.navy }}>{s.type}</div><div className="text-xs" style={{ color: last ? B.blueMid : B.text2 }}>{s.hint} · {s.seconds}s</div></div>
              <div className="f-display text-base" style={{ color: last ? B.green : B.navy }}>{naira(s.prize)}</div>
            </div>); })}
        </Card>
        <div className="mt-4 flex flex-col gap-2 text-sm" style={{ color: B.ink }}>
          <div className="flex gap-2"><Clock size={16} color={B.text3} className="mt-0.5 shrink-0" />{PAYOUT.decisionSeconds} seconds to decide after each stage. No choice means you continue.</div>
          <div className="flex gap-2"><Users size={16} color={B.text3} className="mt-0.5 shrink-0" />{seatsLeft} seats left this week. New players get seats first.</div>
          <div className="flex gap-2"><Trophy size={16} color={B.text3} className="mt-0.5 shrink-0" />Every stage you clear adds points to the weekly leaderboard.</div>
        </div>
        <div className="h-4" />
      </Screen>
      <div className="p-5 flex flex-col gap-2">
        <Btn full tone="green" disabled={!enough} onClick={start} icon={<Zap size={16} />}>{enough ? `Pay ${PAYOUT.entryCoins} coins and start` : `You need ${PAYOUT.entryCoins} coins`}</Btn>
        {!enough && <Btn full tone="line" onClick={() => go("wallet")}>Top up</Btn>}
      </div>
    </div>
  );
}
function Decision({ value, nextValue, onWalk, onContinue }) {
  const t = useCountdown(PAYOUT.decisionSeconds, onContinue);
  return (
    <div className="flex-1 flex flex-col px-5 pb-6">
      <div className="flex-1 flex flex-col justify-center items-center text-center">
        <div className="text-sm font-semibold" style={{ color: B.blueMid }}>You're holding</div>
        <H size={56} color={B.green} className="pop mt-1">{naira(value)}</H>
        <Sub className="mt-4 max-w-xs" color="#fff">Next stage pays <b>{naira(nextValue)}</b>. Lose it and you leave with nothing.</Sub>
        <div className="mt-6 w-20 h-20 rounded-full flex items-center justify-center f-display text-2xl text-white" style={{ boxShadow: `inset 0 0 0 4px ${t <= 3 ? B.red : "rgba(255,255,255,0.2)"}` }}>{t}</div>
        <div className="text-xs mt-2" style={{ color: B.blueMid }}>Continues automatically at 0</div>
      </div>
      <div className="grid grid-cols-2 gap-2"><Btn tone="white" onClick={onWalk}>Walk away with {naira(value)}</Btn><Btn tone="green" onClick={onContinue}>Risk it</Btn></div>
    </div>
  );
}
function PayoutGame() {
  const { go } = useApp();
  const [stage, setStage] = useState(0); const [phase, setPhase] = useState("play"); const [held, setHeld] = useState(0);
  const N = PAYOUT.stages.length;
  const onDone = (ok) => {
    if (!ok) return go("payoutResult", { outcome: "lost", stage, amount: 0 });
    const v = PAYOUT.stages[stage].prize; setHeld(v);
    if (stage === N - 1) return go("payoutResult", { outcome: "won", stage, amount: v });
    setPhase("decide");
  };
  const s = PAYOUT.stages[stage];
  return (
    <div className="flex-1 flex flex-col" style={{ background: B.navy }}>
      <div className="px-5 pt-5"><Ladder compact current={phase === "play" ? stage : -1} held={phase === "decide" ? stage : stage - 1} /></div>
      <div className="px-5 mt-3 flex justify-between text-xs font-semibold" style={{ color: B.blueMid }}><span>Stage {stage + 1} of {N}</span><span>Holding {naira(held)}</span></div>
      {phase === "play" ? <QuestionRound key={stage} item={s} onDone={onDone} label={`${s.type} · for ${naira(s.prize)}`} big={["Scramble", "Word hunt"].includes(s.type)} seconds={s.seconds} />
        : <Decision key={`d${stage}`} value={held} nextValue={PAYOUT.stages[stage + 1].prize} onWalk={() => go("payoutResult", { outcome: "walked", stage, amount: held })} onContinue={() => { setStage(stage + 1); setPhase("play"); }} />}
    </div>
  );
}
function PayoutResult() {
  const { params, reset, openShare, setWallet, addTxn } = useApp();
  const { outcome, stage, amount } = params;
  const credited = useRef(false);
  useEffect(() => { if (amount && !credited.current) { credited.current = true; setWallet((w) => ({ ...w, cash: w.cash + amount })); addTxn({ label: `Payout Challenge · stage ${stage + 1}`, amount, kind: "cash" }); } }, []);
  const pts = (outcome === "lost" ? stage : stage + 1) * 20;
  const lost = outcome === "lost";
  const title = outcome === "won" ? `All ${PAYOUT.stages.length} stages. ${naira(amount)}.` : outcome === "walked" ? `You walked away with ${naira(amount)}` : "So close.";
  return (
    <div className="flex-1 flex flex-col" style={{ background: lost ? B.navy : B.green }}>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="w-24 h-24 rounded-full flex items-center justify-center pop" style={{ background: lost ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.35)" }}>{lost ? <X size={44} color="#fff" /> : <ShieldCheck size={44} color={B.navy} />}</div>
        <H size={32} color={lost ? "#fff" : B.navy} className="mt-5">{title}</H>
        <Sub className="mt-2" color={lost ? B.blueMid : B.navy}>{lost ? `Out at stage ${stage + 1}. You still earned leaderboard points.` : "Added to your cash. Withdraw any time."}</Sub>
        <div className="mt-5 rounded-full px-4 py-2 text-sm font-semibold flex items-center gap-2" style={{ background: lost ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.4)", color: lost ? "#fff" : B.navy }}><Trophy size={16} />+{pts} leaderboard points</div>
      </div>
      <div className="p-5 flex flex-col gap-2">
        {!lost && <Btn full tone="navy" onClick={() => openShare({ kind: "win", text: title })}>Share with friends</Btn>}
        <Btn full tone={lost ? "green" : "white"} onClick={() => reset("payoutIntro")}>Play again</Btn>
        <Btn full tone={lost ? "line" : "white"} onClick={() => reset("home")}><span style={{ color: lost ? "#fff" : B.navy }}>Back to home</span></Btn>
      </div>
    </div>
  );
}

/* =========================================================
   Activity, Me, Wallet, other people's profiles
   ========================================================= */
function ActivityBody() {
  const { notifs, setNotifs, go, following, toggleFollow, openProfile } = useApp();
  useEffect(() => { const t = setTimeout(() => setNotifs((n) => n.map((x) => ({ ...x, unread: false }))), 1500); return () => clearTimeout(t); }, []);
  return (
    <>
      <Screen>
        <Card className="mt-3 overflow-hidden">
          {notifs.map((n, i) => (
            <div key={n.id} onClick={() => (n.go ? go(n.go.screen, n.go) : openProfile(n.who))} className="flex gap-3 p-4 cursor-pointer" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}>
              <div className="relative" onClick={(e) => { e.stopPropagation(); openProfile(n.who); }}><Avatar id={n.who} size={40} />{n.unread && <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full" style={{ background: B.blue, boxShadow: "0 0 0 2px #fff" }} />}</div>
              <div className="flex-1 text-sm" style={{ color: B.ink }}><Name id={n.who} /> {n.text}<div className="text-xs mt-1" style={{ color: B.text3 }}>{n.time}</div></div>
              {n.follow && <div onClick={(e) => e.stopPropagation()}><Btn small tone={following.includes(n.who) ? "soft" : "blue"} onClick={() => toggleFollow(n.who)}>{following.includes(n.who) ? "Following" : "Follow back"}</Btn></div>}
              {n.go && <ChevronRight size={18} color={B.text3} className="self-center" />}
            </div>
          ))}
        </Card>
      </Screen>
    </>
  );
}
function Me() {
  const { user, following, go, openShare, streak, stats, switchProfile } = useApp();
  const code = (user.handle || "you").toUpperCase().slice(0, 8) + "200";
  return (
    <Screen>
      <div className="pt-6 flex flex-col items-center text-center">
        <Avatar me size={84} ring={B.blue} />
        <H size={24} className="mt-3">{user.name || "You"}</H>
        <div className="text-sm flex items-center gap-1.5" style={{ color: B.text2 }}>@{user.handle || "you"}{user.flex ? ` · ${user.flex}` : ""}{user.isBrand && <button onClick={() => go("brandSetup")} className="rounded-full px-2 py-0.5 text-xs font-semibold flex items-center gap-1" style={{ background: "#FFF4D6", color: "#B7791F" }}><BadgeCheck size={12} />Verification pending</button>}</div>
        <div className="mt-4 flex gap-8">
          {[["Followers", 3, "followers"], ["Following", following.length, "following"], ["Streak", `${streak}🔥`]].map(([k, v, tab]) => <button key={k} onClick={() => tab && go("followers", { id: "me", tab })}><div className="f-display text-lg" style={{ color: B.navy }}>{v}</div><div className="text-xs" style={{ color: B.text3 }}>{k}</div></button>)}
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-2">{[["Parties", stats.parties], ["Wins", stats.wins], ["Best payout", naira(stats.best)]].map(([k, v]) => <Card key={k} className="p-3 text-center"><div className="font-semibold" style={{ color: B.navy }}>{v}</div><div className="text-xs" style={{ color: B.text3 }}>{k}</div></Card>)}</div>
      <div className="mt-3 rounded-3xl p-5" style={{ background: B.blue }}>
        <div className="flex items-center gap-2"><Gift size={20} color="#fff" /><div className="font-semibold text-white">Invite friends. You both get 200 coins.</div></div>
        <div className="mt-3 flex items-center gap-2 rounded-2xl p-2 pl-4" style={{ background: "rgba(255,255,255,0.15)" }}><div className="flex-1 f-display text-white tracking-wider">{code}</div><Btn small tone="white" onClick={() => openShare({ kind: "referral", text: `Join me on Contestly. Use my code ${code} for 200 bonus coins.` })}>Share</Btn></div>
      </div>
      {/* One login, several profiles. A person can run brands; a brand always has people behind it. */}
      <Card className="mt-3 p-3">
        <div className="text-xs font-semibold mb-2" style={{ color: B.text3 }}>YOUR PROFILES</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3 rounded-2xl px-2 py-2" style={{ background: !user.isBrand ? B.blueSoft : "transparent" }}><Avatar me size={32} /><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate" style={{ color: B.navy }}>{user.isBrand ? (user.personalName || "Your personal profile") : user.name || "You"}</div><div className="text-xs" style={{ color: B.text2 }}>Personal · play and host</div></div>{!user.isBrand ? <Check size={16} color={B.blue} /> : <button onClick={() => switchProfile(false)} className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: B.soft, color: B.navy }}>Switch</button>}</div>
          {(user.brands || (user.isBrand ? [{ name: user.name, handle: user.handle, role: "Owner" }] : [])).map((b) => (
            <div key={b.handle} className="flex items-center gap-3 rounded-2xl px-2 py-2" style={{ background: user.isBrand && user.handle === b.handle ? "#FFF7ED" : "transparent" }}><div className="w-8 h-8 rounded-full flex items-center justify-center f-display text-white text-xs" style={{ background: "#F97316" }}>{initials(b.name)}</div><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate flex items-center gap-1" style={{ color: B.navy }}>{b.name}<BadgeCheck size={14} color={B.text3} /></div><div className="text-xs" style={{ color: B.text2 }}>Brand · {b.role} · hosts only</div></div>{user.isBrand && user.handle === b.handle ? <Check size={16} color="#F97316" /> : <button onClick={() => switchProfile(true, b)} className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: B.soft, color: B.navy }}>Switch</button>}</div>
          ))}
          {!user.isBrand && !(user.brands || []).length && <button onClick={() => go("whoPlays")} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-left"><div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: B.soft }}><Plus size={16} color={B.navy} /></div><div className="text-sm font-semibold" style={{ color: B.navy }}>Create a brand</div></button>}
        </div>
      </Card>
      <Card className="mt-3 overflow-hidden">
        {[["Wallet", Wallet, () => go("wallet")], ["Interests", LayoutGrid, () => go("interests")], ["Badges", Trophy, null]].map(([t, I, fn], i) => (
          <button key={t} onClick={fn || undefined} className="w-full flex items-center gap-3 px-4 py-4 text-left" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}><I size={20} color={B.blue} /><span className="flex-1 font-semibold text-sm" style={{ color: B.navy }}>{t}</span>{t === "Badges" ? <span className="text-xs font-semibold" style={{ color: B.text3 }}>3 earned</span> : <ChevronRight size={18} color={B.text3} />}</button>
        ))}
      </Card>
      <div className="h-6" />
    </Screen>
  );
}
function WalletScreen() {
  const { wallet, txns, toast, setWallet, addTxn } = useApp();
  return (
    <>
      <TopBar title="Wallet" />
      <Screen>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="rounded-3xl p-4" style={{ background: B.green }}><div className="text-xs font-semibold" style={{ color: B.navy, opacity: 0.7 }}>Cash</div><div className="f-display text-2xl mt-1" style={{ color: B.navy }}>{naira(wallet.cash)}</div><div className="text-xs mt-2" style={{ color: B.navy, opacity: 0.8 }}>Your winnings. Withdraw to your bank any time.</div></div>
          <div className="rounded-3xl p-4" style={{ background: B.navy }}><div className="text-xs font-semibold" style={{ color: B.blueMid }}>Coins</div><div className="f-display text-2xl text-white mt-1">{wallet.bonus}</div><div className="text-xs mt-2" style={{ color: B.blueMid }}>For entries only. Can't be withdrawn.</div></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Btn onClick={() => { setWallet((w) => ({ ...w, bonus: w.bonus + 500 })); addTxn({ label: "Top up (demo)", amount: 500, kind: "bonus" }); toast("Added 500 coins"); }}>Add coins</Btn>
          <Btn tone="line" disabled={!wallet.cash} onClick={() => toast(`Withdrawal of ${naira(wallet.cash)} requested`)}>Withdraw</Btn>
        </div>
        <div className="mt-6 font-semibold text-sm" style={{ color: B.navy }}>History</div>
        <Card className="mt-2 mb-6 overflow-hidden">
          {txns.length === 0 && <div className="p-4 text-sm" style={{ color: B.text2 }}>Nothing yet. Entries and wins show here.</div>}
          {txns.map((t, i) => <div key={i} className="flex items-center px-4 py-3 text-sm" style={{ borderTop: i ? `1px solid ${B.line}` : "none" }}><div className="flex-1" style={{ color: B.navy }}>{t.label}<div className="text-xs" style={{ color: B.text3 }}>{t.kind === "cash" ? "Cash" : "Coins"}</div></div><div className="font-semibold" style={{ color: t.amount > 0 ? B.greenDeep : B.navy }}>{t.amount > 0 ? "+" : ""}{t.kind === "cash" ? naira(t.amount) : `${t.amount} coins`}</div></div>)}
        </Card>
      </Screen>
    </>
  );
}
function UserProfile() {
  const { params, following, toggleFollow, notifyOn, toggleNotify, parties, feed, go, openShare, joined } = useApp();
  const id = params.id; const p = PEOPLE[id];
  const [tab, setTab] = useState("Parties");
  const on = following.includes(id); const alert = notifyOn.includes(id);
  const hosting = parties.filter((pp) => pp.host === id);
  const liveIn = parties.find((pp) => pp.host !== id && pp.players.includes(id));
  const posts = feed.filter((f) => f.who === id);
  const mutuals = followersOf(id).filter((m) => following.includes(m));
  const tabs = p.brand ? ["Parties", "About"] : ["Parties", "Activity", "Badges"];
  const [you, them] = p.h2h || [0, 0];
  return (
    <>
      <div style={{ background: p.color }}><TopBar light title="" right={<button aria-label="Share profile" onClick={() => openShare({ kind: "profile", id })} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.15)" }}><Share2 size={18} color="#fff" /></button>} /><div className="h-10" /></div>
      <Screen>
        <div className="-mt-12 flex items-end justify-between">
          <div className="rounded-full p-1" style={{ background: B.bg }}><Avatar id={id} size={88} ring={liveIn ? B.green : null} /></div>
          <div className="flex gap-2 pb-1">
            {on && <button aria-label={alert ? "Turn off party alerts" : "Get party alerts"} onClick={() => toggleNotify(id)} className="w-11 h-11 rounded-2xl flex items-center justify-center" style={{ background: alert ? B.blue : "#fff", boxShadow: `inset 0 0 0 1.5px ${alert ? B.blue : B.line}` }}>{alert ? <BellRing size={18} color="#fff" /> : <Bell size={18} color={B.ink} />}</button>}
            <button aria-label="Message" onClick={() => go("thread", { id })} className="w-11 h-11 rounded-2xl flex items-center justify-center" style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}` }}><MessageCircle size={18} color={B.ink} /></button>
            <Btn tone={on ? "soft" : "blue"} onClick={() => toggleFollow(id)}>{on ? "Following" : "Follow"}</Btn>
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xl" style={{ color: B.navy }}><Name id={id} /></div>
          <div className="text-sm" style={{ color: B.text2 }}>@{p.handle}{p.brand && " · Official brand account"}</div>
          {p.bio && <Sub className="mt-2" color={B.ink}>{p.bio}</Sub>}
          <div className="mt-2 flex gap-1.5 flex-wrap">{p.cats.map((c) => <span key={c} className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: B.soft, color: B.ink }}>{c}</span>)}</div>
        </div>
        <div className="mt-4 flex gap-6">
          <button onClick={() => go("followers", { id, tab: "followers" })} className="text-left"><b style={{ color: B.navy }}>{fmtCount(p.followers)}</b> <span className="text-sm" style={{ color: B.text2 }}>followers</span></button>
          <button onClick={() => go("followers", { id, tab: "following" })} className="text-left"><b style={{ color: B.navy }}>{p.following}</b> <span className="text-sm" style={{ color: B.text2 }}>following</span></button>
          {!p.brand && <div><b style={{ color: B.navy }}>{p.streak}🔥</b> <span className="text-sm" style={{ color: B.text2 }}>streak</span></div>}
        </div>
        {mutuals.length > 0 && <button onClick={() => go("followers", { id, tab: "followers" })} className="mt-3 flex items-center gap-2 text-left"><div className="flex -space-x-2">{mutuals.slice(0, 3).map((m) => <Avatar key={m} id={m} size={22} ring={B.bg} />)}</div><span className="text-xs" style={{ color: B.text2 }}>Followed by <b style={{ color: B.navy }}>{PEOPLE[mutuals[0]].name.split(" ")[0]}</b>{mutuals.length > 1 && ` and ${mutuals.length - 1} other${mutuals.length > 2 ? "s" : ""} you follow`}</span></button>}
        {on && alert && <div className="mt-3 text-xs font-medium flex items-center gap-1.5" style={{ color: B.text2 }}><BellRing size={13} />You'll get an alert whenever they open or join a party.</div>}
        {liveIn && <button onClick={() => go("lobby", { party: liveIn.id })} className="mt-4 w-full rounded-2xl p-3 flex items-center gap-3 text-left" style={{ background: B.green }}><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.3)" }}><Users size={18} color={B.navy} /></div><div className="flex-1 min-w-0"><div className="text-xs font-semibold" style={{ color: B.navy, opacity: 0.7 }}>Playing now</div><div className="text-sm font-semibold truncate" style={{ color: B.navy }}>{liveIn.title}</div></div><span className="rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: B.navy, color: "#fff" }}>{joined.includes(liveIn.id) ? "Open" : "Join"}</span></button>}
        {p.brand ? (
          <div className="mt-4 grid grid-cols-2 gap-2"><Card className="p-3"><div className="font-semibold" style={{ color: B.navy }}>{p.parties}</div><div className="text-xs" style={{ color: B.text3 }}>Parties hosted</div></Card><Card className="p-3"><div className="font-semibold" style={{ color: B.greenDeep }}>{naira(p.paidOut)}</div><div className="text-xs" style={{ color: B.text3 }}>In prizes given</div></Card></div>
        ) : (<>
          <div className="mt-4 grid grid-cols-3 gap-2">{[["Parties", p.parties], ["Wins", p.wins], ["Best payout", naira(p.best)]].map(([k, v]) => <Card key={k} className="p-3 text-center"><div className="font-semibold" style={{ color: B.navy }}>{v}</div><div className="text-xs" style={{ color: B.text3 }}>{k}</div></Card>)}</div>
          <div className="mt-2 rounded-2xl p-4 flex items-center gap-3" style={{ background: B.navy }}>
            <div className="flex items-center gap-2"><Avatar me size={30} /><span className="f-display text-xl text-white">{you}</span></div>
            <div className="flex-1 text-center text-xs font-semibold" style={{ color: B.blueMid }}>{you + them === 0 ? "You haven't played each other yet" : "Head to head"}</div>
            <div className="flex items-center gap-2"><span className="f-display text-xl text-white">{them}</span><Avatar id={id} size={30} /></div>
          </div>
          <div className="mt-2"><Btn full onClick={() => go("create", { with: id })} icon={<Swords size={18} />}>Challenge {p.name.split(" ")[0]}</Btn></div>
        </>)}
        <div className="mt-5 flex gap-2">{tabs.map((t) => <Chip key={t} active={tab === t} onClick={() => setTab(t)}>{t}</Chip>)}</div>
        <div className="mt-3 mb-6 flex flex-col gap-3">
          {tab === "Parties" && (hosting.length ? hosting.map((pp) => <PartyCard key={pp.id} p={pp} />) : <Card className="p-5 text-center text-sm" style={{ color: B.text2 }}>No open parties right now.{on ? (alert ? " You'll be alerted when the next one opens." : " Turn on alerts to hear about the next one.") : " Follow to hear about the next one."}</Card>)}
          {tab === "Activity" && <Card className="overflow-hidden">{[...posts.map((f) => ({ t: f.text, time: f.time })), { t: `cleared stage ${Math.min(PAYOUT.stages.length, 1 + (p.wins % PAYOUT.stages.length))} of the Payout Challenge`, time: "1d" }, { t: "hit a new best streak", time: "3d" }].map((a, i) => <div key={i} className="px-4 py-3 text-sm" style={{ borderTop: i ? `1px solid ${B.line}` : "none", color: B.ink }}>{p.name.split(" ")[0]} {a.t}<div className="text-xs mt-0.5" style={{ color: B.text3 }}>{a.time}</div></div>)}</Card>}
          {tab === "Badges" && <div className="grid grid-cols-2 gap-2">{[["Cleared every stage", Zap], ["50 parties", Users], ["20-day streak", Flame]].map(([b, I]) => <Card key={b} className="p-4 text-sm font-semibold" style={{ color: B.navy }}><I size={22} color={B.blue} className="mb-2" />{b}</Card>)}</div>}
          {tab === "About" && <Card className="p-4 text-sm" style={{ color: B.ink }}><div className="flex items-center gap-2 font-semibold"><BadgeCheck size={16} color={B.blue} fill={B.blueSoft} />Verified brand</div><Sub className="mt-1">Brand parties are funded by the brand, so entry is usually free. Prizes go to winners' cash like any party.</Sub></Card>}
        </div>
      </Screen>
    </>
  );
}
function PeopleList() {
  const { params, following } = useApp();
  const [tab, setTab] = useState(params.tab || "followers");
  const isMe = params.id === "me"; const name = isMe ? "You" : PEOPLE[params.id].name;
  const list = isMe ? (tab === "following" ? following : ["quiz", "ada", "tunde"]) : tab === "following" ? followingOf(params.id) : followersOf(params.id);
  return (
    <>
      <TopBar title={name} />
      <div className="px-5 flex gap-2"><Chip active={tab === "followers"} onClick={() => setTab("followers")}>Followers</Chip><Chip active={tab === "following"} onClick={() => setTab("following")}>Following</Chip></div>
      <Screen><Card className="mt-3 mb-6 px-4 py-1">{list.length ? list.map((id) => <FollowRow key={id} id={id} compact />) : <div className="py-5 text-sm text-center" style={{ color: B.text2 }}>{isMe ? "You're not following anyone yet. Find people in Parties." : "Nobody here yet."}</div>}</Card></Screen>
    </>
  );
}
function ShareSheet() {
  const { share, closeShare, toast } = useApp();
  if (!share) return null;
  const text = share.kind === "invite" ? `Join my party “${share.party.title}” on Contestly. Pot is ${naira(potOf(share.party))}.` : share.kind === "profile" ? `Play ${PEOPLE[share.id].name} on Contestly (@${PEOPLE[share.id].handle})` : share.text;
  const done = (m) => { toast(m); closeShare(); };
  return (
    <Sheet onClose={closeShare}>
      <div className="rounded-3xl p-5" style={{ background: share.kind === "invite" ? share.party.cover : B.navy }}>
        <div className="flex items-center gap-2"><Mark size={22} /><Wordmark size={16} light /></div>
        <div className="f-display text-lg mt-3 text-white">{text}</div>
        <div className="text-xs mt-2 font-medium" style={{ color: B.blueMid }}>contestly.app/j/x7Kp</div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2 text-center">
        {[["WhatsApp", "💬"], ["Status", "⭕"], ["Instagram", "📸"], ["Copy link", "🔗"]].map(([t, e]) => <button key={t} onClick={() => done(t === "Copy link" ? "Link copied" : `Shared to ${t}`)} className="flex flex-col items-center gap-1"><div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl" style={{ background: B.soft }}>{e}</div><span className="text-xs font-medium" style={{ color: B.ink }}>{t}</span></button>)}
      </div>
      {share.kind === "invite" && (<><div className="mt-4 text-xs font-semibold" style={{ color: B.text3 }}>INVITE PEOPLE YOU FOLLOW</div><div className="mt-2 flex gap-3">{["ada", "segun", "zainab", "chidi"].map((id) => <button key={id} onClick={() => toast(`Invite sent to ${PEOPLE[id].name.split(" ")[0]}`)} className="flex flex-col items-center gap-1"><Avatar id={id} size={44} /><span className="text-xs font-medium" style={{ color: B.ink }}>{PEOPLE[id].name.split(" ")[0]}</span></button>)}</div></>)}
    </Sheet>
  );
}

/* =========================================================
   Flow map
   ========================================================= */
const FLOW = [
  { lane: "Brand path", color: "#F97316", nodes: [["warmup:brand", "Brand warm-up", "What you do (multi), why host; prize type is chosen per party"], ["brandSetup", "Verification + team", "RC, logo, site, email; invite teammates who host as the brand"], ["me", "Profile switcher", "One login; switch between personal and brand profiles"], ["create", "First party", "Prize: cash, product or experience"]] },
  { lane: "Nudges (push + in-app, same content)", color: "#0EA5E9", nodes: [["nudge:starting", "Party starts in 5", "T-5 for parties you're in"], ["nudge:live", "Party is live", "You're in it and not in the room"], ["nudge:friendJoined", "Friend joined", "Someone you follow joined your party"], ["nudge:mention", "@mention", "Tagged in a party chat"], ["nudge:rival", "Rival beat you", "Head-to-head or best stage overtaken"], ["nudge:streak", "Streak at risk", "3h before midnight, once"], ["nudge:seats", "Seats opened", "Weekly Payout seats, priority to new players"], ["nudge:prize", "Prize ready", "Brand confirmed a non-cash prize"], ["nudge:idle", "Win-back", "Day 3 and 7 of inactivity, friends-based"], ["nudge:guest", "Guest follow-up", "24h after a guest game"]] },
  { lane: "Home styles (preview only, same flow)", color: B.amber, nodes: [["home:competitor", "Competitor", "'Settle it' · Challenge Kemi"], ["home:host", "Host", "'Get your people together' · Start a party"], ["home:grinder", "Grinder", "Payout up first; best stage shown"], ["home:fan", "Fan", "Lane-based copy, lane brand featured"], ["home:empty", "No parties", "What Home says when nothing is open"], ["home:joined-later", "Joined · later", "You're in; Remind me + Invite"], ["home:joined-soon", "Joined · soon", "Starts in <15m; details and the lobby"], ["home:joined-starting", "Joined · starting", "Countdown, green, Enter the room"], ["home:joined-live", "Joined · live", "Round in progress; Join the round"]] },
  { lane: "Daily loop", color: B.greenDeep, nodes: [["home", "Home", "One card: Party or Payout. Daily challenge below. That's it."], ["daily", "Today's challenge", "Free, 5 Qs, same for everyone, 60s"], ["dailyResult", "Crew board", "Rank vs friends, dare, challenge to a party"]] },
  { lane: "Entry states", color: B.red, nodes: [["start:direct", "Direct", "Opened the app, no invite"], ["start:invite-free", "Invite · free party", "Guest allowed: name only, play and chat, no prizes"], ["start:invite-staked", "Invite · staked party", "Must sign up to put a stake in or win money; lands in the lobby after"], ["guestName", "Guest name", "One field, then the lobby"]] },
  { lane: "Onboarding (sign-up)", color: B.blue, nodes: [["welcome", "Welcome", "Brand, one line. Invite card if there is one."], ["whoPlays", "Who's playing", "Just me, or a brand"], ["warmup", "About you", "2 timed picks: lanes (multi) and why. Fills the profile."], ["coins", "Bag coins", "Says what the next round earns and what it's for"], ["quickfire", "Quick fire", "3 questions; right and fast earns coins"], ["warmup:live", "Quick fire (live)", "Others onboarding now share the round"], ["warmupResult", "Result", "Solo: reward tier. Live: leaderboard, everyone paid."], ["phone", "Keep your coins", "Phone after the win"], ["otp", "Code", "Auto-advances, coins land"], ["people", "Your people", "Contacts orbit you; brands pre-followed"], ["profile", "Name and face", "Done → Home (or the invite's lobby)"]] },
  { lane: "Party", color: B.blueDeep, nodes: [["home", "Home", "Party first, Payout below, feed, leaderboard"], ["discover", "Parties", "Recommended; 'filling up' badge; not-interested on any card"], ["lobby", "Lobby + chat", "@tags, emoji, hold-to-record voice notes, invite"], ["partyResult", "Result", "Share, rematch, follow"], ["create", "Build a party", "Poster builds as you type; dials for difficulty, pace, formats; stakes as coin stacks; Forge shows the deck being made"], ["partyGame", "Play", "Question → answer reveal with room split → standings ladder with chat, every round"]] },
  { lane: "Payout Challenge", color: B.greenDeep, nodes: [["payoutIntro", "Intro", `${PAYOUT.stages.length} stages from config; seats; rules`], ["payoutGame", "Stages", "Ladder updates per stage; decision timer"], ["payoutResult", "Result", "Cash + points; share"]] },
  { lane: "People", color: "#7C3AED", nodes: [["user", "Someone's profile", "Alerts, head to head, challenge"], ["followers", "Followers / following", "Mutuals first"]] },
  { lane: "Me and money", color: B.navy, nodes: [["chats", "Chats tab", "Messages · party rooms · activity, one place in the nav"], ["leaderboard", "This week", "Friends first; challenge from the row"], ["messages", "Messages", "1:1 chat: text, emoji, voice notes"], ["thread", "Thread", "Same composer as party chat; Challenge from the header"], ["me", "Profile", "Streak, stats, referral"], ["wallet", "Wallet", "Cash vs coins, kept separate"]] },
];
function FlowMap({ jump }) {
  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1"><Mark size={28} /><Wordmark size={22} /></div>
      <H size={24}>UI flow</H><Sub className="mt-1 mb-5">Tap any screen to open it in the prototype. The Payout Challenge ladder has {PAYOUT.stages.length} stages here; it renders from a config array, so any count works.</Sub>
      <div className="flex flex-col gap-5">
        {FLOW.map((lane) => (
          <div key={lane.lane}>
            <div className="text-sm font-semibold mb-2 flex items-center gap-2" style={{ color: B.navy }}><span className="w-2.5 h-2.5 rounded-full" style={{ background: lane.color }} />{lane.lane}</div>
            <div className="flex flex-wrap items-stretch gap-y-2">
              {lane.nodes.map(([id, t, note], i) => (
                <div key={id} className="flex items-center">
                  <button onClick={() => jump(id)} className="rounded-2xl p-3 text-left w-40 h-full hover:-translate-y-0.5 transition" style={{ background: "#fff", boxShadow: `inset 0 0 0 1.5px ${B.line}, inset 4px 0 0 ${lane.color}` }}><div className="text-sm font-semibold" style={{ color: B.navy }}>{i + 1}. {t}</div><div className="text-xs mt-1" style={{ color: B.text2 }}>{note}</div></button>
                  {i < lane.nodes.length - 1 && <ChevronRight size={18} color={B.text3} className="mx-0.5 shrink-0" />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   Root
   ========================================================= */
const TAB_SCREENS = ["home", "discover", "chats", "me"];
export default function App() {
  const [mode, setMode] = useState("proto");
  const [screen, setScreen] = useState("welcome"); const [params, setParams] = useState({}); const [history, setHistory] = useState([]);
  const [user, setUser] = useState({ name: "", handle: "", interests: [], phone: "", flex: "" });
  const [following, setFollowing] = useState([]); const [notifyOn, setNotifyOn] = useState([]);
  const [promo, setPromo] = useState("");
  const [wallet, setWallet] = useState({ cash: 0, bonus: 0 }); const [txns, setTxns] = useState([]);
  const [parties, setParties] = useState(PARTIES_INIT); const [joined, setJoined] = useState([]);
  const [chats, setChats] = useState(() => Object.fromEntries(PARTIES_INIT.map((p) => [p.id, seedChat(p)])));
  const [feed, setFeed] = useState(FEED_INIT); const [notifs, setNotifs] = useState(NOTIFS_INIT);
  const [share, setShare] = useState(null); const [toastMsg, setToastMsg] = useState("");
  const [stats, setStats] = useState({ parties: 0, wins: 0, best: 0 });
  const [why, setWhy] = useState(null); const [warmup, setWarmup] = useState(null);
  // Archetype = explicit "why" tile, nudged by how they played the warm-up and whether they kept brand follows.
  const [dms, setDms] = useState({ kemi: [{ id: 1, who: "kemi", text: "that last question was a setup 😤", time: "2h" }, { id: 2, who: "me", text: "skill issue", time: "2h" }, { id: 3, who: "kemi", voice: true, seconds: 4, time: "1h" }], tunde: [{ id: 4, who: "tunde", text: "Friday 8pm, you in?", time: "3h" }] });
  const sendDm = (id, payload) => {
    setDms((d) => ({ ...d, [id]: [...(d[id] || []), { id: Date.now(), who: "me", time: "now", ...payload }] }));
    setTimeout(() => setDms((d) => ({ ...d, [id]: [...d[id], { id: Date.now() + 1, who: id, time: "now", ...(payload.voice ? { voice: true, seconds: 2 } : { text: ["😂", "say less", "rematch tonight?", "🫡"][Math.floor(Math.random() * 4)] }) }] })), 1500);
  };
  const [entry, setEntry] = useState({ kind: "direct" });
  const [nudge, setNudge] = useState(null);
  // Nudge catalogue for the prototype. Each maps to a worker-owned event in production.
  const NUDGES = {
    starting: { who: "tunde", title: "Friday night football starts in 5 min", body: "6 in the room. Tunde: 'where are you?'", cta: "Enter", go: { screen: "lobby", party: "p2" } },
    live: { who: "tunde", title: "Your party is live", body: "Question 1 of 10 is up. Join before the next one.", cta: "Join", go: { screen: "partyGame", party: "p2" } },
    friendJoined: { who: "ada", title: "Ada joined Friday night football", body: "Now 4 of your people are in.", cta: "Open", go: { screen: "lobby", party: "p2" } },
    rival: { who: "kemi", title: "Kemi beat your best stage", body: "She cleared stage 3. Your best is 2.", cta: "Climb", go: { screen: "payoutIntro" } },
    streak: { title: "Your 1-day streak ends in 3h", body: "Today's challenge takes 60 seconds.", cta: "Play", go: { screen: "daily" } },
    seats: { title: "12 Payout seats just opened", body: "New players get seats first. Yours is held for 20 min.", cta: "Sit", go: { screen: "payoutIntro" } },
    mention: { who: "ada", title: "Ada mentioned you", body: "'@you bet you can't beat me' in Afrobeats throwback", cta: "Reply", go: { screen: "lobby", party: "p1" } },
    prize: { who: "jollof", title: "Your prize is ready", body: "Jollof Republic confirmed lunch for two. Pick a date.", cta: "Arrange", go: { screen: "thread", id: "jollof" } },
    idle: { title: "Segun hosted twice since you last played", body: "Your people are playing without you.", cta: "See", go: { screen: "discover" } },
    guest: { title: "Keep yesterday's score", body: "You came 2nd as a guest. Sign up to save it and get coins.", cta: "Sign up", go: { screen: "whoPlays" } },
  }; // direct | invite (party id)
  const [archetypeOverride, setArchetypeOverride] = useState(null); const [noParties, setNoParties] = useState(false); const [warmupLive, setWarmupLive] = useState(false); // set from the UI-flow "Home styles" lane only
  const archetype = archetypeOverride || (() => { if (user.isBrand) return "host"; if (!why) return "competitor"; if (why === "fan" && following.filter((f) => PEOPLE[f]?.brand).length === 0) return "competitor"; return why; })();
  const [xp, setXp] = useState(220); const [dailyDone, setDailyDone] = useState(false); const [dailyScore, setDailyScore] = useState(0);
  const [missions, setMissions] = useState(MISSIONS_INIT);
  const seatsLeft = 38; const [streak, setStreak] = useState(1);
  const completeDaily = (score) => {
    setDailyDone(true); setDailyScore(score); setXp((x) => x + 40 + score * 10); setStreak((s) => s + (dailyDone ? 0 : 1));
    setWallet((w) => ({ ...w, bonus: w.bonus + 50 })); addTxn({ label: "Today's challenge", amount: 50, kind: "bonus" });
    setMissions((ms) => ms.map((m) => (m.id === "m1" ? { ...m, done: 1 } : m)));
  };

  const go = (s, p = {}) => { setHistory((h) => [...h, { screen, params }]); setScreen(s); setParams(p); setShare(null); };
  const back = () => { const last = history[history.length - 1]; if (!last) return setScreen(TAB_SCREENS.includes(screen) ? screen : "home"); setHistory(history.slice(0, -1)); setScreen(last.screen); setParams(last.params); };
  const reset = (s, p = {}) => { setHistory([]); setScreen(s); setParams(p); setShare(null); };
  const toast = (m) => { setToastMsg(m); setTimeout(() => setToastMsg(""), 1800); };
  const addTxn = (t) => { setTxns((x) => [t, ...x]); if (t.kind === "cash" && t.amount > 0) setStats((s) => ({ ...s, wins: s.wins + 1, best: Math.max(s.best, t.amount) })); };
  const toggleFollow = (id) => { const on = following.includes(id); setFollowing(on ? following.filter((x) => x !== id) : [...following, id]); setNotifyOn((n) => (on ? n.filter((x) => x !== id) : [...n, id])); if (!on) toast(`Following ${PEOPLE[id].name.split(" ")[0]}. You'll hear when they open a party.`); };
  const toggleNotify = (id) => { const on = notifyOn.includes(id); setNotifyOn(on ? notifyOn.filter((x) => x !== id) : [...notifyOn, id]); toast(`Party alerts ${on ? "off" : "on"} for ${PEOPLE[id].name.split(" ")[0]}`); };
  const switchProfile = (toBrand, brand) => {
    if (toBrand) setUser((u) => ({ ...u, isBrand: true, personalName: u.isBrand ? u.personalName : u.name, personalHandle: u.isBrand ? u.personalHandle : u.handle, name: brand.name, handle: brand.handle, brands: u.brands || [brand] }));
    else setUser((u) => ({ ...u, isBrand: false, brands: u.brands || [{ name: u.name, handle: u.handle, role: "Owner" }], name: u.personalName || "You", handle: u.personalHandle || "you" }));
    toast(toBrand ? `Now acting as ${brand.name}` : "Back to your personal profile"); reset("home");
  };
  const openProfile = (id) => (id === "me" ? go("me") : PEOPLE[id] && go("user", { id }));
  const joinParty = (p) => {
    const cost = p.entry;
    setWallet((w) => { const fromBonus = Math.min(w.bonus, cost); return { bonus: w.bonus - fromBonus, cash: w.cash - (cost - fromBonus) }; });
    if (cost) addTxn({ label: `Entry: ${p.title}`, amount: -cost, kind: "bonus" });
    setJoined((j) => [...j, p.id]); setParties((ps) => ps.map((x) => (x.id === p.id ? { ...x, count: x.count + 1 } : x))); setStats((s) => ({ ...s, parties: s.parties + 1 }));
    setMissions((ms) => ms.map((m) => (m.id === "m2" ? { ...m, done: Math.min(m.total, m.done + 1) } : m))); setXp((x) => x + 30);
    setChats((c) => ({ ...c, [p.id]: [...(c[p.id] || []), { id: Date.now(), system: true, text: `${user.name || "You"} joined. Pot is now ${naira(potOf({ ...p, count: p.count + 1 }))}` }] }));
  };
  const sendChat = (pid, payload) => {
    setChats((c) => ({ ...c, [pid]: [...(c[pid] || []), { id: Date.now(), who: "me", ...payload }] }));
    const p = parties.find((x) => x.id === pid); const replier = p.players.find((x) => PEOPLE[x]) || (p.host !== "me" ? p.host : "ada");
    setTimeout(() => setChats((c) => ({ ...c, [pid]: [...c[pid], { id: Date.now() + 1, who: replier, ...(payload.voice ? { voice: true, seconds: 3 } : Math.random() > 0.5 ? { sticker: "😂" } : { text: `@${user.handle || "you"} we'll see 👀` }) }] })), 1400);
  };
  const createParty = (d) => {
    const id = "p" + Date.now();
    const p = { ...d, id, host: "me", cat: d.cat || user.interests[0] || "General knowledge", players: [], count: d.hostMode === "curate" ? 0 : 1, startsIn: 15, hostPlays: (d.hostMode || "sealed") === "sealed", aiQs: true };
    if (d.funding === "host" && !d.sponsored && !d.prize) { setWallet((w) => ({ ...w, cash: w.cash - d.hostPool })); addTxn({ label: `Funded pot: ${d.title}`, amount: -d.hostPool, kind: "cash" }); }
    PEOPLE.me = { name: user.name || "You", handle: user.handle || "you", color: B.blue, followers: 3, following: following.length, cats: [], bio: "" };
    setParties((ps) => [p, ...ps]); setJoined((j) => [...j, id]);
    setChats((c) => ({ ...c, [id]: [{ id: 1, system: true, text: d.visibility === "public" ? "Your party is live. Followers have been notified." : "Private party. Share the link to fill seats." }, ...(d.invite ? [{ id: 2, system: true, text: `${PEOPLE[d.invite].name} has been invited` }] : [])] }));
    reset("lobby", { party: id }); setTimeout(() => setShare({ kind: "invite", party: p }), 400);
  };
  const rematch = (p) => { const id = "p" + Date.now(); const np = { ...p, id, title: p.title + " (rematch)", startsIn: 2, count: Math.min(p.count, 4) }; setParties((ps) => [np, ...ps]); setChats((c) => ({ ...c, [id]: [{ id: 1, system: true, text: "Rematch! Everyone from the last game got an invite." }] })); reset("lobby", { party: id }); };
  const jump = (id) => {
    if (["lobby", "partyGame", "partyResult"].includes(id)) reset(id, { party: "p1", score: 2 });
    else if (id === "payoutResult") reset(id, { outcome: "walked", stage: 2, amount: PAYOUT.stages[2].prize });
    else if (id === "dailyResult") reset(id, { score: 4, time: "19.7s" });
    else if (id === "user") reset(id, { id: "tunde" }); else if (id === "followers") reset(id, { id: "tunde", tab: "followers" }); 
    else if (id === "warmupResult") { setWarmup({ pts: 640, correct: 2, coins: 400, others: NEWCOMERS.map((n, k) => ({ id: n, pts: [720, 510, 300][k] })) }); reset(id); }
    else if (id === "warmup:live") { setWarmupLive(true); setUser((u) => ({ ...u, isBrand: false })); reset("quickfire"); }
    else if (id === "start:direct") { setEntry({ kind: "direct" }); reset("welcome"); }
    else if (id === "start:invite-free") { setEntry({ kind: "invite", party: "p3" }); reset("welcome"); }
    else if (id === "start:invite-staked") { setEntry({ kind: "invite", party: "p2" }); reset("welcome"); }
    else if (id === "guestName") { setEntry({ kind: "invite", party: "p3" }); reset(id, { party: "p3" }); }
    else if (id === "coins") { setWhy("competitor"); setUser((u) => ({ ...u, interests: u.interests.length ? u.interests : ["Football"] })); reset(id); }
    else if (id === "warmup:brand") { setWarmupLive(false); setUser((u) => ({ ...u, isBrand: true, name: "Lagos Thrift Co", handle: "lagosthrift" })); reset("warmup"); }
    else if (id === "brandSetup") { setUser((u) => ({ ...u, isBrand: true, name: u.name || "Lagos Thrift Co", handle: u.handle || "lagosthrift" })); reset(id); }
    else if (id === "home:empty") { setNoParties(true); reset("home"); }
    else if (id.startsWith("nudge:")) { reset("home"); setTimeout(() => setNudge(NUDGES[id.slice(6)]), 300); }
    else if (id.startsWith("home:joined-")) {
      const st = id.slice(12); setNoParties(false); setArchetypeOverride(null);
      setJoined((j) => [...new Set([...j, "p2"])]);
      setParties((ps) => ps.map((x) => (x.id === "p2" ? { ...x, status: st === "live" ? "live" : "open", startsIn: st === "live" ? 0 : st === "starting" ? 1 : st === "soon" ? 9 : 42 } : x)));
      reset("home");
    }
    else if (id.startsWith("home:")) { setArchetypeOverride(id.slice(5)); setNoParties(false); reset("home"); }
    else reset(id);
    if (id === "payoutGame" || id === "payoutIntro") setWallet((w) => ({ ...w, bonus: Math.max(w.bonus, 700) }));
    setMode("proto");
  };

  const ctx = { screen, params, go, back, reset, user, setUser, following, setFollowing, toggleFollow, notifyOn, toggleNotify, openProfile, promo, setPromo, wallet, setWallet, txns, addTxn, parties, joined, joinParty, chats, sendChat, feed, setFeed, notifs, setNotifs, share, openShare: setShare, closeShare: () => setShare(null), toast, createParty, rematch, streak, seatsLeft, stats, xp, dailyDone, dailyScore, missions, completeDaily, why, setWhy, warmup, setWarmup, archetype, noParties, warmupLive, switchProfile, dms, sendDm, entry, setJoined, nudge, setNudge };
  const screens = { welcome: Welcome, whoPlays: WhoPlays, warmup: Warmup, warmupResult: WarmupResult, brandSetup: BrandSetup, phone: PhoneScreen, otp: OtpScreen, interests: InterestsScreen, people: PeopleScreen, profile: ProfileScreen, home: Home, discover: Discover, create: CreateParty, lobby: Lobby, partyGame: PartyGame, partyResult: PartyResult, payoutIntro: PayoutIntro, payoutGame: PayoutGame, payoutResult: PayoutResult, activity: Messages, chats: Messages, me: Me, wallet: WalletScreen, user: UserProfile, followers: PeopleList, leaderboard: Leaderboard, messages: Messages, thread: Thread, guestName: GuestName, coins: CoinsBridge, quickfire: QuickFire, daily: Daily, dailyResult: DailyResult };
  const Cur = screens[screen] || Home; const showTabs = TAB_SCREENS.includes(screen);

  return (
    <Ctx.Provider value={ctx}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');
        .ct, .ct button, .ct input { font-family: 'Inter', system-ui, sans-serif; }
        .f-display { font-family: 'Outfit', 'Inter', system-ui, sans-serif; font-weight: 700; }
        .pop { animation: pop .45s cubic-bezier(.2,1.6,.4,1); }
        @keyframes pop { from { transform: scale(.6); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        .slide-up { animation: su .25s ease-out; }
        .ticker { animation: tick 28s linear infinite; }
        @keyframes tick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .pulse { animation: pulse 1.2s ease-in-out infinite; }
        .drift { animation: drift 3.2s ease-in-out infinite, popin .5s cubic-bezier(.2,1.6,.4,1) both; }
        @keyframes drift { 0%,100% { translate: 0 0 } 50% { translate: 0 -6px } }
        @keyframes popin { from { transform: scale(.4); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        .spin { animation: spin 1s linear infinite; }
        .grow-bar { animation: grow .8s cubic-bezier(.2,.9,.3,1) both; transform-origin: left; }
        @keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
        @keyframes spin { to { transform: rotate(360deg) } }
        .bar { animation: bar .8s ease-in-out infinite alternate; transform-origin: bottom; }
        @keyframes bar { from { transform: scaleY(.4) } to { transform: scaleY(1.1) } }
        .confetti { animation: fall 2.2s ease-in both; border-radius: 2px; }
        @keyframes fall { 0% { transform: translateY(-20px) rotate(0); opacity: 1 } 100% { transform: translateY(820px) rotate(540deg); opacity: 0 } }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        @keyframes su { from { transform: translateY(40px); opacity: .5 } to { transform: none; opacity: 1 } }
        .ct ::-webkit-scrollbar { display: none; }
        @media (prefers-reduced-motion: reduce) { .pop, .slide-up, .ticker, .pulse, .drift, .confetti { animation: none; } }
      `}</style>
      <div className="ct min-h-screen w-full" style={{ background: "#E9EEF7" }}>
        <div className="flex justify-center pt-3 pb-2 gap-2">
          <button onClick={() => setMode("proto")} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold" style={{ background: mode === "proto" ? B.navy : "#fff", color: mode === "proto" ? "#fff" : B.navy }}><Smartphone size={15} />Prototype</button>
          <button onClick={() => setMode("flow")} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold" style={{ background: mode === "flow" ? B.navy : "#fff", color: mode === "flow" ? "#fff" : B.navy }}><LayoutGrid size={15} />UI flow</button>
          {mode === "proto" && screen !== "welcome" && <button onClick={() => { reset("welcome"); setWallet({ cash: 0, bonus: 0 }); setTxns([]); setJoined([]); setWhy(null); setWarmup(null); setFollowing([]); setUser({ name: "", handle: "", interests: [], phone: "" }); setArchetypeOverride(null); setNoParties(false); setWarmupLive(false); setEntry({ kind: "direct" }); setParties(PARTIES_INIT); }} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "#fff", color: B.navy }}>Restart</button>}
        </div>
        {mode === "flow" ? <FlowMap jump={jump} /> : (
          <div className="flex justify-center pb-4">
            <div className="relative w-full flex flex-col overflow-hidden sm:rounded-3xl" style={{ maxWidth: 400, height: "min(820px, calc(100vh - 70px))", background: B.bg, boxShadow: "0 30px 60px rgba(5,25,62,0.22)" }}>
              <Cur key={screen + JSON.stringify(params) + archetype + noParties} />
              {(archetypeOverride || noParties || joined.includes("p2")) && screen === "home" && <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 rounded-full px-3 py-1 text-xs font-bold" style={{ background: B.amber, color: B.navy }}>Preview: {noParties ? "no parties" : archetypeOverride || "joined party"}</div>}
              {showTabs && <TabBar />}
              <ShareSheet />
              <Nudge />
              {toastMsg && <div className="absolute left-4 right-4 top-4 z-50 rounded-2xl px-4 py-3 text-sm font-semibold slide-up" style={{ background: B.navy, color: "#fff" }}>{toastMsg}</div>}
            </div>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
