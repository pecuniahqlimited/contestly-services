/**
 * Every HTTP rate limit, from the environment, with production defaults here. Signed-in requests are
 * limited per user (Nigerian carriers put many people behind one CGNAT address, so an IP is not a person);
 * signed-out requests per real client IP (clientIp.ts). Sign-in has its own tighter limits on top.
 * Dev raises them in .env so the sims can run at once (see .env.example).
 */
const int = (name: string, fallback: number, env = process.env): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
};

export interface Limits {
  /** Per signed-in user (guests included), per minute, across every route. */
  userPerMinute: number;
  /** Per client IP for requests with no session, per minute. */
  ipPerMinute: number;
  /** Sign-in codes sent: per client IP and per email, per hour. */
  codeSendsPerIpPerHour: number;
  codeSendsPerEmailPerHour: number;
  /** Sign-in codes checked: per client IP and per email, per 10 minutes (each code also dies after 5 wrong tries). */
  codeChecksPerIpPer10Min: number;
  codeChecksPerEmailPer10Min: number;
  /** Google/Apple starts and one-time-code exchanges, per client IP per 10 minutes. */
  oauthPerIpPer10Min: number;
}

/**
 * Why these defaults:
 * - 600 a minute per user (10 a second, sustained). A live party's answers and chat go over the party
 *   room's WebSocket, not HTTP, and have their own limits there; over HTTP a player is at most answering
 *   Climb rounds (about one a second at the fastest) while the app refreshes a few screens. That's well
 *   under 100 a minute, so 600 never touches a real player and still caps a runaway client or script.
 * - 300 a minute per IP with no session. Signed-out traffic is only the first screens and share pages
 *   (the app gets an anonymous session at once, and from then on it's per user), but one CGNAT address can
 *   carry thousands of people opening the app, so this stays generous.
 * - Sign-in sends: 5 per email an hour stops mail bombing one inbox; 100 per IP an hour allows a busy
 *   CGNAT address while stopping one machine spraying addresses. Checks: 15 per email and 200 per IP
 *   per 10 minutes, on top of a code's 5 tries.
 */
export const limitsFromEnv = (env = process.env): Limits => ({
  userPerMinute: int("RATE_LIMIT_USER_PER_MINUTE", 600, env),
  ipPerMinute: int("RATE_LIMIT_IP_PER_MINUTE", 300, env),
  codeSendsPerIpPerHour: int("RATE_LIMIT_CODE_SENDS_PER_IP_PER_HOUR", 100, env),
  codeSendsPerEmailPerHour: int("RATE_LIMIT_CODE_SENDS_PER_EMAIL_PER_HOUR", 5, env),
  codeChecksPerIpPer10Min: int("RATE_LIMIT_CODE_CHECKS_PER_IP_PER_10_MIN", 200, env),
  codeChecksPerEmailPer10Min: int("RATE_LIMIT_CODE_CHECKS_PER_EMAIL_PER_10_MIN", 15, env),
  oauthPerIpPer10Min: int("RATE_LIMIT_OAUTH_PER_IP_PER_10_MIN", 120, env),
});
