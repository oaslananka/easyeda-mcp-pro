import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { type EnvConfig } from '../config/env.js';
import { SERVER_VERSION } from '../config/version.js';
import { getLogger } from '../utils/logger.js';
import { EasyedaApiMethodSchema } from './types.js';
import {
  BRIDGE_CONTRACT_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type BridgeHello,
} from './protocol.js';
import type { BridgeState } from './manager.js';

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCdpCall {
  resolve: (value: CdpResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  method: string;
}

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const EASYEDA_EDITOR_URL_PART = 'pro.easyeda.com/editor';
const WRITE_METHOD_RE = /^(schematic\.|pcb\.|project\.(save|export)|board\.|export\.)/;

export class CdpBridgeManager extends EventEmitter {
  public state: BridgeState = 'disconnected';
  public hello: BridgeHello | null = null;

  private config: EnvConfig;
  private ws: WebSocket | null = null;
  private requestIdCounter = 0;
  private pending = new Map<number, PendingCdpCall>();
  private _connectedAtMs = 0;
  private _lastHeartbeatMs = 0;
  private _activePort = 9222;
  private _target: CdpTarget | null = null;
  private _methodRegistryHash: string;

  constructor(config: EnvConfig) {
    super();
    this.config = config;
    this._methodRegistryHash = this.computeMethodRegistryHash();
  }

  get connected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  get activePort(): number {
    return this._activePort;
  }

  get uptimeMs(): number {
    if (!this.connected || this._connectedAtMs === 0) return 0;
    return Date.now() - this._connectedAtMs;
  }

  get lastHeartbeatMs(): number {
    return this._lastHeartbeatMs;
  }

  get methodRegistryHash(): string {
    return this._methodRegistryHash;
  }

  get easyedaVersion(): string | undefined {
    return this.hello?.easyedaVersion;
  }

  get extensionVersion(): string | undefined {
    return undefined;
  }

  get extensionVersionMismatch(): boolean {
    return false;
  }

  get extensionMethodListHash(): string | undefined {
    return this._methodRegistryHash;
  }

  get loaderVersion(): string | undefined {
    return undefined;
  }

  get registryMismatch(): boolean {
    return false;
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    const prev = this.state;
    this.state = 'connecting';
    this.emit('stateChanged', this.state, prev);

    const logger = getLogger();
    const baseUrl = this.getCdpBaseUrl();
    const targets = await this.fetchJson<CdpTarget[]>(`${baseUrl}/json/list`);
    const target = this.selectEasyedaTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      this.state = 'error';
      this.emit('stateChanged', 'error', 'connecting');
      throw new Error(
        'CDP bridge could not find an EasyEDA editor page target. Start EasyEDA Pro with --remote-debugging-port=9222 and open a project.',
      );
    }

    this._target = target;
    this._activePort = Number(new URL(baseUrl).port || '9222');
    this.ws = await this.openWebSocket(target.webSocketDebuggerUrl);
    this.attachSocketHandlers(this.ws);
    await this.cdp('Runtime.enable');

    const status = await this.evaluateObject<{ appVersion?: string; title?: string }>(
      `(() => ({
        title: document.title,
        href: location.href,
        appVersion: globalThis?.navigator?.userAgent?.match(/EasyEDAPro\\/([^ ]+)/)?.[1]
      }))()`,
    );

    this.state = 'connected';
    this._connectedAtMs = Date.now();
    this._lastHeartbeatMs = Date.now();
    this.hello = {
      type: 'hello',
      bridgeVersion: SERVER_VERSION,
      contractVersion: BRIDGE_CONTRACT_VERSION,
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      easyedaVersion: status.appVersion,
      capabilities: EasyedaApiMethodSchema.options,
      methodRegistryHash: this._methodRegistryHash,
      maxPayloadSize: this.config.BRIDGE_MAX_PAYLOAD_SIZE,
      devMode: true,
    };

    logger.info(
      { title: target.title, url: target.url },
      'cdp bridge connected to EasyEDA renderer',
    );
    this.emit('stateChanged', 'connected', prev);
    this.emit('connected', this.hello);
  }

  async call<TParams, TResult>(
    method: string,
    params?: TParams,
    opts?: { timeoutMs?: number; traceparent?: string },
  ): Promise<TResult> {
    if (!this.connected) {
      const waitMs = this.config.BRIDGE_WAIT_FOR_EDA_MS;
      if (waitMs > 0) {
        await this.waitForConnection(waitMs);
      }
    }
    if (!this.connected) {
      throw new Error(`CDP bridge not connected. Cannot call method "${method}".`);
    }

    const timeoutMs = opts?.timeoutMs ?? this.config.BRIDGE_TIMEOUT_MS;
    const startedAt = Date.now();

    try {
      const result = await this.dispatchMethod(method, params, timeoutMs);
      this._lastHeartbeatMs = Date.now();
      return result as TResult;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`CDP bridge method "${method}" failed after ${elapsed}ms: ${detail}`, {
        cause: err,
      });
    }
  }

  disconnect(reason?: string): void {
    const prev = this.state;
    this.state = 'disconnected';
    this.rejectPending(new Error(`CDP bridge disconnected: ${reason ?? 'unknown'}`));
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.hello = null;
    this._target = null;
    this.emit('stateChanged', this.state, prev);
    this.emit('disconnected', reason ?? 'unknown');
  }

  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('CDP bridge not connected'));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnected);
    });
  }

  private async dispatchMethod<TParams>(
    method: string,
    params: TParams,
    timeoutMs: number,
  ): Promise<unknown> {
    if (method === 'system.getStatus') {
      return this.evaluateObject(this.statusExpression());
    }

    if (method === 'system.apiInventory') {
      return this.evaluateObject(this.inventoryExpression());
    }

    if (method === 'api.execute') {
      const expression = this.extractExpression(params);
      if (!expression) {
        throw new Error('api.execute requires one of: expression, code, script.');
      }
      return this.evaluateObject(expression, timeoutMs);
    }

    if (method === 'api.call') {
      const expression = this.apiCallExpression(params);
      return this.evaluateObject(expression, timeoutMs);
    }

    if (method === 'schematic.getSheetInfo') {
      return this.evaluateObject(this.sheetInfoExpression(), timeoutMs);
    }

    if (method === 'schematic.listComponents') {
      return this.evaluateObject(this.componentListExpression(), timeoutMs);
    }

    if (method === 'schematic.listNets') {
      return this.evaluateObject(this.netListExpression(), timeoutMs);
    }

    if (method === 'schematic.searchDevice') {
      return this.evaluateObject(this.searchDeviceExpression(params), timeoutMs);
    }

    if (method === 'schematic.placeComponent') {
      this.requireMappedWriteAllowed(method);
      return this.evaluateObject(this.placeComponentExpression(params), timeoutMs);
    }

    if (method === 'schematic.addWire') {
      this.requireMappedWriteAllowed(method);
      return this.evaluateObject(this.addWireExpression(params), timeoutMs);
    }

    if (method === 'schematic.createNetFlag') {
      this.requireMappedWriteAllowed(method);
      return this.evaluateObject(this.createNetFlagExpression(params), timeoutMs);
    }

    if (method === 'schematic.createNetPort') {
      this.requireMappedWriteAllowed(method);
      return this.evaluateObject(this.createNetPortExpression(params), timeoutMs);
    }

    if (WRITE_METHOD_RE.test(method) && process.env.EASYEDA_CDP_ALLOW_UNMAPPED_WRITES !== 'true') {
      throw new Error(
        `CDP bridge has not mapped mutating EasyEDA method "${method}" yet. Use api.execute for explicit runtime probes, or set EASYEDA_CDP_ALLOW_UNMAPPED_WRITES=true only in a disposable test project.`,
      );
    }

    return this.evaluateObject(this.genericBridgeCallExpression(method, params), timeoutMs);
  }

  private getCdpBaseUrl(): string {
    return (process.env.EASYEDA_CDP_URL ?? DEFAULT_CDP_URL).replace(/\/$/, '');
  }

  private selectEasyedaTarget(targets: CdpTarget[]): CdpTarget | undefined {
    const explicit = process.env.EASYEDA_CDP_TARGET_ID;
    if (explicit) return targets.find((target) => target.id === explicit);
    return (
      targets.find(
        (target) => target.type === 'page' && target.url.includes(EASYEDA_EDITOR_URL_PART),
      ) ??
      targets.find((target) => target.type === 'page' && /JLCEDA|EasyEDA/i.test(target.title)) ??
      targets.find((target) => target.type === 'page')
    );
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CDP HTTP request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  private openWebSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), 5_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as CdpResponse;
      if (data.id !== undefined) {
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          pending.resolve(data);
        }
      }
    });

    ws.on('close', (code, reason) => {
      if (this.state !== 'disconnected') {
        const prev = this.state;
        this.state = 'connecting';
        this.emit('stateChanged', 'connecting', prev);
        this.emit('disconnected', reason.toString() || `cdp_close_${code}`);
      }
    });

    ws.on('error', (err) => {
      getLogger().error({ err }, 'cdp bridge websocket error');
      this.emit('error', err);
    });
  }

  private cdp(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.config.BRIDGE_TIMEOUT_MS,
  ): Promise<CdpResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }
    const id = ++this.requestIdCounter;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now(), method });
      this.ws?.send(message);
    });
  }

  private async evaluateObject<T = unknown>(
    expression: string,
    timeoutMs = this.config.BRIDGE_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.cdp(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: timeoutMs,
      },
      timeoutMs,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const result = response.result as {
      result?: { value?: unknown; unserializableValue?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Runtime evaluation failed',
      );
    }

    return (result?.result?.value ??
      result?.result?.unserializableValue ??
      result?.result?.description) as T;
  }

  private extractExpression(params: unknown): string | undefined {
    if (!params || typeof params !== 'object') return undefined;
    const record = params as Record<string, unknown>;
    const value = record.expression ?? record.code ?? record.script;
    return typeof value === 'string' ? value : undefined;
  }

  private apiCallExpression(params: unknown): string {
    const record = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const targetMethod = String(record.method ?? record.name ?? '');
    const args = JSON.stringify(record.args ?? record.params ?? []);
    if (!targetMethod) {
      throw new Error('api.call requires method/name.');
    }
    return `(() => {
      const path = ${JSON.stringify(targetMethod)}.split('.');
      let fn = globalThis;
      for (const part of path) fn = fn?.[part];
      if (typeof fn !== 'function') throw new Error('Runtime API function not found: ${targetMethod}');
      return fn(...${args});
    })()`;
  }

  private runtimePrelude(): string {
    return `
      const readPath = (source, path) => path.split('.').reduce((acc, part) => acc == null ? undefined : acc[part], source);
      const readFirst = (paths) => {
        const roots = [];
        try { if (typeof eda !== 'undefined' && eda) roots.push(eda); } catch {}
        try { if (typeof EDA !== 'undefined' && EDA) roots.push(EDA); } catch {}
        try { if (typeof api !== 'undefined' && api) roots.push(api); } catch {}
        roots.push(globalThis);
        for (const root of roots) for (const path of paths) {
          const value = readPath(root, path);
          if (value !== undefined && value !== null) return value;
        }
        return undefined;
      };
      const callFirst = async (paths, ...args) => {
        const roots = [];
        try { if (typeof eda !== 'undefined' && eda) roots.push(eda); } catch {}
        try { if (typeof EDA !== 'undefined' && EDA) roots.push(EDA); } catch {}
        try { if (typeof api !== 'undefined' && api) roots.push(api); } catch {}
        roots.push(globalThis);
        for (const root of roots) for (const path of paths) {
          const parts = path.split('.');
          const name = parts.pop();
          const parent = parts.reduce((acc, part) => acc == null ? undefined : acc[part], root);
          const fn = parent == null ? undefined : parent[name];
          if (typeof fn === 'function') return await fn.apply(parent, args);
        }
        throw new Error('No EasyEDA runtime implementation found for ' + paths.join(' or '));
      };
    `;
  }

  private sheetInfoExpression(): string {
    return `async () => {}`.replace(
      'async () => {}',
      `
      (async () => {
        ${this.runtimePrelude()}
        const currentPage = await callFirst(['DMT_Schematic.getCurrentSchematicPageInfo','dmt_Schematic.getCurrentSchematicPageInfo']);
        let pages = [];
        try {
          pages = await callFirst(['DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo','DMT_Schematic.getAllSchematicPagesInfo','dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo','dmt_Schematic.getAllSchematicPagesInfo']);
        } catch (error) {
          pages = { warning: String(error && error.message || error) };
        }
        return { currentPage, pages };
      })()
    `,
    );
  }

  private componentListExpression(): string {
    return `
      (async () => {
        ${this.runtimePrelude()}
        const klass = readFirst(['SCH_PrimitiveComponent','SCH_PrimitiveComponent3','sch_PrimitiveComponent']);
        const fpKlass = readFirst(['LIB_Footprint','lib_Footprint']);
        if (!klass || typeof klass.getAll !== 'function') throw new Error('SCH_PrimitiveComponent.getAll is not available');
        const comps = await klass.getAll(undefined, true);
        const result = [];
        for (const c of comps || []) {
          const reference = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
          const value = typeof c.getState_Name === 'function' ? c.getState_Name() : '';
          let footprint = '';
          try {
            const fpInfo = typeof c.getState_Footprint === 'function' ? c.getState_Footprint() : undefined;
            if (fpInfo && fpInfo.uuid && fpKlass && typeof fpKlass.get === 'function') {
              const fp = await fpKlass.get(fpInfo.uuid, fpInfo.libraryUuid);
              footprint = fp && fp.name || '';
            }
          } catch {}
          const lcsc = typeof c.getState_SupplierId === 'function' ? c.getState_SupplierId() : '';
          const manufacturer = typeof c.getState_Manufacturer === 'function' ? c.getState_Manufacturer() : '';
          result.push({ reference, value, footprint, lcsc, manufacturer });
        }
        return result;
      })()
    `;
  }

  private netListExpression(): string {
    return `
      (async () => {
        ${this.runtimePrelude()}
        const klass = readFirst(['SCH_PrimitiveComponent','SCH_PrimitiveComponent3','sch_PrimitiveComponent']);
        const netKlass = readFirst(['SCH_Net','sch_Net']);
        if (!klass || typeof klass.getAll !== 'function') throw new Error('SCH_PrimitiveComponent.getAll is not available');
        const comps = await klass.getAll(undefined, true);
        const netMap = new Map();
        const add = (netName, node) => {
          if (!netName) return;
          const key = String(netName);
          if (!netMap.has(key)) netMap.set(key, []);
          if (node && !netMap.get(key).some((n) => n.component === node.component && n.pin === node.pin)) netMap.get(key).push(node);
        };
        for (const c of comps || []) {
          const ref = typeof c.getState_Designator === 'function' ? c.getState_Designator() : '';
          if (!ref || typeof c.getAllPins !== 'function') continue;
          try {
            const pins = await c.getAllPins();
            for (const pin of pins || []) {
              const pinNumber = typeof pin.getState_PinNumber === 'function' ? pin.getState_PinNumber() : '';
              const other = typeof pin.getState_OtherProperty === 'function' ? pin.getState_OtherProperty() : undefined;
              const netName = other && (other.net || other.Net || other.NET);
              add(netName, { component: ref, pin: pinNumber });
            }
          } catch {}
        }
        if (netKlass && typeof netKlass.getAllNets === 'function') {
          try {
            const all = await netKlass.getAllNets();
            for (const n of all || []) add(n.netName || n.net || n.name, null);
          } catch {}
        }
        return Array.from(netMap.entries()).map(([netName, nodes]) => ({ netName, nodes }));
      })()
    `;
  }

  private requireMappedWriteAllowed(method: string): void {
    if (process.env.EASYEDA_CDP_ALLOW_WRITES !== 'true') {
      throw new Error(
        `CDP mapped write method "${method}" requires EASYEDA_CDP_ALLOW_WRITES=true. Use only on a disposable EasyEDA test project.`,
      );
    }
  }

  private searchDeviceExpression(params: unknown): string {
    const p = JSON.stringify(params ?? {});
    return `
      (async () => {
        ${this.runtimePrelude()}
        const params = ${p};
        return await callFirst(['LIB_Device.search','lib_Device.search'], params.key, params.libraryUuid, params.classification, params.symbolType, params.itemsOfPage, params.page);
      })()
    `;
  }

  private placeComponentExpression(params: unknown): string {
    const p = JSON.stringify(params ?? {});
    return `
      (async () => {
        ${this.runtimePrelude()}
        const params = ${p};
        if (!params.deviceItem) throw new Error('schematic.placeComponent requires deviceItem. Use schematic.searchDevice first.');
        const result = await callFirst(['SCH_PrimitiveComponent.create','sch_PrimitiveComponent.create'], params.deviceItem, params.x, params.y);
        return { primitiveId: result?.uuid || result?.id || result?.primitiveId || null, raw: result };
      })()
    `;
  }

  private addWireExpression(params: unknown): string {
    const p = JSON.stringify(params ?? {});
    return `
      (async () => {
        ${this.runtimePrelude()}
        const params = ${p};
        const points = Array.isArray(params.points) ? params.points.flatMap((point) => [point.x, point.y]) : [];
        if (points.length < 4) throw new Error('schematic.addWire requires at least two points.');
        const result = await callFirst(['SCH_PrimitiveWire.create','sch_PrimitiveWire.create'], points, params.netName, params.color, params.lineWidth, params.lineType);
        return { primitiveId: result?.uuid || result?.id || result?.primitiveId || null, raw: result };
      })()
    `;
  }

  private createNetFlagExpression(params: unknown): string {
    const p = JSON.stringify(params ?? {});
    return `
      (async () => {
        ${this.runtimePrelude()}
        const params = ${p};
        const powerIds = ['Power','Ground','AnalogGround','ProtectGround'];
        let result;
        if (params.identification && powerIds.includes(params.identification)) {
          result = await callFirst(['SCH_PrimitiveComponent.createNetFlag','sch_PrimitiveComponent.createNetFlag'], params.identification, params.netName, params.x, params.y, params.rotation || 0);
        } else {
          result = await callFirst(['SCH_PrimitiveAttribute.createNetLabel','sch_PrimitiveAttribute.createNetLabel'], params.x, params.y, params.netName);
        }
        return { primitiveId: result?.uuid || result?.id || result?.primitiveId || null, netName: params.netName, raw: result };
      })()
    `;
  }

  private createNetPortExpression(params: unknown): string {
    const p = JSON.stringify(params ?? {});
    return `
      (async () => {
        ${this.runtimePrelude()}
        const params = ${p};
        const map = { input: 'IN', output: 'OUT', bidirectional: 'BI', triState: 'BI', passive: 'BI' };
        const direction = map[params.portType || 'passive'] || 'BI';
        const result = await callFirst(['SCH_PrimitiveComponent.createNetPort','sch_PrimitiveComponent.createNetPort'], direction, params.netName, params.x, params.y, params.rotation || 0);
        return { primitiveId: result?.uuid || result?.id || result?.primitiveId || null, netName: params.netName, raw: result };
      })()
    `;
  }

  private genericBridgeCallExpression(method: string, params: unknown): string {
    return `(() => {
      const detail = {
        method: ${JSON.stringify(method)},
        params: ${JSON.stringify(params ?? null)},
        title: document.title,
        href: location.href,
        hint: 'CDP generic bridge reached EasyEDA renderer, but this MCP method is not mapped to EasyEDA runtime APIs yet.'
      };
      return { ok: false, code: 'CDP_METHOD_NOT_MAPPED', detail };
    })()`;
  }

  private statusExpression(): string {
    return `(() => ({
      bridge: 'cdp',
      title: document.title,
      href: location.href,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      target: ${JSON.stringify(this._target)},
      easyedaLikeGlobals: Object.keys(globalThis).filter((key) => /easy|eda|jlc|api|sch|pcb|editor|project|gvar/i.test(key)).slice(0, 120)
    }))()`;
  }

  private inventoryExpression(): string {
    return `(() => {
      const keys = Object.keys(globalThis);
      const candidates = keys.filter((key) => /easy|eda|jlc|api|sch|pcb|editor|project|gvar|canvas|primitive|net|component/i.test(key));
      const globals = candidates.slice(0, 240).map((key) => {
        const value = globalThis[key];
        return {
          key,
          type: typeof value,
          ctor: value?.constructor?.name,
          ownKeys: value && (typeof value === 'object' || typeof value === 'function') ? Object.keys(value).slice(0, 40) : []
        };
      });
      return {
        bridge: 'cdp',
        title: document.title,
        href: location.href,
        readyState: document.readyState,
        globals,
        localStorageKeys: (() => { try { return Object.keys(localStorage).slice(0, 120); } catch { return []; } })(),
        sessionStorageKeys: (() => { try { return Object.keys(sessionStorage).slice(0, 120); } catch { return []; } })()
      };
    })()`;
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private computeMethodRegistryHash(): string {
    const sorted = [...EasyedaApiMethodSchema.options].sort();
    return crypto.createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 16);
  }
}
