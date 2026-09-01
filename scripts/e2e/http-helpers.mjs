const DEFAULT_DEVICE_KEYWORDS = ['resistor', 'R_0603', 'R_0805', 'capacitor'];

export async function initializeHttpSession({ mcpCall, sendInitializedNotification }) {
  await mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'e2e-http', version: '1.0' },
  });
  await sendInitializedNotification();
}

export async function waitForBridgeConnection({
  toolCall,
  maxWaitSeconds,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = console.log,
}) {
  for (let index = 0; index < maxWaitSeconds; index += 1) {
    try {
      const { text } = await toolCall('easyeda_bridge_status');
      const parsed = JSON.parse(text);
      if (parsed.connected === true) {
        return { connected: true, version: parsed.version || '?' };
      }
    } catch {}
    if ((index + 1) % 15 === 0) log(`  ⏳ waiting for bridge... ${index + 1}s`);
    await sleep(1000);
  }
  return { connected: false, version: '?' };
}

export async function findDeviceCandidates({
  toolCall,
  keywords = DEFAULT_DEVICE_KEYWORDS,
  limit = 10,
  minimum = 2,
}) {
  let devices = [];
  for (const keyword of keywords) {
    const { text } = await toolCall('easyeda_schematic_search_device', { keyword, limit });
    const parsed = JSON.parse(text);
    devices = parsed?.devices || parsed?.results || [];
    if (devices.length >= minimum) break;
  }
  return devices;
}
