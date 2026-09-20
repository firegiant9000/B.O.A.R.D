import { ArrowheadStyle, Plan, ShapeKind } from "../types";
import * as boardService from "./boardService";
import * as pathService from "./pathService";
import * as shapeService from "./shapeService";
import { track } from "./analyticsService";

import cornellNotes from "../templates/cornell-notes.json";
import flashcardDeck from "../templates/flashcard-deck.json";
import mindMap from "../templates/mind-map.json";
import spacedRepetitionPlanner from "../templates/spaced-repetition-planner.json";
import examReviewGrid from "../templates/exam-review-grid.json";
import studyStreakTracker from "../templates/study-streak-tracker.json";
import sprintPlanner from "../templates/sprint-planner.json";
import codeReviewChecklist from "../templates/code-review-checklist.json";
import systemDesignCanvas from "../templates/system-design-canvas.json";
import designDocStructure from "../templates/design-doc-structure.json";
import sequenceDiagramCanvas from "../templates/sequence-diagram-canvas.json";
import erdCanvas from "../templates/erd-canvas.json";
import labReport from "../templates/lab-report.json";
import lectureNotes from "../templates/lecture-notes.json";
import groupBrainstormZones from "../templates/group-brainstorm-zones.json";
import peerReview from "../templates/peer-review.json";
import weeklyKanban from "../templates/weekly-kanban.json";
import retro from "../templates/retro.json";
import oneOnOneAgenda from "../templates/one-on-one-agenda.json";
import standup from "../templates/standup.json";
import decisionLog from "../templates/decision-log.json";

/**
 * Month 6 — the template library.
 *
 * Every file under `src/templates/*.json` is static seed data for a board:
 * `schemaVersion: 1`, a stable `id` (the filename), a `title`, a `category`,
 * and an `elements` array of geometry-only specs. `src/services/__tests__/
 * templates.validity.test.ts` is the floor these files must clear — read it
 * before adding or editing a template.
 *
 * The 21 files are imported statically (not read from disk at runtime) so
 * Metro bundles them into the app like any other module — there is no
 * filesystem to `readdirSync` on a native device. Adding a 22nd template
 * means adding both an import line here and an entry in `ALL_TEMPLATES`;
 * the validity test's exact file-count assertion will catch a mismatch.
 *
 * `path` and `image` are valid live element kinds (useBoardElements.ts's
 * section map) but no template today uses either — `TemplateElement` below
 * is intentionally narrower than the full board element surface. Extend it
 * (and the switch in `applyTemplateToBoard`) only once a template actually
 * needs one of those kinds.
 */

export type TemplateCategory = "study" | "cs" | "classroom" | "meeting";

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  study: "Study",
  cs: "CS & Engineering",
  classroom: "Classroom",
  meeting: "Meetings",
};

/** Display order for the gallery — not alphabetical, so it reads as a
 *  deliberate curriculum (study first, meetings last) rather than a sort. */
export const TEMPLATE_CATEGORY_ORDER: TemplateCategory[] = [
  "study",
  "cs",
  "classroom",
  "meeting",
];

interface TemplateShapeElement {
  type: "shape";
  shape: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  arrowheadStart?: ArrowheadStyle;
  arrowheadEnd?: ArrowheadStyle;
}

interface TemplateTextElement {
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  color?: string;
}

interface TemplateNoteElement {
  type: "note";
  content: string;
  x: number;
  y: number;
}

export type TemplateElement = TemplateShapeElement | TemplateTextElement | TemplateNoteElement;

export interface Template {
  schemaVersion: 1;
  id: string;
  title: string;
  category: TemplateCategory;
  description: string;
  elements: TemplateElement[];
}

// The JSON import gives each file `unknown`-shaped literal types from
// TypeScript's structural inference; asserting `Template` here is the one
// place that narrows them back to the type every other caller works with.
// `templates.validity.test.ts` is what actually guards these files are
// well-formed at the field level — this cast doesn't re-check that.
const ALL_TEMPLATES: Template[] = [
  cornellNotes,
  flashcardDeck,
  mindMap,
  spacedRepetitionPlanner,
  examReviewGrid,
  studyStreakTracker,
  sprintPlanner,
  codeReviewChecklist,
  systemDesignCanvas,
  designDocStructure,
  sequenceDiagramCanvas,
  erdCanvas,
  labReport,
  lectureNotes,
  groupBrainstormZones,
  peerReview,
  weeklyKanban,
  retro,
  oneOnOneAgenda,
  standup,
  decisionLog,
] as Template[];

