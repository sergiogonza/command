import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const HOST='127.0.0.1';

const child=spawn(process.execPath,['server/agent-v090.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT),COMMAND_UPSTREAM_PORT:String(UPSTREAM_PORT+1)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND v0.9 core exited',code)});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const validPlugins=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9._-]+$/i.test(x));

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age','86400');
}
function json(res,status,payload){cors(res);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload))}
function readBody(req,limit=24*1024*1024){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',d=>{size+=d.length;if(size>limit){reject(new Error('Request too large'));req.destroy();return}chunks.push(d)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function execSSHRaw({host,port=22,user,password},command,timeoutMs=600000){return new Promise((resolve,reject)=>{const c=new Client();const timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'))},timeoutMs);c.on('ready',()=>c.exec(command,(err,s)=>{if(err){clearTimeout(timer);c.end();return reject(err)}let stdout='',stderr='';s.on('data',d=>stdout+=d);s.stderr.on('data',d=>stderr+=d);s.on('close',code=>{clearTimeout(timer);c.end();resolve({stdout,stderr,code:Number(code||0)})})})).on('error',e=>{clearTimeout(timer);reject(e)}).connect({host,port:Number(port)||22,username:user,password,readyTimeout:20000,keepaliveInterval:10000,keepaliveCountMax:3})})}

async function fastPluginDelete(buf,res){
  let body;try{body=JSON.parse(buf.toString()||'{}')}catch{return false}
  const job=body.job||{};
  if(job.type!=='plugin_delete')return false;
  const domains=validDomains(job.domains),plugins=validPlugins(job.plugins).filter(x=>x!=='woocommerce');
  if(!domains.length||body.confirmation!==job.confirmation){json(res,400,{ok:false,error:'Confirmation token mismatch'});return true}
  if(!plugins.length){json(res,400,{ok:false,error:'No removable plugins selected'});return true}
  const list=domains.map(q).join(' '),plist=plugins.map(q).join(' ');
  const cmd=`verified=0; skipped=0; failed=0; targets=0; for n in ${list}; do targets=$((targets+1)); p="$HOME/domains/$n/public_html"; [ -f "$p/wp-config.php" ] || { printf '%s|plugin|SKIP|site|no_wp_config\\n' "$n"; skipped=$((skipped+1)); continue; }; cd "$p" 2>/dev/null || { printf '%s|plugin|ERROR|site|cannot_cd\\n' "$n"; failed=$((failed+1)); continue; }; for slug in ${plist}; do dir="wp-content/plugins/$slug"; single="wp-content/plugins/$slug.php"; if [ ! -e "$dir" ] && [ ! -e "$single" ]; then printf '%s|plugin|SKIP|%s|not_installed\\n' "$n" "$slug"; skipped=$((skipped+1)); continue; fi; wp plugin deactivate "$slug" --skip-themes >/dev/null 2>&1 || true; out=$(wp plugin delete "$slug" --skip-themes 2>&1); rc=$?; if [ ! -e "$dir" ] && [ ! -e "$single" ]; then printf '%s|plugin|VERIFIED|%s|deleted\\n' "$n" "$slug"; verified=$((verified+1)); else safe=$(printf '%s' "$out"|tr '\\n|' '__'|cut -c1-160); printf '%s|plugin|ERROR|%s|not_deleted|%s\\n' "$n" "$slug" "$safe"; failed=$((failed+1)); fi; done; done; printf 'SUMMARY|verified=%s|skipped=%s|failed=%s|targets=%s|plugins=%s\\n' "$verified" "$skipped" "$failed" "$targets" ${plugins.length}; exit 0`;
  try{
    const rr=await execSSHRaw(body,cmd,600000);
    const report=(rr.stdout||'').trim()||'SUMMARY|verified=0|skipped=0|failed=0';
    return json(res,200,{ok:true,report,optimized:true});
  }catch(e){return json(res,400,{ok:false,error:e.message})}
}

function proxyBuffer(req,res,buf){const headers={...req.headers,host:`${HOST}:${UPSTREAM_PORT}`,'content-length':String(buf.length)};const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{cors(res);res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent unavailable: ${e.message}`}));p.end(buf)}
function proxy(req,res){const headers={...req.headers,host:`${HOST}:${UPSTREAM_PORT}`};const p=http.request({host:HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{cors(res);res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});p.on('error',e=>json(res,502,{ok:false,error:`Agent unavailable: ${e.message}`}));req.pipe(p)}

const server=http.createServer(async(req,res)=>{
  cors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  try{
    if(req.method==='POST'&&req.url==='/api/jobs/execute'){
      const buf=await readBody(req);
      const handled=await fastPluginDelete(buf,res);
      if(handled!==false)return;
      return proxyBuffer(req,res,buf);
    }
    return proxy(req,res);
  }catch(e){return json(res,400,{ok:false,error:e.message})}
});

server.listen(FRONT_PORT,HOST,()=>console.log(`COMMAND gateway v0.9.1 fast-bulk http://${HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));
process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0))});
