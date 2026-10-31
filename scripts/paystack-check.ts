/**
 * OPT-IN: the Paystack adapter against Paystack's real TEST API (npm run paystack:check). Needs
 * PAYSTACK_SECRET_KEY=sk_test_… and PAYSTACK_TEST_EMAIL (a real address) in .env; refuses anything else. Touches no database: it drives the provider
 * the way the payments module does and checks every answer maps the way the module expects.
 *
 * 1. Banks and account resolution.
 * 2. A top-up: prints a checkout link; pay it with Paystack's test card (4084 0840 8408 4081, any future
 *    expiry, CVV 408, PIN 0000, OTP 123456). It then verifies by our reference until Paystack says success.
 * 3. A transfer of ₦100 to a test recipient, with our reference, then queried until final. Paystack may
 *    refuse transfers on a business that isn't verified yet ("third party payouts"/"starter business"): that's
 *    reported as such, and the module would keep such a payout unknown (debited, alerting) rather than guess.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { paystackProvider, reservedEmailDomain } from "@contestly/payments";

const key = process.env.PAYSTACK_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) {
  console.error("paystack:check runs only with a Paystack TEST key (PAYSTACK_SECRET_KEY=sk_test_…).");
  process.exit(1);
}
const bankCode = process.env.PAYSTACK_TEST_BANK_CODE || "057";
const accountNumber = process.env.PAYSTACK_TEST_ACCOUNT_NUMBER || "0000000000";
// The customer email Paystack gets for the test top-up: a real inbox you own (Paystack validates it). Never invented here.
const email = (process.env.PAYSTACK_TEST_EMAIL ?? "").trim();
if (!email) {
  console.error("Set PAYSTACK_TEST_EMAIL in .env to a real email address you own (the test top-up's customer).");
  process.exit(1);
}
if (reservedEmailDomain(email)) {
  console.error(`PAYSTACK_TEST_EMAIL "${email}" uses a reserved domain (${reservedEmailDomain(email)}) that can't receive mail; use a real address.`);
  process.exit(1);
}
const p = paystackProvider({ secretKey: key });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let problems = 0;
const ok = (cond: boolean, label: string) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) problems++; };

console.log("— banks");
const banks = await p.payout!.banks!.listBanks();
ok(banks.length > 10, `${banks.length} banks listed`);
const resolved = await p.payout!.banks!.resolveAccount({ bankCode, accountNumber }).catch((e: Error) => { console.log(`  resolve failed: ${e.message}`); return null; });
console.log(`  ${bankCode}/${accountNumber} resolves to: ${resolved?.accountName ?? "(no account)"}`);

console.log("— top-up");
const reference = `tp-${randomBytes(12).toString("hex")}`;
const userId = randomUUID();
const amountKobo = 50_000;
const { checkoutUrl } = await p.collection!.createTopup({ reference, amountKobo, currency: "NGN", userId, email, returnUrl: null });
ok(checkoutUrl.startsWith("https://"), `checkout started for ${reference}`);
console.log(`\n  Pay it with the test card, then come back:\n  ${checkoutUrl}\n`);
const before = await p.collection!.verifyTopup(reference);
ok(before.status === "pending", `before paying, verify says pending (Paystack: ${before.providerStatus})`);
let paid = before;
for (let i = 0; i < 120 && paid.status !== "success" && paid.status !== "failed"; i++) { await sleep(5000); paid = await p.collection!.verifyTopup(reference); }
ok(paid.status === "success", `verify says success (Paystack: ${paid.providerStatus})`);
ok(paid.reference === reference && paid.amountKobo === amountKobo && paid.currency === "NGN" && paid.userId === userId, "reference, amount, currency and our user id all match");
ok((await p.collection!.verifyTopup(`tp-${randomBytes(12).toString("hex")}`)).status === "not_found", "an unknown reference is not_found");

console.log("— transfer");
if (!resolved) {
  console.log("  skipped: no test account resolved (set PAYSTACK_TEST_BANK_CODE / PAYSTACK_TEST_ACCOUNT_NUMBER)");
} else {
  const { recipientCode } = await p.payout!.createRecipient({ kind: "bank", bankCode, accountNumber, accountName: resolved.accountName });
  ok(recipientCode.startsWith("RCP_"), `recipient ${recipientCode}`);
  const ref = `po-${randomUUID().replace(/-/g, "")}`;
  const sent = await p.payout!.sendTransfer({ reference: ref, amountKobo: 10_000, recipientCode, reason: "Contestly paystack:check" });
  console.log(`  send: ${sent.status} (Paystack: ${sent.providerStatus}${sent.error ? `; ${sent.error}` : ""})`);
  if (/third party payouts|starter business|not.*verified/i.test(`${sent.providerStatus} ${sent.error}`)) {
    console.log("  → Paystack refuses transfers on this business until it's verified. Not worked around; the module keeps such a payout unknown (still debited) and alerts.");
  } else {
    let q = await p.payout!.queryTransfer(ref);
    for (let i = 0; i < 24 && (q.status === "pending" || q.status === "unknown"); i++) { await sleep(5000); q = await p.payout!.queryTransfer(ref); }
    console.log(`  query: ${q.status} (Paystack: ${q.providerStatus}), amount ${q.amountKobo}, fee ${q.feeKobo}`);
    ok(q.status === "success" || q.status === "failed", "the transfer reached a definite state");
    const again = await p.payout!.sendTransfer({ reference: ref, amountKobo: 10_000, recipientCode, reason: "Contestly paystack:check resend" });
    console.log(`  resending the same reference: ${again.status} (Paystack: ${again.providerStatus}${again.error ? `; ${again.error}` : ""}) — must not be a second transfer`);
  }
}
console.log(problems ? `\n${problems} problem(s)` : "\nall good");
process.exit(problems ? 1 : 0);
