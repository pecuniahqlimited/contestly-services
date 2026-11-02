/**
 * OPT-IN, NEVER IN A CHAIN: does signing in with custom tokens for brand-new uids count against Firebase's
 * "100 new accounts per hour per IP address"? Against a real, non-production Firebase project, it mints a
 * custom token for each of PROBE_COUNT (110) new uids and signs in with it from this machine, as the app's
 * SDK would (the REST call behind signInWithCustomToken), one every PROBE_INTERVAL_MS (1 s). It reports
 * each refusal with when it came, then, after the first refusal, two controls from the same address: a
 * custom token for a uid that already exists (is it new accounts or every sign-in?) and one anonymous
 * sign-up (the same bucket?). Every Firebase user it made is deleted at the end, Ctrl-C included.
 *
 * Its own settings, so the dev .env's emulator setup is left alone:
 *   PROBE_FIREBASE_PROJECT_ID             the test project (never production)
 *   PROBE_FIREBASE_SERVICE_ACCOUNT_JSON   a key for that project, one line (mints tokens, deletes the users)
 *   PROBE_FIREBASE_WEB_API_KEY            that project's Web API key (Project settings → General)
 *   FIREBASE_PRODUCTION_PROJECT_ID        the live project's id: the probe refuses to run against it, and
 *                                         refuses to run at all if this isn't set
 *   PROBE_COUNT (110), PROBE_INTERVAL_MS (1000), PROBE_STOP_AFTER_REFUSALS (5 in a row)
 *
 *   npm run probe:firebase-custom-tokens -- --run
 */
import { randomBytes } from "node:crypto";

const env = process.env;
const project = env.PROBE_FIREBASE_PROJECT_ID?.trim();
const production = env.FIREBASE_PRODUCTION_PROJECT_ID?.trim();
const keyJson = env.PROBE_FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
const apiKey = env.PROBE_FIREBASE_WEB_API_KEY?.trim();
const count = Number(env.PROBE_COUNT ?? 110);
const intervalMs = Number(env.PROBE_INTERVAL_MS ?? 1000);
const stopAfter = Number(env.PROBE_STOP_AFTER_REFUSALS ?? 5);

function refuse(why: string): never {
  console.error(`firebase-custom-token-probe: ${why}`);
  process.exit(1);
}
if (!production) refuse("set FIREBASE_PRODUCTION_PROJECT_ID (the live project's id) so the probe can refuse to touch it");
if (!project || !keyJson || !apiKey) refuse("set PROBE_FIREBASE_PROJECT_ID, PROBE_FIREBASE_SERVICE_ACCOUNT_JSON and PROBE_FIREBASE_WEB_API_KEY");
if (project === production) refuse(`${project} is the production project; use a dev or staging one`);
const credentials = JSON.parse(keyJson) as { project_id?: string };
if (credentials.project_id !== project) refuse(`the service account is for "${credentials.project_id}", not "${project}"`);
if (credentials.project_id === production) refuse("the service account is for the production project");
if (![count, intervalMs, stopAfter].every((n) => Number.isInteger(n) && n > 0)) refuse("PROBE_COUNT, PROBE_INTERVAL_MS and PROBE_STOP_AFTER_REFUSALS must be positive integers");
if (!process.argv.includes("--run")) {
  console.log(`Would sign in with custom tokens for ${count} new uids in ${project}, one every ${intervalMs} ms (~${Math.ceil((count * intervalMs) / 60000)} min), then delete them. Add --run to do it.`);
  process.exit(0);
}

// The real Firebase, whatever the dev .env says about the emulator.
delete env.FIREBASE_AUTH_EMULATOR_HOST;
const { initializeApp, cert } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const admin = getAuth(initializeApp({ projectId: project, credential: cert(credentials as Parameters<typeof cert>[0]) }, "custom-token-probe"));

const IDT = "https://identitytoolkit.googleapis.com/v1";
interface Attempt { n: number; uid: string; atMs: number; ok: boolean; isNewUser?: boolean; error?: string }

