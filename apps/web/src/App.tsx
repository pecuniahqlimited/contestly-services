import { useEffect, useState } from "react";
import { RT, naira, coins } from "@contestly/shared";
import { api, socket, devUser } from "./api";
import Prototype from "./prototype/Prototype";

/**
 * Two things live here for now:
 *  1. The clickable prototype (pure UI, demo data) — the design reference.
 *  2. A thin "backend check" strip proving the API, realtime and DB are wired up locally.
 * Next step is replacing the prototype's demo data with the api()/socket() calls below, screen by screen.
 */
export default function App() {
  const [status, setStatus] = useState<{ api?: string; rt?: string; me?: any; parties?: number }>({});
  useEffect(() => {
    api("/health").then(() => setStatus((s) => ({ ...s, api: "ok" }))).catch(() => setStatus((s) => ({ ...s, api: "down" })));
    api("/me").then((me) => setStatus((s) => ({ ...s, me }))).catch(() => {});
    api("/parties").then((p) => setStatus((s) => ({ ...s, parties: p.length }))).catch(() => {});
    const s = socket();
    s.on("connect", () => setStatus((x) => ({ ...x, rt: "ok" })));
    s.on("connect_error", () => setStatus((x) => ({ ...x, rt: "down" })));
    s.on(RT.chatMessage, (m) => console.log("chat", m));
    s.connect();
    return () => { s.disconnect(); };
  }, []);
  const pill = (v?: string) => v === "ok" ? "bg-emerald-100 text-emerald-800" : v === "down" ? "bg-rose-100 text-rose-800" : "bg-gray-100 text-gray-500";
  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-2 text-xs font-semibold" style={{ background: "#E7E3F4" }}>
        <span className={`rounded-full px-2 py-1 ${pill(status.api)}`}>API {status.api ?? "…"}</span>
        <span className={`rounded-full px-2 py-1 ${pill(status.rt)}`}>Realtime {status.rt ?? "…"}</span>
        <span className="rounded-full px-2 py-1 bg-white text-gray-700">as @{devUser()}{status.me ? ` · 🪙 ${coins(status.me.wallet.bonusKobo)} · ${naira(status.me.wallet.cashKobo)}` : ""}</span>
        {status.parties !== undefined && <span className="rounded-full px-2 py-1 bg-white text-gray-700">{status.parties} open parties</span>}
      </div>
      <Prototype />
    </>
  );
}
