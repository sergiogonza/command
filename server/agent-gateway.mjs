import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';
import geoip from 'geoip-lite';
import fs from 'node:fs';
import path from 'node:path';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const UPSTREAM_HOST='127.0.0.1';
const EVENTS_FILE=path.join(process.cwd(),'server','data','events.jsonl');

const child=spawn(process.execPath,['server/index-v2.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND upstream exited',code)});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const validPlugins=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9._-]+$/i.test(x));

function execSSHRaw({host,port=22,user,password},command,timeoutMs=65000){return new Promise((resolve,reject)=>{
  const c=new Client();
  const timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'))},timeoutMs);
  c.on('ready',()=>c.exec(command,(err,s)=>{
    if(err){clearTimeout(timer);c.end();return reject(err)}
    let stdout='',stderr='';
    s.on('data',d=>stdout+=d);
    s.stderr.on('data',d=>stderr+=d);
    s.on('close',code=>{clearTimeout(timer);c.end();resolve({stdout,stderr,code:Number(code||0)})});
  })).on('error',e=>{clearTimeout(timer);reject(e)}).connect({host,port:Number(port)||22,username:user,password,readyTimeout:18000,keepaliveInterval:10000,keepaliveCountMax:2});
})}

function readBody(req,limit=20*1024*1024){return new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  req.on('data',d=>{size+=d.length;if(size>limit){reject(new Error('Request too large'));req.destroy();return}chunks.push(d)});
  req.on('end',()=>resolve(Buffer.concat(chunks)));
  req.on('error',reject);
})}
function json(res,status,payload){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload))}
function geo(ip){if(!ip)return null;const g=geoip.lookup(ip);return g?{country:g.country||'',region:g.region||'',city:g.city||'',timezone:g.timezone||'',lat:g.ll?.[0]??null,lon:g.ll?.[1]??null}:null}
function readEvents(limit=800){try{if(!fs.existsSync(EVENTS_FILE))return[];return fs.readFileSync(EVENTS_FILE,'utf8').split('\n').filter(Boolean).slice(-limit).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}catch{return[]}}
function appendEvent(e){try{fs.mkdirSync(path.dirname(EVENTS_FILE),{recursive:true});fs.appendFileSync(EVENTS_FILE,JSON.stringify({ts:new Date().toISOString(),...e})+'\n')}catch{}}
function ontology(events){const m=new Map();for(const e of events){if(!e.ip)continue;const x=m.get(e.ip)||{ip:e.ip,first_seen:e.ts,last_seen:e.ts,count:0,actions:new Set(),hosts:new Set(),geo:e.geo||geo(e.ip)};x.count++;if(e.ts<x.first_seen)x.first_seen=e.ts;if(e.ts>x.last_seen)x.last_seen=e.ts;if(e.action)x.actions.add(e.action);if(e.host)x.hosts.add(e.host);m.set(e.ip,x)}return[...m.values()].map(x=>({...x,actions:[...x.actions],hosts:[...x.hosts]})).sort((a,b)=>String(b.last_seen).localeCompare(String(a.last_seen)))}
function parseInventory(raw){const o={};for(const line of raw.split('\n')){if(!line.startsWith('INV|'))continue;const p=line.split('|');o[p[1]]=p.slice(2).join('|')}const mem=(o.MEM||'0,0,0').split(',').map(Number),disk=(o.DISK||'0,0,0,0').split(',').map(Number),ino=(o.INODES||'0,0,0,0').split(',').map(Number);return{hostname:o.HOSTNAME||'',os:o.OS||'',uptime:o.UPTIME||'',load:o.LOAD||'',memory:{total:mem[0]||0,used:mem[1]||0,available:mem[2]||0,percent:mem[0]?Math.round((mem[1]||0)/mem[0]*100):0},disk:{total:disk[0]||0,used:disk[1]||0,available:disk[2]||0,percent:disk[3]||0},inodes:{total:ino[0]||0,used:ino[1]||0,available:ino[2]||0,percent:ino[3]||0},domains:Number(o.DOMAINS||0)}}
function parseSections(raw){const keys=['SSH','ADDR','ROUTE','SOCKETS','LISTEN','NETDEV','WHO','LAST','FAILED','TOPCPU','TOPMEM','HISTORY','INTEGRITY'];const s={};let k='';for(const line of raw.split('\n')){const m=line.match(/^==([A-Z]+)==$/);if(m&&keys.includes(m[1])){k=m[1];s[k]=[];continue}if(k)(s[k]??=[]).push(line)}return s}
function parseSSH(lines=[]){const m=lines.join('\n').match(/SSH_CONNECTION=((?:\d{1,3}\.){3}\d{1,3})\s+(\d+)\s+((?:\d{1,3}\.){3}\d{1,3})\s+(\d+)/);return m?{source_ip:m[1],source_port:Number(m[2]),destination_ip:m[3],destination_port:Number(m[4])}:null}
function extractIPs(text){return[...new Set((text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)||[]).filter(ip=>!['0.0.0.0','127.0.0.1'].includes(ip)))]}
function caps(s){const t=k=>(s[k]||[]).join('\n').trim();return{ssh:!!parseSSH(s.SSH),addresses:!!t('ADDR'),routes:!!t('ROUTE'),sockets:!!t('SOCKETS')&&!/permission denied|not found/i.test(t('SOCKETS')),listeners:!!t('LISTEN')&&!/permission denied|not found/i.test(t('LISTEN')),netdev:/:/.test(t('NETDEV')),sessions:!!t('WHO'),login_history:!!t('LAST'),failed_history:!!t('FAILED'),processes:!!t('TOPCPU')}}

