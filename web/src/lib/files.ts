// Read uploaded files as text in the browser. We keep the extracted text,
// not the file itself, so nothing large is stored.

export const ACCEPTED_FILES = ".txt,.md,.markdown,.csv,.json,.docx,.pdf";
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function readFileText(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 15 MB.`);
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth/mammoth.browser");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return value.trim();
  }
  if (name.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    const text = pages.join("\n\n").trim();
    if (!text) throw new Error(`${file.name} has no selectable text (it may be a scanned image).`);
    return text;
  }
  if (/\.(txt|md|markdown|csv|json)$/.test(name)) return (await file.text()).trim();
  throw new Error(`${file.name} isn't a supported file. Use .txt, .md, .docx or .pdf.`);
}
