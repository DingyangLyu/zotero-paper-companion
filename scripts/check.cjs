const {execFileSync}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);}
for(const f of walk('plugin').filter(x=>x.endsWith('.js')))execFileSync(process.execPath,['--check',f]);
const m=JSON.parse(fs.readFileSync('plugin/manifest.json'));if(m.applications.zotero.id!=='paper-companion@yuanbai.local')throw Error('Manifest ID mismatch');
console.log('Runtime JavaScript and manifest checks passed');
