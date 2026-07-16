# Slack private-pilot setup

This runbook installs and verifies the single-workspace **Save to Distillery** message shortcut.

The shortcut saves one selected message. It does not ingest the rest of the thread. It also saves up to five attached, text-based PDF or DOCX files. PostgreSQL is the duplicate check. The built-in `:hourglass_flowing_sand:` reaction appears immediately after registration. The worker replaces it with `:factory:` (🏭) only after extraction completes for the message and every supported attachment.

## 1. Deploy the database and Worker

Apply every unapplied migration in order, including `0018_slack_connector_and_brief_reader.sql`, before deploying the Worker.

The live interactivity URL in the manifest is:

```text
https://distillery-v0.angela-f4b.workers.dev/api/slack/interactions
```

The endpoint is public because Slack must reach it. It accepts only correctly signed Slack form requests. Workspace, channel, and user allowlists then fail closed.

## 2. Create or update the Slack app

1. Sign in to [Slack API apps](https://api.slack.com/apps) as a workspace administrator.
2. Choose **Create New App** and **From an app manifest**, or open the existing Distillery app and use its manifest editor.
3. Select the pilot workspace.
4. Paste [`config/slack/manifest.yaml`](../../config/slack/manifest.yaml), review the changes, and create or update the app.
5. Confirm **Socket Mode** is off, **Interactivity** is on, there are no slash commands, and there are no subscribed events.
6. Install or reinstall the app to the workspace after any scope change.
7. When the workspace administration plan supports app restrictions, limit Distillery to the intended leadership pilot group.

The manifest requests the required scopes from the pilot objective. It also requests:

- `channels:read`, so executable code can confirm a public channel is not externally shared and the bot is a member;
- `groups:read`, for the same checks in private channels.

Those checks are required to reject Slack Connect and channels where Distillery is not a member. No broader history or administration scope is requested.

## 3. Confirm the reaction lifecycle

Distillery uses Slack's built-in `:hourglass_flowing_sand:` and `:factory:` emoji. No custom emoji upload and no `emoji:read` scope are required. An existing manual reaction never bypasses PostgreSQL persistence. Slack's idempotent `already_reacted` and `no_reaction` results are treated as success.

## 4. Collect configuration without sharing secrets

From **Basic Information**, copy the app signing secret. From **OAuth & Permissions**, copy the bot token beginning with `xoxb-`.

`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are secrets. The workspace, channel, and user IDs and the saved reaction name are non-secret configuration, but the deployment helper stores them as encrypted Worker secrets so the connector follows one fail-closed mechanism. The processing reaction is a non-secret Worker variable fixed to `hourglass_flowing_sand`.

Find Slack IDs through Slack's **Copy link** or **View profile** menus. Configure at least one channel and one invoking user:

```text
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_ALLOWED_TEAM_ID=T...
SLACK_ALLOWED_CHANNEL_IDS=C...,C...
SLACK_ALLOWED_USER_IDS=U...,U...
SLACK_SAVED_REACTION=factory
SLACK_PROCESSING_REACTION=hourglass_flowing_sand
```

Put these values in `.env.local` for deployment/verification and in `apps/web/.dev.vars` only for local Wrangler development. Never commit either file or paste the values into chat, logs, a manifest, or `wrangler.toml`.

The app must be invited to every allowlisted channel. In each channel, use **Integrations → Add apps**, or mention `@Distillery` and follow Slack's prompt.

## 5. Upload secrets and verify Slack state

The normal deployment helper uploads all app, database, model, and Slack runtime secrets:

```bash
pnpm deploy:cloudflare
```

Then run the read-only Slack verification:

```bash
pnpm slack:verify
```

It fails clearly unless:

- the bot token belongs to the allowlisted workspace;
- every allowlisted channel is neither a DM nor Slack Connect;
- the bot is a member of every allowlisted channel;
- every allowlisted user resolves;
- the configured reactions are exactly Slack's built-in `:hourglass_flowing_sand:` and `:factory:` emoji.

The command never prints the bot token or signing secret.

## 6. Exact human click test

Use a new, harmless message in one allowlisted channel from an allowlisted user.

1. Post a message containing a distinctive decision sentence. Optionally attach one small, text-based PDF or DOCX.
2. Hover over or right-click that message.
3. Choose **More actions**. If Slack has not pinned the shortcut yet, choose **Connect to apps…**, select **Distillery**, then **Save to Distillery**.
4. Confirm the action returns promptly and no public channel message appears.
5. Confirm `:hourglass_flowing_sand:` appears immediately.
6. Confirm the hourglass disappears and `:factory:` appears only after the message and every supported attachment finish extraction.
7. Repeat **Save to Distillery**. Confirm no duplicate source, version, evidence, or extraction work appears.
8. Remove the factory reaction and repeat the shortcut. Confirm it returns without a second ingestion.
8. Open `/briefs` after downstream synthesis creates a generated brief. Confirm the citation shows exact source text and opens the Slack message or file.

Also test one denied channel or denied user. The invoker should receive a private error, with no source data and no reaction.

Do not call the feature fully live-verified until a real Slack shortcut click succeeds. A correctly signed synthetic request can verify the deployed endpoint and worker path, but it does not prove that Slack installed and exposed the action in the workspace UI.

When a live click is temporarily unavailable, send a signed request only with identifiers from a real allowlisted Slack message:

```bash
pnpm slack:test-signed -- \
  --channel C01234567 \
  --message-ts 1752624000.000001 \
  --author-user U01234567 \
  --invoking-user U01234567
```

This command reads the signing secret locally, never prints it, and sends the same form and signature shape as Slack. Afterward, verify the canonical source/evidence rows and the reaction. This remains a deployed-path test, not an installation UI test.
