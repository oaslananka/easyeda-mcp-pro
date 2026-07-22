import { describe, expect, it, vi } from 'vitest';
import {
  classifyPostWriteQa,
  collectNativeRuleRunsForPostWriteQa,
} from '../../../src/workflows/schematic-post-write-qa.js';

describe('schematic post-write QA classifier', () => {
  it('fails duplicate net-name DRC warnings even when reported as warning', () => {
    const result = classifyPostWriteQa({
      projectId: 'proj-qa',
      drc: {
        violations: [
          {
            rule: 'wire-net',
            description: 'Wire $1N4 has multiple net names: VCC VCC VCC',
            severity: 'warning',
            net: 'VCC',
          },
        ],
        total_violations: 1,
        warning_count: 1,
      },
      erc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
    });

    expect(result.status).toBe('fail');
    expect(result.passed).toBe(false);
    expect(result.categories.duplicate_net_names).toBe(1);
    expect(result.issues[0]).toMatchObject({
      source: 'drc',
      category: 'duplicate_net_names',
      fatal: true,
      net: 'VCC',
    });
  });

  it('allows free wire-only networks for diagnostic fixtures', () => {
    const result = classifyPostWriteQa({
      projectId: 'fixture',
      policy: 'diagnostic-fixture',
      drc: {
        violations: [
          {
            description: 'The wire GND $1N5 is a free network with no pins attached.',
            severity: 'warning',
            net: 'GND',
          },
        ],
        total_violations: 1,
        warning_count: 1,
      },
      erc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
    });

    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.categories.free_network_no_pins).toBe(1);
    expect(result.issues[0].fatal).toBe(false);
  });

  it('fails free wire-only networks for real circuit workflows', () => {
    const result = classifyPostWriteQa({
      projectId: 'circuit',
      policy: 'circuit',
      drc: {
        violations: [
          {
            description: 'The wire VCC $1N4 is a free network with no pins attached.',
            severity: 'warning',
            net: 'VCC',
          },
        ],
        total_violations: 1,
        warning_count: 1,
      },
      erc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
    });

    expect(result.status).toBe('fail');
    expect(result.categories.free_network_no_pins).toBe(1);
    expect(result.issues[0].fatal).toBe(true);
  });

  it('fails inferred ERC floating pins', () => {
    const result = classifyPostWriteQa({
      projectId: 'proj-qa',
      drc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
      erc: {
        violations: [],
        total_violations: 1,
        warning_count: 1,
        inferred_floating_pins: [{ primitiveId: 'u1', designator: 'U1', pinNumber: '4' }],
      },
    });

    expect(result.status).toBe('fail');
    expect(result.categories.unconnected_pin).toBe(1);
    expect(result.issues[0]).toMatchObject({
      source: 'erc',
      component: 'U1',
      fatal: true,
    });
  });

  it('does not reintroduce an intentional no-connect issue after bridge inference filters it', async () => {
    const bridge = {
      call: vi.fn(async (method: string) => {
        if (method !== 'design.erc') throw new Error(`Unexpected method ${method}`);
        return {
          violations: [],
          totalViolations: 1,
          errorCount: 0,
          warningCount: 1,
          inferredFloatingPins: [],
        };
      }),
    };

    const runs = await collectNativeRuleRunsForPostWriteQa(bridge, 'proj-no-connect', {
      drc: false,
      erc: true,
    });
    const result = classifyPostWriteQa({ projectId: 'proj-no-connect', erc: runs.erc });

    expect(runs.erc).toMatchObject({
      total_violations: 1,
      error_count: 0,
      warning_count: 1,
      inferred_floating_pins: [],
    });
    expect(result.categories.unconnected_pin).toBe(0);
    expect(result.categories.native_rule_violation).toBe(1);
    expect(result.status).toBe('pass');
  });

  it('returns inconclusive when native DRC is unavailable and no fatal issue exists', () => {
    const result = classifyPostWriteQa({
      projectId: 'proj-qa',
      drc: { not_available: true, error: 'native DRC unavailable' },
      erc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
    });

    expect(result.status).toBe('inconclusive');
    expect(result.passed).toBe(false);
    expect(result.categories.native_drc_unavailable).toBe(1);
    expect(result.inconclusive_count).toBe(1);
  });

  it('passes a clean native DRC/ERC report', () => {
    const result = classifyPostWriteQa({
      projectId: 'proj-clean',
      drc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
      erc: { violations: [], total_violations: 0, error_count: 0, warning_count: 0 },
    });

    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.issue_count).toBe(0);
  });
});