const QUICK_COMMAND=`
printf 'INV|HOSTNAME|'; hostname
printf 'INV|UPTIME|'; (uptime -p 2>/dev/null || uptime) | tr '\\n' ' '; printf '\\n'
printf 'INV|LOAD|'; (cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || printf '?'); printf '\\n'
printf 'INV|MEM|'; free -m 2>/dev/null | awk '/Mem:/{print $2","$3","$7}'
printf 'INV|DISK|'; df -P "$HOME" 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}'
printf 'INV|INODES|'; df -Pi "$HOME" 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}'
printf 'INV|OS|'; (. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-Linux}"); printf '\\n'
printf 'INV|DOMAINS|'; find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l
printf '==SSH==\\n'; printf 'SSH_CONNECTION=%s\\n' "${SSH_CONNECTION:-}"; printf 'SSH_CLIENT=%s\\n' "${SSH_CLIENT:-}"
printf '==ADDR==\\n'; (ip -brief addr 2>/dev/null || ifconfig 2>/dev/null || true) | head -60
printf '==ROUTE==\\n'; (ip route 2>/dev/null || route -n 2>/dev/null || true) | head -60
printf '==SOCKETS==\\n'; (ss -Htunap 2>/dev/null || ss -Htuna 2>/dev/null || netstat -tuna 2>/dev/null || true) | head -120
printf '==LISTEN==\\n'; (ss -Hlntup 2>/dev/null || ss -Hlntu 2>/dev/null || netstat -lntu 2>/dev/null || true) | head -80
printf '==NETDEV==\\n'; (cat /proc/net/dev 2>/dev/null || true) | head -40
printf '==WHO==\\n'; (who 2>/dev/null || true) | head -30
printf '==LAST==\\n'; (last -i -n 30 2>/dev/null || true) | head -35
printf '==FAILED==\\n'; (lastb -i -n 30 2>/dev/null || true) | head -35
printf '==TOPCPU==\\n'; (ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu 2>/dev/null || true) | head -30
printf '==TOPMEM==\\n'; (ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%mem 2>/dev/null || true) | head -30
printf '==HISTORY==\\n'; (tail -n 50 "$HOME/.bash_history" 2>/dev/null || true)
printf '==INTEGRITY==\\n'; (find "$HOME/domains" -maxdepth 3 -type f \\( -name '.htaccess' -o -name 'wp-config.php' \\) -printf '%TY-%Tm-%Td %TH:%TM %p\\n' 2>/dev/null | sort -r | head -50 || true)
exit 0`;

async function quickTelemetry(credentials,{inventory=false}={}){const rr=await execSSHRaw(credentials,QUICK_COMMAND,65000);if(rr.code!==0&&!rr.stdout)throw new Error((rr.stderr||`SSH command exited ${rr.code}`).trim());const sections=parseSections(rr.stdout);const ssh=parseSSH(sections.SSH);const ips=extractIPs(Object.values(sections).flat().join('\n'));if(ssh?.source_ip)appendEvent({action:'ssh_session',host:credentials.host,user:credentials.user,ip:ssh.source_ip,port:ssh.source_port,geo:geo(ssh.source_ip)});for(const ip of ips.filter(x=>x!==ssh?.source_ip).slice(0,40))appendEvent({action:'network_observation',host:credentials.host,user:credentials.user,ip,geo:geo(ip)});const events=readEvents();return{data:inventory?parseInventory(rr.stdout):undefined,security:{ok:true,ssh,currentIp:ssh?.source_ip||'',currentGeo:geo(ssh?.source_ip),ips,sections,capabilities:caps(sections),events:events.slice(-200).reverse(),ontology:ontology(events)}}}
async function handleConnectBuffer(buf,res){try{const body=JSON.parse(buf.toString('utf8')||'{}');if(!body.host||!body.user||!body.password)return json(res,400,{ok:false,error:'Host, user and password are required'});const x=await quickTelemetry(body,{inventory:true});appendEvent({action:'connect',host:body.host,user:body.user,target_hostname:x.data.hostname,ip:x.security.currentIp||undefined,geo:x.security.currentGeo||undefined});json(res,200,{ok:true,data:x.data,security:x.security})}catch(e){json(res,400,{ok:false,error:e.message})}}
async function handleTelemetryBuffer(buf,res){try{const body=JSON.parse(buf.toString('utf8')||'{}');const x=await quickTelemetry(body);json(res,200,x.security)}catch(e){json(res,400,{ok:false,error:e.message})}}

