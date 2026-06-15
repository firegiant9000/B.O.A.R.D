import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import type { Session, SessionSummary, ParticipantSnapshot } from "../types";

// Phase 4: exportable session recap (PDF). The HTML builder is a pure function so
// it can be unit-tested without the platform print/share modules. Export is
// platform-split:
//  - native: expo-print renders the HTML to a PDF file, expo-sharing opens the
//    share sheet on it.
//  - web: expo-print's printToFileAsync is unsupported, so we open the HTML in a
//    new window and trigger the browser print dialog (Save as PDF).

/** Normalizes either summary form (legacy string or structured) into the
 *  structured shape, mirroring SummaryCard.normalize. */
function normalizeSummary(
  summary: string | SessionSummary | undefined
): SessionSummary {
  if (!summary) return { tldr: "", actionItems: [], decisions: [], openQuestions: [] };
  if (typeof summary === "string") {
    return { tldr: summary, actionItems: [], decisions: [], openQuestions: [] };
  }
  return {
    tldr: summary.tldr ?? "",
    actionItems: summary.actionItems ?? [],
    decisions: summary.decisions ?? [],
    openQuestions: summary.openQuestions ?? [],
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Real elapsed minutes from startedAt → endedAt when both exist; otherwise the
 *  planned durationMinutes. */
export function recapDurationMinutes(session: Session): number {
  if (session.startedAt && session.endedAt) {
    return Math.max(1, Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60000));
  }
  return session.durationMinutes;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "";
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

/** Builds the printable HTML for a session recap. Pure — no platform deps. */
export function buildRecapHtml(session: Session): string {
  const s = normalizeSummary(session.summary);
  const participants: ParticipantSnapshot[] =
    session.participants && session.participants.length > 0
      ? session.participants
      : [];
  const dateStr = (session.endedAt ?? session.scheduledAt).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const section = (label: string, body: string) =>
    body ? `<section><h2>${escapeHtml(label)}</h2>${body}</section>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; padding: 32px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin: 22px 0 6px; }
  .tldr { font-size: 15px; line-height: 1.5; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 3px 0; font-size: 14px; line-height: 1.4; }
  img.snapshot { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; margin-top: 8px; }
  .participants { font-size: 14px; }
</style></head><body>
  <h1>${escapeHtml(session.title)}</h1>
  <div class="meta">${escapeHtml(session.boardTitle)} • ${escapeHtml(dateStr)} • ${escapeHtml(
    formatDuration(recapDurationMinutes(session))
  )} • ${participants.length || session.participantIds.length + 1} participant(s)</div>
  ${section("Summary", s.tldr ? `<p class="tldr">${escapeHtml(s.tldr)}</p>` : "")}
  ${section("Action items", bulletList(s.actionItems))}
  ${section("Decisions", bulletList(s.decisions))}
  ${section("Open questions", bulletList(s.openQuestions))}
  ${section("Agenda", session.agenda ? `<p class="tldr">${escapeHtml(session.agenda)}</p>` : "")}
  ${section(
    "Participants",
    participants.length > 0
      ? `<div class="participants">${participants
          .map((p) => escapeHtml(p.displayName))
          .join(", ")}</div>`
      : ""
  )}
  ${section(
    "Board snapshot",
    session.canvasSnapshot ? `<img class="snapshot" src="${session.canvasSnapshot}" />` : ""
  )}
</body></html>`;
}

/** Renders the recap to a PDF and opens the platform share/print flow. */
export async function exportRecapPdf(session: Session): Promise<void> {
  const html = buildRecapHtml(session);

  if (Platform.OS === "web") {
    if (typeof window === "undefined") return;
    const win = window.open("", "_blank");
    if (!win) throw new Error("Popup blocked — allow popups to export the recap.");
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    return;
  }

  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: `${session.title} — Recap`,
      UTI: "com.adobe.pdf",
    });
  }
}
