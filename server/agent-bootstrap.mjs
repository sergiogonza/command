import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=path.dirname(new URL(import.meta.url).pathname);
const source=path.join(dir,'agent-gateway.mjs');
const runtime=path.join(dir,'.agent-gateway.runtime.mjs');

let code=fs.readFileSync(source,'utf8');

// Escape shell parameter expansion inside JavaScript template literals.
code=code
  .replaceAll('"${PRETTY_NAME:-Linux}"','"\\${PRETTY_NAME:-Linux}"')
  .replaceAll('"${SSH_CONNECTION:-}"','"\\${SSH_CONNECTION:-}"')
  .replaceAll('"${SSH_CLIENT:-}"','"\\${SSH_CLIENT:-}"');

// Add a WordPress core-update inventory and a verified bulk updater directly
// to the outer gateway. This keeps it independent from the older core agent.
const wpHandlers=String.raw`
async function handleWordPressUpdatesBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const domains=validDomains(body.domains);
    if(!domains.length)return json(res,400,{ok:false,error:'Select at least one domain'});
    const list=domains.map(q).join(' ');
    const cmd=\`for n in \${list}; do
      p="$HOME/domains/$n/public_html"
      if [ ! -f "$p/wp-config.php" ]; then printf '%s|SKIP|no_wp_config\\n' "$n"; continue; fi
      cd "$p" 2>/dev/null || { printf '%s|ERROR|cannot_cd\\n' "$n"; continue; }
      current=$(wp core version --skip-plugins --skip-themes 2>/dev/null); rc=$?
      if [ $rc -ne 0 ] || [ -z "$current" ]; then printf '%s|ERROR|core_version_unreadable\\n' "$n"; continue; fi
      check=$(wp core check-update --format=csv --fields=version,update_type --skip-plugins --skip-themes 2>/dev/null | tail -n +2 | head -1)
      if [ -n "$check" ]; then
        latest=$(printf '%s' "$check" | cut -d, -f1 | tr -d '"')
        type=$(printf '%s' "$check" | cut -d, -f2 | tr -d '"')
        printf '%s|UPDATE|%s|%s|%s\\n' "$n" "$current" "$latest" "$type"
      else
        printf '%s|CURRENT|%s|%s|none\\n' "$n" "$current" "$current"
      fi
    done
    exit 0\`;
    const rr=await execSSHRaw(body,cmd,240000);
    const sites=[];
    for(const line of rr.stdout.split('\\n').filter(Boolean)){
      const [domain,status,current,latest,type]=line.split('|');
      if(status==='UPDATE'||status==='CURRENT')sites.push({domain,status,current,latest,type,needsUpdate:status==='UPDATE'});
      else sites.push({domain,status:'ERROR',current:'',latest:'',type:'',needsUpdate:false,error:[current,latest,type].filter(Boolean).join('|')||status});
    }
    const needsUpdate=sites.filter(x=>x.needsUpdate).length;
    json(res,200,{ok:true,sites,targets:domains.length,needsUpdate,current:sites.filter(x=>x.status==='CURRENT').length,errors:sites.filter(x=>x.status==='ERROR').length});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}

async function handleWordPressUpdateExecuteBuffer(buf,res){
  try{
    const body=JSON.parse(buf.toString('utf8')||'{}');
    const domains=validDomains(body.domains);
    if(!domains.length)return json(res,400,{ok:false,error:'Select at least one domain'});
    if(body.confirm!==true)return json(res,400,{ok:false,error:'Explicit confirmation required'});
    const list=domains.map(q).join(' ');
    const cmd=\`for n in \${list}; do
      p="$HOME/domains/$n/public_html"
      if [ ! -f "$p/wp-config.php" ]; then printf '%s|SKIP|no_wp_config\\n' "$n"; continue; fi
      cd "$p" 2>/dev/null || { printf '%s|ERROR|cannot_cd\\n' "$n"; continue; }
      before=$(wp core version --skip-plugins --skip-themes 2>/dev/null)
      check=$(wp core check-update --format=csv --fields=version --skip-plugins --skip-themes 2>/dev/null | tail -n +2 | head -1 | tr -d '"')
      if [ -z "$check" ]; then printf '%s|SKIP|already_current|%s\\n' "$n" "$before"; continue; fi
      out=$(wp core update --skip-plugins --skip-themes 2>&1); rc=$?
      after=$(wp core version --skip-plugins --skip-themes 2>/dev/null)
      remain=$(wp core check-update --format=count --skip-plugins --skip-themes 2>/dev/null)
      if [ $rc -eq 0 ] && [ "$after" != "$before" ] && [ "${remain:-0}" = "0" ]; then
        printf '%s|VERIFIED|%s|%s\\n' "$n" "$before" "$after"
      elif [ $rc -eq 0 ] && [ "${remain:-0}" = "0" ]; then
        printf '%s|VERIFIED|%s|%s\\n' "$n" "$before" "$after"
      else
        safe=$(printf '%s' "$out" | tr '\\n|' '__' | cut -c1-200)
        printf '%s|ERROR|%s|%s|%s\\n' "$n" "$before" "$after" "$safe"
      fi
    done
    exit 0\`;
    const rr=await execSSHRaw(body,cmd,600000);
    const lines=rr.stdout.split('\\n').filter(Boolean);
    const verified=lines.filter(x=>x.includes('|VERIFIED|')).length;
    const skipped=lines.filter(x=>x.includes('|SKIP|')).length;
    const failed=lines.filter(x=>x.includes('|ERROR|')).length;
    const report=[...lines,\`SUMMARY|verified=\${verified}|skipped=\${skipped}|failed=\${failed}|targets=\${domains.length}\`].join('\\n');
    json(res,200,{ok:true,report,summary:{verified,skipped,failed,targets:domains.length}});
  }catch(e){json(res,400,{ok:false,error:e.message})}
}
`;
code=code.replace('const server=http.createServer(async(req,res)=>{',wpHandlers+'\nconst server=http.createServer(async(req,res)=>{');

// Browser runs Vite on localhost:5173 while the agent listens on 127.0.0.1:8787.
// Add CORS to all direct and proxied responses, and handle preflight locally.
code=code.replace(
  'const server=http.createServer(async(req,res)=>{',
  `const server=http.createServer(async(req,res)=>{\n  res.setHeader('Access-Control-Allow-Origin','*');\n  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');\n  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');\n  res.setHeader('Access-Control-Max-Age','86400');\n  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}\n  if(req.method==='POST'&&req.url==='/api/wordpress/updates'){try{return handleWordPressUpdatesBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}}\n  if(req.method==='POST'&&req.url==='/api/wordpress/update'){try{return handleWordPressUpdateExecuteBuffer(await readBody(req),res)}catch(e){return json(res,400,{ok:false,error:e.message})}}`
);

code=code
  .replaceAll("res.writeHead(u.statusCode||502,u.headers);u.pipe(res)","res.writeHead(u.statusCode||502,{...u.headers,'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Content-Type, Authorization'});u.pipe(res)")
  .replaceAll("res.writeHead(u.statusCode||502,u.headers);\n    u.pipe(res);","res.writeHead(u.statusCode||502,{...u.headers,'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Content-Type, Authorization'});\n    u.pipe(res);");

fs.writeFileSync(runtime,code,'utf8');
try{
  await import(pathToFileURL(runtime).href+'?v='+Date.now());
}catch(err){
  console.error('COMMAND gateway bootstrap failed:',err);
  process.exitCode=1;
}
