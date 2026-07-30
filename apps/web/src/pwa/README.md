# PWA deployment contract

`pnpm --filter @hypermail/web build` emits `dist/pwa/service-worker.js`, copies `static/` to the `dist/` root, and builds the minimal Node host started by `node dist/index.js`. The host links `/manifest.webmanifest`, serves the root-scoped worker/offline/icons assets with safe headers, registers the worker, wires the install prompt and explicit reload-to-update control, and serves direct `/activities/:id` shell routes.

The worker caches only `/offline.html`. It does not cache app documents, API responses, mail/body content, attachments, or writes, and it queues no offline actions. Push uses the existing validated redacted notification payload and Activity deep links.

Serwist was intentionally not added: with one explicit cache entry and no framework bundler, a standard module service worker is the smaller deployable option.
