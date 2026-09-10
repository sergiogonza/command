import {spawn} from 'node:child_process';
const children=[];
function start(file,env={}){const p=spawn(process.execPath,[file],{stdio:'inherit',env:{...process.env,...env}});children.push(p);p.on('exit',code=>{if(code!==0)console.error(`${file} exited with code ${code}`)});return p}
start('server/agent-v094.mjs');
start('server/telemetry-sidecar.mjs');
function stop(){for(const p of children){try{p.kill('SIGINT')}catch{}}setTimeout(()=>process.exit(0),150)}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
console.log('COMMAND launcher v0.9.7 network-security started');
