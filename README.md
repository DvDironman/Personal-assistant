# Reminders: your personal assistant app

A small mobile web app with push notifications for:

- **💊 Pills**: reminds you at your set time, then **keeps reminding you every 15 min** (you can change this) until you tap **Taken ✅**. Resets every day.
- **🏋️ Gym**: the night before each workout day (Mon/Tue/Thu by default) you get "pack your gym clothes". You can change the days in Settings, or switch just tomorrow on the Today screen.
- **📺 Shows**: what you're watching, where you watch it, and your place (season/episode plus a note). Tap **+1 ep** after each episode.
- **📝 Notes**: write down whatever's on your mind, and optionally get reminded about it later.

It's free to run: the app is hosted on **Cloudflare Workers** (free plan) and notifications come through the **ntfy** app (free).

---

## Setup (about 10 minutes)

You need a computer with [Node.js](https://nodejs.org) installed for the one-time deploy. After that, everything happens on your phone.

### 1. Set up notifications on your phone
1. Install **ntfy** from the App Store or Google Play.
2. Pick a **secret topic name** that nobody could guess, e.g. `david-reminders-8f3k2q9x`. (Anyone who knows the name can read the notifications, so make it random.)
3. In the ntfy app, tap **+** and subscribe to that topic on the default server (`ntfy.sh`).
4. Android only: in the ntfy app's settings for that topic, allow it to show alerts, and turn off battery optimisation for ntfy so the alerts arrive on time.

### 2. Create a free Cloudflare account
Sign up at https://dash.cloudflare.com/sign-up.

### 3. Deploy the app (from this folder, on your computer)
```bash
npm install
npx wrangler login                       # opens a browser to sign in to Cloudflare
npx wrangler kv namespace create DATA    # prints an id = "…"
```
Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_ID` with the id it printed.

Then set three secrets. Each command asks you to type a value:
```bash
npx wrangler secret put APP_TOKEN    # a password you'll type into the app once (make it long)
npx wrangler secret put NTFY_TOPIC   # the secret topic name from step 1
npx wrangler secret put ACK_KEY      # any long random string (protects the notification buttons)
```
(Tip: `openssl rand -hex 16` gives you a random string.)

Deploy:
```bash
npx wrangler deploy
```
It prints your app's address, something like `https://reminders.<your-name>.workers.dev`.

### 4. Open it on your phone
1. Open that address in your phone's browser and enter your **APP_TOKEN**.
2. Add it to your home screen:
   - **iPhone (Safari):** Share → *Add to Home Screen*
   - **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*
3. Go to **Settings → Send a test notification**. A notification should appear on your phone within a few seconds.
4. Set your pill time and check the gym days, then tap **Save settings**.

That's it. The app checks every 5 minutes and sends whatever's due.

---

## How the notifications work

| Reminder | When | Buttons on the notification |
|---|---|---|
| Pills | At your pill time, then every N minutes until marked taken | **Taken ✅** · **Snooze 30m** |
| Gym clothes | Once, at 21:30 the night before a workout day | none |
| Note reminder | At the time you picked | **Done ✅** · **Remind in 1h** |

If your phone doesn't show the buttons, tap the notification itself. It opens the app, and you can tap **I took my pills** there.

Timing is accurate to about 5 minutes, because the check runs every 5 minutes.

## Changing things later
- **Settings** in the app covers pill time, repeat interval, gym days, gym reminder time and time zone.
- **Today** screen: "Working out / Not working out" changes just tomorrow without touching your weekly schedule.
- To change the code, edit the files in `src/` and run `npx wrangler deploy` again.

## Files
- `src/worker.js`: server, data storage, and the 5-minute reminder check
- `src/app.html`: the phone app (screens and buttons)
- `wrangler.toml`: Cloudflare config (schedule plus storage)

## Running it locally (optional)
Create a `.dev.vars` file with `APP_TOKEN=…`, `ACK_KEY=…` and `NTFY_TOPIC=…`, then run `npm run dev` and open http://localhost:8787.

## Privacy
Your data is stored in your own Cloudflare account. Notification text passes through ntfy.sh. To keep it fully private you can self-host ntfy and set an `NTFY_SERVER` secret (plus `NTFY_TOKEN` if your server needs one).
