import type { SlackShortcutFile } from "@distillery/contracts";

export const MAX_SLACK_ATTACHMENTS = 5;
export const MAX_SLACK_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SLACK_TOTAL_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_DOCUMENT_CHARS = 200_000;

export type SupportedSlackDocument = "pdf" | "docx";

export function supportedSlackDocument(file: Pick<SlackShortcutFile, "name" | "mimetype" | "filetype" | "mode" | "is_external">): SupportedSlackDocument | null {
  const name = (file.name ?? "").toLowerCase();
  const mime = (file.mimetype ?? "").toLowerCase();
  const filetype = (file.filetype ?? "").toLowerCase();
  if (file.is_external === true || (file.mode ?? "").toLowerCase() === "external") return null;
  if (mime === "application/pdf" || filetype === "pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filetype === "docx" ||
    name.endsWith(".docx")
  ) return "docx";
  return null;
}

export function validateShortcutAttachments(files: SlackShortcutFile[]): string | null {
  if (files.length > MAX_SLACK_ATTACHMENTS) {
    return `A saved message can include at most ${MAX_SLACK_ATTACHMENTS} PDF or DOCX attachments.`;
  }
  let total = 0;
  for (const file of files) {
    if (!supportedSlackDocument(file)) {
      return `Unsupported attachment “${file.name ?? file.title ?? file.id}”. Distillery accepts only text-based PDF and DOCX files.`;
    }
    if (typeof file.size === "number") {
      if (file.size > MAX_SLACK_FILE_BYTES) {
        return `Attachment “${file.name ?? file.id}” exceeds the 10 MB per-file limit.`;
      }
      total += file.size;
    }
  }
  if (total > MAX_SLACK_TOTAL_FILE_BYTES) {
    return "The supported attachments exceed the 25 MB total download limit.";
  }
  return null;
}
