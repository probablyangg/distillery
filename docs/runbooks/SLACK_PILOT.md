# Slack private-pilot setup

This runbook installs and verifies the single-workspace **Save to Distillery** message shortcut.

The shortcut saves the selected message as primary evidence inside a bounded conversation snapshot. It captures the channel profile, a complete bounded thread or a small model-selected nearby set, and up to five text-based PDF or DOCX files. Every message remains separate immutable evidence; Distillery does not concatenate several authors into one document. PostgreSQL is the duplicate check. The built-in `:hourglass_flowing_sand:` reaction appears immediately after registration. The worker replaces it with `:factory:` (🏭) only after context extraction completes.

Thread capture is limited to 50 messages and 40,000 normalized characters. A non-thread capture considers at most five messages before and three after within 30 minutes; the model may retain at most four known candidates, and failure retains none. Because a click can capture other authors' nearby or threaded text, use the shortcut only where contextual collection is expected and review channel membership before enabling the app.

## 1. Deploy the database and Worker

Apply every unapplied migration in order, including `0020_context_aware_slack_ingestion.sql` and `0021_slack_unchanged_refresh_reaction_sync.sql`, before deploying the Worker. Never reset or reseed the pilot database for this upgrade. Before the migration, run the read-only preflight:

```bash
pnpm exec tsx scripts/preflight-slack-context-migration.ts
```

The live interactivity URL in the manifest is:

```text
https://distillery-v0.angela-f4b.workers.dev/api/slack/interactions
```

The endpoint is public because Slack must reach it. It accepts only correctly signed Slack form requests. Workspace and user allowlists, bot membership, and the Slack Connect opt-in then fail closed. Ordinary workspace channels do not use a general channel allowlist.

## 2. Create or update the Slack app

