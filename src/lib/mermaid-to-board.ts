import type { ShapeKind, ArrowheadStyle } from "../types";

// Month 4, Phase 12 — the one-time Mermaid → native-elements renderer. The Cloud
// Function returns validated Mermaid syntax; this pure module parses it into
// geometry-only element specs that the board screen turns into real
// ShapeElement/TextElement docs (applying the user's color/stroke). Kept free of
// Firestore and React so it is exhaustively unit-tested on canonical samples of
// each of the five v1 diagram families (Appendix B.7).
//
// v1 scope (the phase contract): flowchart/graph (also used for simple network
// diagrams), sequenceDiagram, classDiagram, mindmap. Edges are emitted as plain
// `line`/`arrow` shapes — the first-class `connector` element type is a roadmap
// stretch (Appendix A.2) we can upgrade to later without changing this contract.

export type DiagramFamily = "flowchart" | "sequence" | "class" | "mindmap" | "network";

/** A node or edge, in diagram-local coordinates (origin at 0,0). The caller
 *  offsets these to a drop point and applies styling. `role` lets the caller
 *  style nodes and edges differently (e.g. filled node vs. bare connector). */
export interface DiagramShapeSpec {
  role: "node" | "edge";
  shape: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  arrowheadEnd: ArrowheadStyle;
  dashed: boolean;
}

/** A label, in diagram-local coordinates. Node labels and edge labels both land
 *  here; the caller drops them into TextElements. */
export interface DiagramTextSpec {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** "node" labels are centered in a box; "edge" labels float on a connector. */
  role: "node" | "edge";
}

export interface DiagramBuild {
  family: DiagramFamily;
  shapes: DiagramShapeSpec[];
  texts: DiagramTextSpec[];
  /** Overall bounds of the diagram (for centering it on the drop point). */
  width: number;
  height: number;
}

// Layout constants. Tuned so labels of a few words fit and the diagram reads at a
// normal zoom; the caller can scale by translating, not resizing.
const NODE_W = 150;
const NODE_H = 56;
const COL_GAP = 70;
const ROW_GAP = 48;
const MSG_GAP = 64;
const LABEL_W = 120;
const LABEL_H = 24;

class LayoutError extends Error {}

/** Thrown when the Mermaid is well-formed enough to detect a family but yields no
 *  drawable nodes. The caller surfaces it as a friendly "couldn't draw that". */
export class EmptyDiagramError extends Error {
  constructor() {
    super("The diagram had no drawable content.");
    this.name = "EmptyDiagramError";
  }
}

function firstLine(src: string): string {
  return (
    src
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

function detectFamily(src: string): DiagramFamily {
  const head = firstLine(src).toLowerCase();
  if (head.startsWith("flowchart") || head.startsWith("graph")) return "flowchart";
  if (head.startsWith("sequencediagram")) return "sequence";
  if (head.startsWith("classdiagram")) return "class";
  if (head.startsWith("mindmap")) return "mindmap";
  throw new LayoutError(`Unsupported diagram type: "${firstLine(src)}"`);
}

/** Body lines (header stripped), trimmed, with blanks and `%%` comments removed. */
function bodyLines(src: string): string[] {
  return src
    .split("\n")
    .slice(1) // header
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
}

function stripWrappers(raw: string): string {
  // Remove Mermaid node-shape wrappers ([], (), (()), {}, [[]], >]) and quotes.
  let s = raw.trim();
  s = s.replace(/^[[({>]+/, "").replace(/[\])}]+$/, "");
  s = s.replace(/^"+|"+$/g, "");
  return s.trim();
}

// --- Flowchart / graph (and "network", which uses the same grammar) ---

interface FlowNode {
  id: string;
  label: string;
  shape: ShapeKind;
}
interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  arrow: boolean;
}

function nodeShapeFor(rest: string): ShapeKind {
  // rest is the text after the node id, e.g. "[Label]", "(Label)", "{Label}".
  if (rest.startsWith("{")) return "triangle"; // decision/diamond → triangle (closest primitive)
  if (rest.startsWith("(")) return "ellipse"; // (), (()) → rounded/circle
  return "rect"; // [], [[]], default
}

function parseNodeChunk(
  chunk: string,
  nodes: Map<string, FlowNode>
): string | null {
  const trimmed = chunk.trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/^([A-Za-z0-9_]+)/);
  if (!idMatch) return null;
  const id = idMatch[1];
  const rest = trimmed.slice(id.length).trim();
  const existing = nodes.get(id);
  if (rest) {
    // Declaration with a label/shape — set or overwrite.
    nodes.set(id, { id, label: stripWrappers(rest) || id, shape: nodeShapeFor(rest) });
  } else if (!existing) {
    // First mention without a label — default to a rect labeled by its id.
    nodes.set(id, { id, label: id, shape: "rect" });
  }
  return id;
}

