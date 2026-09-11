jest.mock("expo-print", () => ({ printToFileAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { PNG: "png" },
}));
jest.mock("../canvasCapture", () => ({ captureBoardImageForExport: jest.fn() }));

import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { ImageManipulator } from "expo-image-manipulator";
import { captureBoardImageForExport } from "../canvasCapture";
import {
  buildRecapHtml,
  recapDurationMinutes,
  buildBoardPdfHtml,
  buildImageHrefs,
  exportBoardPdf,
  exportBoardPng,
  MAX_EXPORT_PAGES,
} from "../recapExport";
import { Session } from "../../types";
import { SvgExportElement, SvgExportBounds } from "../../lib/svgExport";
import { A4 } from "../../lib/pdfTiling";

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

// --- Month 6: board export (SVG/PDF/PNG) ---

describe("buildBoardPdfHtml", () => {
  it("wraps each page's SVG in its own page div, in order", () => {
    const html = buildBoardPdfHtml(["<svg>A</svg>", "<svg>B</svg>"]);
    const pageCount = (html.match(/class="page"/g) ?? []).length;
    expect(pageCount).toBe(2);
    // Percent-encoded (not base64/btoa — see buildBoardPdfHtml's own comment
    // on why: btoa isn't assumed to exist off the web platform here), so the
    // literal SVG text is recoverable from the data URI.
    expect(html).toContain(encodeURIComponent("<svg>A</svg>"));
    expect(html).toContain(encodeURIComponent("<svg>B</svg>"));
    expect(html.indexOf(encodeURIComponent("<svg>A</svg>"))).toBeLessThan(
      html.indexOf(encodeURIComponent("<svg>B</svg>"))
    );
  });

  it("breaks the page after every tile except the last, so each SVG lands on its own printed page", () => {
    const html = buildBoardPdfHtml(["<svg>A</svg>", "<svg>B</svg>"]);
    expect(html).toContain("page-break-after: always");
    expect(html).toContain(".page:last-child { page-break-after: auto; }");
  });

  it("produces a document with no pages for an empty tile list, rather than throwing", () => {
    expect(() => buildBoardPdfHtml([])).not.toThrow();
    expect(buildBoardPdfHtml([]).match(/class="page"/g)).toBeNull();
  });
});

describe("buildImageHrefs", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete (global as any).FileReader;
  });

  function imageEl(id: string, url: string | undefined): SvgExportElement {
    return {
      kind: "image",
      data: {
        id,
        boardId: "b1",
        userId: "u1",
        storagePath: `boards/b1/images/${id}.jpg`,
        thumbnailPath: `boards/b1/images/${id}_thumb.jpg`,
        url: url as unknown as string,
        thumbnailUrl: url as unknown as string,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        naturalWidth: 10,
        naturalHeight: 10,
        alt: "",
        createdAt: new Date(),
      },
    };
  }

  function mockFileReader(resultFor: (blob: any) => string) {
    (global as any).FileReader = class {
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: string | null = null;
      readAsDataURL(blob: any) {
        this.result = resultFor(blob);
        this.onloadend?.();
      }
    };
  }

  it("fetches bytes for an image element without an override and returns them as a data URI", async () => {
    global.fetch = jest.fn(async (url: unknown) => ({
      blob: async () => ({ __url: url }),
    })) as unknown as typeof fetch;
    mockFileReader((blob) => `data:image/png;base64,FAKE(${blob.__url})`);

    const hrefs = await buildImageHrefs([imageEl("i1", "https://storage/i1.png")], undefined);

    expect(hrefs).toEqual({ i1: "data:image/png;base64,FAKE(https://storage/i1.png)" });
  });

  it("does not re-fetch an image id already covered by a caller-supplied override", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const hrefs = await buildImageHrefs(
      [imageEl("i1", "https://storage/i1.png")],
      { i1: "data:image/png;base64,ALREADY-FETCHED" }
    );

    expect(hrefs).toEqual({ i1: "data:image/png;base64,ALREADY-FETCHED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips an image element with no url instead of fetching the string 'undefined'", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const hrefs = await buildImageHrefs([imageEl("i1", undefined)], undefined);

    expect(hrefs).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves an image's id unset (falling back to its live URL) when the fetch fails, rather than throwing", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      buildImageHrefs([imageEl("i1", "https://storage/i1.png")], undefined)
    ).resolves.toEqual({});
  });

  it("never has more than IMAGE_FETCH_CONCURRENCY fetches in flight at once, for a board with many images", async () => {
    const CONCURRENCY = 4;
    const TOTAL = 10;
    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;
    const releasers: Array<() => void> = [];
    global.fetch = jest.fn(async (url: unknown) => {
      totalCalls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releasers.push(resolve));
      inFlight--;
      return { blob: async () => ({ __url: url }) } as any;
    }) as unknown as typeof fetch;
    mockFileReader((blob) => `data:image/png;base64,${blob.__url}`);

    const images = Array.from({ length: TOTAL }, (_, i) => imageEl(`i${i}`, `https://storage/i${i}.png`));
    const pending = buildImageHrefs(images, undefined);

    // Let the first wave actually start before checking anything.
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    expect(inFlight).toBeGreaterThan(0);
    expect(inFlight).toBeLessThanOrEqual(CONCURRENCY);

    // Release fetches in waves — each release lets one worker pick up its
    // next item — asserting the ceiling holds at every wave, not just the
    // first, until every image has been served. Bounded iteration count so
    // a real regression fails with a clear assertion, not a Jest timeout.
    for (let round = 0; round < TOTAL * 3 && (totalCalls < TOTAL || releasers.length > 0); round++) {
      const toRelease = releasers.splice(0, releasers.length);
      toRelease.forEach((release) => release());
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(CONCURRENCY);
    }

    const hrefs = await pending;
    expect(totalCalls).toBe(TOTAL);
    expect(Object.keys(hrefs)).toHaveLength(TOTAL);
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
  });
});

