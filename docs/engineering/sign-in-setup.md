# Sign-in and email setup checklist

What has to exist outside this repo before sign-in works on staging and production (roadmap row 12).
The design is ADR 0006; the env variables are in `.env.example`. Secrets go in the secrets manager, never in `.env` on the box.

## Dev / staging Firebase project (new, e.g. `contestly-dev`)
- [ ] Authentication → Sign-in method: enable **Anonymous** and **Phone** (Blaze plan for SMS; add test numbers). Don't enable Google, Apple or Email/Password there: we run those ourselves.
- [ ] Add a **Web app** (its config goes to the app). Authorized domains: `localhost` and the staging web domain.
- [ ] Service account key → `FIREBASE_SERVICE_ACCOUNT_JSON` (one line); set `FIREBASE_PROJECT_ID`; unset `FIREBASE_AUTH_EMULATOR_HOST`.

## Live Contestly Firebase project (FCM stays as it is)
- [ ] Enable **Anonymous**, and **Phone** with an SMS region policy that allows Nigeria.
- [ ] Authorized domains: add `play.contestlyapp.com` (web SDK and the phone check's reCAPTCHA).
- [ ] Add a new **Web app** entry.
- [ ] A dedicated service account with **Firebase Authentication Admin** and **Service Account Token Creator**; its key is a secret.
- [ ] Don't change: the account-linking setting, the Identity Platform upgrade or anonymous auto-delete, Cloud Messaging / APNs, existing apps, blocking functions.
- [ ] Firebase **App Check** for the web app (row 12) once the build is on the real domain.

## Google sign-in
- [ ] Google Cloud: OAuth consent screen (scopes `openid email`); OAuth client of type Web application with redirect URI `https://<api-domain>/auth/oauth/google/callback`.
- [ ] `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.

## Sign in with Apple (team 9J8XA5L83J)
- [ ] App ID `com.contestlyapp.contestly` has the Sign in with Apple capability.
- [ ] A **Services ID** with the API's domain and return URL `https://<api-domain>/auth/oauth/apple/callback` (Apple needs public HTTPS, so staging needs a real domain).
- [ ] A Sign in with Apple **key** (.p8).
- [ ] `APPLE_SERVICES_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.

## Email (ZeptoMail primary, Brevo backup)
- [ ] Choose the sender, e.g. `codes@contestlyapp.com` → `EMAIL_FROM_ADDRESS`.
- [ ] ZeptoMail: add the domain to a Mail Agent; publish the DKIM TXT and the bounce CNAME it shows; `ZEPTOMAIL_TOKEN`.
- [ ] Brevo: Senders & Domains → add the domain; publish its verification and DKIM records; `BREVO_API_KEY`. Brevo can block API calls from unknown IPs: add the droplet's IP or turn that off.
- [ ] DNS: **one** SPF record with both providers' includes exactly as their consoles show them; DMARC starting at `v=DMARC1; p=none`.
- [ ] Unset `EMAIL_TRANSPORT` (Mailpit is dev only; it's refused in production).

## API environment
- [ ] `EMAIL_CODE_SECRET`, `PHONE_HASH_SECRET`: 32+ random bytes each. **`PHONE_HASH_SECRET` never changes** (contact matching depends on it).
- [ ] `ADMIN_EMAILS` (your address), `API_PUBLIC_URL`, `AUTH_RETURN_URLS=contestly://auth,https://play.contestlyapp.com/auth`, `TRUST_PROXY=1`, `AUTH_MODE=firebase`, `NODE_ENV=production`.
- [ ] `WEB_ORIGIN` lists the web app's origins, the admin console's included.
- [ ] The admin console signs in like the app: add its `/auth` page to `AUTH_RETURN_URLS`, and its domain to the Firebase Authorized domains. Admins come from `ADMIN_EMAILS`.

## Deep links
- [ ] Android app links already include `/auth`. iOS: add `/auth` to the `apple-app-site-association` the web app serves (no store release needed).
