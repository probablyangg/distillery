# Distillery Worker

`apps/web/src/index.ts` is the deployed Cloudflare Worker. It serves four HTML surfaces, authenticated JSON APIs, the public Slack interaction receiver, the Queue consumer, and the one-minute scheduled handler.

Start with the repository [codebase guide](../../docs/reference/CODEBASE_GUIDE.md). The complete endpoint list and operational commands are in the [runbook](../../docs/runbooks/RUNBOOK.md#api-reference).

## Runtime responsibilities

- `fetch`: public health/Slack routes, shared-password login, HTML shells, authenticated APIs.
- `queue`: claims canonical `pending_work` by `workItemId`, executes one policy, then gives downstream outbox events a bounded routing pass.
- `scheduled`: recovers expired leases, requeues canonical work, schedules bounded synthesis scans, and drains a bounded outbox batch.

The Worker is composition code. Domain rules should stay in packages, model calls in `@distillery/model-gateway`, and atomic persistence rules in ordered SQL migrations.

## Public versus authenticated routes

Public:

- `GET /health`;
- HTML shells at `/`, `/synthesis`, `/graph`, `/briefs`, and `/briefs/{id}`;
- `GET /assets/d3-local.js`;
- `POST /login` and `POST /logout`;
- signed `POST /api/slack/interactions`.

All other `/api/*` routes require the 30-day shared-password session cookie. HTML shells are public so they can render the login state; their data APIs remain protected.

## Configuration

- Non-secret variables and Queue/Cron bindings: `apps/web/wrangler.toml`.
- Local Worker secrets: `apps/web/.dev.vars`, copied from `.dev.vars.example`.
- Deployment scripts read repository `.env.local`; Wrangler does not automatically load it for `pnpm dev`.

Queue messages must remain exactly `{ workItemId }`. PostgreSQL is canonical.
