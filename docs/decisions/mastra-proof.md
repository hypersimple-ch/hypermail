# Mastra/PostgreSQL memory proof decision

**Decision: GO with explicitly opaque Observational Memory for milestone one.** The supported APIs prove durable source-message isolation and workflow recovery below, but do **not** safely support direct OM inspection, correction, or reset. The user explicitly accepted this limitation after reviewing the proof. Milestone one must expose no inspect/correct/reset controls and must retain pause controls, action verification, audits, and the incorrect-action safety threshold as compensating controls.

## Isolated proof

`spikes/mastra-memory/` owns its manifest and `package-lock.json`; no workspace dependency is used. Exact direct versions:

- `@mastra/core` `1.54.0`
- `@mastra/memory` `1.24.0`
- `@mastra/pg` `1.18.0` (peer range: `@mastra/core >=1.51.0-0 <2.0.0-0`)
- `zod` `4.4.3`
- test tooling: `tsx` `4.23.1`, TypeScript `5.9.3`, `@types/node` `25.5.0`

`compose.yaml` supplies PostgreSQL 16 at `postgresql://mastra:mastra@localhost:54329/mastra_proof`. `DATABASE_URL` can point at a separately supplied PostgreSQL instance.

## Supported API evidence and proof coverage

The proof uses these documented Mastra APIs, rather than direct SQL or a substitute adapter:

- `new PostgresStore({ id, connectionString })`, followed by `store.init()` for direct storage use. The adapter owns the `mastra_messages`, `mastra_threads`, `mastra_resources`, and `mastra_workflow_snapshot` tables.
- `new Memory({ storage })`; `createThread({ threadId, resourceId })`; `saveMessages({ messages })`; `recall({ threadId, resourceId, perPage: false })`; and `deleteMessages(messageIds)`.
- `createStep` with Zod `inputSchema`, `resumeSchema`, `suspendSchema`, and `outputSchema`; `createWorkflow(...).then(step).commit()`; `run.start`; `workflow.getWorkflowRunById`; `workflow.createRun({ runId })`; and typed `run.resume({ step, resumeData })`.

`test/postgres-proof.test.ts` creates stable resource IDs `account:proof-alice`, `account:proof-bob`, and `global:proof`, with distinct threads. `recallOwnedThread` is a deliberately small application adapter over Mastra's documented `getThreadById` and `recall`: it rejects a request unless the persisted thread's `resourceId` matches the authorized resource. The test exercises and asserts that Alice's thread is rejected for Bob before it recalls content. This guard is necessary because Mastra documentation explicitly says Memory itself does not enforce access control. It writes actual V2 Mastra messages (`{ format: 2, parts: [{ type: 'text', text }] }`), recalls each resource/thread, and asserts that the other account and global content is absent. It corrects source history with documented `deleteMessages` then `saveMessages`, and resets the account thread by deleting all recalled message IDs. This is source-message inspection/correction/reset, not an assertion about derived OM state.

The second test starts a typed approval workflow which calls `suspend`, closes the first `PostgresStore`/Mastra app, constructs a new store/app, reads the persisted run with `getWorkflowRunById`, recreates the run by ID, and resumes using the typed `approvalStep` and `{ approved: true }`. Passing proves the snapshot was stored in PostgreSQL and that restart recovery works.

## Commands and observed result

Run from the repository root:

```sh
cd spikes/mastra-memory
npm ci
npm run db:up
npm run typecheck
npm test
```

Observed on this proof:

```text
> npm run typecheck
> tsc --noEmit

> npm test
✔ PostgresStore scopes account and global message memory and supports source-message correction/reset
✔ workflow snapshot survives app recreation and resumes typed approval input
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

When PostgreSQL/Docker is unavailable, each integration test is marked skipped with: `PostgreSQL unavailable at <url>; start it with npm run db:up (...)`. That is the only allowed skip path.

## OM limitation (reason for STOP)

Official OM documentation describes configuration (`new Memory({ options: { observationalMemory: true } })`) and observation through Studio, traces, and stream status/completion data. It does **not** document a public server API to read individual derived OM records, edit/correct them, delete/reset them, or rebuild them after source-message deletion. Deleting source messages therefore cannot be represented as a safe OM correction/reset: stale derived observations may remain and recomputation is not documented. The proof deliberately does not query Mastra internal tables or dependency internals to manufacture that capability.

Working memory has a documented `updateWorkingMemory({ threadId, resourceId, workingMemory })` mutation, but it is a different feature and is not an OM reset.

## Official documentation consulted

- [PostgreSQL storage](https://mastra.ai/reference/storage/postgresql)
- [Message history](https://mastra.ai/docs/memory/message-history)
- [Memory class](https://mastra.ai/reference/memory/memory-class)
- [Observational Memory](https://mastra.ai/docs/memory/observational-memory)
- [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)
- [Workflow snapshots](https://mastra.ai/docs/workflows/snapshots)

## Follow-up criteria

Derived OM management remains unavailable. If Mastra later adds a supported public API that can (1) list derived OM scoped by resource/thread, (2) atomically correct or clear it after source-history mutation, and (3) rebuild/verify it durably, add integration tests before exposing any inspect/correct/reset controls. Until then, treat derived observations as opaque and potentially stale.
