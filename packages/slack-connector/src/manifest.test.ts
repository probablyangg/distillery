import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("version-controlled Slack pilot configuration", () => {
  it("defines only the message shortcut and required interactivity URL", () => {
    const manifest = fs.readFileSync("config/slack/manifest.yaml", "utf8");
    expect(manifest).toContain("name: Distillery");
    expect(manifest).toContain("display_name: Distillery");
    expect(manifest).toContain("name: Save to Distillery");
    expect(manifest).toContain("type: message");
    expect(manifest).toContain("callback_id: save_to_distillery");
    expect(manifest).toContain("description: Save this message and supported attachments as evidence.");
    expect(manifest).toContain("request_url: https://distillery-v0.angela-f4b.workers.dev/api/slack/interactions");
    expect(manifest).toContain("socket_mode_enabled: false");
    expect(manifest).not.toContain("slash_commands");
    expect(manifest).not.toContain("event_subscriptions");
  });

  it("requests the bounded scopes, including read scopes needed for channel safety checks", () => {
    const manifest = fs.readFileSync("config/slack/manifest.yaml", "utf8");
    const scopes = [...manifest.matchAll(/^\s{6}- ([a-z:]+)$/gmu)].map((match) => match[1]).sort();
    expect(scopes).toEqual([
      "channels:history",
      "channels:read",
      "commands",
      "files:read",
      "groups:history",
      "groups:read",
      "reactions:write",
      "users:read",
    ]);
  });

});
