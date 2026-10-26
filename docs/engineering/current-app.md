# The current app (what the new one replaces)

Read only for roadmap row 11b (migration) and for delivery. Nothing here is a design reference. Reviewed 22 Oct 2026 from the Lovable project "Contestly" (published).

## Shell
- Capacitor 8, iOS and Android. iOS bundle id com.contestlyapp.contestly (Apple team 9J8XA5L83J); Android applicationId **com.contestly** (the Play package). The shell update must keep both.
- Source of truth for the shell is the Lovable project (latest), not an older local copy.
- The Android release signing config has its keystore passwords in `android/app/build.gradle`; move them to env or a local properties file before the next release.
- Remote URL shell: `server.url = https://play.contestlyapp.com`. The installed app is a WebView on that origin; whatever is served there is the app. Changing `server.url` needs a store release; changing what the domain serves does not.
- Native plugins in the shell: app, browser, clipboard, device, haptics, network, share, status-bar, and `@capacitor-firebase/messaging` (FCM push; this is what the Firebase project is used for today).
- Not in the shell: contacts, microphone permission (no NSMicrophoneUsageDescription), native Google or Apple sign-in. Anything needing these requires one shell update through the stores.
- Deep links: custom scheme `contestly://`. iOS universal links come from `/.well-known/apple-app-site-association`, served by the web app, so new paths can be added without a release. Android app links are listed in the manifest (`/`, `/auth`, `/play/`, `/c/`, `/contest/`, `/s/`, `/r/`, `/ref/`, `/results/`, `/leaderboard`, `/profile`, `/wallet`, … but not `/p/` or `/party/`); new Android paths need a shell update.

## Sign-in
- Supabase auth via Lovable Cloud (`@supabase/supabase-js`, `@lovable.dev/cloud-auth-js`).
- Methods: email + password, email one-time code, Google and Apple via the Lovable OAuth broker opened in the system browser (`@capacitor/browser`) and returned by deep link.
- The session is persisted in the WebView's `localStorage` on the play.contestlyapp.com origin (Supabase's default key, `sb-<project-ref>-auth-token`). A new app served on the same origin can read it.

## Implications
- The new mobile app must be served as a web build at play.contestlyapp.com to ride this shell (Expo web / react-native-web), unless we ship a new native binary.
- Session handoff: the new app reads the Supabase session from localStorage and exchanges it once at the API for a new sign-in (row 11b). No re-login.
- Google/Apple in the shell: keep the system-browser + deep-link pattern (no native plugin, no release) or add native plugins in one shell update.
- Before cutover, one shell update can add: contacts, the microphone permission, `/p/` and `/party/` Android app links, and any native sign-in plugin. Ship it while it still loads the current app.
- Rollback: keep the current app deployable to the same domain.
