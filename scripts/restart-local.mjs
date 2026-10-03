import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Developer helper: identify only this application's listener before replacing it.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const address='http://127.0.0.1:4317';
let session;
try{const response=await fetch(address+'/api/session',{signal:AbortSignal.timeout(2000)});session=await response.json();}catch{}
if(session){
 if(session.product!=='chronicle-earth')throw new Error('Port 4317 does not belong to Chronicle.');
 if(process.platform!=='win32')throw new Error('Stop the existing server before running this helper on another OS.');
 const raw=execFileSync('netstat.exe',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true,timeout:10000});
 const listeners=raw.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(fields=>fields[1]==='127.0.0.1:4317'&&fields[3]==='LISTENING');
 if(listeners.length!==1)throw new Error('Could not identify the application listener.');
 const pid=Number(listeners[0][4]);
 const processInfo=execFileSync('tasklist.exe',['/FI','PID eq '+pid,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(!/^"node\.exe",/i.test(processInfo.trim()))throw new Error('The application listener is not the expected Node process.');
 process.kill(pid);await delay(500);
}
process.argv.push('--no-open');await import('./launch.mjs');
