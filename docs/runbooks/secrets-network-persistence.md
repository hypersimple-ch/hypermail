# Secrets, private networking, and persistence runbook

## Secret rotation

Rotate one credential class at a time: create the replacement in the platform secret store/file, update only consumers that require it, restart those consumers, validate readiness, then revoke the old credential. Rotate `AUTH_SECRET` only with a planned session invalidation. Rotate the database password by changing PostgreSQL and all consumer URLs in a controlled overlap window. Hindsight LLM provider credentials live only in `HINDSIGHT_ENV_FILE`; rotate that provider key by updating only the Hindsight service, restarting it, validating private health/version and one synthetic retain/recall, then revoking the old key. An optional Hindsight API key lives only in `WORKER_ENV_FILE` for an auth-enabled endpoint. Never place either key in web/browser configuration. Provider access/refresh credentials are rotated in Hypermail's encrypted state, never copied into app environment files. Gmail OAuth application configuration is instead Hypermail-only bootstrap configuration in `HYPERMAIL_ENV_FILE`: update the Google redirect registration and replacement secret there, restart/redeploy Hypermail, validate readiness and the live callback, then revoke the old secret. Do not log secret values or complete dependency errors.

## Private networking

`private` is `internal: true`; web has both edge and private networks, while worker, PostgreSQL, and Hypermail have only `private`. Hindsight has private ingress plus a separate non-edge egress network for its LLM provider; none publishes ports or joins the edge/proxy network. On a VPS, Caddy alone binds 80/443. In Dokploy, Traefik alone reaches web over the external Dokploy network. Confirm with `docker compose config` and host firewall rules before every deployment. No production `ports:` stanza may be added to worker, PostgreSQL, Hypermail, or Hindsight. Hindsight's bundled control plane stays disabled.

## Persistence and recovery

`postgres-data` holds PostgreSQL data, `hypermail-data` holds Hypermail encrypted/provider state, and `hindsight-data` holds embedded pg0 and all Mailbox banks. The existing encrypted job backs up PostgreSQL and Hypermail state only. Never tar live pg0 as a purported backup. Development banks may be reset; production requires a supported quiesced or logical Hindsight backup with an isolated recall drill. Before maintenance, confirm volume names, backup freshness, and free disk. Never use `down -v`, `docker volume rm`, or a replacement Hypermail or Hindsight volume during routine deploys.
