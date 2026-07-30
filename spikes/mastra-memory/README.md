# Mastra + PostgreSQL proof

This isolated spike uses the actual Mastra `PostgresStore`, `Memory`, and workflow APIs; it does not substitute an in-memory adapter.

```sh
cd spikes/mastra-memory
npm ci
npm run db:up
npm run typecheck
npm test
npm run db:down
```

`DATABASE_URL` overrides the Compose default (`postgresql://mastra:mastra@localhost:54329/mastra_proof`). The integration tests explicitly skip when that database is unavailable, explaining how to start it.

The tests prove resource/thread-scoped **source message** inspection, deletion-and-replacement correction, deletion reset, and a PostgreSQL workflow snapshot resumed by a newly constructed Mastra app. They intentionally do not claim Observational Memory inspection/reset: Mastra's public APIs do not expose that safely; see `../../docs/decisions/mastra-proof.md`.
