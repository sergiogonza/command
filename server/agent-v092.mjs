import express from 'express';
import cors from 'cors';
import multer from 'multer';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const HOST='127.0.0.1';
const JOBS=new Map();
const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'24mb'}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024}});

// One upstream only. This removes the old v092 -> v091 -> v090 -> core chain.
const child=spawn(process.execPath,['server/index.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND core exited',code)});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const id=()=>`J${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2,6).toUpperCase()}`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));

function newJob(type,domains,total=domains.length){const j={id:id(),type,status:'queued',progress:0,processed:0,total,success:0,skipped:0,failed:0,currentDomain:'',currentStep:'queued',startedAt:new Date().toISOString(),finishedAt:null,logs:[],report:'',data:{}};JOBS.set(j.id,j);return j}
function log(j,line){j.logs.push(`${new Date().toISOString()} ${line}`);if(j.logs.length>800)j.logs.splice(0,j.logs.length-800)}
function publicJob(j){return{id:j.id,type:j.type,status:j.status,progress:j.progress,processed:j.processed,total:j.total,success:j.success,verified:j.success,skipped:j.skipped,failed:j.failed,currentDomain:j.currentDomain,currentPlugin:j.currentPlugin||'',currentStep:j.currentStep,startedAt:j.startedAt,finishedAt:j.finishedAt,logs:j.logs.slice(-180),report:j.report,error:j.error||'',data:j.data}}
function finish(j){j.progress=100;j.finishedAt=new Date().toISOString();j.status=j.failed?(j.success?'warning':'error'):'done';j.currentStep=j.status==='done'?'verified':'completed with diagnostics'}

function upstreamPost(path,payload,timeout=150000){return new Promise((resolve,reject)=>{const body=Buffer.from(JSON.stringify(payload));const req=http.request({host:HOST,port:UPSTREAM_PORT,path,method:'POST',headers:{'content-type':'application/json','content-length':body.length}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{let data;try{data=JSON.parse(raw||'{}')}catch{return reject(new Error(`Invalid upstream response (${res.statusCode})`))}if((res.statusCode||500)>=400||data.ok===false)return reject(new Error(data.error||`Upstream HTTP ${res.statusCode}`));resolve(data)})});req.setTimeout(timeout,()=>req.destroy(new Error(`upstream timeout after ${Math.round(timeout/1000)}s`)));req.on('error',reject);req.end(body)})}

function sshExec(c,cmd,timeout=90000){return new Promise((resolve,reject)=>{const conn=new Client();let done=false;const end=(err,val)=>{if(done)return;done=true;clearTimeout(timer);try{conn.end()}catch{};err?reject(err):resolve(val)};const timer=setTimeout(()=>end(new Error(`SSH timeout after ${Math.round(timeout/1000)}s`)),timeout);conn.on('ready',()=>conn.exec(cmd,(err,s)=>{if(err)return end(err);let stdout='',stderr='';s.on('data',d=>stdout+=d);s.stderr.on('data',d=>stderr+=d);s.on('close',code=>Number(code||0)===0?end(null,{stdout,stderr}):end(new Error((stderr||stdout||`exit ${code}`).trim())))})).on('error',end).connect({host:c.host,port:Number(c.port)||22,username:c.user,password:c.password,readyTimeout:12000,keepaliveInterval:10000,keepaliveCountMax:3})})}
function sftpPut(c,remote,buffer){return new Promise((resolve,reject)=>{const conn=new Client();conn.on('ready',()=>conn.sftp((err,sftp)=>{if(err){conn.end();return reject(err)}const ws=sftp.createWriteStream(remote,{mode:0o600});ws.on('error',e=>{conn.end();reject(e)});ws.on('close',()=>{conn.end();resolve()});ws.end(buffer)})).on('error',reject).connect({host:c.host,port:Number(c.port)||22,username:c.user,password:c.password,readyTimeout:12000,keepaliveInterval:10000,keepaliveCountMax:3})})}

