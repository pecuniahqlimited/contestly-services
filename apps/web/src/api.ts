import { io } from "socket.io-client";

export const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export const RT_URL = import.meta.env.VITE_RT_URL ?? "http://localhost:4001";

/** Dev identity: the handle sent as x-dev-user. Swap for a Firebase ID token when AUTH_MODE=firebase. */
export const devUser = () => localStorage.getItem("devUser") ?? "tunde";

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { "content-type": "application/json", "x-dev-user": devUser(), ...(init.headers ?? {}) } });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { body: await res.json().catch(() => null) });
  return res.json();
}

export const socket = () => io(RT_URL, { auth: { devUser: devUser() }, autoConnect: false });