1. Sign in to [Slack API apps](https://api.slack.com/apps) as a workspace administrator.
2. Choose **Create New App** and **From an app manifest**, or open the existing Distillery app and use its manifest editor.
3. Select the pilot workspace.
4. Paste [`config/slack/manifest.yaml`](../../config/slack/manifest.yaml), review the changes, and create or update the app.
5. Confirm **Socket Mode** is off, **Interactivity** is on, there are no slash commands, and there are no subscribed events.
6. Install or reinstall the app to the workspace after any scope change.
7. When the workspace administration plan supports app restrictions, limit Distillery to the intended leadership pilot group.

The manifest requests the required scopes from the pilot objective. It also requests:

- `channels:read`, so executable code can confirm the bot is a member of a public channel;
- `groups:read`, for the same checks in private channels.

Those checks are required to reject channels where Distillery is not a member. No broader history or administration scope is requested.

## 3. Confirm the reaction lifecycle

Distillery uses Slack's built-in `:hourglass_flowing_sand:` and `:factory:` emoji. No custom emoji upload and no `emoji:read` scope are required. An existing manual reaction never bypasses PostgreSQL persistence. Slack's idempotent `already_reacted` and `no_reaction` results are treated as success.

## 4. Collect configuration without sharing secrets

From **Basic Information**, copy the app signing secret. From **OAuth & Permissions**, copy the bot token beginning with `xoxb-`.

`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are secrets. The workspace and user IDs and the saved reaction name are non-secret configuration, but the deployment helper stores them as encrypted Worker secrets so the connector follows one fail-closed mechanism. The processing reaction is a non-secret Worker variable fixed to `hourglass_flowing_sand`.

Find Slack IDs through Slack's **View profile** menu. Configure the workspace and at least one invoking user:

```text
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_ALLOWED_TEAM_ID=T...
SLACK_ALLOWED_USER_IDS=U...,U...
SLACK_ALLOWED_EXTERNAL_CHANNEL_IDS=C0BG2JXTG77
SLACK_SAVED_REACTION=factory
SLACK_PROCESSING_REACTION=hourglass_flowing_sand
SLACK_CONTEXT_MODEL=
```

Put these values in `.env.local` for deployment/verification and in `apps/web/.dev.vars` only for local Wrangler development. Never commit either file or paste the values into chat, logs, a manifest, or `wrangler.toml`.

The app may save from an ordinary public/private channel in the allowlisted workspace when it is a member. Direct messages and group direct messages remain blocked. Slack Connect channels are blocked by default even when the bot is a member. The deployed pilot explicitly opts in only `#stablepay-war-room` (`C0BG2JXTG77`). Add the app through **Integrations → Add apps** or mention `@Distillery` and follow Slack's prompt.

`SLACK_CONTEXT_MODEL` is optional. When empty, selection and classification use the configured extractor model and existing `OPENROUTER_API_KEY`. No new model key or provider is needed.

Supported PDF/DOCX files are limited to five files, 10 MB per file, 25 MB total download, and 200,000 extracted characters per document. External files are not downloaded. Image-only PDFs fail safely because the connector does not run OCR.

## 5. Upload secrets and verify Slack state

The deployment helper uploads locally available secrets and preserves Slack secrets already configured in the Worker:

```bash
pnpm deploy:cloudflare
```

Then run the read-only Slack verification:

```bash
pnpm slack:verify
pnpm smoke:deployed
```

It fails clearly unless:

- the bot token belongs to the allowlisted workspace;
- every allowlisted user resolves;
- the token has exactly the eight scopes in the manifest;
- the configured reactions are exactly Slack's built-in `:hourglass_flowing_sand:` and `:factory:` emoji.
- the deployed authenticated status reports `C0BG2JXTG77` as the intended Slack Connect opt-in (`pnpm smoke:deployed`).

The command never prints the bot token or signing secret.

## 6. Exact human click test

Use a new harmless thread, or a designated existing test thread, in `#stablepay-war-room` from an allowlisted user. Contextual capture reads more than the clicked message: it reads the channel name/topic/purpose and either the bounded thread or selected nearby messages. Do not use private business content unless the human explicitly selected it for this test.

1. Post a root message containing a distinctive test sentence and at least one harmless reply. Optionally attach one small text-based PDF/DOCX and one harmless screenshot to verify skip behavior.
2. Hover over or right-click that message.
3. Choose **More actions**. If Slack has not pinned the shortcut yet, choose **Connect to apps…**, select **Distillery**, then **Save to Distillery**.
4. Confirm the action returns promptly and no public channel message appears.
5. Confirm `:hourglass_flowing_sand:` appears immediately.
6. Confirm the hourglass disappears and `:factory:` appears only after context extraction finishes.
7. Inspect PostgreSQL: the channel profile, root, selected message, replies, roles, exact authors/timestamps/permalinks, classification, and evidence citations must be present. A screenshot/video must appear only in `skipped_attachments`; its contents must not be claimed as analyzed.
8. Repeat **Save to Distillery** without changing the thread. Confirm no duplicate source version, evidence, context event, or extraction work appears.
9. Add a harmless reply, save again, and confirm context version 2 links to version 1 while version 1 remains unchanged.
10. Remove the factory reaction and repeat the shortcut. Confirm reaction synchronization does not duplicate canonical ingestion.
11. Open `/briefs` after downstream synthesis creates a generated brief. Confirm each citation shows exact source text and opens the correct Slack message or file.

Use the read-only audit helper to inspect one saved context without copying raw database queries into a terminal history:

```bash
pnpm exec tsx scripts/audit-live-slack-context.ts \
  --channel C01234567 \
  --message-ts 1752624000.000001
```

Also test a direct message, nonmember channel, or denied user. The invoker should receive a private error or no successful reaction, with no source data committed.

Do not call the feature fully live-verified until a real Slack shortcut click succeeds. A correctly signed synthetic request can verify the deployed endpoint and worker path, but it does not prove that Slack installed and exposed the action in the workspace UI.

When a live click is temporarily unavailable, send a signed request only with identifiers from a real eligible Slack message:

```bash
pnpm slack:test-signed -- \
  --channel C01234567 \
  --message-ts 1752624000.000001 \
  --author-user U01234567 \
  --invoking-user U01234567
```

This command reads the signing secret locally, never prints it, and sends the same form and signature shape as Slack. Afterward, verify the canonical source/evidence rows and the reaction. This remains a deployed-path test, not an installation UI test.
