"""Bounded, read-only verification of a native Ground device/symbol archive."""
import base64
import hashlib
import io
import json
import re
import sys
import zipfile

LIBRARY = '0819f05c4eef4c71ace90d822a990e87'
SOURCE_DEVICE = '2e4e71fea06848c9a86eef0ed6338204'
SOURCE_SYMBOL = '1c18ed5a06f64a07bdb5b0cf525b3d9e'
# Same 17 semantic records observed in the two independent project exports
# and the official system export. Only document/header revision metadata
# is excluded. Any different geometry or unknown record fails closed.
GEOMETRY_SHA256 = '478117d8bd516816a28e9714e4511dc961a85a996b7221ef6c66de2b9439c2ef'
MAX_BYTES = 65536


def require(condition):
    if not condition:
        raise ValueError('Native Ground archive does not match the verified source')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def read_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda _: require(False))


def unpack(encoded):
    require(isinstance(encoded, str) and len(encoded) <= 4 * ((MAX_BYTES + 2) // 3))
    raw = base64.b64decode(encoded, validate=True)
    require(0 < len(raw) <= MAX_BYTES)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        files = archive.infolist()
        require(len(files) == 2 and len({f.filename for f in files}) == 2)
        require(all(0 < f.file_size <= MAX_BYTES and not f.flag_bits & 1 and
                    not f.is_dir() for f in files))
        documents = [f for f in files if re.fullmatch(r'ProLib_pc_\d{4}-\d{2}-\d{2}\.elibu', f.filename)]
        require(len(documents) == 1 and 'device2.json' in archive.namelist())
        return read_json(archive.read('device2.json')), archive.read(documents[0]).decode('utf8')


def geometry(document, symbol_id, expected_source):
    rows = []
    head_count = 0
    meta_count = 0
    lines = document.splitlines()
    for index, line in enumerate(lines):
        if not line:
            continue
        require(len(rows) < 64 and (line.endswith('|') or index == len(lines) - 1))
        header_text, body_text = line.removesuffix('|').split('||', 1)
        header, body = read_json(header_text), read_json(body_text)
        require(isinstance(header, dict) and isinstance(body, dict))
        require(set(header) <= {'type', 'id', 'ticket', 'firstTicket', 'client'})
        kind = header.get('type')
        if kind == 'DOCHEAD':
            require(body.get('docType') == 'SYMBOL' and body.get('uuid') == symbol_id)
            head_count += 1
            require(head_count <= 4)
        elif kind == 'META':
            require(body.get('title') == 'Ground-GND' and body.get('docType') == 18 and
                    body.get('source') == expected_source)
            meta_count += 1
            require(meta_count <= 2)
        else:
            rows.append([kind, header.get('id'), body])
    require(head_count > 0 and meta_count > 0 and len(rows) == 17)
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    fingerprint = hashlib.sha256(encoded).hexdigest()
    require(fingerprint == GEOMETRY_SHA256)
    return fingerprint


def inspect(encoded, device_id, symbol_id, project=True):
    data, document = unpack(encoded)
    require(set(data) == {'devices', 'symbols', 'footprints', 'panelLibs'})
    require(not data['footprints'] and not data['panelLibs'])
    require(set(data['devices']) == {device_id} and set(data['symbols']) == {symbol_id})
    device, symbol = data['devices'][device_id], data['symbols'][symbol_id]
    require(device['uuid'] == device_id and symbol['uuid'] == symbol_id)
    require(device['display_title'] == symbol['display_title'] == 'Ground-GND' and device['symbol_type'] == 18)
    device_source = SOURCE_DEVICE + '|' + LIBRARY
    symbol_source = SOURCE_SYMBOL + '|' + LIBRARY
    if project:
        require(device.get('source') == device_source and symbol.get('source') == symbol_source)
    else:
        require(device.get('source') in ('', None) and symbol.get('source') in ('', None))
    attrs = device['attributes']
    required = {'Symbol': symbol_id, 'Description': '', 'Global Net Name': 'GND', 'Name': ''}
    require(all(attrs.get(key) == value for key, value in required.items()))
    require(set(attrs) == set(required) | ({'SymbolName'} if project else set()))
    if project:
        name = read_json(attrs['SymbolName'])
        require(name == {'name': 'Ground-GND', 'uuid': symbol_id, 'source': ''})
    return geometry(document, symbol_id, symbol_source if project else '')


def main():
    device_id, symbol_id, project_archive, system_archive = sys.argv[1:]
    require(re.fullmatch('[0-9a-f]{16}', device_id) and re.fullmatch('[0-9a-f]{16}', symbol_id) and
            device_id != symbol_id)
    actual = inspect(project_archive, device_id, symbol_id)
    canonical = inspect(system_archive, SOURCE_DEVICE, SOURCE_SYMBOL, project=False)
    require(actual == canonical)
    print(json.dumps({'projectDeviceUuid': device_id, 'projectSymbolUuid': symbol_id,
                      'deviceSource': SOURCE_DEVICE + '|' + LIBRARY,
                      'symbolSource': SOURCE_SYMBOL + '|' + LIBRARY,
                      'geometryFingerprint': actual}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, AttributeError, OSError, zipfile.BadZipFile):
        print('Native Ground archive verification refused', file=sys.stderr)
        sys.exit(1)
