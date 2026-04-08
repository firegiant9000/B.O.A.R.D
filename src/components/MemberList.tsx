import { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { useBoardPresence } from "../hooks/useBoardPresence";

interface MemberListProps {
  boardId: string;
  memberUids: string[];
  currentUserId: string | undefined;
}

const AVATAR_SIZE = 32;
const OVERLAP = 10;     // how many px each avatar slides under the previous
const MAX_VISIBLE = 4;

export default function MemberList({
  boardId,
  memberUids,
  currentUserId,
}: MemberListProps) {
  const { members, loading } = useBoardPresence(boardId, memberUids, currentUserId);

  // Shimmer animation — runs only while loading
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  const shimmerLoop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (loading) {
      shimmerLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(shimmerAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(shimmerAnim, {
            toValue: 0,
            duration: 700,
            useNativeDriver: true,
          }),
        ])
      );
      shimmerLoop.current.start();
    } else {
      shimmerLoop.current?.stop();
      shimmerAnim.setValue(0);
    }
  }, [loading, shimmerAnim]);

  const shimmerOpacity = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.25, 0.6],
  });

  // ── Shimmer placeholder ────────────────────────────────────────────────────
  if (loading) {
    // Show as many ghost circles as there are members, capped at MAX_VISIBLE
    const ghostCount = Math.min(Math.max(memberUids.length, 1), MAX_VISIBLE);
    return (
      <View style={styles.row}>
        {Array.from({ length: ghostCount }).map((_, i) => (
          <Animated.View
            key={i}
            style={[
              styles.avatar,
              styles.shimmerCircle,
              i > 0 && { marginLeft: -OVERLAP },
              { opacity: shimmerOpacity },
            ]}
          />
        ))}
      </View>
    );
  }

  // ── Live member avatars ────────────────────────────────────────────────────
  const visible = members.slice(0, MAX_VISIBLE);
  const overflow = members.length - MAX_VISIBLE;

  return (
    <View style={styles.row}>
      {visible.map((member, index) => (
        <View
          key={member.uid}
          style={[
            styles.avatarWrap,
            index > 0 && { marginLeft: -OVERLAP },
            // Higher z-index for earlier (online-first sorted) members
            { zIndex: MAX_VISIBLE - index },
          ]}
        >
          <View
            style={[
              styles.avatar,
              styles.avatarFilled,
              member.uid === currentUserId && styles.avatarSelf,
            ]}
          >
            <Text style={styles.initials}>{member.initials}</Text>
          </View>

          {member.isOnline && <View style={styles.onlineDot} />}
        </View>
      ))}

      {overflow > 0 && (
        <View
          style={[styles.avatar, styles.overflowCircle, { marginLeft: -OVERLAP }]}
        >
          <Text style={styles.overflowText}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatarWrap: {
    // Position the online dot relative to this wrapper
    position: "relative",
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 2,
    borderColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarFilled: {
    backgroundColor: "#2563eb",
  },
  avatarSelf: {
    backgroundColor: "#7c3aed",
  },
  initials: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.5,
  },
  onlineDot: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#22c55e",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  shimmerCircle: {
    backgroundColor: "#d1d5db",
  },
  overflowCircle: {
    backgroundColor: "#e5e7eb",
  },
  overflowText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#555",
  },
});
