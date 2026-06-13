import React, { createContext, useEffect, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../config/firebase";
import * as authService from "../services/authService";
import { UserProfile } from "../types";

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  emailVerified: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    displayName: string
  ) => Promise<void>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  reloadUser: () => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setEmailVerified(firebaseUser?.emailVerified ?? false);

      if (firebaseUser) {
        const profileDoc = await getDoc(doc(db, "users", firebaseUser.uid));
        if (profileDoc.exists()) {
          const data = profileDoc.data();
          setUserProfile({
            uid: firebaseUser.uid,
            email: data.email,
            displayName: data.displayName,
            createdAt: data.createdAt?.toDate() ?? new Date(),
            pushToken: data.pushToken,
          });
        }
      } else {
        setUserProfile(null);
      }

      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const handleSignIn = async (email: string, password: string) => {
    await authService.signIn(email, password);
  };

  const handleSignUp = async (
    email: string,
    password: string,
    displayName: string
  ) => {
    await authService.signUp(email, password, displayName);
  };

  const handleSignOut = async () => {
    await authService.signOut();
    setUserProfile(null);
    setEmailVerified(false);
  };

  const sendPasswordReset = async (email: string) => {
    await authService.sendPasswordReset(email);
  };

  const resendVerification = async () => {
    await authService.sendVerificationEmail();
  };

  // Reload reflects a verification done elsewhere; onAuthStateChanged does not
  // re-fire on reload, so we push the fresh flag into state ourselves.
  const reloadUser = async () => {
    const verified = await authService.reloadUser();
    setEmailVerified(verified);
    return verified;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        userProfile,
        emailVerified,
        loading,
        signIn: handleSignIn,
        signUp: handleSignUp,
        signOut: handleSignOut,
        sendPasswordReset,
        resendVerification,
        reloadUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