async function handlePluginsInventoryBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const domains=validDomains(body.domains);
    if(!domains.length)return json(res,400,{ok:false,error:'Select at least one domain'});
    const list=domains.map(q).join(' ');
    const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"
  if [ ! -f "$p/wp-config.php" ]; then printf '%s|__DIAG__|skip|no_wp_config\\n' "$n"; continue; fi
  cd "$p" 2>/dev/null || { printf '%s|__DIAG__|error|cannot_cd\\n' "$n"; continue; }
  out=$(wp plugin list --fields=name,status,version --format=csv --skip-themes 2>&1); rc=$?
  if [ $rc -ne 0 ]; then safe=$(printf '%s' "$out" | tr '\\n|' '__' | cut -c1-180); printf '%s|__DIAG__|error|%s\\n' "$n" "$safe"; continue; fi
  printf '%s\\n' "$out" | tail -n +2 | while IFS=, read -r name status version; do
    name=$(printf '%s' "$name" | sed 's/^"//;s/"$//'); status=$(printf '%s' "$status" | sed 's/^"//;s/"$//'); version=$(printf '%s' "$version" | sed 's/^"//;s/"$//');
    [ -n "$name" ] && printf '%s|%s|%s|%s\\n' "$n" "$name" "$status" "$version"
  done
done
exit 0`;
    const rr=await execSSHRaw(body,cmd,240000);const plugins=[];const diagnostics=[];
    for(const line of rr.stdout.split('\n').filter(Boolean)){const parts=line.split('|');if(parts[1]==='__DIAG__'){diagnostics.push({domain:parts[0],status:parts[2],message:parts.slice(3).join('|')});continue}if(parts.length<4)continue;const[domain,name,status,...rest]=parts;plugins.push({domain,name,status,version:rest.join('|')})}
    const unique=new Map();for(const p of plugins){const x=unique.get(p.name)||{name:p.name,installed:0,active:0,inactive:0,versions:new Set(),domains:[]};x.installed++;if(p.status==='active')x.active++;else x.inactive++;x.versions.add(p.version||'');x.domains.push(p.domain);unique.set(p.name,x)}
    const inventory=[...unique.values()].map(x=>({...x,versions:[...x.versions].filter(Boolean)})).sort((a,b)=>a.name.localeCompare(b.name));json(res,200,{ok:true,plugins,inventory,targetCount:domains.length,uniqueCount:inventory.length,diagnostics});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}

async function handleBackupCleanupBuffer(buf,res){try{const body=JSON.parse(buf.toString('utf8')||'{}'),job=body.job||{},domains=validDomains(job.domains);if(!domains.length||body.confirmation!==job.confirmation)return json(res,400,{ok:false,error:'Confirmation token mismatch'});const list=domains.map(q).join(' ');const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"; if [ ! -f "$p/wp-config.php" ]; then printf '%s|backup|SKIP|no_wp_config\\n' "$n"; continue; fi
  cd "$p" 2>/dev/null || { printf '%s|backup|ERROR|cannot_cd\\n' "$n"; continue; }; found=0
  for x in wp-content/wpvividbackups wp-content/wpvivid_uploads wp-content/updraft wp-content/backups; do [ -e "$x" ] || continue; found=1; size=$(du -sh "$x" 2>/dev/null|awk '{print $1}'); [ -n "$size" ]||size='?'; err=$(rm -rf -- "$x" 2>&1); rc=$?; if [ $rc -eq 0 ] && [ ! -e "$x" ]; then printf '%s|backup|VERIFIED|deleted|%s|%s\\n' "$n" "$x" "$size"; elif [ ! -e "$x" ]; then printf '%s|backup|VERIFIED|deleted_with_warning|%s|%s\\n' "$n" "$x" "$size"; else safeerr=$(printf '%s' "$err"|tr '\\n| ' '___'|cut -c1-180); printf '%s|backup|ERROR|not_deleted|%s|%s|%s\\n' "$n" "$x" "$size" "$safeerr"; fi; done
  [ $found -eq 1 ] || printf '%s|backup|SKIP|no_backup_dirs\\n' "$n"
done
exit 0`;const rr=await execSSHRaw(body,cmd,300000),lines=rr.stdout.split('\n').filter(Boolean),verified=lines.filter(x=>x.includes('|VERIFIED|')).length,skipped=lines.filter(x=>x.includes('|SKIP|')).length,failed=lines.filter(x=>x.includes('|ERROR|')).length,report=[...lines,`SUMMARY|verified=${verified}|skipped=${skipped}|failed=${failed}|targets=${domains.length}`].join('\n');json(res,200,{ok:true,report,summary:{verified,skipped,failed,targets:domains.length}})}catch(e){json(res,400,{ok:false,error:e.message})}}

