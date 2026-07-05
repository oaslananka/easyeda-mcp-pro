import { type EnvConfig } from '../config/env.js';
import { registerBoardTools } from './L1_board.js';
import { registerBomCoreTools } from './L1_bom_core.js';
import { registerBomSourcingTools } from './L1_bom_sourcing.js';
import { registerDiagnosticsCore } from './L0_diagnostics_core.js';
import { registerDiagnosticsApi } from './L0_diagnostics_api.js';
import { registerDrcErcTools } from './L1_drc_erc.js';
import { registerExportTools } from './L1_export.js';
import { registerPcbConstraintTools } from './L1_pcb_constraints.js';
import { registerPcbWriteTools } from './L1_pcb_write.js';
import { registerSchematicReadTools } from './L1_schematic_read.js';
import { registerSchematicWriteTools } from './L1_schematic_write.js';
import { registerVisualTools } from './L1_visual.js';
import { type ToolRegistry } from './registry.js';

export function registerBuiltinTools(registry: ToolRegistry, config: EnvConfig): void {
  registerDiagnosticsCore(registry, config);
  registerDiagnosticsApi(registry, config);
  registerSchematicReadTools(registry, config);
  registerSchematicWriteTools(registry, config);
  registerBomCoreTools(registry, config);
  registerBomSourcingTools(registry, config);
  registerDrcErcTools(registry, config);
  registerBoardTools(registry, config);
  registerPcbConstraintTools(registry, config);
  registerPcbWriteTools(registry, config);
  registerExportTools(registry, config);
  registerVisualTools(registry, config);
}