function parseQuickInventory(raw=''){
 const o={};
 for(const line of raw.split('\n')){const i=line.indexOf('=');if(i>0)o[line.slice(0,i)]=line.slice(i+1)}
 const mem=(o.MEM||'0,0,0').split(',').map(Number),disk=(o.DISK||'0,0,0,0').split(',').map(Number),ino=(o.INODES||'0,0,0,0').split(',').map(Number);
 return{hostname:o.HOSTNAME||'',os:o.OS||'',uptime:o.UPTIME||'',load:o.LOAD||'',memory:{total:mem[0]||0,used:mem[1]||0,available:mem[2]||0,percent:mem[0]?Math.round((mem[1]||0)/mem[0]*100):0},disk:{total:disk[0]||0,used:disk[1]||0,available:disk[2]||0,percent:disk[3]||0},inodes:{total:ino[0]||0,used:ino[1]||0,available:ino[2]||0,percent:ino[3]||0},domains:Number(o.DOMAINS||0)}
}

// Fast control-plane handshake. No security/network scan is performed here.
app.post('/api/connect',async(req,res)=>{
 const t0=Date.now();
 try{
  if(!req.body?.host||!req.body?.user||!req.body?.password)throw new Error('Host, user and password are required');
  const cmd=`printf 'HOSTNAME=';hostname;printf 'UPTIME=';uptime -p 2>/dev/null||uptime;printf 'LOAD=';cut -d' ' -f1-3 /proc/loadavg 2>/dev/null||true;printf 'MEM=';free -m 2>/dev/null|awk '/Mem:/{print $2","$3","$7}';printf 'DISK=';df -P "$HOME" 2>/dev/null|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';printf 'INODES=';df -Pi "$HOME" 2>/dev/null|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';printf 'OS=';(. /etc/os-release 2>/dev/null;printf '%s' "$PRETTY_NAME");printf '\nDOMAINS=';find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d 2>/dev/null|wc -l`;
  const r=await sshExec(req.body,cmd,15000);
  res.json({ok:true,data:parseQuickInventory(r.stdout),security:null,connect_ms:Date.now()-t0,mode:'fast-handshake'});
 }catch(e){res.status(400).json({ok:false,error:e.message,connect_ms:Date.now()-t0})}
});

async function runGenericJob(j,credentials,job,confirmation){j.status='running';for(const domain of validDomains(job.domains)){j.currentDomain=domain;j.currentStep='connecting / executing';log(j,`${domain} CONNECT ${job.type}`);try{const one={...job,domains:[domain]};const r=await upstreamPost('/api/jobs/execute',{...credentials,job:one,confirmation},150000);const report=String(r.report||'').trim();const hasError=/\|ERROR\||UNVERIFIED|error establishing a database connection|fatal/i.test(report);const skipped=/\|SKIP\|/.test(report)&&!/VERIFIED/.test(report);if(hasError){j.failed++;log(j,`${domain} ERROR ${report.slice(0,500)}`)}else if(skipped){j.skipped++;log(j,`${domain} SKIP ${report.slice(0,500)}`)}else{j.success++;log(j,`${domain} VERIFIED ${report.slice(0,500)||'completed'}`)}j.report+=(j.report?'\n':'')+report}catch(e){j.failed++;log(j,`${domain} ERROR ${e.message}`)}j.processed++;j.progress=Math.round(j.processed/Math.max(1,j.total)*100);j.currentStep='read-back / next target';await pause(40)}finish(j)}

async function runCommerce(j,credentials,domains){j.status='running';j.data.sites=[];j.data.diagnostics=[];for(const domain of domains){j.currentDomain=domain;j.currentStep='reading WooCommerce metrics';log(j,`${domain} READ commerce/summary`);try{const r=await upstreamPost('/api/commerce/summary',{...credentials,domains:[domain]},120000);const site=r.sites?.[0];if(site){j.data.sites.push(site);if(site.verified===false){j.failed++;j.data.diagnostics.push({domain,error:site.error||'not verified'});log(j,`${domain} WARNING ${site.error||'not verified'}`)}else{j.success++;log(j,`${domain} OK orders=${site.orders_total??'—'} net_month=${site.net_month??'—'}`)}}else{j.failed++;j.data.diagnostics.push({domain,error:'empty response'});log(j,`${domain} ERROR empty metrics response`)}}catch(e){j.failed++;j.data.diagnostics.push({domain,error:e.message});log(j,`${domain} ERROR ${e.message}`)}j.processed++;j.progress=Math.round(j.processed/Math.max(1,j.total)*100)}finish(j)}

