import express from 'express';
import cors from 'cors';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const HOST='127.0.0.1';
const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'24mb'}));

// Keep existing resilient operations behind this control-plane wrapper.
const child=spawn(process.execPath,['server/agent-v092.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT),COMMAND_UPSTREAM_PORT:String(UPSTREAM_PORT+1)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND ops gateway exited',code)});

function sshExec(c,cmd,timeout=20000){return new Promise((resolve,reject)=>{
 const conn=new Client();let done=false;
 const finish=(err,val)=>{if(done)return;done=true;clearTimeout(timer);try{conn.end()}catch{};err?reject(err):resolve(val)};
 const timer=setTimeout(()=>finish(new Error(`SSH timeout after ${Math.round(timeout/1000)}s`)),timeout);
 conn.on('ready',()=>conn.exec(cmd,(err,s)=>{if(err)return finish(err);let stdout='',stderr='';s.on('data',d=>stdout+=d);s.stderr.on('data',d=>stderr+=d);s.on('close',code=>Number(code||0)===0?finish(null,{stdout,stderr}):finish(new Error((stderr||stdout||`exit ${code}`).trim())))}))
 .on('error',finish)
 .connect({host:c.host,port:Number(c.port)||22,username:c.user,password:c.password,readyTimeout:12000,keepaliveInterval:10000,keepaliveCountMax:2});
})}

function parseInventory(raw=''){const o={};for(const line of raw.split('\n')){const i=line.indexOf('=');if(i>0)o[line.slice(0,i)]=line.slice(i+1)}const mem=(o.MEM||'0,0,0').split(',').map(Number),disk=(o.DISK||'0,0,0,0').split(',').map(Number),ino=(o.INODES||'0,0,0,0').split(',').map(Number);return{hostname:o.HOSTNAME||'',os:o.OS||'',uptime:o.UPTIME||'',load:o.LOAD||'',memory:{total:mem[0]||0,used:mem[1]||0,available:mem[2]||0,percent:mem[0]?Math.round((mem[1]||0)/mem[0]*100):0},disk:{total:disk[0]||0,used:disk[1]||0,available:disk[2]||0,percent:disk[3]||0},inodes:{total:ino[0]||0,used:ino[1]||0,available:ino[2]||0,percent:ino[3]||0},domains:Number(o.DOMAINS||0)}}

app.get('/api/health',(_,res)=>res.json({ok:true,version:'0.9.4',mode:'fast-control-plane'}));

app.post('/api/connect',async(req,res)=>{const t0=Date.now();try{
 if(!req.body?.host||!req.body?.user||!req.body?.password)throw new Error('Host, user and password are required');
 const cmd=`printf 'HOSTNAME=';hostname;printf 'UPTIME=';uptime -p 2>/dev/null||uptime;printf 'LOAD=';cut -d' ' -f1-3 /proc/loadavg 2>/dev/null||true;printf 'MEM=';free -m 2>/dev/null|awk '/Mem:/{print $2","$3","$7}';printf 'DISK=';df -P "$HOME" 2>/dev/null|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';printf 'INODES=';df -Pi "$HOME" 2>/dev/null|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';printf 'OS=';(. /etc/os-release 2>/dev/null;printf '%s' "$PRETTY_NAME");printf '\nDOMAINS=';find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d 2>/dev/null|wc -l`;
 const r=await sshExec(req.body,cmd,15000);
 res.json({ok:true,data:parseInventory(r.stdout),security:null,connect_ms:Date.now()-t0,mode:'fast-handshake'});
}catch(e){res.status(400).json({ok:false,error:e.message,connect_ms:Date.now()-t0})}});

// Direct domain discovery: no WordPress CLI, no telemetry and no upstream hop.
app.post('/api/domains',async(req,res)=>{const t0=Date.now();try{
 const cmd=`for d in "$HOME"/domains/*; do [ -d "$d" ]||continue; n=$(basename "$d"); p="$d/public_html"; wp=0; wc=0; [ -f "$p/wp-config.php" ]&&wp=1; { [ -d "$p/wp-content/plugins/woocommerce" ]||[ -f "$p/wp-content/plugins/woocommerce/woocommerce.php" ]; }&&wc=1; printf '%s|%s|%s\\n' "$n" "$wp" "$wc"; done`;
 const r=await sshExec(req.body,cmd,20000);
 const domains=r.stdout.trim().split('\n').filter(Boolean).map(line=>{const[name,wp,wc]=line.split('|');return{name,wordpress:wp==='1',woocommerce:wc==='1'}}).filter(x=>x.name);
 res.json({ok:true,domains,discover_ms:Date.now()-t0,count:domains.length});
}catch(e){res.status(400).json({ok:false,error:e.message,discover_ms:Date.now()-t0})}});

function proxy(req,res){const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.originalUrl||req.url,method:req.method,headers:{...req.headers,host:`${HOST}:${UPSTREAM_PORT}`}},u=>{res.statusCode=u.statusCode||502;for(const[k,v]of Object.entries(u.headers))if(v!==undefined)res.setHeader(k,v);u.pipe(res)});p.on('error',e=>res.status(502).json({ok:false,error:`Agent unavailable: ${e.message}`}));req.pipe(p)}
app.use((req,res)=>proxy(req,res));

app.listen(FRONT_PORT,HOST,()=>console.log(`COMMAND gateway v0.9.4 domain-fix http://${HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));
process.on('SIGINT',()=>{child.kill('SIGINT');process.exit(0)});
process.on('SIGTERM',()=>{child.kill('SIGTERM');process.exit(0)});
