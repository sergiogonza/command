import http from 'node:http';
import {spawn} from 'node:child_process';
import {Client} from 'ssh2';

const FRONT_PORT=Number(process.env.COMMAND_PORT||8787);
const UPSTREAM_PORT=Number(process.env.COMMAND_UPSTREAM_PORT||8788);
const UPSTREAM_HOST='127.0.0.1';

const child=spawn(process.execPath,['server/index-v2.mjs'],{
  stdio:'inherit',
  env:{...process.env,COMMAND_PORT:String(UPSTREAM_PORT)}
});
child.on('exit',code=>{if(code!==0)console.error('COMMAND upstream exited',code)});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const validPlugins=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9._-]+$/i.test(x));

function execSSHRaw({host,port=22,user,password},command){return new Promise((resolve,reject)=>{
  const c=new Client();
  const timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'))},240000);
  c.on('ready',()=>c.exec(command,(err,s)=>{
    if(err){clearTimeout(timer);c.end();return reject(err)}
    let stdout='',stderr='';
    s.on('data',d=>stdout+=d);
    s.stderr.on('data',d=>stderr+=d);
    s.on('close',code=>{clearTimeout(timer);c.end();resolve({stdout,stderr,code:Number(code||0)})});
  })).on('error',e=>{clearTimeout(timer);reject(e)}).connect({host,port:Number(port)||22,username:user,password,readyTimeout:25000});
})}

function readBody(req,limit=20*1024*1024){return new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  req.on('data',d=>{size+=d.length;if(size>limit){reject(new Error('Request too large'));req.destroy();return}chunks.push(d)});
  req.on('end',()=>resolve(Buffer.concat(chunks)));
  req.on('error',reject);
})}

function json(res,status,payload){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload))}

async function handlePluginsInventoryBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const domains=validDomains(body.domains);
    if(!domains.length)return json(res,400,{ok:false,error:'Select at least one domain'});
    const list=domains.map(q).join(' ');
    const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"
  if [ ! -f "$p/wp-config.php" ]; then
    printf '%s|__DIAG__|skip|no_wp_config\\n' "$n"
    continue
  fi
  cd "$p" 2>/dev/null || { printf '%s|__DIAG__|error|cannot_cd\\n' "$n"; continue; }
  out=$(wp plugin list --fields=name,status,version --format=csv --skip-themes 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    safe=$(printf '%s' "$out" | tr '\\n|' '__' | cut -c1-180)
    printf '%s|__DIAG__|error|%s\\n' "$n" "$safe"
    continue
  fi
  printf '%s\\n' "$out" | tail -n +2 | while IFS=, read -r name status version; do
    name=$(printf '%s' "$name" | sed 's/^"//;s/"$//')
    status=$(printf '%s' "$status" | sed 's/^"//;s/"$//')
    version=$(printf '%s' "$version" | sed 's/^"//;s/"$//')
    [ -n "$name" ] && printf '%s|%s|%s|%s\\n' "$n" "$name" "$status" "$version"
  done
done
exit 0`;
    const rr=await execSSHRaw(body,cmd);
    const plugins=[];const diagnostics=[];
    for(const line of rr.stdout.split('\n').filter(Boolean)){
      const parts=line.split('|');
      if(parts[1]==='__DIAG__'){diagnostics.push({domain:parts[0],status:parts[2],message:parts.slice(3).join('|')});continue}
      if(parts.length<4)continue;
      const [domain,name,status,...rest]=parts;
      const version=rest.join('|');
      plugins.push({domain,name,status,version});
    }
    const unique=new Map();
    for(const p of plugins){
      const x=unique.get(p.name)||{name:p.name,installed:0,active:0,inactive:0,versions:new Set(),domains:[]};
      x.installed++;if(p.status==='active')x.active++;else x.inactive++;x.versions.add(p.version||'');x.domains.push(p.domain);unique.set(p.name,x);
    }
    const inventory=[...unique.values()].map(x=>({...x,versions:[...x.versions].filter(Boolean)})).sort((a,b)=>a.name.localeCompare(b.name));
    json(res,200,{ok:true,plugins,inventory,targetCount:domains.length,uniqueCount:inventory.length,diagnostics});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}

async function handleBackupCleanupBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const job=body.job||{};
    const domains=validDomains(job.domains);
    if(!domains.length||body.confirmation!==job.confirmation)return json(res,400,{ok:false,error:'Confirmation token mismatch'});
    const list=domains.map(q).join(' ');
    const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"
  if [ ! -f "$p/wp-config.php" ]; then printf '%s|backup|SKIP|no_wp_config\\n' "$n"; continue; fi
  cd "$p" 2>/dev/null || { printf '%s|backup|ERROR|cannot_cd\\n' "$n"; continue; }
  found=0
  for x in wp-content/wpvividbackups wp-content/wpvivid_uploads wp-content/updraft wp-content/backups; do
    [ -e "$x" ] || continue
    found=1
    size=$(du -sh "$x" 2>/dev/null | awk '{print $1}')
    [ -n "$size" ] || size='?'
    err=$(rm -rf -- "$x" 2>&1); rc=$?
    if [ $rc -eq 0 ] && [ ! -e "$x" ]; then
      printf '%s|backup|VERIFIED|deleted|%s|%s\\n' "$n" "$x" "$size"
    elif [ ! -e "$x" ]; then
      printf '%s|backup|VERIFIED|deleted_with_warning|%s|%s\\n' "$n" "$x" "$size"
    else
      safeerr=$(printf '%s' "$err" | tr '\\n| ' '___' | cut -c1-180)
      printf '%s|backup|ERROR|not_deleted|%s|%s|%s\\n' "$n" "$x" "$size" "$safeerr"
    fi
  done
  [ $found -eq 1 ] || printf '%s|backup|SKIP|no_backup_dirs\\n' "$n"
done
exit 0`;
    const rr=await execSSHRaw(body,cmd);
    const lines=rr.stdout.split('\n').filter(Boolean);
    const verified=lines.filter(x=>x.includes('|VERIFIED|')).length;
    const skipped=lines.filter(x=>x.includes('|SKIP|')).length;
    const failed=lines.filter(x=>x.includes('|ERROR|')).length;
    const report=[...lines,`SUMMARY|verified=${verified}|skipped=${skipped}|failed=${failed}|targets=${domains.length}`].join('\n');
    json(res,200,{ok:true,report,summary:{verified,skipped,failed,targets:domains.length}});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}

