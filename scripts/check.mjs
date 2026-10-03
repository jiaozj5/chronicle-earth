import {readdir,readFile} from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
const roots=['apps','features','packages/contracts','packages/workspace','packages/ui'];let checked=0;const failures=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(['vendor','data'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(/\.(m?js)$/.test(file)){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});checked++;if(r.status)failures.push(file+'\n'+r.stderr);}}}
for(const root of roots){try{await walk(root);}catch(e){if(e.code!=='ENOENT')throw e;}}
console.log(`Checked ${checked} JavaScript modules.`);if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