// One edge connector with an optional |label| or " text " between dashes.
const FLOW_EDGE_RE = /\s*(-->|---|==>|===)\s*(?:\|([^|]*)\|\s*)?/g;

function parseFlowchart(src: string): DiagramBuild {
  const lines = bodyLines(src);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const direction = /\b(lr|rl)\b/i.test(firstLine(src)) ? "LR" : "TD";

  for (let line of lines) {
    if (/^(subgraph|end|style|classdef|class|click|linkstyle|direction)\b/i.test(line)) {
      continue; // unsupported directives — skip rather than fail
    }
    // Normalize "A -- text --> B" into "A -->|text| B" so one regex handles both.
    line = line.replace(/--\s+([^>|][^>]*?)\s+-->/g, (_m, lbl) => `-->|${lbl.trim()}|`);

    FLOW_EDGE_RE.lastIndex = 0;
    const chunks: string[] = [];
    const conns: { label?: string; arrow: boolean }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = FLOW_EDGE_RE.exec(line))) {
      chunks.push(line.slice(last, m.index));
      conns.push({ label: m[2]?.trim() || undefined, arrow: m[1] === "-->" || m[1] === "==>" });
      last = FLOW_EDGE_RE.lastIndex;
    }
    chunks.push(line.slice(last));

    const ids = chunks.map((c) => parseNodeChunk(c, nodes));
    for (let i = 0; i < conns.length; i++) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from && to) edges.push({ from, to, label: conns[i].label, arrow: conns[i].arrow });
    }
  }

  if (nodes.size === 0) throw new EmptyDiagramError();
  return layoutLayered([...nodes.values()], edges, direction);
}

/** Longest-path layering: rank(root)=0, rank(to)=max(rank(from)+1). Relax V times
 *  so any line ordering converges; cycles are harmless (capped by V passes). */
function layoutLayered(
  nodes: FlowNode[],
  edges: FlowEdge[],
  direction: "TD" | "LR"
): DiagramBuild {
  const rank = new Map<string, number>();
  nodes.forEach((n) => rank.set(n.id, 0));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const r = Math.max(rank.get(e.to) ?? 0, (rank.get(e.from) ?? 0) + 1);
      if (r !== rank.get(e.to)) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group by rank, preserving node insertion order within each rank.
  const ranks = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r)!.push(n);
  }
  const maxCount = Math.max(...[...ranks.values()].map((g) => g.length));
  const crossSpan = maxCount * NODE_W + (maxCount - 1) * COL_GAP;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [r, group] of ranks) {
    const span = group.length * NODE_W + (group.length - 1) * COL_GAP;
    const start = (crossSpan - span) / 2;
    group.forEach((n, i) => {
      const cross = start + i * (NODE_W + COL_GAP);
      // TD: rank ↓ (y), spread → (x). LR: rank → (x), spread ↓ (y).
      const x = direction === "TD" ? cross : r * (NODE_W + COL_GAP);
      const y = direction === "TD" ? r * (NODE_H + ROW_GAP) : start + i * (NODE_H + ROW_GAP);
      pos.set(n.id, { x, y });
    });
  }

  const shapes: DiagramShapeSpec[] = [];
  const texts: DiagramTextSpec[] = [];
  for (const n of nodes) {
    const p = pos.get(n.id)!;
    shapes.push(nodeShape(n.shape, p.x, p.y));
    texts.push(nodeLabel(n.label, p.x, p.y));
  }
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    pushEdge(shapes, texts, a, b, direction, e.arrow, e.label);
  }
  return finalize("flowchart", shapes, texts);
}

