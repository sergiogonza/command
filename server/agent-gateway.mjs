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

function execSSHRaw({host,port=22,user,password},command){return new Promise((resolve,reject)=>{
  const c=new Client();
  const timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'))},180000);
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

async function handleBackupCleanup(req,res){
  try{
    const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');
    const job=body.job||{};
    const domains=validDomains(job.domains);
    if(!domains.length||body.confirmation!==job.confirmation){
      res.writeHead(400,{'content-type':'application/json'});
      return res.end(JSON.stringify({ok:false,error:'Confirmation token mismatch'}));
    }
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
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,report,summary:{verified,skipped,failed,targets:domains.length}}));
  }catch(e){
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:false,error:e.message}));
  }
}

function proxy(req,res){
  const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`};
  const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{
    res.writeHead(u.statusCode||502,u.headers);
    u.pipe(res);
  });
  p.on('error',e=>{
    res.writeHead(502,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:false,error:`Agent upstream unavailable: ${e.message}`}));
  });
  req.pipe(p);
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/jobs/execute'){
    const chunks=[];let size=0;
    req.on('data',d=>{size+=d.length;chunks.push(d)});
    req.on('end',async()=>{
      const buf=Buffer.concat(chunks);
      let parsed=null;
      try{parsed=JSON.parse(buf.toString('utf8'))}catch{}
      if(parsed?.job?.type==='backup_cleanup'){
        const fakeReq=new (class extends (await import('node:stream')).Readable{_read(){this.push(buf);this.push(null)}})();
        return handleBackupCleanup(fakeReq,res);
      }
      const headers={...req.headers,host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`,'content-length':String(buf.length)};
      const p=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});
      p.on('error',e=>{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:`Agent upstream unavailable: ${e.message}`}))});
      p.end(buf);
    });
    return;
  }
  proxy(req,res);
});

server.listen(FRONT_PORT,UPSTREAM_HOST,()=>console.log(`COMMAND gateway http://${UPSTREAM_HOST}:${FRONT_PORT} -> ${UPSTREAM_PORT}`));

process.on('SIGINT',()=>{child.kill('SIGINT');server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{child.kill('SIGTERM');server.close(()=>process.exit(0))});
