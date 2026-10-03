import {spawn} from 'node:child_process';

for(const file of ['tests/acceptance/run.mjs','tests/acceptance/cloud-ui.mjs','tests/acceptance/full-chain.mjs','scripts/check-shell.mjs','tests/acceptance/map-agent-ui.mjs']){
 console.log('\nRunning '+file);
 const status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',resolve);});
 if(status!==0)process.exit(status||1);
}
