// Pure-function tests for the Mermaid → board-element renderer (Phase 12), on
// canonical samples of each of the five v1 diagram families plus the failure
// modes the board screen relies on (empty / unsupported).

import { mermaidToBoard, EmptyDiagramError } from "../mermaid-to-board";

describe("flowchart", () => {
  const src = `flowchart TD
    A[Start] --> B{Decision}
    B -->|yes| C[Do it]
    B -->|no| D[Skip]`;

  it("emits a node shape + label per node and an edge per arrow", () => {
    const build = mermaidToBoard(src);
    expect(build.family).toBe("flowchart");
    // 4 nodes + 3 edges.
    expect(build.shapes.filter((s) => s.role === "node")).toHaveLength(4);
    expect(build.shapes.filter((s) => s.role === "edge")).toHaveLength(3);
    // 4 node labels + 2 edge labels (yes / no).
    expect(build.texts.filter((t) => t.role === "node")).toHaveLength(4);
    expect(build.texts.filter((t) => t.role === "edge")).toHaveLength(2);
  });

  it("maps node-shape syntax to primitives ([] rect, {} triangle)", () => {
    const build = mermaidToBoard(src);
    const nodes = build.shapes.filter((s) => s.role === "node");
    expect(nodes.some((n) => n.shape === "rect")).toBe(true);
    expect(nodes.some((n) => n.shape === "triangle")).toBe(true);
  });

  it("ranks nodes so children sit below their parent (TD)", () => {
    const build = mermaidToBoard(src);
    // The decision node should be on a lower row (greater y) than the start node.
    const labels = build.texts.filter((t) => t.role === "node");
    const start = labels.find((t) => t.text === "Start")!;
    const decision = labels.find((t) => t.text === "Decision")!;
    expect(decision.y).toBeGreaterThan(start.y);
  });

  it("normalizes everything to a (0,0) origin", () => {
    const build = mermaidToBoard(src);
    const minX = Math.min(...build.shapes.map((s) => Math.min(s.x, s.x + s.width)));
    const minY = Math.min(...build.shapes.map((s) => Math.min(s.y, s.y + s.height)));
    expect(minX).toBeCloseTo(0);
    expect(minY).toBeCloseTo(0);
  });
});

describe("graph LR (also the 'network' grammar)", () => {
  it("lays a left-right graph out by column", () => {
    const build = mermaidToBoard("graph LR\n  A --> B\n  B --> C");
    expect(build.family).toBe("flowchart");
    const labels = build.texts.filter((t) => t.role === "node");
    const a = labels.find((t) => t.text === "A")!;
    const c = labels.find((t) => t.text === "C")!;
    // Rightward flow → C further right than A.
    expect(c.x).toBeGreaterThan(a.x);
  });
});

describe("sequenceDiagram", () => {
  const src = `sequenceDiagram
    participant U as User
    participant S as Server
    U->>S: GET /login
    S-->>U: 200 OK`;

  it("draws a box + dashed lifeline per participant and an arrow per message", () => {
    const build = mermaidToBoard(src);
    expect(build.family).toBe("sequence");
    const nodes = build.shapes.filter((s) => s.role === "node");
    expect(nodes).toHaveLength(2); // U, S
    const lifelines = build.shapes.filter((s) => s.role === "edge" && s.dashed && s.height > 0);
    expect(lifelines).toHaveLength(2);
    const messages = build.shapes.filter(
      (s) => s.role === "edge" && s.shape === "arrow" && s.width !== 0
    );
    expect(messages).toHaveLength(2);
    // The reply is a dashed message (-->>).
    expect(messages.some((m) => m.dashed)).toBe(true);
  });

  it("stacks messages downward", () => {
    const build = mermaidToBoard(src);
    const msgs = build.shapes
      .filter((s) => s.role === "edge" && s.shape === "arrow" && s.width !== 0)
      .sort((a, b) => a.y - b.y);
    expect(msgs[1].y).toBeGreaterThan(msgs[0].y);
  });
});

describe("classDiagram", () => {
  const src = `classDiagram
    class Animal {
      +String name
      +eat()
    }
    class Dog
    Animal <|-- Dog`;

  it("emits a box per class and an edge for the relation", () => {
    const build = mermaidToBoard(src);
    expect(build.family).toBe("class");
    expect(build.shapes.filter((s) => s.role === "node")).toHaveLength(2);
    expect(build.shapes.filter((s) => s.role === "edge")).toHaveLength(1);
  });

  it("folds class members into the node label", () => {
    const build = mermaidToBoard(src);
    const animal = build.texts.find((t) => t.text.startsWith("Animal"))!;
    expect(animal.text).toContain("name");
    expect(animal.text).toContain("eat()");
  });
});

describe("mindmap", () => {
  const src = `mindmap
  root((Photosynthesis))
    Inputs
      Sunlight
      Water
    Outputs
      Glucose`;

  it("builds a node per line and an edge per parent-child link", () => {
    const build = mermaidToBoard(src);
    expect(build.family).toBe("mindmap");
    // 6 nodes: root + Inputs + Sunlight + Water + Outputs + Glucose.
    expect(build.shapes.filter((s) => s.role === "node")).toHaveLength(6);
    // 5 edges (every non-root node has one parent link).
    expect(build.shapes.filter((s) => s.role === "edge")).toHaveLength(5);
  });

  it("places deeper nodes further right", () => {
    const build = mermaidToBoard(src);
    const labels = build.texts.filter((t) => t.role === "node");
    const root = labels.find((t) => t.text === "Photosynthesis")!;
    const leaf = labels.find((t) => t.text === "Sunlight")!;
    expect(leaf.x).toBeGreaterThan(root.x);
  });
});

describe("failure modes", () => {
  it("throws on an unsupported diagram type", () => {
    expect(() => mermaidToBoard("gantt\n  title X")).toThrow();
  });

  it("throws EmptyDiagramError when a recognized family has no nodes", () => {
    expect(() => mermaidToBoard("flowchart TD\n")).toThrow(EmptyDiagramError);
  });
});