// --- Sequence diagram ---

const SEQ_MSG_RE = /^(\w+)\s*((?:-|=){1,2}(?:>>?|x)?)\s*(\w+)\s*:\s*(.+)$/;

function parseSequence(src: string): DiagramBuild {
  const lines = bodyLines(src);
  const order: string[] = [];
  const ensure = (id: string) => {
    if (!order.includes(id)) order.push(id);
  };
  const messages: { from: string; to: string; text: string; dashed: boolean }[] = [];

  for (const line of lines) {
    const part = line.match(/^(?:participant|actor)\s+(\w+)(?:\s+as\s+.+)?$/i);
    if (part) {
      ensure(part[1]);
      continue;
    }
    const m = line.match(SEQ_MSG_RE);
    if (m) {
      ensure(m[1]);
      ensure(m[3]);
      messages.push({ from: m[1], to: m[3], text: m[4].trim(), dashed: m[2].includes("--") });
    }
  }

  if (order.length === 0) throw new EmptyDiagramError();

  const colGap = NODE_W + COL_GAP;
  const colX = new Map<string, number>();
  order.forEach((id, i) => colX.set(id, i * colGap));
  const lifelineTop = NODE_H;
  const lifelineBottom = lifelineTop + (messages.length + 1) * MSG_GAP;

  const shapes: DiagramShapeSpec[] = [];
  const texts: DiagramTextSpec[] = [];
  order.forEach((id) => {
    const x = colX.get(id)!;
    shapes.push(nodeShape("rect", x, 0));
    texts.push(nodeLabel(id, x, 0));
    // Lifeline: a dashed vertical line down the participant's center.
    const cx = x + NODE_W / 2;
    shapes.push({
      role: "edge",
      shape: "line",
      x: cx,
      y: lifelineTop,
      width: 0,
      height: lifelineBottom - lifelineTop,
      arrowheadEnd: "none",
      dashed: true,
    });
  });

  messages.forEach((msg, i) => {
    const fromX = (colX.get(msg.from) ?? 0) + NODE_W / 2;
    const toX = (colX.get(msg.to) ?? 0) + NODE_W / 2;
    const y = lifelineTop + (i + 1) * MSG_GAP;
    shapes.push({
      role: "edge",
      shape: "arrow",
      x: fromX,
      y,
      width: toX - fromX,
      height: 0,
      arrowheadEnd: "classic",
      dashed: msg.dashed,
    });
    const midX = (fromX + toX) / 2;
    texts.push({
      text: msg.text,
      x: midX - LABEL_W / 2,
      y: y - LABEL_H - 4,
      width: LABEL_W,
      height: LABEL_H,
      role: "edge",
    });
  });

  return finalize("sequence", shapes, texts);
}

// --- Class diagram ---

const CLASS_REL_RE =
  /^(\w+)\s*(<\|--|--\|>|\*--|o--|<--|-->|<\.\.|\.\.>|--|\.\.)\s*(\w+)(?:\s*:\s*(.*))?$/;

