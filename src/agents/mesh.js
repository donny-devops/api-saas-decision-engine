// Agent mesh: a registry + message bus that routes skill calls to local agents
// in-process, or to remote agents over A2A JSON-RPC. Every hop is recorded as
// an A2A-shaped message so the whole conversation between agents is traceable.
import { randomUUID } from 'node:crypto';

export class AgentMesh {
  constructor({ traceSize = 500, fetchImpl = fetch } = {}) {
    this.agents = new Map();
    this.remotes = new Map();
    this.trace = [];
    this.traceSize = traceSize;
    this.fetchImpl = fetchImpl;
  }

  /** @param {{name, description, skills: Record<string,{description, credits?, handler:(input, meta)=>Promise<any>}>}} agent */
  register(agent) {
    if (this.agents.has(agent.name)) throw new Error(`Agent "${agent.name}" already registered`);
    this.agents.set(agent.name, agent);
    return this;
  }

  /** Register an agent that lives in another service and speaks A2A. */
  registerRemote(name, { url, token }) {
    this.remotes.set(name, { url, token });
    return this;
  }

  list() {
    return [...this.agents.values()].map((a) => ({
      name: a.name, description: a.description, location: 'local',
      skills: Object.entries(a.skills).map(([id, s]) => ({ id, description: s.description, credits: s.credits ?? 1 })),
    })).concat([...this.remotes].map(([name, r]) => ({ name, location: 'remote', url: r.url })));
  }

  skill(agentName, skillId) {
    const s = this.agents.get(agentName)?.skills[skillId];
    if (!s) throw Object.assign(new Error(`Unknown skill ${agentName}.${skillId}`), { status: 404 });
    return s;
  }

  #record(entry) {
    this.trace.push({ at: new Date().toISOString(), ...entry });
    if (this.trace.length > this.traceSize) this.trace.splice(0, this.trace.length - this.traceSize);
  }

  async call(agentName, skillId, input = {}, meta = {}) {
    const messageId = randomUUID();
    const contextId = meta.contextId ?? randomUUID();
    this.#record({ messageId, contextId, from: meta.caller ?? 'client', to: agentName, skill: skillId, kind: 'request' });
    const t0 = Date.now();
    try {
      let output;
      if (this.agents.has(agentName)) {
        output = await this.skill(agentName, skillId).handler(input, { ...meta, contextId, mesh: this });
      } else if (this.remotes.has(agentName)) {
        output = await this.#callRemote(agentName, skillId, input, { messageId, contextId });
      } else {
        throw Object.assign(new Error(`Unknown agent "${agentName}"`), { status: 404 });
      }
      this.#record({ messageId, contextId, from: agentName, to: meta.caller ?? 'client', skill: skillId, kind: 'response', ms: Date.now() - t0 });
      return output;
    } catch (err) {
      this.#record({ messageId, contextId, from: agentName, to: meta.caller ?? 'client', skill: skillId, kind: 'error', error: err.message });
      throw err;
    }
  }

  async #callRemote(agentName, skillId, input, { messageId, contextId }) {
    const { url, token } = this.remotes.get(agentName);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        jsonrpc: '2.0', id: messageId, method: 'message/send',
        params: { message: { role: 'user', messageId, contextId, parts: [{ kind: 'data', data: { skill: skillId, input } }] }, metadata: { agent: agentName } },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    if (body.error) throw new Error(`Remote agent ${agentName}: ${body.error.message}`);
    return body.result?.artifacts?.[0]?.parts?.find((p) => p.kind === 'data')?.data;
  }
}
