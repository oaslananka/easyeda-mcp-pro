import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const python = '/usr/bin/python3';
const available = process.platform === 'linux' && spawnSync(python, ['--version']).status === 0;
const verifier = resolve('scripts/private-ground/archive-evidence.py');

// Synthetic geometry exercises parser semantics without distributing vendor library files.
// The real production fingerprint is independently exercised by native acceptance.
const harness = String.raw`
import base64, hashlib, importlib.util, io, json, sys, zipfile
spec=importlib.util.spec_from_file_location('archive',sys.argv[1])
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
mode=sys.argv[2]
device='319c703be1c3d74e'
symbol='b20f8332e03c640f'
rows=[['POLY','p'+str(i),{'points':[{'x':i,'y':0}]}] for i in range(17)]
test_hash=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
if mode!='unreviewed': m.GEOMETRY_SHA256=test_hash
def archive(local, fault=None):
 d=device if local else m.SOURCE_DEVICE
 s=symbol if local else m.SOURCE_SYMBOL
 ds=m.SOURCE_DEVICE+'|'+m.LIBRARY if local else ''
 ss=m.SOURCE_SYMBOL+'|'+m.LIBRARY if local else ''
 attrs={'Symbol':s,'Description':'','Global Net Name':'GND','Name':''}
 if local:attrs['SymbolName']=json.dumps({'name':'Ground-GND','uuid':s,'source':''})
 if fault=='wrong-link':attrs['Symbol']='other'
 data={'devices':{d:{'uuid':d,'display_title':'Ground-GND','symbol_type':18,'attributes':attrs,'source':ds}},
       'symbols':{s:{'uuid':s,'display_title':'Ground-GND','source':ss}},
       'footprints':{},'panelLibs':{}}
 if fault=='wrong-source':data['symbols'][s]['source']='other'
 encode=lambda h,b:json.dumps(h)+'||'+json.dumps(b)+'|'
 records=[encode({'type':'DOCHEAD'},{'docType':'SYMBOL','uuid':s,'updateTime':123}),
          encode({'type':'META','id':'META'},{'title':'Ground-GND','docType':18,'source':ss})]
 for k,i,b in rows:
  record={'points':[{'x':99,'y':0}]} if fault=='geometry' and i=='p0' else b
  records.append(encode({'type':k,'id':i,'ticket':5},record))
 document='\n'.join(records)
 if fault=='missing-symbol':document=''
 stream=io.BytesIO()
 with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('ProLib_pc_2026-11-21.elibu',document)
  raw=json.dumps(data)
  if fault=='duplicate-key':raw=raw[:-1]+',"panelLibs":{}}'
  z.writestr('device2.json',raw)
  if fault=='extra-member':z.writestr('unknown.json','{}')
 return base64.b64encode(stream.getvalue()).decode()
try:
 a=m.inspect(archive(True,mode),device,symbol)
 b=m.inspect(archive(False,'geometry' if mode=='canonical-geometry' else None),m.SOURCE_DEVICE,m.SOURCE_SYMBOL,project=False)
 m.require(a==b)
 print('verified')
except (ValueError,KeyError,TypeError,zipfile.BadZipFile):
 sys.exit(1)
`;

describe.skipIf(!available)('private Ground native library archive boundary', () => {
  const testArchive = (mode: string) =>
    spawnSync(python, ['-B', '-c', harness, verifier, mode], { encoding: 'utf8', timeout: 10000 });
  it('accepts equivalent document geometry with a source-bound project-local identity', () => {
    const result = testArchive('valid');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('verified');
  });
  it.each([
    'wrong-link',
    'wrong-source',
    'geometry',
    'canonical-geometry',
    'missing-symbol',
    'duplicate-key',
    'extra-member',
    'unreviewed',
  ])('rejects %s without granting creation evidence', (mode) => {
    const result = testArchive(mode);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
  });
});