async function runPluginUpload(j,credentials,domains,file,activate){j.status='running';let remote='';try{j.currentStep='preparing remote upload';log(j,`SSH CONNECT ${credentials.host}:${credentials.port||22}`);const home=(await sshExec(credentials,'printf %s "$HOME"',30000)).stdout.trim();if(!home)throw new Error('Unable to resolve remote HOME');const dir=`${home}/.command-uploads`;remote=`${dir}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await sshExec(credentials,`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`,30000);j.currentStep=`uploading ${file.originalname}`;log(j,`SFTP UPLOAD ${file.originalname} (${file.size} bytes)`);await sftpPut(credentials,remote,file.buffer);log(j,'SFTP VERIFIED remote file created');for(const domain of domains){j.currentDomain=domain;j.currentStep=activate?'install + activate + verify':'install + verify';log(j,`${domain} INSTALL ${file.originalname}`);try{const p=`$HOME/domains/${domain}/public_html`;const cmd=`cd "${p}" || exit 21; [ -f wp-config.php ] || exit 22; out=$(wp plugin install ${q(remote)} --force ${activate?'--activate':''} --skip-themes 2>&1); rc=$?; printf '%s\\n' "$out"; [ $rc -eq 0 ] || exit $rc; wp plugin list --format=count --skip-themes >/dev/null 2>&1`;const r=await sshExec(credentials,cmd,120000);j.success++;log(j,`${domain} VERIFIED ${r.stdout.trim().slice(0,350)||'plugin installed'}`)}catch(e){j.failed++;log(j,`${domain} ERROR ${e.message}`)}j.processed++;j.progress=Math.round(j.processed/Math.max(1,j.total)*100)}finish(j)}catch(e){j.error=e.message;j.failed=Math.max(1,j.failed);log(j,`FATAL ${e.message}`);finish(j)}finally{if(remote)sshExec(credentials,`rm -f ${q(remote)}`,30000).catch(()=>{})}}

app.get('/api/ops/status',(req,res)=>{const j=JOBS.get(String(req.query.id||''));if(!j)return res.status(404).json({ok:false,error:'Job not found'});res.json({ok:true,job:publicJob(j)})});
app.post('/api/ops/job-start',(req,res)=>{try{const job=req.body.job||{},domains=validDomains(job.domains);if(!domains.length)throw new Error('Select at least one domain');if(req.body.confirmation!==job.confirmation)throw new Error('Confirmation token mismatch');const j=newJob(job.type,domains);const credentials={host:req.body.host,port:req.body.port,user:req.body.user,password:req.body.password};runGenericJob(j,credentials,job,req.body.confirmation);res.status(202).json({ok:true,job:publicJob(j)})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.post('/api/ops/commerce-start',(req,res)=>{try{const domains=validDomains(req.body.domains);if(!domains.length)throw new Error('Select at least one domain');const j=newJob('commerce_metrics',domains);const credentials={host:req.body.host,port:req.body.port,user:req.body.user,password:req.body.password};runCommerce(j,credentials,domains);res.status(202).json({ok:true,job:publicJob(j)})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.post('/api/plugins/upload',upload.single('file'),(req,res)=>{try{if(!req.file||!/\.zip$/i.test(req.file.originalname))throw new Error('ZIP plugin required');const domains=validDomains(JSON.parse(req.body.domains||'[]'));if(!domains.length)throw new Error('Select at least one domain');const credentials={host:req.body.host,port:req.body.port,user:req.body.user,password:req.body.password};const j=newJob('plugin_upload',domains);runPluginUpload(j,credentials,domains,req.file,req.body.activate==='true');res.status(202).json({ok:true,job:publicJob(j)})}catch(e){res.status(400).json({ok:false,error:e.message})}});

function proxy(req,res){const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.originalUrl||req.url,method:req.method,headers:{...req.headers,host:`${HOST}:${UPSTREAM_PORT}`}},u=>{res.statusCode=u.statusCode||502;for(const[k,v]of Object.entries(u.headers))if(v!==undefined)res.setHeader(k,v);u.pipe(res)});p.on('error',e=>res.status(502).json({ok:false,error:`Agent unavailable: ${e.message}`}));req.pipe(p)}
app.use((req,res)=>proxy(req,res));

app.listen(FRONT_PORT,HOST,()=>console.log(`COMMAND gateway v0.9.3 fast-ssh http://${HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));
process.on('SIGINT',()=>{child.kill('SIGINT');process.exit(0)});process.on('SIGTERM',()=>{child.kill('SIGTERM');process.exit(0)});
