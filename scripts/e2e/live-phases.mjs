import { extractPinsPayload } from './payloads.mjs';

const DEFAULT_REQUIRED_METHODS = [
  'schematic.createNetFlag',
  'schematic.createNetPort',
  'schematic.connectPinToNet',
  'schematic.connectPinsByNet',
  'schematic.validateNetlist',
  'project.save',
];
const DEFAULT_DEVICE_KEYWORDS = ['resistor', 'R_0603', 'R_0805', 'capacitor'];

export async function waitForLiveBridge({
  toolCall,
  maxWaitSeconds,
  sleep,
  log = console.log,
  reporter,
}) {
  let status = {};
  const attempts = Math.ceil(maxWaitSeconds / 3);
  for (let index = 0; index < attempts; index += 1) {
    try {
      const { text } = await toolCall('easyeda_bridge_status');
      const parsed = JSON.parse(text);
      status = parsed;
      if (parsed.connected === true) {
        reporter.ok(
          'Bridge connected',
          `version=${parsed.bridge_version || parsed.version || '?'}`,
        );
        reporter.capture('bridge status', parsed);
        return { connected: true, status: parsed };
      }
    } catch {}
    const elapsed = (index + 1) * 3;
    if (elapsed >= maxWaitSeconds) break;
    if ((index + 1) % 5 === 0) log(`  ⏳ waiting for bridge... ${elapsed}s elapsed`);
    await sleep(3000);
  }
  return { connected: false, status };
}

export async function verifyRequiredBridgeMethods({
  toolCall,
  capabilities,
  requiredMethods = DEFAULT_REQUIRED_METHODS,
  reporter,
}) {
  const methodResults = {};
  for (const method of requiredMethods) {
    let found = capabilities.includes(method);
    if (!found) {
      try {
        const { text: inventory } = await toolCall('easyeda_api_inventory', { filter: method });
        if (inventory.includes(method)) found = true;
      } catch {}
    }
    methodResults[method] = found;
    if (found) reporter.ok(`Bridge method declared: ${method}`);
    else reporter.fail(`Bridge method: ${method}`, 'not in capabilities');
  }
  return methodResults;
}

export async function discoverActiveDocument({ toolCall, projectId, reporter }) {
  try {
    const { text: netsText } = await toolCall('easyeda_schematic_nets', { projectId });
    const parsed = JSON.parse(netsText);
    if (!parsed.not_available) {
      const initialNets = parsed.nets || [];
      reporter.ok('Active document confirmed', `${initialNets.length} initial nets`);
      reporter.capture('initial nets', netsText);
      return true;
    }
  } catch {}

  try {
    const { text: componentText } = await toolCall('easyeda_schematic_components', {
      projectId,
      limit: 1,
    });
    const parsed = JSON.parse(componentText);
    if (parsed && !parsed.not_available) {
      reporter.ok('Active document confirmed via components');
      return true;
    }
  } catch {}
  return false;
}

export async function searchValidationDevices({
  toolCall,
  reporter,
  keywords = DEFAULT_DEVICE_KEYWORDS,
}) {
  let deviceItems = [];
  for (const keyword of keywords) {
    try {
      const { text } = await toolCall('easyeda_schematic_search_device', {
        key: keyword,
        itemsOfPage: 10,
        page: 1,
      });
      const parsed = JSON.parse(text);
      const devices = parsed.devices || parsed.results || [];
      if (devices.length > 0) deviceItems = devices;
      if (deviceItems.length >= 2) break;
    } catch (error) {
      reporter.warn('Device search attempt', `${keyword}: ${error.message}`);
    }
  }
  return deviceItems;
}

function deviceSearchName(device) {
  return device.title || device.name || '';
}

function findDeviceBySize(deviceItems, size) {
  return deviceItems.find((device) => deviceSearchName(device).toLowerCase().includes(size));
}

function deviceUuid(device) {
  return device.uuid || device.deviceUUID || device.mp || '';
}

function deviceLibraryUuid(device) {
  return device.libraryUuid || device.libraryId || '';
}

function deviceDisplayName(device, fallbackUuid) {
  return device.title || device.name || device.display || fallbackUuid;
}

