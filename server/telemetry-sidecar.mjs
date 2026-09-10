import express from 'express';
import cors from 'cors';
import {Client} from 'ssh2';
import geoip from 'geoip-lite';
import fs from 'node:fs';
import path from 'node:path';

const PORT=Number(process.env.COMMAND_TELEMETRY_PORT||8790);
const HOST='127.0.0.1';
const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'4mb'}));

const DATA_DIR=path.resolve('server/data');
const EVENTS_FILE=path.join(DATA_DIR,'telemetry-events.jsonl');
fs.mkdirSync(DATA_DIR,{recursive:true});

function sshExec(c,cmd,timeout=25000){return new Promise((resolve,reject)=>{const conn=new Client();let done=false;const finish=(err,val)=>{if(done)return;done=true;clearTimeout(timer);try{conn.end()}catch{};err?reject(err):resolve(val)};const timer=setTimeout(()=>finish(new Error(`SSH timeout after ${Math.round(timeout/1000)}s`)),timeout);conn.on('ready',()=>conn.exec(cmd,(err,s)=>{if(err)return finish(err);let stdout='',stderr='';s.on('data',d=>stdout+=d);s.stderr.on('data',d=>stderr+=d);s.on('close',code=>finish(null,{stdout,stderr,code:Number(code||0)}))})).on('error',finish).connect({host:c.host,port:Number(c.port)||22,username:c.user,password:c.password,readyTimeout:12000,keepaliveInterval:8000,keepaliveCountMax:2})})}
function sectionParse(raw=''){const sections={};let cur='';for(const line of raw.split('\n')){const m=line.match(/^==([A-Z0-9_]+)==$/);if(m){cur=m[1];sections[cur]=[];continue}if(cur)(sections[cur]??=[]).push(line)}return sections}
function text(sections,k){return(sections[k]||[]).join('\n').trim()}
function ips(raw=''){return[...new Set((raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)||[]).filter(ip=>!['0.0.0.0','127.0.0.1'].includes(ip)))]}
function geo(ip){const g=ip?geoip.lookup(ip):null;return g?{country:g.country||'',region:g.region||'',city:g.city||'',timezone:g.timezone||'',lat:g.ll?.[0]??null,lon:g.ll?.[1]??null}:null}
function parseSSH(sections){const raw=[text(sections,'SSH'),text(sections,'ENV')].join('\n');let m=raw.match(/SSH_CONNECTION=((?:\d{1,3}\.){3}\d{1,3})\s+(\d+)\s+((?:\d{1,3}\.){3}\d{1,3})\s+(\d+)/);if(!m)m=raw.match(/SSH_CLIENT=((?:\d{1,3}\.){3}\d{1,3})\s+(\d+)\s+(\d+)/);return m?{source_ip:m[1],source_port:Number(m[2]),destination_ip:m[3]&&m[3].includes('.')?m[3]:'',destination_port:Number(m[4]||m[3]||0)}:null}
function readEvents(host){if(!fs.existsSync(EVENTS_FILE))return[];return fs.readFileSync(EVENTS_FILE,'utf8').split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(x=>x&&(!host||x.host===host)).slice(-2500)}
function appendEvents(events){if(!events.length)return;fs.appendFileSync(EVENTS_FILE,events.map(x=>JSON.stringify(x)).join('\n')+'\n')}
function ontologyFrom(events){const m=new Map();for(const e of events){if(!e.ip)continue;const x=m.get(e.ip)||{ip:e.ip,first_seen:e.ts,last_seen:e.ts,count:0,actions:new Set(),hosts:new Set(),geo:e.geo||null};x.count++;if(e.ts<x.first_seen)x.first_seen=e.ts;if(e.ts>x.last_seen)x.last_seen=e.ts;x.actions.add(e.action||'network_observation');if(e.host)x.hosts.add(e.host);if(!x.geo&&e.geo)x.geo=e.geo;m.set(e.ip,x)}return[...m.values()].map(x=>({...x,actions:[...x.actions],hosts:[...x.hosts]})).sort((a,b)=>b.count-a.count)}

