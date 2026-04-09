import {
  collection,
  addDoc,
  getDocs,
  updateDoc,
  doc,
  getDoc,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { FriendRequest } from "../types";

async function getUserByEmail(email: string) {
  const q = query(collection(db, "users"), where("email", "==", email));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { uid: d.id, ...(d.data() as any) };
}

function mapRequest(d: any): FriendRequest {
  const data = d.data();
  return {
    id: d.id,
    fromId: data.fromId,
    fromDisplayName: data.fromDisplayName ?? "",
    fromEmail: data.fromEmail ?? "",
    toId: data.toId,
    toDisplayName: data.toDisplayName ?? "",
    toEmail: data.toEmail ?? "",
    status: data.status,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export async function sendFriendRequest(
  fromId: string,
  fromDisplayName: string,
  fromEmail: string,
  toEmail: string
): Promise<"sent" | "not_found" | "already_friends" | "pending" | "self"> {
  const target = await getUserByEmail(toEmail);
  if (!target) return "not_found";
  if (target.uid === fromId) return "self";

  const reqsRef = collection(db, "friendRequests");

  // Check any existing request in either direction
  const [fwd, rev] = await Promise.all([
    getDocs(query(reqsRef, where("fromId", "==", fromId), where("toId", "==", target.uid))),
    getDocs(query(reqsRef, where("fromId", "==", target.uid), where("toId", "==", fromId))),
  ]);

  if (!fwd.empty) {
    const status = fwd.docs[0].data().status;
    return status === "accepted" ? "already_friends" : "pending";
  }
  if (!rev.empty) {
    const status = rev.docs[0].data().status;
    return status === "accepted" ? "already_friends" : "pending";
  }

  await addDoc(reqsRef, {
    fromId,
    fromDisplayName,
    fromEmail,
    toId: target.uid,
    toDisplayName: target.displayName ?? "",
    toEmail: target.email ?? toEmail,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  return "sent";
}

export async function getPendingRequests(userId: string): Promise<FriendRequest[]> {
  const q = query(
    collection(db, "friendRequests"),
    where("toId", "==", userId),
    where("status", "==", "pending")
  );
  const snap = await getDocs(q);
  return snap.docs.map(mapRequest);
}

export async function getFriends(userId: string): Promise<FriendRequest[]> {
  const reqsRef = collection(db, "friendRequests");
  const [snap1, snap2] = await Promise.all([
    getDocs(query(reqsRef, where("fromId", "==", userId), where("status", "==", "accepted"))),
    getDocs(query(reqsRef, where("toId", "==", userId), where("status", "==", "accepted"))),
  ]);
  return [...snap1.docs.map(mapRequest), ...snap2.docs.map(mapRequest)];
}

export async function respondToFriendRequest(
  requestId: string,
  accept: boolean
): Promise<void> {
  await updateDoc(doc(db, "friendRequests", requestId), {
    status: accept ? "accepted" : "rejected",
  });
}

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  await updateDoc(doc(db, "users", blockerId), {
    blockedIds: arrayUnion(blockedId),
  });
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await updateDoc(doc(db, "users", blockerId), {
    blockedIds: arrayRemove(blockedId),
  });
}

export async function getBlockedIds(userId: string): Promise<string[]> {
  const d = await getDoc(doc(db, "users", userId));
  if (!d.exists()) return [];
  return (d.data() as any).blockedIds ?? [];
}

export async function areFriends(userId1: string, userId2: string): Promise<boolean> {
  const reqsRef = collection(db, "friendRequests");
  const [s1, s2] = await Promise.all([
    getDocs(query(reqsRef, where("fromId", "==", userId1), where("toId", "==", userId2), where("status", "==", "accepted"))),
    getDocs(query(reqsRef, where("fromId", "==", userId2), where("toId", "==", userId1), where("status", "==", "accepted"))),
  ]);
  return !s1.empty || !s2.empty;
}

export async function hasPendingRequest(fromId: string, toId: string): Promise<boolean> {
  const q = query(
    collection(db, "friendRequests"),
    where("fromId", "==", fromId),
    where("toId", "==", toId),
    where("status", "==", "pending")
  );
  const snap = await getDocs(q);
  return !snap.empty;
}
