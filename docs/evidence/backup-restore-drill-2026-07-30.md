# Seeded backup/restore drill evidence

- Executed UTC: 2026-07-30 12:15:45–12:15:46
- Command: `infra/backup/test/drill.sh`
- Generation: `1785413745-7b35776efebe`
- Encrypted artifact total: 12,784 bytes
- Integrity: encrypted manifest decrypted and SHA-256/byte checks passed before decryption.
- Database verification: isolated `hypermail_restore` contained seeded `drill_seed` row (`id=7`).
- State verification: isolated empty target contained byte-identical synthetic state fixture.
- Key safety check: restore rejected a group/other-readable age identity before object access.
- Result: passed.
- Measured drill RTO: 1 second wall-clock from backup invocation through both restore checks (local disposable Docker environment; not a production RTO commitment).
- Observed RPO: seed was created immediately before the run; the restored snapshot included it (at most the daily schedule interval in production).

No keys, database URLs, bucket names, credentials, provider tokens, account state, or artifact hashes are recorded here.
