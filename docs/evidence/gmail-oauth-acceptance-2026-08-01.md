# Gmail OAuth acceptance record

Status: **EXTERNAL/TESTING ONBOARDING PASS / RELEASE NO-GO**  
Evidence date: 2026-08-01

## Boundary

This record covers one local Gmail onboarding proof against a dedicated Hypersimple development project. It does not cover production OAuth, long-lived authorization, mailbox ingestion timing, reads, mutations, sending, provider-failure recovery, or deployed production behavior.

The Google registration was verified as:

- app name `Hypersimple Hypermail`;
- External audience in Testing status;
- one named test user;
- only `https://www.googleapis.com/auth/gmail.modify` data access;
- one local Web client with exactly `http://localhost:8080/oauth/gmail/callback` and no JavaScript origin or production callback;
- Gmail API enabled in the dedicated `hypersimple-hypermail-dev` project under the Hypersimple organization.

No credential value, authorization URL, callback query, authorization code, OAuth state, token, or mailbox content is retained in this evidence.

## Live outcome

With the autonomous worker stopped, the authenticated Settings flow generated a Google authorization request, completed consent through the same-origin callback, and returned a successful onboarding result. Hypermail reported one ready Gmail account and the application projected one Gmail account with one owner relationship.

The successful flow performed no mailbox read, send, archive, move, delete, draft, or read-state mutation. The worker remained stopped throughout acceptance.

## Safety and persistence checks

- Google client configuration was present only in the private Hypermail container; web, migration, and worker environments were blanked.
- Hypermail retained no published host port. Private application traffic used the internal network while a separate egress network allowed outbound Google token/profile requests.
- PostgreSQL contained one safe Gmail account projection and one owner relationship, with zero OAuth tokens in the application auth table.
- Hypermail's private persistent state was nonempty, mode `0600`, and did not contain the test address, Google client configuration, or token-field markers in plaintext.
- Current web, proxy, and Hypermail logs contained no configured client credential, callback code/state query, access token, refresh token, or client-secret field.
- The callback success path removed query data before completion and cleared the opaque pending browser-session record before displaying the projected account; targeted browser contract tests cover both behaviors.
- No post-fix onboarding failure diagnostic was present.

## Verification

The targeted Hypermail/web onboarding and browser suites passed: 6 files, 29 tests. The full workspace check passed lint, typechecking, 242 tests with 11 explicitly skipped live/disposable cases, all workspace builds, and deployment static verification. Compose parsing, documentation invariants, `git diff --check`, ignored `.env` mode `0600`, tracked-file credential scanning, downloaded-credential cleanup, and stopped-worker checks also passed.

## Limitations and decision

External/Testing authorization for this non-basic scope, including refresh-token access, expires after seven days. This proof therefore cannot establish durable Gmail operation or production readiness.

Production remains blocked on a separate production Google project/client, owned HTTPS domain and exact callback, public application/privacy pages, domain verification, restricted-scope verification, any applicable security assessment, production-shaped deployment, and the broader provider/runtime acceptance matrix. The release decision remains **NO-GO**.
