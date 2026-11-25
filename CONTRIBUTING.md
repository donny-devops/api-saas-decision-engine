# Contributing

Thank you for your interest in the API SaaS Decision Engine.

This project is intentionally dependency-free and deterministic. Contributions that preserve those properties are preferred.

## Development setup

```bash
git clone https://github.com/donny-devops/api-saas-decision-engine.git
cd api-saas-decision-engine
npm test          # run the full suite
npm start         # start API + dashboard on http://localhost:8787
npm run seed      # generate local API keys
```

Requirements:
- Node.js ≥ 22.5
- No `npm install` is required or expected

## Project layout (quick map)

| Path | Responsibility |
|---|---|
| `src/engine/` | Pure financial model (browser-safe) |
| `src/api/` | HTTP API surface |
| `src/agents/` | Agent mesh, master agent, A2A |
| `src/orchestrator/` | Async DAG engine and pipelines |
| `src/credit/` | Business credit platform |
| `src/secrets/` | Secrets manager + PQC hybrid chains |
| `pipelines/` | Declarative pipeline definitions |
| `docs/` | Model, architecture, security, OpenAPI |

## Making changes

1. Create a branch following the naming convention: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `perf/`, or `ci/`.
2. Keep the model deterministic and free of side effects in `src/engine/`.
3. Add or update tests under `test/` for any behavioral change.
4. Run `npm test` and `npm run lint` before opening a pull request.
5. Enable the pre-commit secret scanner once:
   ```bash
   git config core.hooksPath .githooks
   ```

## Pull request guidelines

- Reference related issues when applicable.
- Describe the change and any impact on model outputs or policy behavior.
- Ensure the OpenAPI spec (`docs/openapi.yaml`) stays in sync with API changes.
- New scenarios, pipelines, or agents should include documentation updates.

## Code style

- Prefer clear, explicit code over clever abstractions.
- Use modern JavaScript (ES modules, top-level await where helpful).
- Keep functions small and pure where possible, especially in the engine.
- Document non-obvious assumptions in comments or in `docs/model.md`.

## Security

Never commit secrets. The pre-commit hook and CI scanners will reject them. If you discover a vulnerability, please report it privately rather than opening a public issue.

## Questions

Open a GitHub issue for design discussions or unclear behavior. For security issues, use the process described in `SECURITY.md`.
