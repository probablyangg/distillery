import { describe, expect, it } from "vitest";
import { parseDocxDocument, parsePdfDocument } from "./documents";

describe("real Worker-compatible document parser integration", () => {
  it("extracts real PDF text with a page locator", async () => {
    const result = await parsePdfDocument({
      bytes: minimalTextPdf("Leadership approved the private pilot launch."),
      sourceVersionId: "srcv_real_pdf",
      permalink: "https://example.slack.com/files/F12345678",
      newSpanId: () => "span_real_pdf",
    });
    expect(result.content).toContain("Leadership approved the private pilot launch.");
    expect(result.structure.pageCount).toBe(1);
    expect(result.evidenceSpans[0]?.locator).toMatchObject({ pageNumber: 1 });
    for (const span of result.evidenceSpans) {
      expect(result.content.slice(span.startChar, span.endChar)).toBe(span.text);
    }
  });

  it("extracts real DOCX paragraphs with exact paragraph locators", async () => {
    const result = await parseDocxDocument({
      bytes: minimalDocx([
        "Leadership approved the private pilot launch.",
        "The Slack administrator owns installation.",
      ]),
      sourceVersionId: "srcv_real_docx",
      permalink: "https://example.slack.com/files/F87654321",
      newSpanId: (() => { let id = 0; return () => `span_real_docx_${++id}`; })(),
    });
    expect(result.content).toBe(
      "Leadership approved the private pilot launch.\n\nThe Slack administrator owns installation.",
    );
    expect(result.structure.paragraphCount).toBe(2);
    expect(result.evidenceSpans.map((span) => span.locator?.paragraphNumber)).toEqual([1, 2]);
    for (const span of result.evidenceSpans) {
      expect(result.content.slice(span.startChar, span.endChar)).toBe(span.text);
    }
  });
});

function minimalTextPdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function minimalDocx(paragraphs: string[]): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`)
    .join("")}<w:sectPr/></w:body></w:document>`;
  return storeZip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`],
    ["word/document.xml", documentXml],
  ]);
}

function storeZip(entries: Array<[string, string]>): Uint8Array {
  const encoded = entries.map(([name, value]) => ({
    name: new TextEncoder().encode(name),
    data: new TextEncoder().encode(value),
  }));
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of encoded) {
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + entry.name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    local.set(entry.data, 30 + entry.name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, entry.name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(entry.name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, encoded.length, true);
  endView.setUint16(10, encoded.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
