import { describe, expect, it } from "vitest";
import type { SlackMessage } from "./client";
import {
  MAX_SLACK_CONTEXT_MESSAGES,
  boundThreadMessages,
  defaultSlackClassification,
  nearbyMessageCandidates,
  normalizedSlackMessageContent,
} from "./context";

describe("Slack context selection bounds", () => {
  it("keeps a thread chronological and retains the root, selected reply, earliest context, and recent replies", () => {
    const messages = Array.from({ length: 60 }, (_, index) => message(1_752_624_000 + index, `Reply ${index}`));
    const bounded = boundThreadMessages({
      messages: [...messages].reverse(),
      rootTimestamp: messages[0]!.ts,
      selectedTimestamp: messages[24]!.ts,
    });

    expect(bounded.messages).toHaveLength(MAX_SLACK_CONTEXT_MESSAGES);
    expect(bounded.messages[0]?.ts).toBe(messages[0]?.ts);
    expect(bounded.messages.some((item) => item.ts === messages[24]?.ts)).toBe(true);
    expect(bounded.messages.at(-1)?.ts).toBe(messages.at(-1)?.ts);
    expect(bounded.messages.map((item) => Number.parseFloat(item.ts))).toEqual(
      [...bounded.messages].map((item) => Number.parseFloat(item.ts)).sort((left, right) => left - right),
    );
    expect(bounded.truncation).toMatchObject({
      truncated: true,
      messageLimitApplied: true,
      originalMessageCount: 60,
      retainedMessageCount: 50,
    });
  });

  it("applies the 40,000-character bound without dropping the selected message or root", () => {
    const messages = Array.from({ length: 12 }, (_, index) => message(
      1_752_624_000 + index,
      `${index}:${"x".repeat(5_000)}`,
    ));
    const bounded = boundThreadMessages({
      messages,
      rootTimestamp: messages[0]!.ts,
      selectedTimestamp: messages[5]!.ts,
    });
    expect(bounded.messages.some((item) => item.ts === messages[0]?.ts)).toBe(true);
    expect(bounded.messages.some((item) => item.ts === messages[5]?.ts)).toBe(true);
    expect(bounded.truncation.characterLimitApplied).toBe(true);
    expect(bounded.truncation.retainedCharacterCount).toBeLessThanOrEqual(40_000);
  });

  it("offers at most five preceding and three following top-level messages within thirty minutes", () => {
    const selected = 1_752_624_000;
    const candidates = nearbyMessageCandidates([
      ...Array.from({ length: 8 }, (_, index) => message(selected - 480 + index * 60, `Before ${index}`)),
      ...Array.from({ length: 6 }, (_, index) => message(selected + 60 + index * 60, `After ${index}`)),
      { ...message(selected - 30, "Thread reply"), thread_ts: timestamp(selected - 60) },
      { ...message(selected - 20, "Joined"), subtype: "channel_join" },
      message(selected - 1_900, "Too old"),
    ], timestamp(selected));
    expect(candidates.filter((item) => Number.parseFloat(item.ts) < selected)).toHaveLength(5);
    expect(candidates.filter((item) => Number.parseFloat(item.ts) > selected)).toHaveLength(3);
    expect(candidates.some((item) => item.text === "Joined" || item.text === "Too old" || item.text === "Thread reply")).toBe(false);
  });

  it("preserves app block and unfurl text without duplicating the primary text", () => {
    const value = message(1_752_624_000, "PAY-1719 moved to Done");
    value.blocks = [{ type: "section", text: { type: "mrkdwn", text: "PAY-1719 moved to Done" } }];
    value.attachments = [{ title: "PAY-1719", text: "Payment issue lifecycle event" }];
    expect(normalizedSlackMessageContent(value)).toBe(
      "PAY-1719 moved to Done\n\nPAY-1719\n\nPayment issue lifecycle event",
    );
    expect(defaultSlackClassification([value.text]).identities.issueTicketIds).toEqual(["PAY-1719"]);
  });
});

function message(seconds: number, text: string): SlackMessage {
  return {
    type: "message",
    ts: timestamp(seconds),
    user: "U12345678",
    text,
    files: [],
    blocks: [],
    attachments: [],
  };
}

function timestamp(seconds: number): string {
  return `${Math.floor(seconds)}.000001`;
}