function parseClass(src: string): DiagramBuild {
  const lines = bodyLines(src);
  const classes = new Map<string, string[]>(); // name → member lines
  const order: string[] = [];
  const ensure = (name: string) => {
    if (!classes.has(name)) {
      classes.set(name, []);
      order.push(name);
    }
  };
  const rels: { from: string; to: string; label?: string; arrow: boolean }[] = [];

  let open: string | null = null;
  for (const line of lines) {
    if (open) {
      if (line.startsWith("}")) {
        open = null;
      } else {
        // Keep member lines verbatim (e.g. "+eat()") — stripWrappers would eat the
        // trailing parens.
        classes.get(open)!.push(line.trim());
      }
      continue;
    }
    const block = line.match(/^class\s+(\w+)\s*\{?$/);
    if (block) {
      ensure(block[1]);
      if (line.endsWith("{")) open = block[1];
      continue;
    }
    const rel = line.match(CLASS_REL_RE);
    if (rel) {
      ensure(rel[1]);
      ensure(rel[3]);
      rels.push({
        from: rel[1],
        to: rel[3],
        label: rel[4]?.trim() || undefined,
        arrow: rel[2].includes(">") || rel[2].includes("|"),
      });
    }
  }

  if (order.length === 0) throw new EmptyDiagramError();

  // Simple grid layout (≈ square).
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
  const pos = new Map<string, { x: number; y: number }>();
  order.forEach((name, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(name, { x: c * (NODE_W + COL_GAP), y: r * (NODE_H + ROW_GAP) });
  });

  const shapes: DiagramShapeSpec[] = [];
  const texts: DiagramTextSpec[] = [];
  order.forEach((name) => {
    const p = pos.get(name)!;
    shapes.push(nodeShape("rect", p.x, p.y));
    const members = classes.get(name)!.filter(Boolean);
    const label = members.length ? `${name}\n${members.join("\n")}` : name;
    texts.push(nodeLabel(label, p.x, p.y));
  });
  for (const rel of rels) {
    const a = pos.get(rel.from);
    const b = pos.get(rel.to);
    if (!a || !b) continue;
    pushEdge(shapes, texts, a, b, "TD", rel.arrow, rel.label);
  }

  return finalize("class", shapes, texts);
}

// --- Mindmap ---

interface MindNode {
  text: string;
  depth: number;
  children: MindNode[];
}

function parseMindmap(src: string): DiagramBuild {
  // Indentation defines depth; preserve raw leading whitespace (bodyLines trims,
  // so re-read the raw lines here for indentation).
  const raw = src.split("\n").slice(1).filter((l) => l.trim().length > 0 && !l.trim().startsWith("%%"));
  if (raw.length === 0) throw new EmptyDiagramError();

  const indentOf = (l: string) => l.match(/^\s*/)![0].replace(/\t/g, "  ").length;

  // A mindmap node is "id((text))", "id[text]", a bare "((text))"/"[text]" wrapper,
  // or just plain text. Pull the label out of whichever form is present.
  const mindLabel = (l: string): string => {
    const t = l.trim();
    const m = t.match(/^[A-Za-z0-9_]+\s*[([{]+(.*?)[)\]}]+\s*$/);
    if (m) return m[1].trim();
    if (/^[([{]/.test(t)) return stripWrappers(t);
    return t;
  };

  const root: MindNode = { text: mindLabel(raw[0]), depth: 0, children: [] };
  const stack: { node: MindNode; indent: number }[] = [{ node: root, indent: indentOf(raw[0]) }];

  for (let i = 1; i < raw.length; i++) {
    const indent = indentOf(raw[i]);
    const node: MindNode = { text: mindLabel(raw[i]), depth: 0, children: [] };
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    node.depth = parent.depth + 1;
    parent.children.push(node);
    stack.push({ node, indent });
  }

  // Left-to-right tree: x by depth, y by in-order leaf counter; an internal node
  // sits at the midpoint of its children's y span.
  const pos = new Map<MindNode, { x: number; y: number }>();
  let row = 0;
  const assign = (n: MindNode): number => {
    const x = n.depth * (NODE_W + COL_GAP);
    if (n.children.length === 0) {
      const y = row * (NODE_H + ROW_GAP);
      row++;
      pos.set(n, { x, y });
      return y;
    }
    const ys = n.children.map(assign);
    const y = (ys[0] + ys[ys.length - 1]) / 2;
    pos.set(n, { x, y });
    return y;
  };
  assign(root);

  const shapes: DiagramShapeSpec[] = [];
  const texts: DiagramTextSpec[] = [];
  const walk = (n: MindNode) => {
    const p = pos.get(n)!;
    shapes.push(nodeShape("ellipse", p.x, p.y));
    texts.push(nodeLabel(n.text || "·", p.x, p.y));
    for (const c of n.children) {
      const cp = pos.get(c)!;
      pushEdge(shapes, texts, p, cp, "LR", false, undefined);
      walk(c);
    }
  };
  walk(root);

  return finalize("mindmap", shapes, texts);
}

// --- Shared element builders ---

function nodeShape(shape: ShapeKind, x: number, y: number): DiagramShapeSpec {
  return {
    role: "node",
    shape,
    x,
    y,
    width: NODE_W,
    height: NODE_H,
    arrowheadEnd: "none",
    dashed: false,
  };
}

function nodeLabel(text: string, x: number, y: number): DiagramTextSpec {
  return { text, x: x + 8, y: y + 8, width: NODE_W - 16, height: NODE_H - 16, role: "node" };
}

/** Emit an edge between two node top-lefts, anchored on the boundary facing the
 *  flow direction, with an optional midpoint label. */
function pushEdge(
  shapes: DiagramShapeSpec[],
  texts: DiagramTextSpec[],
  a: { x: number; y: number },
  b: { x: number; y: number },
  direction: "TD" | "LR",
  arrow: boolean,
  label?: string
): void {
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  if (direction === "TD") {
    start = { x: a.x + NODE_W / 2, y: a.y + NODE_H };
    end = { x: b.x + NODE_W / 2, y: b.y };
  } else {
    start = { x: a.x + NODE_W, y: a.y + NODE_H / 2 };
    end = { x: b.x, y: b.y + NODE_H / 2 };
  }
  shapes.push({
    role: "edge",
    shape: arrow ? "arrow" : "line",
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    arrowheadEnd: arrow ? "classic" : "none",
    dashed: false,
  });
  if (label) {
    texts.push({
      text: label,
      x: (start.x + end.x) / 2 - LABEL_W / 2,
      y: (start.y + end.y) / 2 - LABEL_H / 2,
      width: LABEL_W,
      height: LABEL_H,
      role: "edge",
    });
  }
}

/** Normalize the diagram to a (0,0) origin and compute its bounds so the caller
 *  can center it on a drop point. */
function finalize(
  family: DiagramFamily,
  shapes: DiagramShapeSpec[],
  texts: DiagramTextSpec[]
): DiagramBuild {
  if (shapes.length === 0) throw new EmptyDiagramError();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x, x + w);
    minY = Math.min(minY, y, y + h);
    maxX = Math.max(maxX, x, x + w);
    maxY = Math.max(maxY, y, y + h);
  };
  shapes.forEach((s) => consider(s.x, s.y, s.width, s.height));
  texts.forEach((t) => consider(t.x, t.y, t.width, t.height));

  for (const s of shapes) {
    s.x -= minX;
    s.y -= minY;
  }
  for (const t of texts) {
    t.x -= minX;
    t.y -= minY;
  }
  return { family, shapes, texts, width: maxX - minX, height: maxY - minY };
}

/**
 * Parse Mermaid source into geometry-only board element specs. Throws
 * `EmptyDiagramError` when the family is recognized but yields no nodes, or a
 * generic Error for an unsupported diagram type (the function should have
 * filtered these, but the client guards too).
 */
export function mermaidToBoard(src: string): DiagramBuild {
  const family = detectFamily(src);
  switch (family) {
    case "flowchart":
    case "network":
      return parseFlowchart(src);
    case "sequence":
      return parseSequence(src);
    case "class":
      return parseClass(src);
    case "mindmap":
      return parseMindmap(src);
  }
}
