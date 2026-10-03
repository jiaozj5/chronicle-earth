import {runMcp} from './agent-mcp.mjs';
runMcp({scope:'library'}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
