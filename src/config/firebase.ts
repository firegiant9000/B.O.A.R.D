import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// TODO: Replace with your Firebase project config
// Get these values from Firebase Console > Project Settings > Your Apps
const firebaseConfig = {
  apiKey: "AIzaSyAJFFIUWRaydXbhEjgdln4IfHfynJVfJK0",
  authDomain: "board-6b415.firebaseapp.com",
  projectId: "board-6b415",
  storageBucket: "board-6b415.firebasestorage.app",
  messagingSenderId: "1077801569891",
  appId: "1:1077801569891:web:e1b872528ab64cd9cdb256",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
