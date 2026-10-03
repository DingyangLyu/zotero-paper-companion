const fs=require('node:fs');const path=require('node:path');const {buildSync}=require('esbuild');const {execFileSync}=require('node:child_process');
fs.mkdirSync('plugin/content/vendor',{recursive:true});
buildSync({stdin:{contents:"import {marked} from 'marked'; globalThis.marked=marked;",resolveDir:process.cwd(),loader:'js'},bundle:true,format:'iife',platform:'browser',outfile:'plugin/content/vendor/marked.js',minify:true,legalComments:'eof'});
buildSync({stdin:{contents:"import katex from './plugin/content/vendor/katex/katex.min.js'; globalThis.katex=katex;",resolveDir:process.cwd(),loader:'js'},bundle:true,format:'iife',platform:'browser',outfile:'plugin/content/vendor/katex/runtime.js',minify:true,legalComments:'eof'});
fs.copyFileSync('node_modules/marked/LICENSE','plugin/content/vendor/marked-LICENSE.md');
execFileSync('python3',['scripts/build_xpi.py','plugin','--output','dist','--slug','paper-companion'],{stdio:'inherit'});
