import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { handleMessage } from '../src/mcp/server.js';

test('MCP handshake, tools/list, tools/call, resources', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'api-saas-decision-engine');
  const tools = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name);
  for (const t of ['run_model', 'goal_seek', 'ask_master_agent', 'run_pipeline']) assert.ok(tools.includes(t), t);
  const run = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_model', arguments: { scenario: 'bear' } } });
  assert.equal(run.result.structuredContent.summary.scenario, 'Bear case');
  const bad = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_model', arguments: { scenario: { acquisition: { freeToPaid: 9 } } } } });
  assert.equal(bad.result.isError, true);
  const res = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'model://drivers' } });
  assert.ok(JSON.parse(res.result.contents[0].text).length > 5);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('MCP server speaks JSON-RPC over stdio', async () => {
  const child = spawn(process.execPath, ['src/mcp/server.js'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compare_scenarios', arguments: { names: ['base', 'bull'] } } })}\n`);
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
  child.kill();
  assert.equal(JSON.parse(lines[0]).id, 1);
  assert.equal(JSON.parse(lines[1]).result.structuredContent.items.length, 2);
});
