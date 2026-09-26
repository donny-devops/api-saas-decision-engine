# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private
[security advisory](../../security/advisories/new) form for this repository.
Include reproduction steps, affected endpoint or module, and impact.

- Acknowledgement within **3 business days**
- Triage and severity assessment within **7 days**
- Fix or mitigation target: critical 7 days, high 30 days, others next release

## Scope

In scope: the HTTP API, auth and API keys, webhook signing and delivery,
mailhooks, the MCP server, A2A endpoint, commerce ledger, secrets handling,
container image, and CI workflows.

Out of scope: findings that require a leaked admin key, denial of service by
volume, and issues in third-party services we call (Slack, Resend, Vault).

## Security controls (summary)

| Area | Control |
|---|---|
| Authentication | Bearer API keys (`sde_live_…`), stored as SHA-256 hashes, scoped `read` / `write` / `admin`, revocable |
| Rate limiting | Token bucket per key / IP |
| Secrets | Pluggable secrets manager (Docker/K8s secret files, Vault KV v2, env); nothing reads credentials from code |
| Data at rest | Webhook signing secrets encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`) |
| Webhooks | HMAC-SHA256 signatures with timestamp (replay window 5 min); SSRF guard blocks private/link-local targets |
| Inbound hooks | Mailhook shared token + sender allowlist; GitHub hook `X-Hub-Signature-256` verification |
| HTTP | Body size limit, strict CSP, `nosniff`, `X-Frame-Options: DENY`, HSTS in production, CORS allowlist |
| Logging | Credential redaction before any log line |
| Supply chain | Zero runtime npm dependencies; Dependabot; CodeQL; signed provenance + SBOM on release images |
| Secret scanning | gitleaks (full history) + built-in scanner in CI and as a pre-commit hook |
| Container | Non-root user, read-only root FS, all capabilities dropped, `no-new-privileges` |
| Repository | Rulesets: protected `main` (reviews, code owners, required checks, signed commits), immutable release tags, branch naming |

See [docs/security.md](docs/security.md) for operational details.