/** What the app's SDK does with a custom token: POST accounts:signInWithCustomToken from this machine. */
async function signInWithCustomToken(uid: string): Promise<{ ok: boolean; isNewUser?: boolean; error?: string }> {
  const token = await admin.createCustomToken(uid); // minted by the Admin SDK with the service account, not per IP
  const res = await fetch(`${IDT}/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, returnSecureToken: true }),
  });
  const body = await res.json() as { isNewUser?: boolean; error?: { message?: string } };
  return res.ok ? { ok: true, isNewUser: body.isNewUser } : { ok: false, error: `${res.status} ${body.error?.message ?? "unknown"}` };
}

const run = randomBytes(4).toString("hex");
const made = new Set<string>(); // every uid this run may have created in Firebase, deleted at the end
const attempts: Attempt[] = [];
const started = Date.now();
const elapsed = () => Date.now() - started;
const fmt = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function cleanUp() {
  const uids = [...made];
  if (!uids.length) return;
  const result = await admin.deleteUsers(uids); // a uid Firebase never created counts as deleted
  console.log(`\ncleaned up: ${result.successCount} of ${uids.length} uids deleted${result.failureCount ? `, ${result.failureCount} failed: ${result.errors.map((e) => `${uids[e.index]} ${e.error.code}`).join(", ")}` : ""}`);
}
process.on("SIGINT", () => { console.log("\ninterrupted"); void cleanUp().finally(() => process.exit(130)); });

try {
  console.log(`project ${project}: ${count} new uids, one every ${intervalMs} ms (run ${run})\n`);
  let inARow = 0;
  for (let n = 1; n <= count; n++) {
    const uid = `probe-ct-${run}-${n}`;
    made.add(uid);
    const r = await signInWithCustomToken(uid);
    attempts.push({ n, uid, atMs: elapsed(), ...r });
    console.log(`${String(n).padStart(3)}  ${fmt(elapsed()).padStart(7)}  ${r.ok ? `ok${r.isNewUser ? " (new user)" : ""}` : `REFUSED ${r.error}`}`);
    inARow = r.ok ? 0 : inARow + 1;
    if (inARow >= stopAfter) {
      console.log(`stopping: ${stopAfter} refusals in a row`);
      break;
    }
    if (n < count) await new Promise((done) => setTimeout(done, intervalMs));
  }

  const ok = attempts.filter((a) => a.ok);
  const refused = attempts.filter((a) => !a.ok);
  console.log(`\n==== result ====`);
  console.log(`signed in: ${ok.length} (Firebase said new user for ${ok.filter((a) => a.isNewUser).length}); refused: ${refused.length}`);
  if (refused.length) {
    const first = refused[0];
    console.log(`first refusal: attempt ${first.n} at ${fmt(first.atMs)}, after ${ok.filter((a) => a.n < first.n).length} new accounts: ${first.error}`);
    console.log(`refusal messages: ${[...new Set(refused.map((a) => a.error))].join("; ")}`);

    const known = ok[0];
    if (known) {
      const again = await signInWithCustomToken(known.uid);
      console.log(`control, an existing uid (${known.uid}) from the same address: ${again.ok ? "ok: only new accounts are refused" : `REFUSED ${again.error}: every custom-token sign-in is refused`}`);
    }
    const anon = await fetch(`${IDT}/accounts:signUp?key=${apiKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    const anonBody = await anon.json() as { localId?: string; error?: { message?: string } };
    if (anonBody.localId) made.add(anonBody.localId);
    console.log(`control, one anonymous sign-up from the same address: ${anon.ok ? "ok: a separate bucket from custom tokens" : `REFUSED ${anon.status} ${anonBody.error?.message}`}`);
  } else {
    console.log(`no refusal: ${ok.length} new uids signed in with custom tokens from one address in ${fmt(elapsed())}, so on this evidence custom-token sign-ups don't count against the 100 per IP per hour limit.`);
  }
} finally {
  await cleanUp();
}
process.exit(0);