async function handlePluginDeleteBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const job=body.job||{};
    const domains=validDomains(job.domains);
    const plugins=validPlugins(job.plugins).filter(x=>x!=='woocommerce');
    if(!domains.length||body.confirmation!==job.confirmation)return json(res,400,{ok:false,error:'Confirmation token mismatch'});
    if(!plugins.length)return json(res,400,{ok:false,error:'No plugins selected (WooCommerce is protected)'});
    const list=domains.map(q).join(' '),plist=plugins.map(q).join(' ');
    const cmd=`for n in ${list}; do
  p="$HOME/domains/$n/public_html"
  if [ ! -f "$p/wp-config.php" ]; then printf '%s|plugin|SKIP|site|no_wp_config\\n' "$n"; continue; fi
  cd "$p" 2>/dev/null || { printf '%s|plugin|ERROR|site|cannot_cd\\n' "$n"; continue; }
  for slug in ${plist}; do
    if ! wp plugin is-installed "$slug" --skip-themes >/dev/null 2>&1; then
      printf '%s|plugin|SKIP|%s|not_installed\\n' "$n" "$slug"
      continue
    fi
    wp plugin deactivate "$slug" --skip-themes >/dev/null 2>&1 || true
    out=$(wp plugin delete "$slug" --skip-themes 2>&1); rc=$?
    if ! wp plugin is-installed "$slug" --skip-themes >/dev/null 2>&1; then
      printf '%s|plugin|VERIFIED|%s|deleted\\n' "$n" "$slug"
    else
      safe=$(printf '%s' "$out" | tr '\\n|' '__' | cut -c1-180)
      printf '%s|plugin|ERROR|%s|not_deleted|rc=%s|%s\\n' "$n" "$slug" "$rc" "$safe"
    fi
  done
done
exit 0`;
    const rr=await execSSHRaw(body,cmd);
    const lines=rr.stdout.split('\n').filter(Boolean);
    const verified=lines.filter(x=>x.includes('|VERIFIED|')).length;
    const skipped=lines.filter(x=>x.includes('|SKIP|')).length;
    const failed=lines.filter(x=>x.includes('|ERROR|')).length;
    const report=[...lines,`SUMMARY|verified=${verified}|skipped=${skipped}|failed=${failed}|targets=${domains.length}|plugins=${plugins.length}`].join('\n');
    json(res,200,{ok:true,report,summary:{verified,skipped,failed,targets:domains.length,plugins:plugins.length}});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}

function proxyBuffer(req,res,buf){
  const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`,'content-length':String(buf.length)};
  const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});
  p.on('error',e=>json(res,502,{ok:false,error:`Agent upstream unavailable: ${e.message}`}));
  p.end(buf);
}
function proxy(req,res){
  const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`};
  const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});
  p.on('error',e=>json(res,502,{ok:false,error:`Agent upstream unavailable: ${e.message}`}));
  req.pipe(p);
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/plugins'){
    try{return handlePluginsInventoryBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}
  }
  if(req.method==='POST'&&req.url==='/api/jobs/execute'){
    try{
      const buf=await readBody(req);
      let parsed=null;try{parsed=JSON.parse(buf.toString('utf8'))}catch{}
      if(parsed?.job?.type==='backup_cleanup')return handleBackupCleanupBuffer(buf,res);
      if(parsed?.job?.type==='plugin_delete')return handlePluginDeleteBuffer(buf,res);
      return proxyBuffer(req,res,buf);
    }catch(e){return json(res,400,{ok:false,error:e.message})}
  }
  proxy(req,res);
});

server.listen(FRONT_PORT,UPSTREAM_HOST,()=>console.log(`COMMAND gateway v0.7.2 http://${UPSTREAM_HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));

process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0))});
