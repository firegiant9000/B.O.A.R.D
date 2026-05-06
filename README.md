# CollabBoard — CMPS 357 Final Project (Team 2)

A real-time collaborative whiteboard and study-session app built with React Native / Expo.

**Team:** Arlo Kharod · Scott Williams

[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/oHRMfboi)

---

## Features

- **Real-time drawing** — pen, eraser, stroke-width, and color picker synced across all users via Firestore
- **Text elements** — tap to place, resize via corner handles, delete (owner or admin)
- **Undo / Redo** — per-client history; redo stack cleared on new stroke
- **Sticky notes** — floating notes overlay with per-note delete (owner or admin)
- **Session scheduling** — create study sessions with title, date, time, and duration; push notifications via Expo
- **AI session summaries** — generate a GPT-3.5-based summary of board content at session end (requires OpenAI key)
- **Friend system** — add friends by email, accept/reject requests, see friend status on shared boards
- **Board sharing** — invite collaborators via 6-digit code or share link
- **User presence** — see who is currently on the board with "Active Xm ago" indicators
- **Admin controls** — board creator can clear the board, start sessions, and manage any element
- **Block user** — hide another user's drawings and notes locally

---

## Setup

### Prerequisites

- Node.js 18+
- [Expo Go](https://expo.dev/client) installed on your phone (iOS or Android), or an Android/iOS emulator

### 1. Clone and install

```bash
git clone https://github.com/School-of-Computing-and-Informatics/cmps-357-sp26-final-project-cmps357-team2.git
cd cmps-357-sp26-final-project-cmps357-team2
npm install
```

### 2. Firebase configuration

The app uses the shared team Firebase project. The config is already set in `src/config/firebase.ts` — no changes needed for graders.

To use your own Firebase project instead:

1. Go to [Firebase Console](https://console.firebase.google.com) → Create project
2. Enable **Authentication** (Email/Password provider)
3. Enable **Firestore Database** (start in test mode, then apply `firestore.rules`)
4. Copy your project config into `src/config/firebase.ts`:
   ```ts
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
   };
   ```
5. Deploy indexes: `firebase deploy --only firestore:indexes`

### 3. Run the app

```bash
npx expo start
```

- **Expo Go (phone):** scan the QR code in the terminal
- **Android emulator:** press `a`
- **iOS simulator:** press `i`
- **Web:** press `w`

### 4. Add your OpenAI API key (for AI summaries)

1. Open the app → **Profile** tab → **AI Settings**
2. Paste your `sk-...` key and tap the checkmark
3. The key persists across restarts via AsyncStorage — each user needs their own key

---

## Project Structure

```
app/
  (auth)/           Login and registration screens
  (tabs)/           Main tab UI (boards, schedule, profile)
  board/[id].tsx    Canvas screen (drawing, text elements, presence)
  session/          Session creation and edit screens
src/
  components/       Reusable UI components
  contexts/         AuthContext (global auth state)
  hooks/            useAuth and other custom hooks
  services/         All Firestore access (boardService, pathService, sessionService, ...)
  types/            TypeScript interfaces
firestore.rules     Security rules
firestore.indexes.json  Composite index definitions
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React Native + Expo (TypeScript) |
| Routing | expo-router (file-based) |
| Auth | Firebase Authentication (email/password) |
| Database | Cloud Firestore (NoSQL, real-time) |
| Drawing | react-native-svg |
| AI | OpenAI GPT-3.5 (user-supplied key) |
| Notifications | Expo Push Notifications |

---

## Known Limitations

- **Per-client redo stack** — redo is local only. If another user draws while you have items in your redo stack, redo may re-add paths visually out of order. Accepted trade-off for scope.
- **OpenAI key is per-device** — the key is stored in AsyncStorage and is not synced to Firestore. Each user must enter their own key.
- **Push notifications require Expo Go** — standalone builds are not configured. Notifications only work when the app is running inside Expo Go with a valid push token registered.
- **No offline support** — all reads and writes require an active network connection. Failures surface as dismissible error banners.
- **Eraser removes full strokes** — Firestore stores paths as point arrays (not raster), so the eraser deletes entire strokes rather than pixel regions.
- **Session participants** — participants are friends-only; there is no public session discovery or open join link.

---

## Presentation Demo Script

### Before the demo
- Two devices/emulators logged in (admin account + participant account)
- A test board already created on the admin account
- Both accounts are friends
- OpenAI key configured on admin device

### Step-by-step flow

**1. Real-time drawing**
- Admin: open a board, draw strokes in different colors and widths
- Participant: join the board via the invite code in the Share modal
- Observe strokes appear in real time on the participant device
- Admin: undo → stroke disappears on both devices; redo → it comes back

**2. Text elements**
- Admin: select the T tool, tap the canvas → a text box appears
- Type text, resize using the corner handles
- Tap the trash icon (appears when selected) → element removed from all clients

**3. Presence**
- Participant: admin's avatar appears in the board header
- Tap the avatar → modal shows "Active just now" and friend/add-friend status

**4. Session scheduling**
- Admin: tap the Session button in the board header
- Fill in title, board, date, and time → create
- Both devices receive a push notification
- Navigate to Schedule tab → session shows in Upcoming

**5. AI summary**
- Mark the session as Ended from the Schedule tab
- Session moves to Past → tap "Generate AI Summary"
- Summary populates on the session card
- Force-close the app and reopen → summary is persisted (Firestore write confirmed)

**6. Friends**
- Profile tab → Add Friend by email
- Accept on the other device → both appear in each other's friends list

---

## Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `chore/description` — infrastructure, docs, cleanup
