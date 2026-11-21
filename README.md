# Kids Tube — setup guide

Parents sign in with Google, pick the YouTube channels their kids may watch, and set a PIN and a daily time limit.
Kids see only those channels: no search, no YouTube recommendations.

```
Browser (kid's tablet / parent's phone)
   │  HTTPS
   ▼
nginx (kidsyt.ehfservices.com) ──► Docker: Node (server.js, port 3100) ──► SQLite (data/kidsyt.db)
                                         │
                                         └─► YouTube Data API (your one key, never sent to browsers)
```

Each channel's / playlist's video list is checked at most once per hour, only while someone is using it, and shared
by every family, so quota grows with the number of *different channels*, not the number of parents.
An hourly check reads only the list of video ids (1 unit per 50 videos) and fetches details just for new uploads;
every video is fully re-checked once a day. Removing and re-adding a channel or playlist costs nothing, since it
stays cached. Roughly 1 unit per channel per hour (10,000 free units/day).

---

## 1. Google Cloud (project "YoutubeKidsAyman")

### a) YouTube API key (server only)
1. **APIs & Services → Credentials → Create credentials → API key**.
2. Edit the key:
   - **Application restrictions → IP addresses** → add your VPS public IP (and its IPv6 address if it has one).
   - **API restrictions → Restrict key → YouTube Data API v3**.
3. Copy the key → `YT_API_KEY` in `.env`.

> If you created a key earlier with *Websites* restriction for the old single-file version, change it to
> *IP addresses*. The server now makes the calls, not the browser.

### b) Google sign-in (OAuth client)
1. **Google Auth Platform → Branding** (older consoles call it the *OAuth consent screen*):
   app name "Kids Tube", support email, app home page `https://kidsyt.ehfservices.com`,
   privacy policy `https://kidsyt.ehfservices.com/privacy`, authorized domain `ehfservices.com`.
   Skip the logo for now: uploading one triggers a brand review.
2. **Audience** → User type **External** → **Publish app** (status *In production*). Only the basic
   `openid`, `email` and `profile` scopes are used, so no Google verification is needed.
3. **Clients → Create client → Web application**
   - Authorized JavaScript origins: `https://kidsyt.ehfservices.com`
   - Authorized redirect URIs: `https://kidsyt.ehfservices.com/api/auth/google`
4. Copy the **Client ID** → `GOOGLE_CLIENT_ID` in `.env`.

---

## 2. VPS (Ubuntu on Hostinger)

DNS first: in Hostinger, point an **A record** `kidsyt` → your VPS IP.

Runs in Docker (needs Docker + the compose plugin, nginx and certbot on the host).

```bash
# App files
sudo git clone https://github.com/sultanwasif/kidsyt.git /opt/kidsyt
cd /opt/kidsyt
sudo cp .env.example .env && sudo nano .env        # fill GOOGLE_CLIENT_ID and YT_API_KEY
sudo chmod 600 .env
sudo mkdir -p data && sudo chown 1000:1000 data    # container runs as user "node" (uid 1000)

# Build + start (restarts automatically on reboot)
sudo docker compose up -d --build
sudo docker compose ps                # should say "running"
curl -s http://127.0.0.1:3100/api/config   # should print {"googleClientId":"..."}

# nginx + HTTPS
sudo cp deploy/nginx-kidsyt.conf /etc/nginx/sites-available/kidsyt
sudo ln -s /etc/nginx/sites-available/kidsyt /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kidsyt.ehfservices.com
```

Open `https://kidsyt.ehfservices.com` → **Sign in with Google** → create a PIN → add channels → **Save**.

Logs: `cd /opt/kidsyt && sudo docker compose logs -f`
Update: `cd /opt/kidsyt && sudo git pull && sudo docker compose up -d --build`
Backup: copy `/opt/kidsyt/data/kidsyt.db` (stop the container first, or use `sqlite3 kidsyt.db ".backup backup.db"`).