export function selectValidationDevicePair(deviceItems) {
  let dev0 = findDeviceBySize(deviceItems, '0603') || deviceItems[0];
  let dev1 =
    findDeviceBySize(deviceItems, '0805') ||
    (deviceItems.length > 1 ? deviceItems[1] : deviceItems[0]);
  if (dev0 === dev1) dev1 = deviceItems[1] || deviceItems[0];

  const d0Uuid = deviceUuid(dev0);
  const d0LibraryUuid = deviceLibraryUuid(dev0);
  const d1Uuid = deviceUuid(dev1);
  const d1LibraryUuid = deviceLibraryUuid(dev1);

  return {
    dev0,
    dev1,
    d0Uuid,
    d0LibraryUuid,
    d1Uuid,
    d1LibraryUuid,
    dev0Name: deviceDisplayName(dev0, d0Uuid),
    dev1Name: deviceDisplayName(dev1, d1Uuid),
  };
}

function extractPlacedPrimitiveId(text) {
  try {
    return JSON.parse(text).component?.primitiveId || '';
  } catch {
    return '';
  }
}

async function placeOneComponent({ toolCall, deviceItem, x, label, reporter }) {
  try {
    const result = await toolCall('easyeda_schematic_place_component', {
      deviceItem,
      x,
      y: 200,
      rotation: 0,
      confirmWrite: true,
    });
    reporter.ok(`Placed ${label}`, result.text.slice(0, 200));
    reporter.capture(`place ${label}`, result.text);
    return extractPlacedPrimitiveId(result.text);
  } catch (error) {
    reporter.fail(`Place ${label}`, error.message);
    return '';
  }
}

function componentReference(component) {
  return component.reference || component.ref || component.name || '';
}

function componentPrimitiveId(component) {
  return component.primitiveId || component.uuid || component.id || '';
}

function isValidationReference(reference) {
  return reference.startsWith('E2E_') || reference.startsWith('R');
}

function recoverIdsFromComponents(components, initialR1PrimId, initialR2PrimId) {
  let r1PrimId = initialR1PrimId;
  let r2PrimId = initialR2PrimId;
  for (const component of components) {
    if (!isValidationReference(componentReference(component))) continue;
    const primitiveId = componentPrimitiveId(component);
    if (!r1PrimId) {
      r1PrimId = primitiveId;
      continue;
    }
    if (!r2PrimId && primitiveId !== r1PrimId) r2PrimId = primitiveId;
  }
  return { r1PrimId, r2PrimId };
}

async function recoverPlacedPrimitiveIds({ toolCall, projectId, r1PrimId, r2PrimId, reporter }) {
  if (r1PrimId && r2PrimId) return { r1PrimId, r2PrimId };
  try {
    const { text } = await toolCall('easyeda_schematic_components', { projectId, limit: 50 });
    reporter.capture('components list', text);
    const parsed = JSON.parse(text);
    return recoverIdsFromComponents(parsed.components || parsed.results || [], r1PrimId, r2PrimId);
  } catch (error) {
    reporter.warn('Component enumeration', error.message);
    return { r1PrimId, r2PrimId };
  }
}

async function readPins({ toolCall, primitiveId, label, reporter }) {
  try {
    const { text } = await toolCall('easyeda_schematic_component_pins', { primitiveId });
    const pins = extractPinsPayload(JSON.parse(text));
    reporter.ok(
      `${label} pins`,
      `${pins.length} pins: ${pins.map((pin) => pin.number || pin.pinNumber || '').join(', ')}`,
    );
    return pins;
  } catch (error) {
    reporter.warn(`${label} pins`, error.message);
    return [];
  }
}

