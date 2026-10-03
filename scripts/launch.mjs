import {spawn} from 'node:child_process';
import {mkdir,open,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const address='http://127.0.0.1:4317';
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Please install Node.js 24 or newer.');
async function ready(){try{const response=await fetch(address+'/api/session',{signal:AbortSignal.timeout(700)});if(!response.ok)return false;const value=await response.json();return value.product==='chronicle-earth';}catch{return false;}}
if(!await ready()){
 await mkdir(path.join(root,'.local'),{recursive:true});
 const output=await open(path.join(root,'.local','server.log'),'a'),errors=await open(path.join(root,'.local','server-error.log'),'a');
 try{const child=spawn(process.execPath,['apps/server/main.js'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',output.fd,errors.fd]});child.unref();await writeFile(path.join(root,'.local','server-process.json'),JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),root}));}finally{await output.close();await errors.close();}
 for(let attempt=0;attempt<30&&!await ready();attempt++)await new Promise(resolve=>setTimeout(resolve,250));
 if(!await ready())throw new Error('The local app did not start. Check .local/server-error.log. Port 4317 may be in use.');
}
console.log('Chronicle is ready: '+address);
if(!process.argv.includes('--no-open')){
 const opener=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',address]]:process.platform==='darwin'?['open',[address]]:['xdg-open',[address]];
 const child=spawn(opener[0],opener[1],{detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>console.log('Open '+address+' in your browser.'));child.unref();
}
