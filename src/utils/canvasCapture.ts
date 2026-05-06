import { Platform } from "react-native";

const MAX_EDGE = 1024;
const MAX_DATA_URL_BYTES = 900_000;

export async function captureSvgAsPng(
  svgEl: SVGSVGElement | null | undefined,
  maxEdge: number = MAX_EDGE
): Promise<string | null> {
  if (Platform.OS !== "web") return null;
  if (!svgEl || typeof window === "undefined") return null;

  try {
    const rect = svgEl.getBoundingClientRect();
    const srcWidth =
      Number(svgEl.getAttribute("width")) || rect.width || 800;
    const srcHeight =
      Number(svgEl.getAttribute("height")) || rect.height || 600;

    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(srcWidth));
    clone.setAttribute("height", String(srcHeight));

    const svgString = new XMLSerializer().serializeToString(clone);
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
    const fullSvg = xmlHeader + svgString;
    const encoded = btoa(unescape(encodeURIComponent(fullSvg)));
    const svgDataUrl = `data:image/svg+xml;base64,${encoded}`;

    const img: HTMLImageElement = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("svg image load failed"));
      i.src = svgDataUrl;
    });

    const longest = Math.max(srcWidth, srcHeight);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      console.warn(
        `[canvasCapture] PNG data URL too large (${dataUrl.length} bytes), skipping snapshot.`
      );
      return null;
    }
    return dataUrl;
  } catch (err) {
    console.warn("[canvasCapture] capture failed:", err);
    return null;
  }
}
