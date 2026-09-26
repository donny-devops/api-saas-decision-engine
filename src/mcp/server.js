#!/usr/bin/env node
// MCP server (stdio, newline-delimited JSON-RPC 2.0). Exposes the decision
// engine, the agent mesh and the pipelines as MCP tools + resources, so any MCP
// client (Claude Code, Claude Desktop, …) can drive the model directly.
// Logs go to stderr only — stdout is the protocol channel.
import { createInterface } from 'node:readline';
import {
  runModel, compareScenarios, sensitivity, goalSeek, monteCarlo, evaluatePolicies,
  DEFAULT_ASSUMPTIONS, SCENARIO_PRESETS, KEY_DRIVERS, DEFAULT_POLICIES, METRICS,
} from '../engine/index.js';
import { createAgentSystem } from '../agents/index.js';
import { loadPipelines, runPipeline } from '../orchestrator/pipelines.js';

const PROTOCOL_VERSION = '2025-06-18';
const { mesh, master } = createAgentSystem();
const pipelines = loadPipelines();

const scenarioSchema = {
  description: 'Preset name (base|bull|bear|efficiency) or an assumptions patch object; patches may nest via "extends".',
  anyOf: [{ type: 'string' }, { type: 'object' }],
};
const toScenario = (s) => (typeof s === 'string' ? { extends: s } : s ?? {});
const metricEnum = { type: 'string', enum: Object.keys(METRICS) };

export const TOOLS = {
  run_model: {
    description: 'Run the driver-based financial model for an API SaaS scenario. Returns the summary, annual P&L and policy results; set includeMonths for the full monthly series.',
    inputSchema: { type: 'object', properties: { scenario: scenarioSchema, includeMonths: { type: 'boolean' } } },
    run: ({ scenario, includeMonths }) => {
      const r = runModel(toScenario(scenario));
      return { summary: r.summary, policies: evaluatePolicies(r), ...(includeMonths ? { months: r.months.map(({ tiers, ...m }) => m) } : {}) };
    },
  },
  compare_scenarios: {
    description: 'Compare scenario summaries side by side.',
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } },
    run: ({ names }) => compareScenarios(names ?? Object.keys(SCENARIO_PRESETS)),
  },
  sensitivity: {
    description: 'Tornado sensitivity: shock each key driver ±delta and rank by swing in the target metric.',
    inputSchema: { type: 'object', properties: { scenario: scenarioSchema, target: metricEnum, delta: { type: 'number', minimum: 0.01, maximum: 0.9 } } },
    run: ({ scenario, target, delta }) => sensitivity(toScenario(scenario), { target, delta }),
  },
  goal_seek: {
    description: 'Solve for the driver value that hits a goal (e.g. the paid spend needed for $30M ending ARR). Wildcard paths like tiers.*.price solve a multiplier.',
    inputSchema: { type: 'object', required: ['path', 'goal'], properties: { scenario: scenarioSchema, path: { type: 'string' }, target: metricEnum, goal: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' } } },
    run: ({ scenario, ...rest }) => goalSeek(toScenario(scenario), rest),
  },
  monte_carlo: {
    description: 'Seeded Monte Carlo simulation over uncertain drivers; returns P10/P50/P90 and cash-out probability.',
    inputSchema: { type: 'object', properties: { scenario: scenarioSchema, iterations: { type: 'integer', minimum: 10, maximum: 5000 }, seed: { type: 'integer' } } },
    run: ({ scenario, iterations = 300, seed }) => {
      const mc = monteCarlo(toScenario(scenario), { iterations, seed });
      return { iterations: mc.iterations, probabilityOfCashOut: mc.probabilityOfCashOut, metrics: mc.metrics };
    },
  },
  evaluate_policies: {
    description: 'Evaluate a policy ruleset (defaults if omitted) against a scenario.',
    inputSchema: { type: 'object', properties: { scenario: scenarioSchema, rules: { type: 'array', items: { type: 'object' } } } },
    run: ({ scenario, rules }) => evaluatePolicies(runModel(toScenario(scenario)), rules ?? DEFAULT_POLICIES),
  },
  ask_master_agent: {
    description: 'Ask the master agent a business question; it plans, delegates to specialist agents in parallel and returns recommendations with evidence.',
    inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, scenario: scenarioSchema } },
    run: ({ question, scenario }) => master.ask(question, { scenario: toScenario(scenario) }),
  },
  call_agent: {
    description: 'Call one specialist agent skill directly over the agent mesh.',
    inputSchema: { type: 'object', required: ['agent', 'skill'], properties: { agent: { type: 'string' }, skill: { type: 'string' }, input: { type: 'object' } } },
    run: ({ agent, skill, input }) => mesh.call(agent, skill, input ?? {}, { caller: 'mcp' }),
  },
  run_pipeline: {
    description: `Run a workflow pipeline on the async DAG engine. Available: ${Object.keys(pipelines).join(', ')}.`,
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', enum: Object.keys(pipelines) }, input: { type: 'object' } } },
    run: async ({ name, input }) => {
      const r = await runPipeline(pipelines[name], input ?? {}, { mesh, master }, { trigger: 'mcp' });
      return { status: r.status, durationMs: r.durationMs, tasks: Object.fromEntries(Object.entries(r.tasks).map(([k, t]) => [k, { status: t.status, error: t.error }])), output: r.output };
    },
  },
};

const RESOURCES = {
  'model://assumptions/default': { name: 'Default assumptions', mimeType: 'application/json', read: () => DEFAULT_ASSUMPTIONS },
  'model://scenarios/presets': { name: 'Scenario presets', mimeType: 'application/json', read: () => SCENARIO_PRESETS },
  'model://drivers': { name: 'Key drivers', mimeType: 'application/json', read: () => KEY_DRIVERS },
  'model://policies/default': { name: 'Default policy ruleset', mimeType: 'application/json', read: () => DEFAULT_POLICIES },
  'model://agents': { name: 'Agent mesh directory', mimeType: 'application/json', read: () => mesh.list() },
};

export async function handleMessage(msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'api-saas-decision-engine', version: '0.1.0' } });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS[params.name];
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        const out = await tool.run(params.arguments ?? {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out });
      } catch (err) {
        return ok({ isError: true, content: [{ type: 'text', text: err.errors ? `${err.message}\n- ${err.errors.join('\n- ')}` : err.message }] });
      }
    }
    case 'resources/list':
      return ok({ resources: Object.entries(RESOURCES).map(([uri, r]) => ({ uri, name: r.name, mimeType: r.mimeType })) });
    case 'resources/read': {
      const r = RESOURCES[params.uri];
      if (!r) return fail(-32002, `Resource not found: ${params.uri}`);
      return ok({ contents: [{ uri: params.uri, mimeType: r.mimeType, text: JSON.stringify(r.read(), null, 2) }] });
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const res = await handleMessage(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  console.error('[mcp] api-saas-decision-engine ready on stdio');
}
