# Agentr

"Like Tinder, but for realtors." Clients swipe through local agent profiles;
a right swipe is an instant match that drops the client into that agent's
leads inbox. Branded with the IKONICK Properties logo and color palette
(gold `#E9C21C`, rust `#B45132`, near-black `#15110A`).

This is a real, working MVP — not a static mockup. It has a database, a
server, and persistent matches.

## How it works

- **Clients** fill out a short form (name, contact info, what they're
  looking for, area), then swipe through agent profiles. Swipe right (or
  tap ♥) to match, left (or tap ✕) to pass.
- A right swipe is an **instant match** — no need for the agent to swipe
  back. This is a lead-gen tool, not a dating app, so every "like" becomes
  a lead immediately. (If you'd rather agents approve/decline before a
  client sees contact info, that's a small change — see "Ideas for next
  steps" below.)
- Matched agents show up in the client's **Matches** tab with one-tap
  Call / Text / Email links.
- Each agent has a **leads dashboard** at `/realtor/:id` (e.g. `/realtor/1`
  is the seeded Gregory DePasquale profile) showing everyone who matched
  with them, with contact info and what they're looking for.

## Tech notes

- Zero npm dependencies. The backend is plain Node (`http` module) and the
  frontend is plain HTML/CSS/JS — no React, no build step, nothing to
  install. It runs on Node 22.5+ using Node's built-in SQLite
  (`node:sqlite`) for storage.
- Data lives in `data/app.db` (SQLite), created automatically on first run
  and seeded with 5 sample agent profiles (including a real profile for
  Gregory DePasquale / DePasquale Properties).

## Run it locally

```bash
node server.js
```

Then open **http://localhost:3000** in a browser (use your phone's
dev-tools device emulator, or just resize the browser window narrow, to see
the mobile layout — it's designed mobile-first).

No `npm install` needed.

## Deploying it for real

To get a live link you can actually hand out, deploy it to any host that
runs Node 22+: Railway, Render, Fly.io, or a small VPS all work well for a
single Node process like this.

1. Push this folder to a GitHub repo (or upload it directly if the host
   supports that).
2. Set the start command to `node server.js`.
3. Set the `PORT` environment variable if your host requires a specific
   port (the app already reads `process.env.PORT`).

**One thing to know:** the SQLite database is a single file
(`data/app.db`) on local disk. That's perfect for a pilot with a handful of
users, but most hosting platforms wipe local disk on each redeploy, so
matches/leads would reset. For anything beyond an initial pilot, either use
a host with a persistent volume (Railway and Fly.io both support this), or
swap in a hosted Postgres database later — the whole database layer is
isolated in `db.js`, so that's a contained change.

**You need to do this step (deploy to a live URL) before the App Store step
below** — a native app needs something real to talk to.

## Getting this on the App Store

I generated everything I could without needing internet access or Xcode
(neither of which this environment has): the App Store-ready icon, a splash
screen, and a Capacitor config, all using your actual IKONICK Properties
logo and colors. See `appstore-assets/` — `icon.png` (1024×1024, no
transparency, per Apple's requirement) and `splash.png` (2732×2732).

The remaining steps need to run on your own Mac, where you have internet
access and (if installed) Xcode — I can't run these myself from here:

1. **Deploy the backend first** (see "Deploying it for real" above) and
   grab the live URL, e.g. `https://ikonick-match.up.railway.app`.

2. **Point the app at it.** Open `capacitor.config.json` and replace
   `REPLACE-WITH-YOUR-DEPLOYED-URL.example.com` in the `server.url` field
   with your real deployed URL. This makes the native app shell simply
   display your live, working app — no code changes needed elsewhere.

3. **In Terminal, from this project folder:**

   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/ios
   npx cap init "Agentr" "com.ikonickproperties.findmyagent" --web-dir=public
   npx cap add ios
   npx @capacitor/assets generate --iconBackgroundColor "#15110a" --splashBackgroundColor "#15110a"
   npx cap sync ios
   npx cap open ios
   ```

   The last command opens the generated project in Xcode (you'll need
   Xcode installed from the Mac App Store — it's free).

4. **In Xcode:** set your Team under Signing & Capabilities (this requires
   an Apple Developer Program membership, $99/year, enrolled at
   [developer.apple.com](https://developer.apple.com)), then Product →
   Archive to build a release version.

5. **In App Store Connect** (developer.apple.com): create a new app
   listing, fill in the required metadata — screenshots (use the phone
   simulator in Xcode, or real screenshots from the deployed web app),
   description, privacy policy URL (required — you'll need to write one,
   since the app collects names/phone/email), and support URL. Upload the
   build from Xcode Organizer, then submit for review.

Review typically takes about a week. A couple of things reviewers commonly
flag for apps like this, worth handling before you submit: an account
deletion path (a way for a client to ask you to delete their data), and a
real privacy policy page describing what you collect and why.

## Assumptions I made building this

- **Instant match, not mutual match** — a client's right-swipe is treated
  as a lead immediately, since the goal is connecting clients to agents
  fast, not a two-sided dating flow.
- **No login/password system yet** — clients are identified by a browser-
  local ID (stored in `localStorage`), and agent dashboards are reached by
  a plain URL (`/realtor/:id`) rather than a password-protected login.
  Fine for a demo/pilot; before a public launch you'd want real agent
  accounts so one agent can't view another's leads.
- **Sample data** — 4 of the 5 agent profiles are seed data I wrote to make
  the demo feel real; swap in your actual agent roster (and real photos
  instead of emoji) in `db.js` before using this with real clients.
- **Branding** — logo and colors pulled from `ikonick properties logo.png`
  in your Downloads folder, per your choice of the IKONICK Properties
  brand over the DePasquale Properties (Keller Williams) branding also
  found there.

## Ideas for next steps

- Real photos instead of emoji avatars (drop image URLs into the
  `realtors` table / `db.js` seed data).
- Agent-side password login instead of an open dashboard URL.
- Text/email notification to the agent the moment they get a new match,
  reusing the SMS lead-response templates you've already been drafting.
- Mutual-match mode (agent has to accept before contact info is shared) if
  you'd rather vet leads before they land in an inbox.
- Agent subscription/paywall (Stripe Checkout on your own site, per Apple's
  post-Epic-ruling external payment link allowance) to actually charge
  agents for a listed profile.
