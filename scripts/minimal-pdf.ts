// DP-CORPUS §6 FM-04 fallback — vendored minimal born-digital PDF writer.
// Used because pdfkit is not installed in this environment; output is a valid
// PDF 1.4 with selectable text (Helvetica), exact first line preserved.
// Records a note: see scripts/gen-corpus.ts header.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Writes `lines` as left-aligned 12pt Helvetica text starting at the top of one A4 page. */
export function writeMinimalPdf(filePath: string, lines: string[]): void {
  const contentLines: string[] = [
    "BT",
    "/F1 12 Tf",
    "50 800 Td",
    "14 TL",
  ];
  for (const line of lines) {
    contentLines.push(`(${escapePdfText(line)}) Tj`);
    contentLines.push("T*");
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, pdf, "utf8");
}
