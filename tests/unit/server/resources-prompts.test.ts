import { describe, expect, it, vi } from 'vitest';
import { registerProjectResourcesAndPrompts } from '../../../src/server/resources-prompts.js';
import { type ToolContext } from '../../../src/tools/types.js';

type ServerParameter = Parameters<typeof registerProjectResourcesAndPrompts>[0];

interface RegisteredResourceEntry {
  name: string;
  target: unknown;
  metadata: Record<string, unknown>;
  callback: (...args: unknown[]) => unknown;
}

interface RegisteredPromptEntry {
  name: string;
  config: Record<string, unknown>;
  callback: (...args: unknown[]) => unknown;
}

function createMockServer() {
  const resources: RegisteredResourceEntry[] = [];
  const prompts: RegisteredPromptEntry[] = [];
  return {
    resources,
    prompts,
    server: {
      registerResource: vi.fn((name, target, metadata, callback) => {
        resources.push({ name, target, metadata, callback });
      }),
      registerPrompt: vi.fn((name, config, callback) => {
        prompts.push({ name, config, callback });
      }),
    },
  };
}

function createMockContext(): ToolContext {
  return {
    profile: 'core',
    bridge: {
      connected: true,
      call: vi.fn(async (method: string) => {
        if (method === 'schematic.listNets') {
          return [
            {
              netName: 'VCC',
              nodes: [
                { component: 'U1', pin: '1' },
                { component: 'C1', pin: '1' },
              ],
            },
          ];
        }
        if (method === 'bom.generate') {
          return [
            {
              reference: 'R1',
              value: '10k',
              footprint: '0603',
              lcsc: 'C25804',
              quantity: 1,
              manufacturer: 'Yageo',
            },
          ];
        }
        return [];
      }),
    },
    config: {
      bridgeTimeoutMs: 15000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      bridgeHost: '127.0.0.1',
      bridgePort: 49620,
    },
    vendors: {
      lcsc: null,
      jlcpcb: null,
      mouser: null,
      digikey: null,
    },
  };
}

function asMcpServer(server: unknown): ServerParameter {
  return server as ServerParameter;
}

function requireResource(
  resources: RegisteredResourceEntry[],
  name: string,
): RegisteredResourceEntry {
  const resource = resources.find((entry) => entry.name === name);
  if (!resource) throw new Error(`Missing resource: ${name}`);
  return resource;
}

function requirePrompt(prompts: RegisteredPromptEntry[], name: string): RegisteredPromptEntry {
  const prompt = prompts.find((entry) => entry.name === name);
  if (!prompt) throw new Error(`Missing prompt: ${name}`);
  return prompt;
}

function firstTextContent(result: { contents: Array<{ text: string }> }): string {
  const [content] = result.contents;
  if (!content) throw new Error('Missing resource content.');
  return content.text;
}

describe('registerProjectResourcesAndPrompts', () => {
  it('should register project resources and review prompts', () => {
    const { server, resources, prompts } = createMockServer();

    registerProjectResourcesAndPrompts(asMcpServer(server), createMockContext());

    expect(resources.map((resource) => resource.name)).toEqual([
      'project_netlist',
      'project_bom',
      'project_review_workflow',
      'design_rules_reference',
      'design_rules_dfm_checklist',
    ]);
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'review_schematic',
      'review_bom',
      'prepare_manufacturing_review',
      'review_layout',
    ]);
  });

  it('should expose a design rules reference resource', async () => {
    const { server, resources } = createMockServer();
    registerProjectResourcesAndPrompts(asMcpServer(server), createMockContext());

    const resource = requireResource(resources, 'design_rules_reference');
    const result = (await resource.callback(
      new URL('easyeda://design-rules/reference'),
      {},
      {},
    )) as {
      contents: Array<{ text: string }>;
    };

    expect(firstTextContent(result)).toContain('easyeda_design_rules_lookup');
  });

  it('should expose the static DFM checklist as a JSON resource', async () => {
    const { server, resources } = createMockServer();
    registerProjectResourcesAndPrompts(asMcpServer(server), createMockContext());

    const resource = requireResource(resources, 'design_rules_dfm_checklist');
    const result = (await resource.callback(
      new URL('easyeda://design-rules/dfm-checklist'),
      {},
      {},
    )) as { contents: Array<{ text: string }> };
    const payload = JSON.parse(firstTextContent(result)) as { items: unknown[] };

    expect(payload.items.length).toBeGreaterThan(5);
  });

  it('should create a review_layout prompt that references the design rules tool', () => {
    const { server, prompts } = createMockServer();
    registerProjectResourcesAndPrompts(asMcpServer(server), createMockContext());

    const prompt = requirePrompt(prompts, 'review_layout');
    const result = prompt.callback({ projectId: 'demo' }, {}) as {
      messages: Array<{ content: { text: string } }>;
    };

    const [message] = result.messages;
    if (!message) throw new Error('Missing prompt message.');
    expect(message.content.text).toContain('easyeda_design_rules_lookup');
    expect(message.content.text).toContain('easyeda_pcb_constraint_check');
  });

  it('should expose a project netlist resource through the bridge', async () => {
    const { server, resources } = createMockServer();
    const context = createMockContext();
    registerProjectResourcesAndPrompts(asMcpServer(server), context);

    const resource = requireResource(resources, 'project_netlist');

    const result = (await resource.callback(
      new URL('easyeda://project/demo/netlist'),
      { projectId: 'demo' },
      {},
    )) as { contents: Array<{ text: string }> };
    const payload = JSON.parse(firstTextContent(result)) as { project_id: string; total: number };

    expect(context.bridge.call).toHaveBeenCalledWith('schematic.listNets', { projectId: 'demo' });
    expect(payload.project_id).toBe('demo');
    expect(payload.total).toBe(1);
  });

  it('should expose a project BOM resource through the bridge', async () => {
    const { server, resources } = createMockServer();
    const context = createMockContext();
    registerProjectResourcesAndPrompts(asMcpServer(server), context);

    const resource = requireResource(resources, 'project_bom');

    const result = (await resource.callback(
      new URL('easyeda://project/demo/bom'),
      { projectId: 'demo' },
      {},
    )) as { contents: Array<{ text: string }> };
    const payload = JSON.parse(firstTextContent(result)) as {
      project_id: string;
      total_entries: number;
    };

    expect(context.bridge.call).toHaveBeenCalledWith('bom.generate', {
      projectId: 'demo',
      format: 'json',
      groupBy: 'value',
    });
    expect(payload.project_id).toBe('demo');
    expect(payload.total_entries).toBe(1);
  });

  it('should create prompts that point agents to the registered resources', () => {
    const { server, prompts } = createMockServer();
    registerProjectResourcesAndPrompts(asMcpServer(server), createMockContext());

    const prompt = requirePrompt(prompts, 'review_schematic');

    const result = prompt.callback({ projectId: 'demo' }, {}) as {
      messages: Array<{ content: { text: string } }>;
    };

    const [message] = result.messages;
    if (!message) throw new Error('Missing prompt message.');
    expect(message.content.text).toContain('easyeda://project/demo/netlist');
    expect(message.content.text).toContain('easyeda://project/demo/bom');
    expect(message.content.text).toContain('easyeda://workflow/project-review');
  });
});
