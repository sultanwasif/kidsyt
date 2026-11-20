# Kids Tube — setup guide

Parents sign in with Google, pick the YouTube channels their kids may watch, and set a PIN and a daily time limit.
Kids see only those channels: no search, no YouTube recommendations.

```
Browser (kid's tablet / parent's phone)
   │  HTTPS
   ▼
nginx (kidsyt.ehfservices.com) ──► Node (server.js, port 3100) ──► SQLite (data/kidsyt.db)
                                         │
                                         └─► YouTube Data API (your one key, never sent to browsers)
```

Each channel's video list is fetched at most once per hour and shared by every family, so quota grows with the
number of *different channels*, not the number of parents (≈2 units per channel per hour; 10,000 free units/day).

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

```bash
# Node 22 + build tools + nginx + certbot
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 nginx certbot python3-certbot-nginx

# App user + files
sudo useradd --system --home /opt/kidsyt --shell /usr/sbin/nologin kidsyt
sudo mkdir -p /opt/kidsyt
# upload this folder's contents to /opt/kidsyt (scp / sftp / git), then:
cd /opt/kidsyt
sudo npm ci --omit=dev || sudo npm install --omit=dev
sudo cp .env.example .env && sudo nano .env        # fill GOOGLE_CLIENT_ID and YT_API_KEY
sudo mkdir -p data && sudo chown -R kidsyt:kidsyt /opt/kidsyt
sudo chmod 600 .env

# Service
sudo cp deploy/kidsyt.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kidsyt
sudo systemctl status kidsyt          # should say "active (running)"

# nginx + HTTPS
sudo cp deploy/nginx-kidsyt.conf /etc/nginx/sites-available/kidsyt
sudo ln -s /etc/nginx/sites-available/kidsyt /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kidsyt.ehfservices.com
```

Open `https://kidsyt.ehfservices.com` → **Sign in with Google** → create a PIN → add channels → **Save**.

Logs: `sudo journalctl -u kidsyt -f`
Update after changing files: `sudo systemctl restart kidsyt`
Backup: copy `/opt/kidsyt/data/kidsyt.db` (e.g. a nightly cron with `sqlite3 kidsyt.db ".backup backup.db"`).

---

## 3. On the kid's device

1. Open the site, sign in with the **parent's** Google account (once; it stays signed in for 180 days).
2. **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen).
3. Lock the kid into the app: **iPad → Guided Access**, **Android → App pinning**. Also restrict or remove the
   regular YouTube app.

The parent can sign in on their own phone with the same Google account and change channels/limits; the kid's
device picks up changes within 10 minutes or when the app is reopened.

---

## How it works

| Feature | Where |
|---|---|
| Google sign-in (redirect mode, works in home-screen apps) | `POST /api/auth/google` |
| Session cookie, 180 days, httpOnly | `server.js` |
| Parent PIN (scrypt hash, 6 tries / 5 min) → 15-min unlock token | `/api/pin`, `/api/pin/verify` |
| Forgot PIN → sign out, sign in again with Google → set a new PIN (allowed within 10 min of sign-in) | `/api/pin` |
| Channel lookup by @handle / link / ID | `/api/channels` |
| Shared hourly video cache, serves stale data if YouTube fails | `youtube.js` |
| Filters (blocked words, Shorts ≤ 3 min) applied per family | `/api/videos` |
| Daily limit tracked on the server, so it works across devices | `/api/usage/*` |
| Delete account (removes all of the parent's data) | `DELETE /api/account` |

## Before you invite other parents
- Fill in `[DATE]` and `[CONTACT EMAIL]` in `public/privacy.html`.
- Keep the app positioned as a **parent tool**: parents sign in and choose content; collect nothing from children.
- The YouTube player is shown unmodified (no overlays), as YouTube's Required Minimum Functionality requires.
  Use Guided Access / App pinning to keep kids from leaving.
- Read YouTube's Developer Policies section on child-directed API clients:
  https://developers.google.com/youtube/terms/developer-policies
