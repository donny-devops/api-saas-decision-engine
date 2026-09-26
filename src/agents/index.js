import { AgentMesh } from './mesh.js';
import { createSpecialists } from './specialists.js';
import { MasterAgent } from './master.js';

/** Build the default agent mesh: five specialists + the master agent as a mesh member. */
export function createAgentSystem({ lookup, rulesFor, remotes = {} } = {}) {
  const mesh = new AgentMesh();
  for (const agent of createSpecialists({ lookup, rulesFor })) mesh.register(agent);
  const master = new MasterAgent(mesh);
  mesh.register({
    name: 'master',
    description: 'Plans and delegates questions across specialist agents.',
    skills: { ask: { description: 'Answer a question with recommendations', credits: 10, handler: ({ question, scenario }) => master.ask(question, { scenario }) } },
  });
  for (const [name, cfg] of Object.entries(remotes)) mesh.registerRemote(name, cfg);
  return { mesh, master };
}

export { AgentMesh, MasterAgent };
