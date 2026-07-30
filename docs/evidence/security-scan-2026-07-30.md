# Dependency security scan evidence

- Executed UTC: 2026-07-30
- Command: `pnpm security:scan`
- Policy result: passed; no high or critical production dependency findings.
- Remaining moderate: `GHSA-67mh-4wv8-2f99` in optional `esbuild@0.18.20` under Better Auth → Drizzle Kit tooling. The affected development server is not present or exposed in either production image.
- Remaining low: `GHSA-866g-f22w-33x8` in Mastra's transitive `@ai-sdk/provider-utils`. Model calls remain bounded by application timeouts and schema validation; update when the pinned Mastra line admits the patched dependency.
- CI also builds the production web and worker images and fails Trivy on high/critical findings.

These accepted lower-severity findings must be reconsidered during Phase 8 release acceptance; this record is not a waiver for a new high/critical finding.
