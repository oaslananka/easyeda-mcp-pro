// Entry point for the standalone dispatcher bundle (dist/dispatcher.js).
// The loader evals this bundle during a hot swap and picks the factory up
// from globalThis, then calls it with its DispatcherToolkit.
import { createDispatcher } from './dispatcher.js';

(globalThis as { __mcpDispatcherFactory?: unknown }).__mcpDispatcherFactory = createDispatcher;
