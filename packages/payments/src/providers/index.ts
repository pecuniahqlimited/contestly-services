/**
 * The provider registry. Adding a provider is one file in this folder implementing PaymentProvider, one line
 * in REGISTRY, and its env (secrets stay in env, never in the database). A provider whose env isn't set isn't
 * there; nothing else in the codebase names a provider.
 */
import { makeRedis } from "@contestly/queue";
import type { Redis } from "ioredis";
import type { PaymentProvider } from "../types.js";
import { MOCK, mockProvider, type MockControls } from "./mock.js";
import { paystackProvider } from "./paystack.js";

type Env = NodeJS.ProcessEnv;
const isProduction = (env: Env) => env.NODE_ENV === "production";
/**
 * The mock provider, its checkout page and /wallet/dev-topup exist only with PAYMENTS_DEV_TOOLS=true, and
 * never in production whatever the flag says. A staging box that forgets NODE_ENV still has none of them.
 */
export const paymentsDevTools = (env: Env = process.env) => env.PAYMENTS_DEV_TOOLS === "true" && !isProduction(env);

let mockRedis: Redis | undefined;
const redis = () => (mockRedis ??= makeRedis());
let mockControls: MockControls | null = null;

const REGISTRY: Record<string, (env: Env) => PaymentProvider | null> = {
  /** Dev and tests only (PAYMENTS_DEV_TOOLS). Its webhook secret has no default: assertPaymentsEnv requires it. */
  mock: (env) => {
    if (!paymentsDevTools(env) || !env.MOCK_PAYMENTS_WEBHOOK_SECRET) return null;
    mockControls = mockProvider({
      redis, webhookSecret: env.MOCK_PAYMENTS_WEBHOOK_SECRET,
      checkoutBaseUrl: (env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT ?? 4000}`).replace(/\/+$/, ""),
    });
    return mockControls.provider;
  },
  paystack: (env) => (env.PAYSTACK_SECRET_KEY ? paystackProvider({ secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL || undefined }) : null),
};

/**
 * Refuse to start on a payments env that could move real money where it shouldn't, or take forged webhooks:
 * - outside production, any value that looks like a live secret key (sk_live_…), whichever provider it's for,
 *   and a Paystack key that isn't a test key (sk_test_…);
 * - every provider's webhook secret is required (Paystack signs with its secret key; the mock needs
 *   MOCK_PAYMENTS_WEBHOOK_SECRET when the dev tools are on). There is no default secret.
 */
export function assertPaymentsEnv(env: Env = process.env) {
  if (paymentsDevTools(env) && !env.MOCK_PAYMENTS_WEBHOOK_SECRET) throw new Error("PAYMENTS_DEV_TOOLS=true needs MOCK_PAYMENTS_WEBHOOK_SECRET (the mock provider's webhook secret; there is no default)");
  if (isProduction(env)) return;
  const live = Object.entries(env).filter(([, v]) => typeof v === "string" && v.trim().startsWith("sk_live_")).map(([k]) => k);
  if (live.length) throw new Error(`live payment key(s) in ${live.join(", ")} while NODE_ENV is "${env.NODE_ENV ?? ""}": live keys run only in production`);
  const paystack = env.PAYSTACK_SECRET_KEY?.trim();
  if (paystack && !paystack.startsWith("sk_test_")) throw new Error(`PAYSTACK_SECRET_KEY isn't a test key (sk_test_…) while NODE_ENV is "${env.NODE_ENV ?? ""}": only test keys run outside production`);
}

let built: Map<string, PaymentProvider> | null = null;
function providers(): Map<string, PaymentProvider> {
  if (built) return built;
  assertPaymentsEnv();
  built = new Map();
  for (const [name, make] of Object.entries(REGISTRY)) {
    const p = make(process.env);
    if (p) built.set(name, p);
  }
  return built;
}

export const knownProviderNames = () => Object.keys(REGISTRY);
/** Real providers' published webhook addresses (never the mock's): exempt from the refusal throttle. */
export const allowListedWebhookIps = () => [...providers().values()].filter((p) => p.name !== MOCK).flatMap((p) => p.webhookIps);
export const configuredProviderNames = () => [...providers().keys()];

const notConfigured = (name: string) => Object.assign(new Error("provider_not_configured"), { statusCode: 409, details: { provider: name } });

/** A provider by name, for finishing a transaction it started (whatever the current setting) or starting a new one. */
export function providerNamed(name: string): PaymentProvider {
  const p = providers().get(name);
  if (!p) throw notConfigured(name);
  return p;
}

/** The default when no admin has chosen: env, else the mock when the dev tools are on, else Paystack. */
export const defaultProviderName = (env: Env = process.env) => env.PAYMENTS_PROVIDER || (paymentsDevTools(env) ? MOCK : "paystack");

/** The mock's controls (complete a checkout, plant provider-side state), for the dev checkout page, sims and tests. */
export function mockControlsOrNull(): MockControls | null {
  providers();
  return mockControls;
}

/** Tests: rebuild the registry from the current env (after changing a key), and close the mock's connection. */
export function resetProviders() { built = null; mockControls = null; }
export async function closeProviders() {
  await mockRedis?.quit();
  mockRedis = undefined;
}
