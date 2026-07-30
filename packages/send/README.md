# Approved send adapter

`PrivateApprovedSendHttpProvider` sends only an `ApprovedSend` payload to a deployment-owned private HTTPS endpoint. The endpoint must accept `POST` JSON with an `Authorization` header and `Idempotency-Key`, and return HTTP 200 JSON exactly shaped as `{ "providerMessageId": "..." }`.

The deployment must durably deduplicate `idempotencyKey`. Hypermail v0.7 exposes no native idempotent send API, so direct MCP calls cannot provide exactly-once delivery guarantees.
