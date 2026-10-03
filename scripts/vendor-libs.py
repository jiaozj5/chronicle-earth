import base64, hashlib, io, json, tarfile, urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
dest=root/'packages'/'ui'/'vendor'
dest.mkdir(parents=True,exist_ok=True)
manifest_file=root/'vendor-lock.json'
previous=json.loads(manifest_file.read_text(encoding='utf-8')) if manifest_file.exists() else {}
manifest={}
for name in ['marked','dompurify','katex']:
    version=previous.get(name,{}).get('version','latest')
    meta=json.load(urllib.request.urlopen('https://registry.npmjs.org/'+name+'/'+version,timeout=30))
    raw=urllib.request.urlopen(meta['dist']['tarball'],timeout=60).read()
    integrity=meta['dist']['integrity']
    alg,want=integrity.split('-',1)
    got=base64.b64encode(hashlib.new(alg,raw).digest()).decode()
    if got!=want: raise ValueError('Package integrity mismatch: '+name)
    out=dest/name
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile(): continue
            p=Path(member.name)
            if p.parts[0]!='package' or '..' in p.parts: raise ValueError('Invalid archive path')
            rel=Path(*p.parts[1:])
            if rel.parts[0] not in ['dist','lib'] and rel.name not in ['LICENSE','LICENSE.md','LICENSE.txt','package.json']: continue
            target=out/rel
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
    manifest[name]={'version':meta['version'],'tarball':meta['dist']['tarball'],'integrity':integrity,'license':meta.get('license')}
    print(name,meta['version'])
manifest_file.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
