# Secrets, private networking, and persistence runbook

## Secret rotation

Rotate one credential class at a time: create the replacement in the platform secret store/file, update only consumers that require it, restart those consumers, validate readiness, then revoke the old credential. Rotate `AUTH_SECRET` only with a planned session invalidation. Rotate the database password by changing PostgreSQL and all consumer URLs in a controlled overlap window. Hypermail OAuth/provider credentials are rotated in Hypermail, never copied into app environment files. Do not log secret values or complete dependency errors.

## Private networking

`private` is `internal: true`; web has both edge and private networks, while worker, PostgreSQL, and Hypermail have only private. On a VPS, Caddy alone binds 80/443. In Dokploy, Traefik alone reaches web over the external Dokploy network. Confirm with `docker compose config` and host firewall rules before every deployment. No production `ports:` stanza may be added to worker, PostgreSQL, or Hypermail.

## Persistence and recovery

`postgres-data` holds PostgreSQL data and `hypermail-data` holds Hypermail encrypted/provider state. Back both up on an encrypted, tested schedule, retaining backup generations separately from Docker volumes. Test restore to an isolated private network at least quarterly. Before maintenance, confirm volume names, backup freshness, and free disk. Never use `down -v`, `docker volume rm`, or a replacement Hypermail volume during routine deploys.
