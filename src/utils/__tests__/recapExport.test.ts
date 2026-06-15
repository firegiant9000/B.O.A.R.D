jest.mock("expo-print", () => ({ printToFileAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

import { buildRecapHtml, recapDurationMinutes } from "../recapExport";
import { Session } from "../../types";

const base: Session = {
  id: "s1",
  workspaceId: "ws1",
  boardId: "b1",
  boardTitle: "Algorithms",
  title: "Midterm Review",
  description: "",
  scheduledAt: new Date("2026-06-10T15:00:00Z"),
  durationMinutes: 60,
  createdById: "u1",
  createdByName: "Arlo",
  participantIds: ["u2"],
  status: "ended",
  createdAt: new Date("2026-06-10T14:00:00Z"),
};

describe("recapDurationMinutes", () => {
  it("uses real elapsed when startedAt + endedAt exist", () => {
    const s = {
      ...base,
      startedAt: new Date("2026-06-10T15:00:00Z"),
      endedAt: new Date("2026-06-10T15:45:00Z"),
    };
    expect(recapDurationMinutes(s)).toBe(45);
  });

  it("falls back to durationMinutes when timestamps are missing", () => {
    expect(recapDurationMinutes(base)).toBe(60);
  });
});

describe("buildRecapHtml", () => {
  it("renders the structured summary sections", () => {
    const s: Session = {
      ...base,
      summary: {
        tldr: "Covered sorting & recursion.",
        actionItems: ["Practice quicksort"],
        decisions: ["Skip heaps"],
        openQuestions: ["Big-O of merge sort?"],
      },
    };
    const html = buildRecapHtml(s);
    expect(html).toContain("Midterm Review");
    expect(html).toContain("Covered sorting &amp; recursion.");
    expect(html).toContain("Practice quicksort");
    expect(html).toContain("Skip heaps");
    expect(html).toContain("Big-O of merge sort?");
  });

  it("treats a legacy string summary as the TL;DR", () => {
    const html = buildRecapHtml({ ...base, summary: "Just a plain string." });
    expect(html).toContain("Just a plain string.");
  });

  it("escapes HTML in user content", () => {
    const html = buildRecapHtml({ ...base, title: "<script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("embeds the snapshot image when present", () => {
    const html = buildRecapHtml({ ...base, canvasSnapshot: "data:image/png;base64,AAA" });
    expect(html).toContain('src="data:image/png;base64,AAA"');
  });
});
