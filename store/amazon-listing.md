# Amazon Appstore listing — Hassle Free TV (Fire TV)

Console: https://developer.amazon.com/apps-and-games/console (free account, no fee).
Upload file: `tv-android/app/build/outputs/apk/release/app-release.apk` (Amazon takes the **APK**, the same one served at `/apk`).
Amazon re-signs the app with its own key; that's normal and changes nothing for us.

## 1. App information
- App title: **Hassle Free TV**
- App category: **Entertainment** (or Lifestyle → Parenting if offered)
- Customer support email: ehfservices@gmail.com · Website: https://tv.ehfservices.com
- Privacy policy URL: https://tv.ehfservices.com/privacy

## 2. Target your app (device support)
- Select **Fire TV** devices only. Untick phones and tablets (they use the website instead).
- After the APK uploads, open the device list and check that Fire TV models show as **supported**. If they're greyed
  out because of the `leanback required="true"` feature, ask Claude for an Amazon build with it set to optional.
- Language: English. Countries: all, or the ones you want.

## 3. Upload the APK
- Upload `app-release.apk` (versionCode 3, version 1.0.2).
- "Does the app use DRM?": **No**.
- Export compliance: tick the box (the app uses only standard HTTPS).

## 4. Availability and content
- Price: **Free**. In-app purchases: **No**. Ads: **No**.
- "Is this app directed at children under 13?": **Yes**. Children watch it, though only a parent signs in, on
  a phone. This is fine because the app has no ads, no analytics SDKs and collects nothing from children.
- Content rating questionnaire: answer **None** for violence, sex, language, drugs and gambling. For "user-generated / web
  content" or "accesses the internet", answer **Yes**: it plays parent-approved YouTube videos.
- Collects personal info: **Yes**, but only the parent's name and email, from Google sign-in on a phone or computer.
  Nothing is collected on the TV.

## 5. Text (copy from `store/play-listing.md`)
- Short description: use the first two paragraphs of the Play full description.
- Long description: the Play full description.
- Product feature bullets (up to 5):
  - Only the channels, playlists and videos a parent approves
  - No search box and no surprise recommendations
  - Block words like "horror" or "GTA" and hide Shorts
  - Daily screen-time limit and 7-day watch history, protected by a parent PIN
  - Link your TV in seconds with a short code from your phone
- Keywords: kids, parental control, safe videos, family, screen time, youtube channels, children

## 6. Images (ready in `store/`)
| Amazon field | File |
|---|---|
| Small icon 114×114 | `store/amazon/icon-114.png` |
| Large icon 512×512 | `store/amazon/icon-512.png` |
| Fire TV icon 1280×720 | `store/amazon/firetv-icon-1280x720.png` |
| Fire TV background 1920×1080 | `store/amazon/background-1920x1080.png` |
| Screenshots 1920×1080 (3–10) | `store/screenshots-tv/01-home.png` … `05-parent-menu.png` |
| Promotional image 1024×500 (optional) | `store/graphics/feature-graphic-1024x500.png` |

## 7. Notes for the reviewer (testing instructions)
Use the same text as "App access" in `store/play-listing.md` (link the TV with the on-screen code at
https://tv.ehfservices.com/tv, then add `@LEGO` in Parent settings). Mention:
Remote: D-pad to move, Select to play/pause, Left/Right to skip 10 s, Back to close the video. Leaving the app pauses playback.

## Fire TV checks Amazon tests (already handled)
- Everything works with the remote only; Back always goes back and exits from the home screen.
- Video pauses when the app goes to the background (Home button).
- No links that leave the app; no "download from another store" prompts.