async function exerciseNativeNoConnect({ toolCall, projectId, r2PrimId, r2Pins, reporter }) {
  const noConnectPin = r2Pins[0]?.pinNumber || r2Pins[0]?.number;
  if (!noConnectPin) {
    reporter.warn('Native No Connect', 'Skipped because no addressable R2 pin was available');
    return;
  }

  try {
    const setResult = await toolCall('easyeda_schematic_set_pin_no_connect', {
      projectId,
      primitiveId: r2PrimId,
      pinNumber: String(noConnectPin),
      noConnected: true,
      confirmWrite: true,
    });
    const setPayload = JSON.parse(setResult.text);
    if (setPayload.no_connected !== true || setPayload.verified !== true) {
      throw new Error(`set readback was not verified: ${setResult.text}`);
    }
    reporter.ok('Set native No Connect', `${r2PrimId}/${noConnectPin}`);
    reporter.capture('set native no-connect', setResult.text);

    const { text: readText } = await toolCall('easyeda_schematic_component_pins', {
      primitiveId: r2PrimId,
    });
    const readPins = extractPinsPayload(JSON.parse(readText));
    const readPin = readPins.find(
      (pin) => String(pin.pinNumber || pin.number || '') === String(noConnectPin),
    );
    if (readPin?.noConnected !== true) {
      throw new Error(`component pin readback did not expose noConnected=true: ${readText}`);
    }
    reporter.ok(
      'Read back native No Connect',
      `pinPrimitiveId=${readPin.primitiveId || 'unknown'}`,
    );

    const clearResult = await toolCall('easyeda_schematic_set_pin_no_connect', {
      projectId,
      primitiveId: r2PrimId,
      pinNumber: String(noConnectPin),
      noConnected: false,
      confirmWrite: true,
    });
    const clearPayload = JSON.parse(clearResult.text);
    if (clearPayload.no_connected !== false || clearPayload.verified !== true) {
      throw new Error(`clear readback was not verified: ${clearResult.text}`);
    }
    reporter.ok('Clear native No Connect', `${r2PrimId}/${noConnectPin}`);
    reporter.capture('clear native no-connect', clearResult.text);
  } catch (error) {
    reporter.fail('Native No Connect set/readback/clear', error.message);
  }
}

export async function placeValidationComponents({ toolCall, projectId, devices, reporter }) {
  const r1Ref = 'E2E_R1';
  const r2Ref = 'E2E_R2';
  let r1PrimId = await placeOneComponent({
    toolCall,
    deviceItem: { libraryUuid: devices.d0LibraryUuid, uuid: devices.d0Uuid },
    x: 100,
    label: 'R1',
    reporter,
  });
  let r2PrimId = await placeOneComponent({
    toolCall,
    deviceItem: { libraryUuid: devices.d1LibraryUuid, uuid: devices.d1Uuid },
    x: 500,
    label: 'R2',
    reporter,
  });

  ({ r1PrimId, r2PrimId } = await recoverPlacedPrimitiveIds({
    toolCall,
    projectId,
    r1PrimId,
    r2PrimId,
    reporter,
  }));
  if (!r1PrimId) r1PrimId = r1Ref;
  if (!r2PrimId) r2PrimId = r2Ref;
  reporter.ok('Component primitive IDs', `R1=${r1PrimId} R2=${r2PrimId}`);

  await readPins({ toolCall, primitiveId: r1PrimId, label: 'R1', reporter });
  const r2Pins = await readPins({ toolCall, primitiveId: r2PrimId, label: 'R2', reporter });
  await exerciseNativeNoConnect({ toolCall, projectId, r2PrimId, r2Pins, reporter });

  return { r1PrimId, r2PrimId, r2Pins, r1Ref, r2Ref };
}

async function createNetArtifact({
  toolCall,
  name,
  args,
  resultKey,
  label,
  captureLabel,
  reporter,
}) {
  let primitiveId = 'unknown';
  try {
    const result = await toolCall(name, args);
    try {
      primitiveId = JSON.parse(result.text)[resultKey]?.primitiveId || 'unknown';
    } catch {}
    reporter.ok(label, `primitiveId=${primitiveId}`);
    reporter.capture(captureLabel, result.text);
  } catch (error) {
    reporter.fail(label.replace(' TEST_NET', ''), error.message);
  }
  return primitiveId;
}

export async function createValidationNetArtifacts({ toolCall, projectId, netName, reporter }) {
  const flagPrimId = await createNetArtifact({
    toolCall,
    name: 'easyeda_schematic_create_net_flag',
    args: {
      projectId,
      netName,
      x: 300,
      y: 100,
      rotation: 0,
      confirmWrite: true,
    },
    resultKey: 'netFlag',
    label: 'Create net flag TEST_NET',
    captureLabel: 'net flag result',
    reporter,
  });
  const portPrimId = await createNetArtifact({
    toolCall,
    name: 'easyeda_schematic_create_net_port',
    args: {
      projectId,
      netName,
      x: 300,
      y: 300,
      portType: 'passive',
      rotation: 0,
      confirmWrite: true,
    },
    resultKey: 'netPort',
    label: 'Create net port TEST_NET',
    captureLabel: 'net port result',
    reporter,
  });
  return { flagPrimId, portPrimId };
}
