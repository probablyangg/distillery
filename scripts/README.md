# Repository scripts

Most operational scripts read `.env.local` unless noted. Never point a mutating script at production until you have checked its target and the command explicitly allows that use.

## Normal commands

| Command | Purpose | Writes external state? |
|---|---|---|
| `pnpm deploy:cloudflare` | Verify Cloudflare, create the Queue if needed, upload available secrets, deploy, apply triggers, health-check | Yes |
| `pnpm seed:stable` | Add the approved starter fixtures and starter briefs | Yes, database |
| `pnpm retrieval:backfill` | Embed missing claim/evidence/entity/schema targets | Yes unless `--dry-run` |
| `pnpm pilot:verify-schema` | Read-only PostgREST/RPC projection checks | No |
| `pnpm slack:verify` | Verify Slack token identity, users, exact scopes, and reaction names | No |
| `pnpm smoke:deployed` | Read-only deployed Worker, brief reader, and Slack-status smoke | No canonical writes |
| `pnpm test:slack-db` | Start a disposable Docker PostgreSQL instance and test all migrations/Slack invariants | Disposable local container only |

## Migration and Slack-context helpers

- `apply-latest-migration.ts`: applies the path passed as its first argument. The package command `pnpm retrieval:migrate` intentionally applies only migration `0011`; it is not a general migrator.
- `preflight-slack-context-migration.ts`: read-only checks before the live `0020`/`0021` Slack-context upgrade.
- `audit-live-slack-context.ts --channel C… --message-ts …`: read-only snapshot of one saved Slack context.
- `verify-live-slack-save.ts`: asserts source versions, roles, evidence, classification, attachment counts, extraction, and reaction state for a real save.
- `send-signed-slack-shortcut.ts`: sends a correctly signed synthetic shortcut request using real Slack identifiers. It does not prove the action is installed in Slack UI.
- `recover-live-work-item.ts`: manually claims canonical pilot work. It requires `--confirm-live` and should be used only for an identified stuck work item.
- `story-commits.sh`: optional developer tooling that asks OpenRouter to group the current working tree into a commit story, then stages and commits those groups. Use `-n` for a dry run. It sends a bounded repository diff to OpenRouter and bypasses the product model gateway because it is standalone Git tooling, not runtime or policy code.

## Destructive or live-sensitive commands

- `pnpm reset:stable` truncates tenant-scoped application data through `tenants cascade`. It preserves schema/functions but destroys pilot data. Run it only when the human explicitly names and authorizes the target database.
- `pnpm smoke:live` is a legacy direct database/model integration smoke. Its cleanup does not cover asynchronous corpus-synthesis state. Use only an isolated disposable database.
- `pnpm deploy:cloudflare`, seeding, backfill, manual recovery, and migration scripts all mutate external systems.

See the [runbook](../docs/runbooks/RUNBOOK.md) and [Slack pilot runbook](../docs/runbooks/SLACK_PILOT.md) for prerequisites and exact procedures.
