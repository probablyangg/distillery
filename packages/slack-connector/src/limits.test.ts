import { describe, expect, it } from "vitest";
import {
  MAX_SLACK_ATTACHMENTS,
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_TOTAL_FILE_BYTES,
  supportedSlackDocument,
  validateShortcutAttachments,
} from "./limits";

describe("Slack attachment limits", () => {
  it.each([
    [{ id: "F12345678", name: "brief.pdf" }, "pdf"],
    [{ id: "F12345678", mimetype: "application/pdf" }, "pdf"],
    [{ id: "F12345678", filetype: "docx" }, "docx"],
    [{ id: "F12345678", name: "brief.DOCX" }, "docx"],
  ] as const)("recognizes supported PDF/DOCX metadata %#", (file, kind) => {
    expect(supportedSlackDocument(file)).toBe(kind);
  });

  it("rejects more than five attachments", () => {
    const files = Array.from({ length: MAX_SLACK_ATTACHMENTS + 1 }, (_, index) => ({
      id: `F1234567${index}`,
      name: `${index}.pdf`,
      size: 100,
    }));
    expect(validateShortcutAttachments(files)).toContain("at most 5");
  });

  it("rejects one attachment above 10 MB", () => {
    expect(validateShortcutAttachments([{
      id: "F12345678",
      name: "large.pdf",
      size: MAX_SLACK_FILE_BYTES + 1,
    }])).toContain("10 MB");
  });

  it("rejects externally hosted or unfurled files even when their names look supported", () => {
    expect(validateShortcutAttachments([{
      id: "F12345678",
      name: "linked-document.pdf",
      mimetype: "application/pdf",
      is_external: true,
      mode: "external",
    }])).toContain("Unsupported attachment");
  });

  it("rejects a supported attachment set above 25 MB total", () => {
    expect(validateShortcutAttachments(Array.from({ length: 3 }, (_, index) => ({
      id: `F1234567${index}`,
      name: `${index}.pdf`,
      size: Math.floor(MAX_SLACK_TOTAL_FILE_BYTES / 3) + 1,
    })))).toContain("25 MB");
  });
});
