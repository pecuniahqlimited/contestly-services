/** POST JSON and throw with the provider's own error text on anything but 2xx. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}
