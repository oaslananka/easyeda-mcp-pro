import { describe, expect, it, vi } from 'vitest';
import { createDesignRuleCheckOperations } from '../src/design-rule-check-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function createSubject() {
  const callFirst = vi.fn();
  const findFloatingPins = vi.fn().mockResolvedValue({ floatingPins: [], partRefs: [] });
  const logRecoverableError = vi.fn();
  const operations = createDesignRuleCheckOperations({
    callFirst,
    createBridgeError: bridgeError,
    logRecoverableError,
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    findFloatingPins,
  });
  return { operations, callFirst, findFloatingPins, logRecoverableError };
}

describe('design rule-check operations', () => {
  it('normalizes detailed leaves and nested UI trees', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      {
        name: 'Netlist mismatch',
        count: 1,
        list: [
          {
            ruleName: 'Missing connection',
            message: 'U1.1 is disconnected',
            severity: 'fatal',
            position: { x: 10, y: 20 },
            layer: 'TopLayer',
          },
        ],
      },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      totalViolations: 1,
      errorCount: 1,
      warningCount: 0,
      passed: false,
      violations: [
        {
          rule: 'Missing connection',
          description: 'U1.1 is disconnected',
          severity: 'error',
          location: { x: 10, y: 20, layer: 'TopLayer' },
        },
      ],
    });
    expect(callFirst).toHaveBeenCalledWith(['PCB_Drc.check'], true, true, true);
  });

  it('counts flat aggregate groups without inventing leaf detail', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      { type: 'error', count: 2 },
      { type: 'warn', count: 3 },
      { type: 'info', count: 4 },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      totalViolations: 9,
      errorCount: 2,
      warningCount: 3,
      passed: false,
    });
  });

  it('normalizes primitive leaves and every supported message, rule, component, and location fallback', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      'raw violation',
      null,
      { msg: 'from msg', rule: 'rule-direct', netName: 'N1', ref: 'R1', location: { x: 1, y: 2 } },
      { description: 'from description', ruleTypeName: 'rule-type', component: 'U1' },
      { text: 'from text', errorType: 'error-type', designator: 'D1' },
      { detail: 'from detail', name: 'named-rule', primitiveId: 'primitive-1' },
      { explanation: { str: 'from explanation' }, type: 'typed-rule', x: 5, y: 6 },
      { message: { nested: true }, ruleName: 'json-message' },
    ]);

    const result = await operations.runDrc();

    expect(result).toMatchObject({ totalViolations: 8, errorCount: 1, passed: false });
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'unknown', description: 'raw violation', severity: 'info' }),
      expect.objectContaining({ rule: 'unknown', description: 'null', severity: 'info' }),
      expect.objectContaining({
        rule: 'rule-direct',
        description: 'from msg',
        net: 'N1',
        component: 'R1',
        location: { x: 1, y: 2, layer: undefined },
      }),
      expect.objectContaining({
        rule: 'rule-type',
        description: 'from description',
        component: 'U1',
      }),
      expect.objectContaining({
        rule: 'error-type',
        description: 'from text',
        severity: 'error',
        component: 'D1',
      }),
      expect.objectContaining({
        rule: 'named-rule',
        description: 'from detail',
        component: 'primitive-1',
      }),
      expect.objectContaining({
        rule: 'typed-rule',
        description: 'from explanation',
        location: { x: 5, y: 6, layer: undefined },
      }),
      expect.objectContaining({ rule: 'json-message', description: '{"nested":true}' }),
    ]);
  });

  it('ignores object-valued severity and rule fields instead of leaking object stringification', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      {
        message: 'safe leaf',
        level: { unsafe: true },
        severity: { unsafe: true },
        rule: { unsafe: true },
        ruleName: { unsafe: true },
        ruleTypeName: 'safe-rule',
      },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      violations: [
        expect.objectContaining({
          rule: 'safe-rule',
          description: 'safe leaf',
          severity: 'info',
        }),
      ],
    });
  });

  it('uses only scalar aggregate title values for severity classification', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      {
        type: { unsafe: true },
        severity: { unsafe: true },
        title: [{ unsafe: true }, 'WARN', 42],
        count: 2,
      },
    ]);

    await expect(operations.runDrc()).resolves.toMatchObject({
      totalViolations: 2,
      warningCount: 2,
      passed: true,
      violations: [expect.objectContaining({ severity: 'warning' })],
    });
  });

  it('handles nested aggregate-only and empty trees, zero counts, and title variants', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([
      { list: [{ type: 'warn', count: 2 }] },
      { list: [{}], type: 'info', count: 0 },
      { title: ['WARN', 'group'], count: 1 },
      { title: 'error group', count: 1 },
      { count: 'not-numeric' },
    ]);

    const result = await operations.runDrc();

    expect(result).toMatchObject({
      totalViolations: 4,
      errorCount: 1,
      warningCount: 3,
      passed: false,
    });
    expect(result.violations).toHaveLength(3);
  });

  it('treats a non-array native response as an empty successful check', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue({ unexpected: true });

    await expect(operations.runDrc()).resolves.toEqual({
      violations: [],
      totalViolations: 0,
      errorCount: 0,
      warningCount: 0,
      passed: true,
    });
  });

  it('returns the PCB result without attempting schematic fallback when ruleCheck succeeds', async () => {
    const { operations, callFirst, logRecoverableError } = createSubject();
    callFirst.mockResolvedValue([{ type: 'info', count: 1 }]);

    await expect(operations.runRuleCheck()).resolves.toMatchObject({
      totalViolations: 1,
      passed: true,
    });
    expect(callFirst).toHaveBeenCalledTimes(1);
    expect(callFirst).toHaveBeenCalledWith(['PCB_Drc.check'], true, true, true);
    expect(logRecoverableError).not.toHaveBeenCalled();
  });

  it('runs a native schematic check for cross-domain validation consumers', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockResolvedValue([{ type: 'warn', count: 2 }]);

    await expect(operations.runSchematicCheck()).resolves.toMatchObject({
      totalViolations: 2,
      errorCount: 0,
      warningCount: 2,
      passed: true,
    });
    expect(callFirst).toHaveBeenCalledWith(['SCH_Drc.check'], true, true, true);
  });

  it('translates an inactive PCB context for design.drc', async () => {
    const { operations, callFirst } = createSubject();
    callFirst.mockRejectedValue(new Error('no PCB canvas'));

    await expect(operations.runDrc()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'PCB DRC is unavailable in the current editor context.',
      suggestion: 'Open and focus a PCB document, then retry design.drc.',
      data: { cause: 'no PCB canvas' },
    });
  });

  it('falls back from PCB to schematic for design.ruleCheck', async () => {
    const { operations, callFirst, logRecoverableError } = createSubject();
    callFirst
      .mockRejectedValueOnce(new Error('no PCB canvas'))
      .mockResolvedValueOnce([{ type: 'warn', count: 1 }]);

    await expect(operations.runRuleCheck()).resolves.toMatchObject({
      totalViolations: 1,
      errorCount: 0,
      warningCount: 1,
      passed: true,
    });
    expect(callFirst.mock.calls).toEqual([
      [['PCB_Drc.check'], true, true, true],
      [['SCH_Drc.check'], true, true, true],
    ]);
    expect(logRecoverableError).toHaveBeenCalledTimes(1);
  });

  it('reports both causes when neither canvas is available', async () => {
    const { operations, callFirst } = createSubject();
    callFirst
      .mockRejectedValueOnce(new Error('no PCB canvas'))
      .mockRejectedValueOnce(new Error('no schematic canvas'));

    await expect(operations.runRuleCheck()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { pcbCause: 'no PCB canvas', schematicCause: 'no schematic canvas' },
    });
  });

  it('supplements ERC with inferred floating pins', async () => {
    const floatingPins = [{ primitiveId: 'p1', designator: 'U1', pinNumber: '1' }];
    const { operations, callFirst, findFloatingPins } = createSubject();
    callFirst.mockResolvedValue([{ type: 'warn', count: 1 }]);
    findFloatingPins.mockResolvedValue({ floatingPins, partRefs: ['U1'] });

    await expect(operations.runErc()).resolves.toMatchObject({
      inferredFloatingPins: floatingPins,
      detailSource: 'inferred_partial',
    });
  });

  it('contains ERC inference failures and returns the native aggregate', async () => {
    const { operations, callFirst, findFloatingPins, logRecoverableError } = createSubject();
    callFirst.mockResolvedValue([{ type: 'warn', count: 1 }]);
    findFloatingPins.mockRejectedValue(new Error('inference failed'));

    await expect(operations.runErc()).resolves.toMatchObject({
      inferredFloatingPins: [],
      detailSource: 'native_aggregate_only',
      warningCount: 1,
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'design.erc: floating-pin inference failed',
      expect.any(Error),
    );
  });
});
