import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const HOST='127.0.0.1';
const JOBS=new Map();

const child=spawn(process.execPath,['server/agent-v090.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT),COMMAND_UPSTREAM_PORT:String(UPSTREAM_PORT+1)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND v0.9 core exited',code)});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const validPlugins=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9._-]+$/i.test(x));

function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Max-Age','86400')}
function json(res,status,payload){cors(res);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload))}
function readBody(req,limit=24*1024*1024){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',d=>{size+=d.length;if(size>limit){reject(new Error('Request too large'));req.destroy();return}chunks.push(d)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function connectSSH({host,port=22,user,password}){return new Promise((resolve,reject)=>{const c=new Client();c.on('ready',()=>resolve(c)).on('error',reject).connect({host,port:Number(port)||22,username:user,password,readyTimeout:20000,keepaliveInterval:10000,keepaliveCountMax:3})})}

function publicJob(j){return{id:j.id,type:j.type,status:j.status,progress:j.progress,processed:j.processed,total:j.total,verified:j.verified,skipped:j.skipped,failed:j.failed,currentDomain:j.currentDomain,currentPlugin:j.currentPlugin,startedAt:j.startedAt,finishedAt:j.finishedAt||null,logs:j.logs.slice(-120),report:j.report||'',error:j.error||''}}
function addLog(j,line){if(!line)return;j.logs.push(line);if(j.logs.length>500)j.logs.splice(0,j.logs.length-500);const p=line.split('|');if(p[0]==='SUMMARY')return;if(p.length>=5&&p[1]==='plugin'){
  j.currentDomain=p[0];j.currentPlugin=p[3]||'';j.processed++;
  if(p[2]==='VERIFIED')j.verified++;else if(p[2]==='SKIP')j.skipped++;else if(p[2]==='ERROR')j.failed++;
  j.progress=Math.min(99,Math.round((j.processed/Math.max(1,j.total))*100));
}}

async function runPluginDelete(j,body,domains,plugins){
  let conn;
  try{
    j.status='connecting';j.logs.push(`CONNECT|${body.host}:${body.port||22}|${body.user}`);
    conn=await connectSSH(body);j.status='running';j.logs.push(`START|targets=${domains.length}|plugins=${plugins.length}`);
    const list=domains.map(q).join(' '),plist=plugins.map(q).join(' ');
    const cmd=`verified=0; skipped=0; failed=0; targets=0; for n in ${list}; do targets=$((targets+1)); p="$HOME/domains/$n/public_html"; if [ ! -f "$p/wp-config.php" ]; then for slug in ${plist}; do printf '%s|plugin|SKIP|%s|no_wp_config\\n' "$n" "$slug"; skipped=$((skipped+1)); done; continue; fi; cd "$p" 2>/dev/null || { for slug in ${plist}; do printf '%s|plugin|ERROR|%s|cannot_cd\\n' "$n" "$slug"; failed=$((failed+1)); done; continue; }; for slug in ${plist}; do dir="wp-content/plugins/$slug"; single="wp-content/plugins/$slug.php"; if [ ! -e "$dir" ] && [ ! -e "$single" ]; then printf '%s|plugin|SKIP|%s|not_installed\\n' "$n" "$slug"; skipped=$((skipped+1)); continue; fi; wp plugin deactivate "$slug" --skip-themes >/dev/null 2>&1 || true; out=$(wp plugin delete "$slug" --skip-themes 2>&1); if [ ! -e "$dir" ] && [ ! -e "$single" ]; then printf '%s|plugin|VERIFIED|%s|deleted\\n' "$n" "$slug"; verified=$((verified+1)); else safe=$(printf '%s' "$out"|tr '\\n|' '__'|cut -c1-160); printf '%s|plugin|ERROR|%s|not_deleted|%s\\n' "$n" "$slug" "$safe"; failed=$((failed+1)); fi; done; done; printf 'SUMMARY|verified=%s|skipped=%s|failed=%s|targets=%s|plugins=%s\\n' "$verified" "$skipped" "$failed" "$targets" ${plugins.length}; exit 0`;
    await new Promise((resolve,reject)=>conn.exec(cmd,(err,s)=>{if(err)return reject(err);let buf='';const feed=d=>{buf+=d.toString();let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);addLog(j,line)}};s.on('data',feed);s.stderr.on('data',d=>{const line='STDERR|'+d.toString().trim();if(line!=='STDERR|')j.logs.push(line)});s.on('close',()=>{if(buf.trim())addLog(j,buf.trim());resolve()})}));
    j.status=j.failed?'warning':'done';j.progress=100;j.finishedAt=new Date().toISOString();j.report=j.logs.filter(x=>!x.startsWith('CONNECT|')&&!x.startsWith('START|')).join('\n');
  }catch(e){j.status='error';j.error=e.message;j.logs.push('FATAL|'+e.message);j.finishedAt=new Date().toISOString();j.progress=100}
  finally{try{conn?.end()}catch{}}
}

async function handleJobStart(buf,res){
  let body;try{body=JSON.parse(buf.toString()||'{}')}catch{return json(res,400,{ok:false,error:'Invalid JSON'})}
  const job=body.job||{};if(job.type!=='plugin_delete')return json(res,400,{ok:false,error:'Live start currently supports plugin_delete'});
  const domains=validDomains(job.domains),plugins=validPlugins(job.plugins).filter(x=>x!=='woocommerce');
  if(!domains.length||body.confirmation!==job.confirmation)return json(res,400,{ok:false,error:'Confirmation token mismatch'});
  if(!plugins.length)return json(res,400,{ok:false,error:'No removable plugins selected'});
  const id=`J${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  const j={id,type:'plugin_delete',status:'queued',progress:0,processed:0,total:domains.length*plugins.length,verified:0,skipped:0,failed:0,currentDomain:'',currentPlugin:'',startedAt:new Date().toISOString(),logs:[],report:'',error:''};JOBS.set(id,j);
  runPluginDelete(j,body,domains,plugins);
  return json(res,202,{ok:true,job:publicJob(j)});
}
function handleJobStatus(req,res){const u=new URL(req.url,`http://${HOST}`),id=u.searchParams.get('id')||'';const j=JOBS.get(id);if(!j)return json(res,404,{ok:false,error:'Job not found'});return json(res,200,{ok:true,job:publicJob(j)})}

function proxyBuffer(req,res,buf){const headers={...req.headers,host:`${HOST}:${UPSTREAM_PORT}`,'content-length':String(buf.length)};const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{cors(res);res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent unavailable: ${e.message}`}));p.end(buf)}
function proxy(req,res){const headers={...req.headers,host:`${HOST}:${UPSTREAM_PORT}`};const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{cors(res);res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent unavailable: ${e.message}`}));req.pipe(p)}

const server=http.createServer(async(req,res)=>{cors(res);if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}try{
  if(req.method==='POST'&&req.url==='/api/jobs/start')return handleJobStart(await readBody(req),res);
  if(req.method==='GET'&&req.url.startsWith('/api/jobs/status'))return handleJobStatus(req,res);
  return proxy(req,res);
}catch(e){return json(res,400,{ok:false,error:e.message})}});

server.listen(FRONT_PORT,HOST,()=>console.log(`COMMAND gateway v0.9.1 live-jobs http://${HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0))});process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0))});
