#!/usr/bin/env python3
"""Build the runtime directory into a reproducible Zotero XPI."""
import argparse, hashlib, json, stat, zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--slug',default='paper-companion');a=p.parse_args()
manifest=json.loads((a.source/'manifest.json').read_text())
assert (a.source/'bootstrap.js').is_file()
assert manifest['manifest_version']==2
assert manifest['applications']['zotero']['update_url'].startswith('https://')
a.output.mkdir(parents=True,exist_ok=True)
out=a.output/f"{a.slug}-{manifest['version']}.xpi"
temporary=out.with_suffix('.xpi.tmp')
with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f in sorted(a.source.rglob('*')):
  if f.is_symlink():raise ValueError(f'Symlink not allowed: {f}')
  if not f.is_file():continue
  rel=f.relative_to(a.source)
  if any(x.startswith('.') or x=='node_modules' for x in rel.parts) or rel.name=='README.md':continue
  info=zipfile.ZipInfo(str(rel),(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(stat.S_IFREG|0o644)<<16
  z.writestr(info,f.read_bytes())
temporary.replace(out)
(a.output/'SHA256SUMS').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'  '+out.name+'\n')
print(out.resolve())
