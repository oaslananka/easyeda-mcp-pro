import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_JS } from '../../../src/cloud/portal-assets.js';

type ClickHandler = () => Promise<void>;

class TestElement {
  dataset: Record<string, string> = {};
  textContent = '';
  className = '';
  disabled = false;
  hidden = false;
  children: TestElement[] = [];
  listeners = new Map<string, ClickHandler>();
  classList = {
    classes: new Set<string>(),
    add(name: string) {
      this.classes.add(name);
    },
    remove(name: string) {
      this.classes.delete(name);
    },
    contains(name: string) {
      return this.classes.has(name);
    },
  };

  addEventListener(name: string, handler: ClickHandler): void {
    this.listeners.set(name, handler);
  }

  appendChild(element: TestElement): void {
    this.children.push(element);
  }

  replaceChildren(...elements: TestElement[]): void {
    this.children = elements;
  }

  click(): Promise<void> {
    const handler = this.listeners.get('click');
    if (!handler) throw new Error('Missing click handler');
    return handler();
  }
}

describe('Hosted Cloud pairing-code user experience', () => {
  it('copies only a live code and removes it from the page when its lifetime ends', async () => {
    const elements = new Map<string, TestElement>();
    const get = (id: string): TestElement => {
      let element = elements.get(id);
      if (!element) {
        element = new TestElement();
        elements.set(id, element);
      }
      return element;
    };
    get('cloud-root').dataset.page = 'account';

    let clock = 10_000;
    let tick: (() => void) | undefined;
    const clipboard = vi.fn(async (_code: string) => {});
    const clipboardPayload = 'EDA-A1B2C3D4';
    let codeAttempts = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url === '/cloud/api/pairing-code' && codeAttempts++ === 0) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ message: 'Service temporarily unavailable' }),
        };
      }
      const result =
        url === '/cloud/api/me'
          ? { user: { name: 'Acceptance Owner' } }
          : url === '/cloud/api/extensions'
            ? { sessions: [], selection: null }
            : url === '/cloud/api/clients'
              ? { clients: [] }
              : url === '/cloud/api/pairing-code'
                ? { code: clipboardPayload, expiresInSeconds: 600 }
                : null;
      if (!result) throw new Error('Unexpected request: ' + url);
      return { ok: true, json: async () => result };
    });

    runInNewContext(CLOUD_JS, {
      document: {
        getElementById: (id: string) => get(id),
        createElement: () => new TestElement(),
      },
      window: { location: { search: '', assign: vi.fn() } },
      navigator: { clipboard: { writeText: clipboard } },
      fetch,
      Date: { now: () => clock },
      setInterval: (callback: () => void) => {
        tick = callback;
        return 1;
      },
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(get('generate-pairing').listeners.has('click')).toBe(true));
    await get('generate-pairing').click();
    expect(get('notice').classList.contains('error')).toBe(true);

    await get('generate-pairing').click();
    expect(get('notice').classList.contains('error')).toBe(false);
    expect(get('pairing-code').textContent).toBe(clipboardPayload);
    expect(get('copy-pairing').disabled).toBe(false);
    expect(get('copy-pairing').hidden).toBe(false);
    expect(get('pairing-hint').textContent).toContain('10:00');

    await get('copy-pairing').click();
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(clipboardPayload);
    expect(get('notice').textContent).toContain('Code copied');

    clipboard.mockRejectedValueOnce(new Error('Clipboard permission denied'));
    await get('copy-pairing').click();
    expect(get('notice').textContent).toContain('Select the displayed code');

    clock += 600_001;
    tick?.();
    expect(get('pairing-code').textContent).toBe('Expired');
    expect(get('copy-pairing').disabled).toBe(true);
    expect(get('copy-pairing').hidden).toBe(true);
    expect(get('pairing-hint').textContent).toContain('Generate a new code');

    await get('copy-pairing').click();
    expect(clipboard).toHaveBeenCalledTimes(2);
    expect(get('pairing-code').textContent).not.toContain(clipboardPayload);
  });

  it('allows the owner to reselect a newly focused PCB within the same project', async () => {
    const elements = new Map<string, TestElement>();
    const get = (id: string): TestElement => {
      let element = elements.get(id);
      if (!element) {
        element = new TestElement();
        elements.set(id, element);
      }
      return element;
    };
    get('cloud-root').dataset.page = 'account';

    let activeProjectId = 'project-1';
    let activeDocumentId = 'pcb-1';
    let selectedProjectId = activeProjectId;
    let selectedDocumentId = activeDocumentId;
    const fetch = vi.fn(async (url: string, options?: { method?: string }) => {
      const result =
        url === '/cloud/api/me'
          ? { user: { name: 'Acceptance Owner' } }
          : url === '/cloud/api/extensions'
            ? {
                sessions: [
                  {
                    sessionId: 'sess_test',
                    connected: true,
                    mode: 'hosted',
                    extensionVersion: '1.15.4',
                    activeProject: {
                      projectId: activeProjectId,
                      documentId: activeDocumentId,
                      projectName: 'Disposable',
                      documentType: 'pcb',
                    },
                  },
                ],
                selection: {
                  sessionId: 'sess_test',
                  projectId: selectedProjectId,
                  documentId: selectedDocumentId,
                },
              }
            : url === '/cloud/api/clients'
              ? { clients: [] }
              : url === '/cloud/api/selection' && options?.method === 'PUT'
                ? {
                    selection: {
                      sessionId: 'sess_test',
                      projectId: activeProjectId,
                      documentId: activeDocumentId,
                    },
                  }
                : null;
      if (!result) throw new Error('Unexpected request: ' + url);
      if (url === '/cloud/api/selection') {
        selectedProjectId = activeProjectId;
        selectedDocumentId = activeDocumentId;
      }
      return { ok: true, json: async () => result };
    });

    runInNewContext(CLOUD_JS, {
      document: {
        getElementById: (id: string) => get(id),
        createElement: () => new TestElement(),
      },
      window: { location: { search: '', assign: vi.fn() } },
      navigator: {},
      fetch,
    });

    const button = (): TestElement => {
      const card = get('extensions').children[0];
      const choose = card?.children.find((child) => child.className === 'btn secondary');
      if (!choose) throw new Error('Expected a project/document selection button');
      return choose;
    };

    await vi.waitFor(() => expect(get('refresh-extensions').listeners.has('click')).toBe(true));
    expect(button().textContent).toBe('Selected PCB');
    expect(button().disabled).toBe(true);

    // A new native document under the SAME project must not appear selected.
    activeDocumentId = 'pcb-2';
    await get('refresh-extensions').click();
    expect(button().textContent).toBe('Use this PCB');
    expect(button().disabled).toBe(false);
    await button().click();
    expect(fetch).toHaveBeenCalledWith(
      '/cloud/api/selection',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(button().textContent).toBe('Selected PCB');
    expect(button().disabled).toBe(true);
    expect(get('notice').textContent).toContain('Document selected');

    // An unchanged document UUID in a DIFFERENT project is not selected either.
    activeProjectId = 'project-2';
    await get('refresh-extensions').click();
    expect(button().textContent).toBe('Use this PCB');
    expect(button().disabled).toBe(false);
  });
});
