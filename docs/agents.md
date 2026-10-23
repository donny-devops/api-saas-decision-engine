# Agents, A2A and agentic commerce

## Agent mesh

`AgentMesh` is a registry and message bus. Agents register **skills**, and each skill has
a handler and a credit price. `mesh.call(agent, skill, input)` routes the call in-process,
or over A2A to a remote agent (`mesh.registerRemote(name, { url, token })`). Every hop is
recorded in `mesh.trace` with a shared `contextId`, so you can reconstruct a whole
multi-agent conversation (`GET /v1/agents/trace`).

| Agent | Skills (credits) |
|---|---|
| `forecaster` | `forecast` (1), `compare` (2), `drivers` (3) |
| `risk-analyst` | `policies` (1), `stress` (5) |
| `pricing-strategist` | `priceImpact` (2), `requiredPrice` (3) |
| `capacity-planner` | `scaling` (1) |
| `treasurer` | `runway` (1) |
| `quant-strategist` | `marketSignals` (3), `hybridValuation` (4) |
| `crypto-watcher` | `trendSpotter` (3) |
| `forensics-auditor` | `benfordAudit` (4) |
| `master` | `ask` (10) |

## Master agent

1. **Plan:** intent rules map the question to specialist skills. It always runs `forecast` and
   `policies`, then adds skills for keywords such as pricing, runway/cash, scale/infra, risk,
   compare, and drivers.
2. **Execute:** the plan becomes a DAG and runs concurrently with retries and `continueOnError`.
   One failing specialist doesn't sink the answer.
3. **Synthesize:** explicit, ordered rules turn the evidence into prioritized recommendations
   plus a narrative. Examples: a blocking policy breach, cash-out probability above 20%,
   LTV:CAC below 3 or above 5, gross margin below 70%, infra dominating COGS, a funding gap.

## A2A

- Discovery: `GET /.well-known/agent.json` returns the agent card, with skills listed as `<agent>.<skill>`.
- `POST /a2a` handles JSON-RPC 2.0 requests:
  - `message/send` with a data part `{ skill: "treasurer.runway", input }` runs that skill.
  - A text part goes to the master agent.
  - Returns a `Task` with `status.state` and `artifacts[].parts[].data`.
- `tasks/get` with `{ id }` fetches a stored task.

## Agentic commerce

Agents (or people) pay for skills in credits:

```
POST /v1/commerce/quote  {agent, skill, input}   → { quoteId, credits, expiresAt }
POST /v1/commerce/accept {quoteId}               → debit (atomic) → execute → settle
                                                   └ failure → automatic refund
```

- Over A2A, pass `metadata.quoteId` to settle a quote.
- With `A2A_REQUIRE_PAYMENT=true`, unpaid skill calls are refused with JSON-RPC error `-32002`.
- Credits are an internal unit in `ledger`; this code touches no payment rails.
- `POST /v1/commerce/top-up` (admin) grants credits.

## Claude Code subagents

`.claude/agents/` defines subagents that drive this repo through the MCP server:

- `financial-analyst`: scenarios, variance, board narrative.
- `pricing-strategist`: price and packaging experiments.
- `platform-engineer`: capacity and unit cost.
- `model-reviewer`: reviews driver and formula changes in pull requests.
- `quant-crypto-strategist`: algorithmic trading signals, crypto trend spotting, and SaaS valuation multiples.
- `pqc-forensics-auditor`: Benford's Law forensic audit, digital transformation maturity, and PQC chain verification.

The `saas-financial-model` skill in `.claude/skills/` teaches Claude the driver tree and the
tool workflow.
