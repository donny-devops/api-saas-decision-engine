# CLAUDE.md

Driver-based financial model + decision engine for API SaaS. Node ≥ 22.5, **zero npm dependencies**.

## Commands
- `npm test` — all tests (`node --test "test/**/*.test.js"`)
- `npm run lint` · `npm run scan:secrets`
- `npm start` — API + dashboard on :8787 · `npm run seed` — local keys to `.env.local`
- `node src/cli/index.js run|compare|sensitivity|goal-seek|monte-carlo|ask|pipeline`
- MCP server: `node src/mcp/server.js` (registered in `.mcp.json`)

## Layout
- `src/engine` — pure model (no Node/DOM imports; also served to the browser dashboard)
- `src/orchestrator` — async DAG engine, pipelines (`pipelines/*.json`), cron
- `src/agents` — mesh, specialists, master agent, A2A, commerce
- `src/api` — HTTP API + auth · `src/mcp` · `src/cli` · `src/bots`
- `src/db` (node:sqlite + migrations) · `src/secrets` · `src/webhooks` · `src/mail`

## Conventions
- What-ifs are scenario patches with `extends`; do not edit defaults to answer a question.
- Credentials only via `getSecret()`; never log them (`redact()`).
- Branch names `feat|fix|chore|docs|…/<name>`; merge with `--no-ff`.
- Model changes: update `docs/model.md` and paste `compare` before/after in the PR.
- Use the `saas-financial-model` skill and the subagents in `.claude/agents/`.
