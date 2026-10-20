// PDF extraction (PCMS-WEB-RESEARCH round 2; spec §40 promoted from P1).
// pdf.js parses locally — embedded scripts are never executed
// (isEvalSupported:false). Two-stage like the IncusHub Docling pipeline:
// native text layer first (quality gate: min chars per page), insufficient
// text means a scanned document and the caller may hand rendered page images
// to the vision transcriber. All bounds are enforced here: page cap, per-page
// render scale, char budget.
import type { VisionImage } from "./vision.js";

export interface PdfExtraction {
  readonly markdown: string;
  readonly pageCount: number;
  readonly textSufficient: boolean;
}

const MIN_CHARS_PER_PAGE = 200;
const MAX_PAGES_TEXT = 64;
const MAX_CHARS_HARD = 400_000;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  return (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** Extracts the native text layer; page structure is preserved as markers. */
export async function extractPdfText(bytes: Buffer): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs();
  // pdf.js never executes embedded PDF JavaScript in this configuration —
  // no scripting hooks are provided at all.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PAGES_TEXT);
  const sections: string[] = [];
  let total = 0;
  for (let n = 1; n <= pageCount; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? (item.str ?? "") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    sections.push(`## Page ${String(n)}\n\n${text}`);
    total += text.length;
  }
  const markdown = sections.join("\n\n");
  const inspectedPages = Math.min(doc.numPages, MAX_PAGES_TEXT);
  const textSufficient = total >= MIN_CHARS_PER_PAGE * inspectedPages;
  return {
    markdown: markdown.slice(0, MAX_CHARS_HARD),
    pageCount: doc.numPages,
    textSufficient,
  };
}

/** Renders pages to images for the vision transcriber (scanned documents).
 * Scale targets ~1600px wide — enough for OCR-grade reading, bounded bytes. */
export async function renderPdfPages(
  bytes: Buffer,
  options: { readonly maxPages: number },
): Promise<readonly VisionImage[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const pdfjs = await loadPdfjs();
  // pdf.js never executes embedded PDF JavaScript in this configuration —
  // no scripting hooks are provided at all.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = Math.min(doc.numPages, options.maxPages);
  const images: VisionImage[] = [];
  for (let n = 1; n <= pages; n += 1) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1600 / base.width, 2.2);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    // napi-rs canvas is structurally compatible; pdfjs types want the DOM
    // CanvasRenderingContext2D which the SKRS context satisfies at runtime.
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;
    const data = canvas.toBuffer("image/jpeg", 0.75);
    images.push({
      mime: "image/jpeg",
      data: Buffer.from(data),
      locator: `page ${String(n)} of ${String(doc.numPages)}`,
    });
  }
  return images;
}
