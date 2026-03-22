# BOARD

A mobile collaboration app that combines a shared whiteboard with lightweight session scheduling tools. Built for students and small teams who need a simple way to brainstorm visually, organize ideas, and plan future collaboration sessions.

[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/oHRMfboi)

## Tech Stack

- **Frontend:** React Native + Expo (TypeScript)
- **Routing:** expo-router (file-based)
- **Backend:** Firebase (Auth + Firestore)
- **Drawing:** react-native-svg
- **AI (stretch):** OpenAI API for session summaries

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Expo CLI (`npx expo`)
- A Firebase project with Auth + Firestore enabled

### Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/School-of-Computing-and-Informatics/cmps-357-sp26-final-project-cmps357-team2.git
   cd cmps-357-sp26-final-project-cmps357-team2
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Firebase:
   - Copy your Firebase config into `src/config/firebase.ts`
   - See the placeholder values in that file

4. Start the development server:
   ```bash
   npx expo start
   ```

5. Scan the QR code with Expo Go (mobile) or press `w` for web.

## Project Structure

```
app/                    # expo-router file-based routing
  (auth)/               # Login/Register screens
  (tabs)/               # Main tab navigation (Boards, Schedule, Profile)
  board/                # Board canvas screen
src/
  components/           # Reusable UI components
  config/               # Firebase configuration
  contexts/             # React contexts (Auth)
  hooks/                # Custom hooks
  services/             # Firebase service wrappers
  types/                # TypeScript interfaces
```

## Team

- **Arlo Kharod**
- **Scott Williams**

## Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `chore/description` — infrastructure, docs, cleanup