describe("exportBoardPdf", () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  const pathEl: SvgExportElement = {
    kind: "path",
    data: {
      id: "p1",
      boardId: "b1",
      userId: "u1",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      color: "#000000",
      strokeWidth: 2,
      tool: "pen",
      createdAt: new Date(),
    },
  };

  it("tiles a wide board into A4-sized pages and shares the resulting PDF (native)", async () => {
    Platform.OS = "ios";
    (Print.printToFileAsync as jest.Mock).mockResolvedValue({ uri: "file:///cache/board.pdf" });
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);

    const bounds: SvgExportBounds = { x: 0, y: 0, width: 2000, height: 500 };
    await exportBoardPdf([pathEl], bounds, { title: "My Board" });

    expect(Print.printToFileAsync).toHaveBeenCalledWith(
      expect.objectContaining({ width: A4.width, height: A4.height })
    );
    const html = (Print.printToFileAsync as jest.Mock).mock.calls[0][0].html as string;
    // ceil(2000 / 595) = 4 columns, 1 row — a page per tile, not per element.
    expect((html.match(/class="page"/g) ?? []).length).toBe(4);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      "file:///cache/board.pdf",
      expect.objectContaining({ mimeType: "application/pdf", dialogTitle: "My Board — Export" })
    );
  });

  it("opens a print window instead of calling expo-print on web", async () => {
    Platform.OS = "web";
    const win = { document: { write: jest.fn(), close: jest.fn() }, focus: jest.fn(), print: jest.fn() };
    (global as any).window = { open: jest.fn(() => win) };

    await exportBoardPdf([pathEl], { x: 0, y: 0, width: 300, height: 300 });

    expect(win.document.write).toHaveBeenCalled();
    expect(win.print).toHaveBeenCalled();
    expect(Print.printToFileAsync).not.toHaveBeenCalled();

    delete (global as any).window;
  });

  it("throws naming the page-count limit instead of attempting an oversized export, before fetching any images", async () => {
    Platform.OS = "ios";
    const fetchMock = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    // One column too many past the limit — width chosen so tilePages
    // produces exactly MAX_EXPORT_PAGES + 1 single-row pages.
    const bounds: SvgExportBounds = { x: 0, y: 0, width: A4.width * (MAX_EXPORT_PAGES + 1), height: 100 };
    const imageEl: SvgExportElement = {
      kind: "image",
      data: {
        id: "i1",
        boardId: "b1",
        userId: "u1",
        storagePath: "boards/b1/images/i1.jpg",
        thumbnailPath: "boards/b1/images/i1_thumb.jpg",
        url: "https://storage/i1.png",
        thumbnailUrl: "https://storage/i1.png",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        naturalWidth: 10,
        naturalHeight: 10,
        alt: "",
        createdAt: new Date(),
      },
    };

    await expect(exportBoardPdf([pathEl, imageEl], bounds)).rejects.toThrow(
      new RegExp(`${MAX_EXPORT_PAGES}-page`)
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Print.printToFileAsync).not.toHaveBeenCalled();

    global.fetch = originalFetch;
  });
});

describe("exportBoardPng", () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  it("converts the captured data URL to a real local file and shares that (Sharing.shareAsync needs a file URI, not a data: URI)", async () => {
    Platform.OS = "ios";
    (captureBoardImageForExport as jest.Mock).mockResolvedValue("data:image/png;base64,AAAA");
    const renderAsync = jest.fn().mockResolvedValue({
      saveAsync: jest.fn().mockResolvedValue({ uri: "file:///cache/board.png" }),
    });
    (ImageManipulator.manipulate as jest.Mock).mockReturnValue({ renderAsync });
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);

    await exportBoardPng(null, { title: "My Board" });

    expect(ImageManipulator.manipulate).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      "file:///cache/board.png",
      expect.objectContaining({ mimeType: "image/png", dialogTitle: "My Board — Export" })
    );
  });

  it("triggers a browser download on web instead of the native share sheet", async () => {
    Platform.OS = "web";
    (captureBoardImageForExport as jest.Mock).mockResolvedValue("data:image/png;base64,BBBB");
    const link = { click: jest.fn(), href: "", download: "" };
    const appendChild = jest.fn();
    const removeChild = jest.fn();
    (global as any).document = {
      createElement: jest.fn(() => link),
      body: { appendChild, removeChild },
    };

    await exportBoardPng(null, { title: "My Board" });

    expect(link.href).toBe("data:image/png;base64,BBBB");
    expect(link.download).toBe("My-Board.png");
    expect(link.click).toHaveBeenCalled();
    expect(ImageManipulator.manipulate).not.toHaveBeenCalled();

    delete (global as any).document;
  });

  it("throws rather than silently no-oping when capture fails", async () => {
    Platform.OS = "ios";
    (captureBoardImageForExport as jest.Mock).mockResolvedValue(null);

    await expect(exportBoardPng(null)).rejects.toThrow(/PNG export failed/);
  });
});