const CMD=`printf '==SSH==\\n';printf 'SSH_CONNECTION=%s\\n' "\${SSH_CONNECTION:-}";printf 'SSH_CLIENT=%s\\n' "\${SSH_CLIENT:-}";printf '==ENV==\\n';env 2>/dev/null|grep '^SSH_'||true;printf '==HOST==\\n';hostname 2>/dev/null||true;printf '==ADDR==\\n';(ip -brief addr 2>/dev/null||ifconfig 2>/dev/null||hostname -I 2>/dev/null||true);printf '==ROUTE==\\n';(ip route 2>/dev/null||route -n 2>/dev/null||cat /proc/net/route 2>/dev/null||true);printf '==SOCKETS==\\n';(ss -Htunap 2>/dev/null||ss -Htuna 2>/dev/null||netstat -tuna 2>/dev/null||cat /proc/net/tcp 2>/dev/null||true)|head -300;printf '==LISTEN==\\n';(ss -Hlntup 2>/dev/null||ss -Hlntu 2>/dev/null||netstat -lntup 2>/dev/null||true)|head -180;printf '==NETDEV==\\n';cat /proc/net/dev 2>/dev/null||true;printf '==WHO==\\n';who 2>/dev/null||true;printf '==LAST==\\n';last -i -n 80 2>/dev/null||true;printf '==FAILED==\\n';lastb -i -n 80 2>/dev/null||true;printf '==TOPCPU==\\n';ps -eo pid,user,%cpu,%mem,etime,comm,args --sort=-%cpu 2>/dev/null|head -50;printf '==TOPMEM==\\n';ps -eo pid,user,%cpu,%mem,etime,comm,args --sort=-%mem 2>/dev/null|head -50;printf '==PROC_TCP==\\n';cat /proc/net/tcp /proc/net/tcp6 2>/dev/null|head -180;printf '==PROC_UDP==\\n';cat /proc/net/udp /proc/net/udp6 2>/dev/null|head -120;printf '==HISTORY==\\n';(tail -n 80 ~/.bash_history 2>/dev/null||history 80 2>/dev/null||true)`;

async function telemetry(req,res){const started=Date.now();try{if(!req.body?.host||!req.body?.user||!req.body?.password)throw new Error('Host, user and password are required');const r=await sshExec(req.body,CMD,30000);const sections=sectionParse(r.stdout);const ssh=parseSSH(sections);const now=new Date().toISOString();const currentIps=ips(r.stdout);if(req.body.host&&!currentIps.includes(req.body.host))currentIps.push(req.body.host);const failedSet=new Set(ips(text(sections,'FAILED')));const snapshot=currentIps.map(ip=>({ts:now,host:req.body.host,ip,geo:geo(ip),action:failedSet.has(ip)?'failed_auth_observation':'network_observation'}));appendEvents(snapshot);const events=readEvents(req.body.host);const ontology=ontologyFrom(events);const capabilities={ssh:!!ssh,addresses:!!text(sections,'ADDR'),routes:!!text(sections,'ROUTE'),sockets:!!text(sections,'SOCKETS'),listeners:!!text(sections,'LISTEN'),netdev:!!text(sections,'NETDEV'),sessions:!!text(sections,'WHO'),login_history:!!text(sections,'LAST'),failed_history:!!text(sections,'FAILED'),processes:!!text(sections,'TOPCPU'),proc_tcp:!!text(sections,'PROC_TCP'),history:!!text(sections,'HISTORY')};const unusual=[...failedSet];res.json({ok:true,ssh,currentIp:ssh?.source_ip||'',currentGeo:geo(ssh?.source_ip),hostIp:req.body.host,ips:currentIps,sections,capabilities,events,ontology,unusual_ips:unusual,telemetry_ms:Date.now()-started,stderr:r.stderr||''})}catch(e){res.status(400).json({ok:false,error:e.message,telemetry_ms:Date.now()-started})}}

app.get('/api/health',(_,res)=>res.json({ok:true,version:'0.9.6',mode:'telemetry-sidecar'}));
app.post('/api/security/live',telemetry);
app.post('/api/network/live',telemetry);
app.listen(PORT,HOST,()=>console.log(`COMMAND telemetry v0.9.6 http://${HOST}:${PORT}`));
