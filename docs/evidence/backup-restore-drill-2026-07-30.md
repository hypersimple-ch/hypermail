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

## 2026-10-05 complete application-state drill

- Command: `FULL_ACCEPTANCE_BACKUP_DRILL=1 HINDSIGHT_DRILL_IMAGE=<approved 0.9.1 digest> bash infra/acceptance/full-runtime.sh`.
- Generation: `1791242129-ef251d3b31fd`; snapshot/restore UTC: 2026-10-05 23:15:29–23:15:37.
- Three separately domain-encrypted artifacts, manifest v2; encrypted artifact total 455,759 bytes.
- Source was the launcher's owned disposable PostgreSQL database after successful actual HTTP auth/onboarding/activation, reviews/corrections/conversations, approved send and SMTP reset. Web and worker were cleanly stopped before the backup hook.
- Restored every `app`/`mastra` table and compared complete sorted-row digests/counts against the quiesced source; required populated accounts, proposals, reviews, conversations/messages and approved-send journal.
- Corrupted Hindsight ciphertext was rejected before any DB/state target writes; a valid generation then restored SQL and both byte-identical offline state fixtures. The isolated target had no provider egress.
- Result: **passed**, `application_state=verified`, `memory_recall=not_exercised`. Provider/Hindsight state remains synthetic. This does not prove native Hindsight prior-memory recall, native Mastra OM restoration, remote object-storage permissions, production scheduling or a production RTO/RPO.

## 2026-10-06 final repeat

- The full HTTP case and application-state restore passed again after CLI shutdown integration.
- Generation `1791246364-8a4b8c4459c0`; UTC 00:26:03–00:26:12; encrypted artifact total 455,751 bytes.
- Complete controlled-profile `app`/`mastra` comparison, ciphertext corruption rejection and both synthetic state archives passed; `application_state=verified`, `memory_recall=not_exercised`.
- The database dump includes all schemas, including native Mastra-owned `public.mastra_*` tables when present. This controlled case does not populate/exercise native OM restoration; the separately passing native-model case proves source history, not a native Hindsight backup recall.
- All restored targets remained disposable/internal-network-only. No production state, remote bucket, live mailbox or external SMTP destination was used.
