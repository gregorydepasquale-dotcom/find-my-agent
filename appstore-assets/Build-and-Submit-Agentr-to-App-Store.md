# Building & Submitting Agentr to the App Store

This has to happen on your Mac — Xcode (Apple's build tool) only runs on macOS, and Apple requires you to sign the app with your own Apple Developer account, so there's no way around doing this step yourself. This guide is written so you can copy-paste your way through it with no guesswork.

Everything else — the code, the App Store Connect listing (name, description, pricing, privacy answers), the backend, the admin panel — is already done. This is the last mile.

## Before you start, make sure you have:

1. **A Mac** with Xcode installed (free, from the Mac App Store — search "Xcode"). If you already have Xcode, open it once and let it finish any "installing additional components" prompt.
2. **An active Apple Developer Program membership** ($99/year) signed in on that Mac. Check: open Xcode → Settings (or Preferences) → Accounts → your Apple ID should be listed. This needs to be the same Apple account tied to the "Agentr" app in App Store Connect.
3. **Node.js installed** on the Mac. Check by opening the **Terminal** app and typing `node -v` — if you see a version number (like `v22.x.x`), you're set. If not, download it from [nodejs.org](https://nodejs.org) (choose the "LTS" version) and install it, then re-check.

## Step 1 — Get the code onto your Mac

Open **Terminal** (search for it with Spotlight — Cmd+Space, type "Terminal") and paste this, one line at a time:

```
cd ~/Desktop
git clone https://github.com/gregorydepasquale-dotcom/find-my-agent.git
cd find-my-agent
```

If `git` isn't installed, macOS will prompt you to install "command line developer tools" — click Install and wait, then re-run the commands above.

## Step 2 — Install the dependencies

```
npm install
```

This pulls in everything needed to build the iOS wrapper. Takes a minute or two.

## Step 3 — Add the iOS project

```
npx cap add ios
npx cap sync ios
```

This generates a full Xcode project inside a new `ios/` folder. You'll see it appear in Finder if you have that folder open.

## Step 4 — Open it in Xcode

```
npx cap open ios
```

This launches Xcode automatically with the right project open (`App.xcworkspace`). Give it a minute to index the project the first time.

## Step 5 — Set up signing

In Xcode:

1. In the left sidebar, click the blue **App** project icon at the very top, then select the **App** target.
2. Click the **Signing & Capabilities** tab.
3. Check **"Automatically manage signing."**
4. Under **Team**, choose your name / your Apple Developer account from the dropdown.
5. Confirm **Bundle Identifier** reads exactly: `com.ikonickproperties.findmyagent` — it should already be filled in correctly. If Xcode shows a red error here, it usually means you need to select a Team first (step 4).

## Step 6 — Set the version number (optional but recommended)

Same **General** tab (next to Signing & Capabilities): confirm **Version** is `1.0` and **Build** is `1`. These should already match what's set in App Store Connect.

## Step 7 — Archive the build

1. At the top of the Xcode window, next to the Play/Stop buttons, there's a device dropdown — click it and choose **"Any iOS Device (arm64)"** (not a simulator — this matters, archiving won't work on a simulator target).
2. From the menu bar: **Product → Archive**.
3. This takes a few minutes. A progress bar shows in the top bar. If it fails, the error will show in red — if that happens, copy the exact error text and send it to me, I can usually tell you the fix even though I can't run Xcode myself.

## Step 8 — Upload to App Store Connect

When archiving finishes, the **Organizer** window pops up automatically showing your new archive.

1. Select the archive, click **Distribute App**.
2. Choose **App Store Connect** → Next.
3. Choose **Upload** → Next.
4. Leave the default options (automatic signing) → Next → Upload.
5. Wait for the upload to finish (progress bar). When done, you'll see a confirmation.

Apple then "processes" the build on their end — this usually takes 10–30 minutes. You'll get an email from Apple when it's ready.

## Step 9 — Attach the build in App Store Connect

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com), open **Agentr** → **Distribution** → **iOS App Version 1.0**.
2. Scroll to the **Build** section, click **+ (Add Build)**, and select the build you just uploaded.
3. Scroll up to **Previews and Screenshots** — you still need at least 3 screenshots (iPhone 6.5" size: 1242×2688px or 1284×2778px). Tell me if you'd like help generating these — I can capture them from the live web app sized correctly and send them to you to upload, since I can't upload files directly into App Store Connect myself.

## Step 10 — Submit for review

Once the build and screenshots are attached, click **Add for Review**, then **Submit to App Review** on the next screen. Apple's review typically takes 24–48 hours, sometimes longer. You'll get an email when it's approved (or if they need changes).

---

### If anything goes wrong

Copy the exact error message you see (from Xcode or App Store Connect) and send it to me — I can read the code and the App Store Connect setup, so I can usually tell you exactly what's wrong and how to fix it, even though I can't click the buttons myself.