(`deploy/kidsyt.service` is only for running without Docker.)

---

## 3. On the kid's device

1. Open the site, sign in with the **parent's** Google account (once; it stays signed in for 180 days).
2. **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen).
3. Lock the kid into the app: **iPad → Guided Access**, **Android → App pinning**. Also restrict or remove the
   regular YouTube app.

The parent can sign in on their own phone with the same Google account and change channels/limits; the kid's
device picks up changes within 10 minutes or when the app is reopened.

---

## 4. TV app (Fire TV Stick, Android TV / Google TV)

`tv-android/` is a tiny Android app (no libraries, ~40 KB) that opens `https://kidsyt.ehfservices.com/tv-app`
full-screen, works with the remote (arrows, OK, Back, play/pause) and blocks every other website.

**Install on a Fire TV Stick**
1. Fire TV: Settings → My Fire TV → Developer options → *Install unknown apps* → allow **Downloader**
   (if Developer options is hidden: Settings → My Fire TV → About → click the device name 7 times).
2. Install **Downloader** from the Fire TV app store, open it, type `kidsyt.ehfservices.com/apk` → Install.
3. Open **Kids Tube**. The TV shows a code, e.g. `K7P-4QX`.
4. On your phone open `kidsyt.ehfservices.com/tv`, sign in, enter the PIN and the code → the TV opens your videos.
5. Lock the TV: Settings → Preferences → Parental Controls (PIN for other apps), or uninstall the YouTube app.

Unlink a TV: ⚙️ on the TV → Unlink this TV (PIN), or on the phone: Parent settings → Sign out other devices.

**Build a new APK** (Windows, Android Studio installed):
```powershell
cd tv-android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleRelease
copy app\build\outputs\apk\release\app-release.apk ..\public\downloads\kidstube-tv.apk
```
Bump `versionCode` in `tv-android/app/build.gradle` for each new APK. Release signing uses
`tv-android/keystore.properties` + the `.jks` key in `%USERPROFILE%\.kidstube\` — **back both up**; without them
updates can't be installed over the old app. Artwork: `node tools/make-icons.mjs`.

---

## How it works

| Feature | Where |
|---|---|
| Google sign-in (redirect mode, works in home-screen apps) | `POST /api/auth/google` |
| Session cookie, 180 days, httpOnly | `server.js` |
| Parent PIN (scrypt hash, 6 tries / 5 min) → 15-min unlock token | `/api/pin`, `/api/pin/verify` |
| Forgot PIN → sign out, sign in again with Google → set a new PIN (allowed within 10 min of sign-in) | `/api/pin` |
| Channel lookup by @handle / link / ID | `/api/channels` |
| Playlists by link (up to 100 videos, refreshed hourly, filters apply) | `/api/picks/playlist` |
| Single videos by link (shown under "My picks", filters don't apply, re-checked daily) | `/api/picks/video` |
| Shared hourly video cache, serves stale data if YouTube fails | `youtube.js` |
| Filters applied per family, before the per-channel limit: Shorts ≤ 3 min, blocked words in title / description / tags | `/api/videos` |
| Daily limit tracked on the server, so it works across devices | `/api/usage/*` |
| Watch history: video + minutes per day, kept 7 days, parent can clear | `/api/history` |
| Installable app (manifest + icons) for iPhone/iPad/Android home screens | `public/manifest.json` |
| Delete account (removes all of the parent's data) | `DELETE /api/account` |

## Before you invite other parents
- Fill in `[DATE]` and `[CONTACT EMAIL]` in `public/privacy.html`.
- Keep the app positioned as a **parent tool**: parents sign in and choose content; collect nothing from children.
- The YouTube player is shown unmodified (no overlays), as YouTube's Required Minimum Functionality requires.
  Use Guided Access / App pinning to keep kids from leaving.
- Read YouTube's Developer Policies section on child-directed API clients:
  https://developers.google.com/youtube/terms/developer-policies