/** Every template, in a fixed order (declaration order above — same
 *  four-group curriculum order as TEMPLATE_CATEGORY_ORDER). */
export function listTemplates(): Template[] {
  return ALL_TEMPLATES;
}

/** Templates grouped by category, each group in TEMPLATE_CATEGORY_ORDER and
 *  internally in the same order `listTemplates()` returns. A category with
 *  no templates would simply be an empty array — every category here has at
 *  least one today. */
export function listTemplatesByCategory(): Array<{
  category: TemplateCategory;
  label: string;
  templates: Template[];
}> {
  return TEMPLATE_CATEGORY_ORDER.map((category) => ({
    category,
    label: TEMPLATE_CATEGORY_LABELS[category],
    templates: ALL_TEMPLATES.filter((t) => t.category === category),
  }));
}

export function getTemplate(id: string): Template | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id);
}

/**
 * Writes every element of `template` onto `boardId` as real board docs —
 * one `shapeService.saveShape` / `pathService.saveTextElement` /
 * `pathService.saveTextNote` call per element, awaited in the template's own
 * array order (not `Promise.all`) so each element's `createdAt` — the
 * z-order tiebreak every element kind here uses (see DrawPath.z's comment in
 * src/types/index.ts) — lands in the same order the template author laid
 * the elements out in, rather than whatever order concurrent writes happen
 * to resolve in.
 *
 * Exported (not just used by `createBoardFromTemplate` below) because a
 * later onboarding seed (Month 6 — seeding a new signup's first board from a
 * template) applies a template to a board it created through a different
 * path than this file's own `createBoardFromTemplate`.
 */
export async function applyTemplateToBoard(
  boardId: string,
  userId: string,
  template: Template
): Promise<void> {
  for (const el of template.elements) {
    switch (el.type) {
      case "shape":
        await shapeService.saveShape(boardId, {
          boardId,
          userId,
          shape: el.shape,
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          rotation: el.rotation ?? 0,
          fill: el.fill ?? "none",
          stroke: el.stroke ?? "#334155",
          strokeWidth: el.strokeWidth ?? 2,
          dashed: el.dashed ?? false,
          arrowheadStart: el.arrowheadStart ?? "none",
          arrowheadEnd: el.arrowheadEnd ?? "none",
        });
        break;
      case "text":
        await pathService.saveTextElement(boardId, {
          boardId,
          userId,
          text: el.text,
          position: { x: el.x, y: el.y },
          width: el.width,
          height: el.height,
          fontSize: el.fontSize ?? 16,
          color: el.color ?? "#111827",
        });
        break;
      case "note":
        await pathService.saveTextNote(boardId, {
          boardId,
          userId,
          content: el.content,
          position: { x: el.x, y: el.y },
        });
        break;
      default: {
        // Exhaustiveness check: TemplateElement is a closed union today, so
        // this branch is unreachable from well-typed callers. It stays a
        // runtime throw (not just the `never` assignment) because `template`
        // ultimately comes from a JSON.parse at module load — a malformed
        // file that slipped past templates.validity.test.ts would otherwise
        // silently drop the element instead of failing loudly.
        const exhaustive: never = el;
        throw new Error(
          `templateService.applyTemplateToBoard: template "${template.id}" has an ` +
            `element with unsupported type ${JSON.stringify((exhaustive as { type?: unknown })?.type)}`
        );
      }
    }
  }
}

/**
 * Creates a new board from `templateId` and seeds it with that template's
 * elements: `boardService.createBoard` (same quota/callable path every
 * other board-create call site uses) followed by `applyTemplateToBoard`.
 *
 * Fires `board_created` (an existing taxonomy event — see
 * analyticsService.ts; this is its first production call site) with the
 * template's stable `id` as `templateId`. Deliberately NOT the template's
 * `title`: today's titles are fixed copy ("Cornell Notes", "Sprint
 * Retro", ...) with no user content, but the analytics seam's rule is that
 * event properties never carry anything that *could* hold user content —
 * an id from this file's own closed, developer-authored list satisfies that
 * unconditionally, where a title field name invites a future template
 * feature (e.g. a renameable copy) to quietly start leaking one.
 */
export async function createBoardFromTemplate(
  templateId: string,
  ownerId: string,
  workspaceId: string,
  plan?: Plan,
  currentCount?: number
): Promise<string> {
  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(`templateService.createBoardFromTemplate: unknown template id "${templateId}"`);
  }
  const boardId = await boardService.createBoard(template.title, ownerId, workspaceId, plan, currentCount);
  await applyTemplateToBoard(boardId, ownerId, template);
  track("board_created", { templateId: template.id });
  return boardId;
}
