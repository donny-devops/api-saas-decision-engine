// Agent-to-Agent (A2A) protocol surface: an agent card for discovery and a
// JSON-RPC 2.0 endpoint implementing `message/send` and `tasks/get`.
// Skill selection: a data part `{ skill, input }`, or a text part routed to the master agent.
import { randomUUID } from 'node:crypto';
import { json, parse } from '../db/index.js';

export function agentCard(mesh, baseUrl) {
  return {
    protocolVersion: '0.3.0',
    name: 'API SaaS Decision Engine',
    description: 'Financial-model agents for API SaaS: forecasting, risk, pricing, capacity and treasury, coordinated by a master agent.',
    url: `${baseUrl}/a2a`,
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
    skills: [
      { id: 'master.ask', name: 'Ask the master agent', description: 'Natural-language question → plan → specialist calls → recommendations', tags: ['orchestration'] },
      ...mesh.list().filter((a) => a.location === 'local').flatMap((a) => a.skills.map((s) => ({ id: `${a.name}.${s.id}`, name: s.id, description: s.description, tags: [a.name], credits: s.credits }))),
    ],
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleA2A(body, { mesh, master, db, webhooks, commerce, account }) {
  const { id = null, method, params = {} } = body ?? {};
  if (body?.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');

  if (method === 'tasks/get') {
    const row = db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(params.id);
    if (!row) return rpcError(id, -32001, 'Task not found');
    return { jsonrpc: '2.0', id, result: toTask(row) };
  }
  if (method !== 'message/send') return rpcError(id, -32601, `Method not found: ${method}`);

  const parts = params.message?.parts ?? [];
  const data = parts.find((p) => p.kind === 'data')?.data;
  const text = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
  const [agent, skill] = data?.skill?.includes('.') ? data.skill.split('.') : [params.metadata?.agent ?? (data ? null : 'master'), data?.skill ?? 'ask'];
  if (!agent) return rpcError(id, -32602, 'Specify skill as "<agent>.<skill>" or metadata.agent');

  const taskId = randomUUID();
  const contextId = params.message?.contextId ?? randomUUID();
  db.prepare('INSERT INTO a2a_tasks (id, agent, skill, status, input_json, account) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, agent, skill, 'working', json(data?.input ?? { text }), account ?? null);

  try {
    let output;
    let credits = 0;
    if (agent === 'master') {
      output = await master.ask(text || data?.input?.question || '', { scenario: data?.input?.scenario });
    } else if (params.metadata?.quoteId && commerce) {
      const settled = await commerce.accept(params.metadata.quoteId, account);
      output = settled.output;
      credits = settled.credits;
    } else if (process.env.A2A_REQUIRE_PAYMENT === 'true') {
      throw Object.assign(new Error('Payment required: request a quote via /v1/commerce/quote and pass metadata.quoteId'), { rpc: -32002 });
    } else {
      output = await mesh.call(agent, skill, data?.input ?? {}, { caller: account ? `account:${account}` : 'a2a', contextId });
    }
    db.prepare("UPDATE a2a_tasks SET status = 'completed', output_json = ?, credits = ?, updated_at = datetime('now') WHERE id = ?").run(json(output), credits, taskId);
    await webhooks?.emit('a2a.task.completed', { taskId, agent, skill });
  } catch (err) {
    db.prepare("UPDATE a2a_tasks SET status = 'failed', output_json = ?, updated_at = datetime('now') WHERE id = ?").run(json({ error: err.message }), taskId);
    if (err.rpc) return rpcError(id, err.rpc, err.message);
  }
  return { jsonrpc: '2.0', id, result: toTask(db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(taskId), contextId) };
}

function toTask(row, contextId) {
  const output = parse(row.output_json);
  return {
    kind: 'task',
    id: row.id,
    contextId,
    status: { state: row.status, timestamp: row.updated_at },
    artifacts: row.status === 'completed' ? [{ artifactId: `${row.id}-result`, name: `${row.agent}.${row.skill}`, parts: [{ kind: 'data', data: output }] }] : [],
    ...(row.status === 'failed' ? { error: output?.error } : {}),
  };
}
