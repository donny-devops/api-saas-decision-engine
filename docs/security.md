# Security operations

## Secrets manager

Code never reads credentials directly; it calls `getSecret(NAME)`. Providers are tried in
the order given by `SECRETS_PROVIDERS` (default `file,env`):

| Provider | Source | Use |
|---|---|---|
| `file` | `$SECRETS_DIR/<NAME>` (default `/run/secrets`) | Docker / Kubernetes secrets, used in production |
| `vault` | HashiCorp Vault KV v2 at `$VAULT_ADDR/v1/$VAULT_MOUNT/data/$VAULT_PATH` | Central secret store |
| `env` | `process.env` | Local development and CI (GitHub encrypted secrets) |

Custom backends (AWS Secrets Manager, GCP Secret Manager, 1Password Connect) plug in with
`registerSecretProvider(name, async (key) => value)`.

| Secret | Purpose |
|---|---|
| `DATA_ENCRYPTION_KEY` | 32-byte base64 key; AES-256-GCM for data at rest. **Required when `NODE_ENV=production`.** |
| `ADMIN_API_KEY` | Bootstrap admin key; use it to mint scoped keys, then rotate it |
| `INBOUND_EMAIL_TOKEN`, `INBOUND_EMAIL_ALLOWLIST` | Mailhook auth and allowed senders (`a@x.com`, `@x.com`) |
| `GITHUB_WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` |
| `SLACK_WEBHOOK_URL`, `RESEND_API_KEY` | Outbound notifications |

### Credential hashing

API keys and similar credentials are stored with scrypt (`N=65536`, `r=8`, `p=1`). Existing hashes created with the previous cost factor remain verifiable. New hashes use the higher cost. The verification path rejects inflated parameters (`N > 131072` or `r`/`p` > 64) to prevent denial-of-service.

### Rotation

- **API keys:** create a new key (`POST /v1/api-keys`), roll clients over, then `DELETE` the old key. The prefix-based lookup remains valid across rotations.
- **Webhook secrets:** register a new endpoint, verify deliveries, then delete the old one.
- **`DATA_ENCRYPTION_KEY`:**
  1. Generate a new 32-byte base64 key and stage it in the secrets manager under a temporary name if desired.
  2. Update the secret value (or switch providers).
  3. Ciphertexts are versioned (`v1.`). After the key change, re-encrypt any stored secrets (webhook signing secrets, etc.) by reading with the old key (if still available) or by re-registering the affected resources.
  4. Restart the service so all processes pick up the new key. No downtime is required if you keep the old key available briefly for decryption only.
  5. Confirm successful decryption of existing records before retiring the previous key.

## Secret scanning

1. **Pre-commit:** `git config core.hooksPath .githooks` runs `scripts/scan-secrets.js --staged`.
2. **CI:** gitleaks scans the full history using `.gitleaks.toml`, and the built-in scanner runs on
   every push and pull request, plus a weekly scheduled scan.
3. **GitHub:** enable Secret Protection and push protection in the repository settings.

If a secret is committed: revoke it at the provider **first**, then rotate it, then purge it from
history. Deleting the line afterwards is not enough.

## Webhook verification (receiver side)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

## Audit logging

Minimal structured audit events are emitted for:
- Authentication success and failure (API key and bootstrap admin)
- Secret retrievals that fail or are required
- API key creation and revocation

Events are logged via `console` in JSON form (suitable for container log aggregation). No secret values are included.

## Repository rulesets

`.github/rulesets/*.json` are importable via **Settings → Rules → Rulesets → Import**, or with:

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/main-protection.json
```

- **main-protection:** pull requests only, 1 approval plus code-owner review, stale reviews dismissed,
  conversations resolved, required checks (tests on Node 22 and 24, forecast gate, gitleaks, built-in
  scan, CodeQL), signed commits, no force-push or deletion.
- **release-tags:** `v*` tags are immutable and signed.
- **branch-naming:** branches must match `feat|fix|chore|docs|refactor|test|perf|ci/<name>`.
