FROM alpine:3.21
RUN apk add --no-cache bash postgresql16-client age aws-cli tar coreutils curl python3
COPY infra/backup/bin/backup-run infra/backup/bin/restore-run /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup-run /usr/local/bin/restore-run
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/backup-run"]
