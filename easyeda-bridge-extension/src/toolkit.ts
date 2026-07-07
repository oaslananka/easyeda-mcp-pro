// The contract between the loader (index.ts — socket lifecycle, handshake,
// heartbeat) and the dispatcher module (dispatcher.ts — every EasyEDA API
// interaction). The dispatcher must reach ALL runtime globals through this
// toolkit, never via bare identifiers: the baked bundle runs in the extension
// script scope where `eda`/`EDA`/`api` may exist as scope-locals, but a
// hot-swapped dispatcher is eval'd via AsyncFunction where only globalThis is
// visible. Routing through the toolkit makes the same code correct in both.

export interface DispatcherToolkit {
  /** The `eda` runtime global (extension scope or globalThis), if present. */
  getEda(): unknown;
  /** The `EDA` runtime global, if present. */
  getEDA(): unknown;
  /** The `api` runtime global, if present. */
  getApi(): unknown;
  /** The best global object to resolve EasyEDA classes on (eda, else globalThis). */
  getGlobal(): Record<string, unknown> | null;
  /** Loader log sink (console with the extension prefix). */
  log(message: string, data?: unknown): void;
  /** Show a toast in the EasyEDA UI (falls back to console). */
  showToast(message: string): void;
  /** The server-advertised BRIDGE_MAX_PAYLOAD_SIZE (updated on hello). */
  getBridgeMaxPayloadSize(): number;
  /** The bridge protocol version string reported by system.getStatus. */
  getBridgeVersion(): string;
}

export interface Dispatcher {
  dispatch(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Every bridge method this dispatcher can handle, sorted. */
  methodList: string[];
  /** Build identifier injected at bundle time; distinguishes pushed builds. */
  buildId: string;
}

export type DispatcherFactory = (toolkit: DispatcherToolkit) => Dispatcher;