async function handlePluginDeleteBuffer(buf,res){try{const body=JSON.parse(buf.toString('utf8')||'{}'),job=body.job||{},domains=validDomains(job.domains),plugins=validPlugins(job.plugins).filter(x=>x!=='woocommerce');if(!domains.length||body.confirmation!==job.confirmation)return json(res,400,{ok:false,error:'Confirmation token mismatch'});if(!plugins.length)return json(res,400,{ok:false,error:'No plugins selected (WooCommerce is protected)'});const list=domains.map(q).join(' '),plist=plugins.map(q).join(' ');const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"; if [ ! -f "$p/wp-config.php" ]; then printf '%s|plugin|SKIP|site|no_wp_config\\n' "$n"; continue; fi
  cd "$p" 2>/dev/null || { printf '%s|plugin|ERROR|site|cannot_cd\\n' "$n"; continue; }
  for slug in ${plist}; do if ! wp plugin is-installed "$slug" --skip-themes >/dev/null 2>&1; then printf '%s|plugin|SKIP|%s|not_installed\\n' "$n" "$slug"; continue; fi; wp plugin deactivate "$slug" --skip-themes >/dev/null 2>&1||true; out=$(wp plugin delete "$slug" --skip-themes 2>&1); rc=$?; if ! wp plugin is-installed "$slug" --skip-themes >/dev/null 2>&1; then printf '%s|plugin|VERIFIED|%s|deleted\\n' "$n" "$slug"; else safe=$(printf '%s' "$out"|tr '\\n|' '__'|cut -c1-180); printf '%s|plugin|ERROR|%s|not_deleted|rc=%s|%s\\n' "$n" "$slug" "$rc" "$safe"; fi; done
done
exit 0`;const rr=await execSSHRaw(body,cmd,300000),lines=rr.stdout.split('\n').filter(Boolean),verified=lines.filter(x=>x.includes('|VERIFIED|')).length,skipped=lines.filter(x=>x.includes('|SKIP|')).length,failed=lines.filter(x=>x.includes('|ERROR|')).length,report=[...lines,`SUMMARY|verified=${verified}|skipped=${skipped}|failed=${failed}|targets=${domains.length}|plugins=${plugins.length}`].join('\n');json(res,200,{ok:true,report,summary:{verified,skipped,failed,targets:domains.length,plugins:plugins.length}})}catch(e){json(res,400,{ok:false,error:e.message})}}

function proxyBuffer(req,res,buf){const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`,'content-length':String(buf.length)};const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent upstream unavailable: ${e.message}`}));p.end(buf)}
function proxy(req,res){const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`};const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent upstream unavailable: ${e.message}`}));req.pipe(p)}

const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/connect'){try{return handleConnectBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}}
  if(req.method==='POST'&&(req.url==='/api/security/live'||req.url==='/api/network/live')){try{return handleTelemetryBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}}
  if(req.method==='POST'&&req.url==='/api/plugins'){try{return handlePluginsInventoryBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}}
  if(req.method==='POST'&&req.url==='/api/jobs/execute'){try{const buf=await readBody(req);let parsed=null;try{parsed=JSON.parse(buf.toString('utf8'))}catch{}if(parsed?.job?.type==='backup_cleanup')return handleBackupCleanupBuffer(buf,res);if(parsed?.job?.type==='plugin_delete')return handlePluginDeleteBuffer(buf,res);return proxyBuffer(req,res,buf)}catch(e){return json(res,400,{ok:false,error:e.message})}}
  proxy(req,res);
});
server.listen(FRONT_PORT,UPSTREAM_HOST,()=>console.log(`COMMAND gateway v0.8.1 http://${UPSTREAM_HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0))});
