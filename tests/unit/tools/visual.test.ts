import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerVisualTools } from '../../../src/tools/L1_visual.js';
import { EnvSchema } from '../../../src/config/env.js';

describe('Visual Tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: any;

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerVisualTools(registry, config);

    bridgeCall = vi.fn();

    context = {
      profile: 'core',
      bridge: {
        connected: true,
        call: bridgeCall,
      },
      config: {
        bridgeTimeoutMs: 1000,
        artifactDir: '.easyeda-mcp-pro/artifacts',
      },
      vendors: {
        lcsc: null,
        jlcpcb: null,
        mouser: null,
        digikey: null,
      },
    };
  });

  describe('easyeda_canvas_capture', () => {
    it('returns a captured image on success', async () => {
      const tool = registry.get('easyeda_canvas_capture');
      expect(tool).toBeDefined();

      bridgeCall.mockResolvedValue({
        base64: 'ZmFrZS1wbmctYnl0ZXM=',
        mimeType: 'image/png',
        fileName: 'capture.png',
        byteLength: 14,
      });

      const result = await tool?.handler(context, {});

      expect(bridgeCall).toHaveBeenCalledWith('canvas.capture', { tabId: undefined });
      expect(result).toMatchObject({
        captured: true,
        mime_type: 'image/png',
        file_name: 'capture.png',
        byte_length: 14,
        image_base64: 'ZmFrZS1wbmctYnl0ZXM=',
      });
    });

    it('passes tabId through to the bridge call', async () => {
      const tool = registry.get('easyeda_canvas_capture');
      bridgeCall.mockResolvedValue({ base64: 'YQ==', mimeType: 'image/png' });

      await tool?.handler(context, { tabId: 'tab-1' });

      expect(bridgeCall).toHaveBeenCalledWith('canvas.capture', { tabId: 'tab-1' });
    });

    it('reports not_available when the bridge returns no image data', async () => {
      const tool = registry.get('easyeda_canvas_capture');
      bridgeCall.mockResolvedValue({});

      const result = await tool?.handler(context, {});

      expect(result?.captured).toBe(false);
      expect(result?.not_available).toBe(true);
    });

    it('reports not_available when the bridge call throws (e.g. payload too large)', async () => {
      const tool = registry.get('easyeda_canvas_capture');
      bridgeCall.mockRejectedValue(new Error('PAYLOAD_TOO_LARGE'));

      const result = await tool?.handler(context, {});

      expect(result?.captured).toBe(false);
      expect(result?.not_available).toBe(true);
      expect(result?.error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('produces an MCP image content block via imageContent', () => {
      const tool = registry.get('easyeda_canvas_capture');
      expect(tool?.imageContent).toBeDefined();

      const images = tool!.imageContent!({
        captured: true,
        image_base64: 'ZmFrZS1wbmctYnl0ZXM=',
        mime_type: 'image/png',
      });
      expect(images).toEqual([{ data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png' }]);
    });

    it('produces no image content when capture failed', () => {
      const tool = registry.get('easyeda_canvas_capture');
      const images = tool!.imageContent!({ captured: false });
      expect(images).toEqual([]);
    });
  });

  describe('easyeda_canvas_capture_region', () => {
    it('zooms to the region and returns the captured image', async () => {
      const tool = registry.get('easyeda_canvas_capture_region');
      expect(tool).toBeDefined();

      bridgeCall.mockResolvedValue({
        base64: 'cmVnaW9uLWJ5dGVz',
        mimeType: 'image/png',
        fileName: 'capture-region.png',
      });

      const result = await tool?.handler(context, {
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        tabId: 'tab-1',
      });

      expect(bridgeCall).toHaveBeenCalledWith('canvas.captureRegion', {
        left: 0,
        right: 100,
        top: 0,
        bottom: 50,
        tabId: 'tab-1',
      });
      expect(result).toMatchObject({ captured: true, image_base64: 'cmVnaW9uLWJ5dGVz' });
    });

    it('reports not_available on bridge error', async () => {
      const tool = registry.get('easyeda_canvas_capture_region');
      bridgeCall.mockRejectedValue(new Error('bridge offline'));

      const result = await tool?.handler(context, { left: 0, right: 1, top: 0, bottom: 1 });

      expect(result?.captured).toBe(false);
      expect(result?.not_available).toBe(true);
      expect(result?.error).toBe('bridge offline');
    });
  });

  describe('easyeda_schematic_capture_full_page', () => {
    it('frames runtime sheet geometry and reports the image transform', async () => {
      const tool = registry.get('easyeda_schematic_capture_full_page');
      expect(tool).toBeDefined();

      const png = Buffer.alloc(24);
      png.write('PNG', 1, 'ascii');
      png.writeUInt32BE(1200, 16);
      png.writeUInt32BE(800, 20);
      bridgeCall
        .mockResolvedValueOnce({ pageSize: { width: 600, height: 400, unit: 'mil' } })
        .mockResolvedValueOnce({
          base64: png.toString('base64'),
          mimeType: 'image/png',
          fileName: 'full-page.png',
          byteLength: png.length,
          selectionCleared: true,
        });

      const result = await tool?.handler(context, {
        projectId: 'project-1',
        tabId: 'tab-1',
        padding: 0,
        allowInferredA4: false,
      });

      expect(bridgeCall).toHaveBeenNthCalledWith(1, 'schematic.getSheetInfo', {
        projectId: 'project-1',
      });
      expect(bridgeCall).toHaveBeenNthCalledWith(2, 'canvas.captureRegion', {
        left: -0,
        right: 600,
        top: 400,
        bottom: -0,
        tabId: 'tab-1',
        clearSelection: true,
      });
      expect(result).toMatchObject({
        captured: true,
        deterministic_viewport: true,
        selection_overlays_removed: true,
        image_dimensions: { width: 1200, height: 800 },
        sheet_to_image_transform: {
          scale_x: 2,
          scale_y: -2,
          offset_x: 0,
          offset_y: 800,
        },
      });
    });

    it('fails safely when runtime sheet geometry is unavailable', async () => {
      const tool = registry.get('easyeda_schematic_capture_full_page');
      bridgeCall.mockResolvedValueOnce({});

      const result = await tool?.handler(context, { projectId: 'project-1' });

      expect(bridgeCall).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        captured: false,
        not_available: true,
        deterministic_viewport: false,
      });
      expect(result?.error).toContain('runtime sheet geometry');
    });
  });

  describe('easyeda_canvas_locate', () => {
    it('returns the resulting viewport rectangle', async () => {
      const tool = registry.get('easyeda_canvas_locate');
      expect(tool).toBeDefined();

      bridgeCall.mockResolvedValue({ left: 0, right: 10, top: 0, bottom: 10 });

      const result = await tool?.handler(context, { x: 5, y: 5, scaleRatio: 2 });

      expect(bridgeCall).toHaveBeenCalledWith('canvas.locate', {
        x: 5,
        y: 5,
        scaleRatio: 2,
        tabId: undefined,
      });
      expect(result).toMatchObject({ located: true, left: 0, right: 10, top: 0, bottom: 10 });
    });

    it('reports not_available when EasyEDA cannot zoom to the coordinate (returns false)', async () => {
      const tool = registry.get('easyeda_canvas_locate');
      bridgeCall.mockResolvedValue(false);

      const result = await tool?.handler(context, {});

      expect(result?.located).toBe(false);
      expect(result?.not_available).toBe(true);
    });

    it('reports not_available on bridge error', async () => {
      const tool = registry.get('easyeda_canvas_locate');
      bridgeCall.mockRejectedValue(new Error('bridge offline'));

      const result = await tool?.handler(context, {});

      expect(result?.located).toBe(false);
      expect(result?.not_available).toBe(true);
      expect(result?.error).toBe('bridge offline');
    });
  });
});
