/**
 * The provider interfaces (ADR 0013). Everything outside src/providers speaks these types; a provider maps
 * its own codes into them, and anything it can't map is "unknown" — never success, never failure.
 */

/**
 * What a provider says about one top-up or transfer, by our reference.
 * - success / failed: definite. Only these ever finish a transaction.
 * - pending: the provider has it and hasn't finished (for a transfer, also: "queued", "processing", "otp").
 * - not_found: the provider has no record of the reference.
 * - unknown: no definite answer (timeout, network error, 5xx, an unmapped status).
 */
export type CheckStatus = "success" | "failed" | "pending" | "not_found" | "unknown";

export interface ProviderCheck {
  status: CheckStatus;
  /** The provider's own word for it, for admins and logs. */
  providerStatus: string;
  reference: string | null;
  /** In kobo, converted and checked inside the provider; null when it didn't say. */
  amountKobo: number | null;
  currency: string | null;
  /** The user id we put in the metadata when we started it (top-ups). */
  userId: string | null;
  /** What the provider charged to send it (transfers), when it says. */
  feeKobo: number | null;
  /** Why it's unknown (the network error, the HTTP status), for logs. */
  error: string | null;
}

export interface DateRange { from: Date; to: Date }
/** One transaction in a provider's own list, for reconciliation. */
export interface ProviderRecord { reference: string; amountKobo: number; status: CheckStatus; providerStatus: string }

export interface StartTopup { reference: string; amountKobo: number; currency: "NGN"; userId: string; email: string; returnUrl: string | null }

export interface CollectionProvider {
  /** Ask the provider to start a payment for our reference; returns where to send the person to pay. Throws if it can't. */
  createTopup(input: StartTopup): Promise<{ checkoutUrl: string }>;
  /** A fresh, server-to-server read of the payment by our reference. Never throws: trouble is "unknown". */
  verifyTopup(reference: string): Promise<ProviderCheck>;
  listTopups(range: DateRange): Promise<ProviderRecord[]>;
}

/**
 * Where a payout goes. Banks today; a voucher or airtime rail (Android, Play Store policy) adds its own
 * kind here and implements PayoutProvider without a bank directory.
 */
export type PayoutDestination = { kind: "bank"; bankCode: string; accountNumber: string; accountName: string };

export interface Bank { code: string; name: string }
/** Bank rails only: the list of banks and resolving an account number to its holder's name. */
export interface BankDirectory {
  listBanks(): Promise<Bank[]>;
  /** The account holder's name, or null when the bank says there's no such account. Throws when the provider can't answer. */
  resolveAccount(input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string } | null>;
}

export interface SendTransfer { reference: string; amountKobo: number; recipientCode: string; reason: string }

export interface PayoutProvider {
  banks: BankDirectory | null;
  /** Register where the money goes; returns the provider's id for it. Throws if it can't. */
  createRecipient(destination: PayoutDestination): Promise<{ recipientCode: string }>;
  /** The provider's fee for sending this amount, as published (the real one replaces it when it succeeds, if reported). */
  transferFeeKobo(amountKobo: number): number;
  /**
   * Send, with our reference as the provider's idempotency reference. Never throws: a timeout, a network
   * error or a 5xx is "unknown" (it may have gone through), and only a definite refusal is "failed".
   */
  sendTransfer(input: SendTransfer): Promise<ProviderCheck>;
  /** Ask about a transfer by our reference. Never throws. */
  queryTransfer(reference: string): Promise<ProviderCheck>;
  listTransfers(range: DateRange): Promise<ProviderRecord[]>;
}

/** An authenticated webhook, in our terms. Only a hint: a top-up or transfer is finished from a fresh verify. */
export interface WebhookEvent {
  /** Unique per event (the provider's id, or a hash of the body when it gives none), so a redelivery is the same event. */
  eventId: string;
  type: "topup" | "transfer" | "other";
  /** The provider's event name. */
  name: string;
  reference: string | null;
  providerStatus: string;
  amountKobo: number | null;
  currency: string | null;
  userId: string | null;
}

export type Headers = Record<string, string | string[] | undefined>;

/** One provider: a file in src/providers implementing this, plus its line in the registry and its env. */
export interface PaymentProvider {
  name: string;
  collection: CollectionProvider | null;
  payout: PayoutProvider | null;
  /** Authenticate a webhook (signature against the raw body) and read it. Null: not authentic, refuse it. */
  parseWebhook(rawBody: Buffer, headers: Headers): WebhookEvent | null;
  /** Read a body that was authenticated when it arrived (the worker processing a stored event). */
  readWebhook(rawBody: Buffer): WebhookEvent;
  /** The addresses its webhooks come from, for the optional allow-list. */
  webhookIps: string[];
}

/**
 * The provider (or its adapter, before calling it) refused to start something, so nothing exists at the
 * provider and no money moved. Any other error from a start means we don't know what the provider did.
 */
export class ProviderRefusal extends Error {
  constructor(message: string, readonly httpStatus: number | null = null) { super(message); this.name = "ProviderRefusal"; }
}

/** Reserved names that can never receive mail (RFC 2606, RFC 6761): our dev and test accounts use them. */
const RESERVED_TLDS = ["invalid", "test", "example", "localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
export function reservedEmailDomain(email: string): string | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const tld = domain.split(".").pop() ?? "";
  if (RESERVED_TLDS.includes(tld)) return `.${tld}`;
  return RESERVED_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`)) ?? null;
}
/** A real provider is never sent a reserved address: refused here, before any call, with a message that says why. */
export function assertDeliverableEmail(email: string, provider: string) {
  const reserved = reservedEmailDomain(email);
  if (reserved) throw new ProviderRefusal(`"${email}" uses the reserved domain ${reserved}, which ${provider} can't send to; use a real address`);
}

/** A check that never reached a definite answer. */
export const unknownCheck = (reference: string | null, error: string, providerStatus = "error"): ProviderCheck =>
  ({ status: "unknown", providerStatus, reference, amountKobo: null, currency: null, userId: null, feeKobo: null, error });
