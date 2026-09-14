import { useState } from "react";
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as templateService from "../services/templateService";
import type { TemplateCategory } from "../services/templateService";
import * as activityService from "../services/activityService";
import { isQuotaDenial } from "../services/quotaService";
import { showAlert } from "../utils/alerts";
import type { Plan } from "../types";

/**
 * Month 6 — the new-board template gallery.
 *
 * The gallery itself owns the create-from-template flow (calling
 * `templateService.createBoardFromTemplate` and logging the activity-feed
 * entry) so callers only need to react to the outcome — `onCreated` /
 * `onQuotaDenied` — mirroring how `JoinBoardModal` owns `joinBoardByCode`
 * and just hands its caller a result. The screen that renders this
 * (`app/(tabs)/index.tsx`) does no Firestore/service work of its own for
 * this flow, only navigation on success.
 */

const CATEGORY_ICON: Record<TemplateCategory, keyof typeof Ionicons.glyphMap> = {
  study: "book-outline",
  cs: "code-slash-outline",
  classroom: "school-outline",
  meeting: "people-outline",
};

export interface TemplateGalleryModalProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the new board's id once it's created and seeded. */
  onCreated: (boardId: string) => void;
  /** Called instead of a generic error when creation is denied for being
   *  over the workspace's plan limit — the caller shows its own upsell UI. */
  onQuotaDenied: () => void;
  ownerId: string;
  /** Display name for the activity-feed entry; falls back the same way the
   *  blank-board create flow does (displayName, then email, then "Someone"). */
  ownerName: string;
  workspaceId: string;
  plan?: Plan;
  currentBoardCount?: number;
}

export default function TemplateGalleryModal({
  visible,
  onClose,
  onCreated,
  onQuotaDenied,
  ownerId,
  ownerName,
  workspaceId,
  plan,
  currentBoardCount,
}: TemplateGalleryModalProps) {
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const groups = templateService.listTemplatesByCategory();

  const handleSelect = async (template: templateService.Template) => {
    if (creatingId) return; // one create at a time
    setCreatingId(template.id);
    try {
      const boardId = await templateService.createBoardFromTemplate(
        template.id,
        ownerId,
        workspaceId,
        plan,
        currentBoardCount
      );
      activityService.logBoardCreated({
        workspaceId,
        boardId,
        actorId: ownerId,
        actorName: ownerName,
        title: template.title,
      });
      onCreated(boardId);
    } catch (error: any) {
      if (isQuotaDenial(error)) {
        onQuotaDenied();
      } else {
        showAlert("Couldn't create board", error?.message ?? "Something went wrong. Please try again.");
      }
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <Ionicons name="grid-outline" size={20} color="#2563eb" />
          </View>
          <Text style={styles.title}>Start from a Template</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="Close template gallery">
            <Ionicons name="close" size={22} color="#666" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {groups.map((group) => (
            <View key={group.category} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name={CATEGORY_ICON[group.category]} size={15} color="#6b7280" />
                <Text style={styles.sectionTitle}>{group.label}</Text>
              </View>
              {group.templates.map((template) => {
                const busy = creatingId === template.id;
                return (
                  <TouchableOpacity
                    key={template.id}
                    style={styles.card}
                    onPress={() => handleSelect(template)}
                    disabled={!!creatingId}
                    activeOpacity={0.7}
                  >
                    <View style={styles.cardText}>
                      <Text style={styles.cardTitle}>{template.title}</Text>
                      <Text style={styles.cardDescription} numberOfLines={2}>
                        {template.description}
                      </Text>
                    </View>
                    {busy ? (
                      <ActivityIndicator size="small" color="#2563eb" />
                    ) : (
                      <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    position: "absolute",
    top: 60,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  section: {
    marginBottom: 20,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  cardText: {
    flex: 1,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
  },
  cardDescription: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 2,
  },
});
