#!/usr/bin/env python3
"""Build the runtime directory into a reproducible Zotero XPI.

Release:  build_xpi.py plugin --output dist
Dev:      build_xpi.py plugin --output dist --dev   (adds dev/devbridge.js, name ends in -dev)
"""
import argparse, hashlib, json, stat, zipfile
from pathlib import Path

REPO = 'DingyangLyu/zotero-paper-companion'

p = argparse.ArgumentParser()
p.add_argument('source', type=Path)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--slug', default='paper-companion')
p.add_argument('--dev', action='store_true')
a = p.parse_args()

manifest = json.loads((a.source / 'manifest.json').read_text())
assert (a.source / 'bootstrap.js').is_file()
assert manifest['manifest_version'] == 2
zotero = manifest['applications']['zotero']
assert zotero['update_url'].startswith('https://')
version = manifest['version']

files = {}
for f in sorted(a.source.rglob('*')):
    if f.is_symlink():
        raise ValueError(f'Symlink not allowed: {f}')
    if not f.is_file():
        continue
    rel = f.relative_to(a.source)
    if any(x.startswith('.') or x == 'node_modules' for x in rel.parts) or rel.name == 'README.md':
        continue
    if str(rel) == 'content/vendor/katex/katex.min.js':  # build input; runtime.js is the bundled copy
        continue
    files[str(rel)] = f.read_bytes()
if a.dev:
    files['content/devbridge.js'] = Path('dev/devbridge.js').read_bytes()

a.output.mkdir(parents=True, exist_ok=True)
out = a.output / f"{a.slug}-{version}{'-dev' if a.dev else ''}.xpi"
tmp = out.with_suffix('.xpi.tmp')
with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(files):
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        z.writestr(info, files[name])
tmp.replace(out)
digest = hashlib.sha256(out.read_bytes()).hexdigest()

if not a.dev:
    (a.output / 'SHA256SUMS').write_text(f'{digest}  {out.name}\n')
    updates = {'addons': {zotero['id']: {'updates': [{
        'version': version,
        'update_link': f'https://raw.githubusercontent.com/{REPO}/main/dist/{out.name}',
        'update_hash': f'sha256:{digest}',
        'applications': {'zotero': {'strict_min_version': zotero['strict_min_version'],
                                    'strict_max_version': zotero['strict_max_version']}},
    }]}}}
    Path('updates.json').write_text(json.dumps(updates, indent=2) + '\n')
print(out.resolve())
