# ⚡ NEXUS — Live Chat App

A full-featured real-time chat platform with black & purple design. Deploy to Vercel in minutes.

## Features
- 🌐 **Global Live Chat** — Everyone on the same URL sees the same messages (via BroadcastChannel + Firebase)
- 💬 **Direct Messages** — One-on-one conversations
- 🖼️ **Image Sharing** — Share images inline
- 📎 **File Sharing** — Share any file (up to 5MB)
- 📞 **Voice Calls** — Simulated voice call UI
- 📹 **Video / FaceTime** — Real camera access via WebRTC
- 👤 **Add Users** — Dynamically add users to the server
- 😊 **Emoji Picker** — Built-in emoji support
- ⌨️ **Typing Indicators** — See when others are typing
- 🔔 **Unread Badges** — Never miss a message

## Quick Deploy to Vercel

### Option 1 — Vercel CLI
```bash
npm i -g vercel
cd nexus-chat
vercel --prod
```

### Option 2 — Drag & Drop
1. Go to https://vercel.com/new
2. Drag the `nexus-chat` folder into the deploy box
3. Click Deploy ✅

### Option 3 — GitHub
1. Push this folder to a GitHub repo
2. Import at https://vercel.com/new
3. Auto-deploys on every push

---

## 🔥 Enable Real-Time Firebase (for true multi-user live chat)

The app works across browser tabs immediately using `BroadcastChannel`.  
For **cross-device** live messaging, set up Firebase:

### 1. Create Firebase Project
1. Go to https://console.firebase.google.com
2. Click "Add project" → name it `nexus-chat`
3. Enable **Realtime Database** (not Firestore)
4. Set rules to:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### 2. Get your config
In Firebase Console → Project Settings → Your apps → Add Web App

Copy the config object.

### 3. Replace config in index.html
Find this section in `index.html`:
```javascript
const firebaseConfig = {
  apiKey: "AIzaSyDemo-...",
  ...
};
```
Replace with your real config.

### 4. Redeploy
```bash
vercel --prod
```

---

## Tech Stack
- Vanilla HTML/CSS/JS (zero build step)
- Firebase Realtime Database (optional, for cross-device)
- BroadcastChannel API (live sync across tabs — works instantly)
- WebRTC (camera access for video calls)
- Google Fonts (Syne + JetBrains Mono)

## Keyboard Shortcuts
- `Enter` — Send message
- `Shift+Enter` — New line
- `Escape` — Close modals / end calls
