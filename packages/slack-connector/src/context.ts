import type {
  SlackConversationClassification,
  SlackContextTruncation,
} from "@distillery/contracts";
import type { SlackMessage } from "./client";

export const SLACK_CONTEXT_SELECTION_VERSION = "slack-context-v1";
export const MAX_SLACK_CONTEXT_MESSAGES = 50;
export const MAX_SLACK_CONTEXT_CHARS = 40_000;
export const NEARBY_WINDOW_SECONDS = 30 * 60;
export const MAX_NEARBY_BEFORE = 5;
export const MAX_NEARBY_AFTER = 3;
export const MAX_SELECTED_NEARBY = 4;

export type SlackContextMessage = {
  message: SlackMessage;
  content: string;
};

export function normalizedSlackMessageContent(message: SlackMessage): string {
  const parts = [message.text.trim()];
  for (const block of message.blocks) collectSlackText(block, parts);
  for (const attachment of message.attachments) collectSlackText(attachment, parts);
  const seen = new Set<string>();
  return parts
    .map((part) => part.replace(/\r\n?/gu, "\n").trim())
    .filter((part) => part.length > 0 && !seen.has(part) && seen.add(part))
    .join("\n\n");
}

export function isSlackSystemMessage(message: SlackMessage): boolean {
  if (!message.subtype) return false;
  return [
    "channel_archive",
    "channel_join",
    "channel_leave",
    "channel_name",
    "channel_purpose",
    "channel_topic",
    "group_archive",
    "group_join",
    "group_leave",
    "message_deleted",
    "tombstone",
  ].includes(message.subtype);
}

export function nearbyMessageCandidates(
  messages: SlackMessage[],
  selectedTimestamp: string,
): SlackMessage[] {
  const selected = Number.parseFloat(selectedTimestamp);
  const eligible = messages
    .filter((message) => !message.thread_ts)
    .filter((message) => !isSlackSystemMessage(message))
    .filter((message) => Math.abs(Number.parseFloat(message.ts) - selected) <= NEARBY_WINDOW_SECONDS)
    .sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
  const preceding = eligible.filter((message) => Number.parseFloat(message.ts) < selected).slice(-MAX_NEARBY_BEFORE);
  const following = eligible.filter((message) => Number.parseFloat(message.ts) > selected).slice(0, MAX_NEARBY_AFTER);
  return [...preceding, ...following];
}

export function boundThreadMessages(input: {
  messages: SlackMessage[];
  selectedTimestamp: string;
  rootTimestamp: string;
}): { messages: SlackMessage[]; truncation: SlackContextTruncation } {
  const ordered = [...new Map(input.messages.map((message) => [message.ts, message])).values()]
    .sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
  const contentByTimestamp = new Map(ordered.map((message) => [message.ts, normalizedSlackMessageContent(message)]));
  const originalCharacterCount = [...contentByTimestamp.values()].reduce((sum, content) => sum + content.length, 0);
  const requiresTruncation = ordered.length > MAX_SLACK_CONTEXT_MESSAGES || originalCharacterCount > MAX_SLACK_CONTEXT_CHARS;
  if (!requiresTruncation) {
    return {
      messages: ordered,
      truncation: {
        truncated: false,
        messageLimitApplied: false,
        characterLimitApplied: false,
        originalMessageCount: ordered.length,
        retainedMessageCount: ordered.length,
        originalCharacterCount,
        retainedCharacterCount: originalCharacterCount,
        omittedMessageTimestamps: [],
      },
    };
  }

  const retained = new Map<string, SlackMessage>();
  let retainedCharacters = 0;
  const add = (message: SlackMessage, required = false): boolean => {
    if (retained.has(message.ts)) return true;
    const contentLength = contentByTimestamp.get(message.ts)?.length ?? 0;
    if (!required && (retained.size >= MAX_SLACK_CONTEXT_MESSAGES || retainedCharacters + contentLength > MAX_SLACK_CONTEXT_CHARS)) {
      return false;
    }
    retained.set(message.ts, message);
    retainedCharacters += contentLength;
    return true;
  };
  const root = ordered.find((message) => message.ts === input.rootTimestamp);
  const selected = ordered.find((message) => message.ts === input.selectedTimestamp);
  if (root) add(root, true);
  if (selected) add(selected, true);

  const remaining = ordered.filter((message) => !retained.has(message.ts));
  const earliestTarget = Math.floor((MAX_SLACK_CONTEXT_MESSAGES - retained.size) / 2);
  let earliestAdded = 0;
  for (const message of remaining) {
    if (earliestAdded >= earliestTarget) break;
    if (add(message)) earliestAdded += 1;
  }
  for (const message of [...remaining].reverse()) add(message);

  const messages = [...retained.values()].sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
  return {
    messages,
    truncation: {
      truncated: true,
      messageLimitApplied: ordered.length > MAX_SLACK_CONTEXT_MESSAGES,
      characterLimitApplied: originalCharacterCount > MAX_SLACK_CONTEXT_CHARS,
      originalMessageCount: ordered.length,
      retainedMessageCount: messages.length,
      originalCharacterCount,
      retainedCharacterCount: retainedCharacters,
      omittedMessageTimestamps: ordered.filter((message) => !retained.has(message.ts)).map((message) => message.ts),
    },
  };
}

export function defaultSlackClassification(texts: string[]): SlackConversationClassification {
  return {
    category: "unknown",
    rationale: "Classification model was unavailable or returned invalid output.",
    identities: {
      products: [],
      featureComponents: [],
      externalServices: [],
      issueTicketIds: parseIssueTicketIds(texts),
      releaseVersions: [],
      environments: [],
      namedOrganizations: [],
    },
  };
}

export function mergeDeterministicSlackIdentities(
  classification: SlackConversationClassification,
  texts: string[],
): SlackConversationClassification {
  return {
    ...classification,
    identities: {
      ...classification.identities,
      issueTicketIds: [...new Set([...classification.identities.issueTicketIds, ...parseIssueTicketIds(texts)])],
    },
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseIssueTicketIds(texts: string[]): string[] {
  const matches = texts.flatMap((text) => text.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,15}-\d{1,10}\b/gu) ?? []);
  return [...new Set(matches)].sort();
}

function collectSlackText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSlackText(item, output);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && ["text", "title", "pretext", "fallback", "author_name", "footer"].includes(key)) {
      output.push(item);
    } else if (typeof item === "object" && item !== null) {
      collectSlackText(item, output);
    }
  }
}
