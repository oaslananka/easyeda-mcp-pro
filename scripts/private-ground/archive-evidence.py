import base64,io,zipfile,json,sys
b=base64.b64decode(sys.argv[1],validate=True);assert 0<len(b)<=65536
with zipfile.ZipFile(io.BytesIO(b)) as z:
 infos=z.infolist();assert len(infos)==2
 m=[x for x in infos if x.filename=='device2.json'];assert len(m)==1 and 0<m[0].file_size<=65536
 data=json.loads(z.read(m[0]))
assert set(data.keys())=={'devices','symbols','footprints','panelLibs'}
assert not data['footprints'] and not data['panelLibs']
assert set(data['devices'])=={'af20086a8911a85a'} and set(data['symbols'])=={'17c558f9e954b079'}
d=data['devices']['af20086a8911a85a'];s=data['symbols']['17c558f9e954b079']
assert d['uuid']=='af20086a8911a85a' and s['uuid']=='17c558f9e954b079'
assert d['display_title']==s['display_title']=='Ground-GND' and d['symbol_type']==18
print(json.dumps({'projectDeviceUuid':d['uuid'],'projectSymbolUuid':s['uuid'],'deviceSource':d['source'],'symbolSource':s['source']}))
