import express from 'express';
import cors from 'cors';
import {Client} from 'ssh2';

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'3mb'}));

const execSSH=({host,port=22,user,password},command)=>new Promise((resolve,reject)=>{
 const c=new Client(),timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'))},45000);
 c.on('ready',()=>c.exec(command,(err,s)=>{
  if(err){clearTimeout(timer);c.end();return reject(err)}
  let out='',bad='';
  s.on('data',d=>out+=d);
  s.stderr.on('data',d=>bad+=d);
  s.on('close',code=>{clearTimeout(timer);c.end();code===0?resolve(out):reject(new Error(bad||`exit ${code}`))});
 })).on('error',e=>{clearTimeout(timer);reject(e)})
 .connect({host,port:Number(port)||22,username:user,password,readyTimeout:15000});
});

const q=s=>`'${String(s??'').replaceAll("'","'\\''")}'`;
const validDomains=a=>(Array.isArray(a)?a:[]).filter(x=>/^[a-z0-9.-]+$/i.test(x));
const cleanPath=s=>String(s||'').replace(/[^a-zA-Z0-9_./-]/g,'').replace(/^\/+|\/+$/g,'').replace(/\.\./g,'');

const INVENTORY=`printf 'HOSTNAME=';hostname;
printf 'UPTIME=';uptime -p 2>/dev/null||uptime;
printf 'LOAD=';cat /proc/loadavg 2>/dev/null|cut -d' ' -f1-3;
printf 'MEM=';free -m|awk '/Mem:/{print $2","$3","$7}';
printf 'DISK=';df -P "$HOME"|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';
printf 'INODES=';df -Pi "$HOME"|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}';
printf 'OS=';(. /etc/os-release 2>/dev/null;echo "$PRETTY_NAME");
printf 'DOMAINS=';find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d 2>/dev/null|wc -l`;

function parse(s){
 const o={};
 for(const l of s.trim().split('\n')){const i=l.indexOf('=');if(i>0)o[l.slice(0,i)]=l.slice(i+1)}
 const mem=(o.MEM||'0,0,0').split(',').map(Number),disk=(o.DISK||'0,0,0,0').split(',').map(Number),ino=(o.INODES||'0,0,0,0').split(',').map(Number);
 return {hostname:o.HOSTNAME,os:o.OS,uptime:o.UPTIME,load:o.LOAD,memory:{total:mem[0],used:mem[1],available:mem[2],percent:mem[0]?Math.round(mem[1]/mem[0]*100):0},disk:{total:disk[0],used:disk[1],available:disk[2],percent:disk[3]},inodes:{total:ino[0],used:ino[1],available:ino[2],percent:ino[3]},domains:Number(o.DOMAINS||0)};
}

app.get('/api/health',(_,r)=>r.json({ok:true,mode:'localhost-control-agent'}));

app.post('/api/connect',async(req,r)=>{
 try{r.json({ok:true,data:parse(await execSSH(req.body,INVENTORY))})}
 catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/domains',async(req,r)=>{
 try{
  const cmd=`for d in "$HOME"/domains/*; do
   [ -d "$d" ]||continue;
   n=$(basename "$d");
   p="$d/public_html";
   wp=0; wc=0;
   [ -f "$p/wp-config.php" ]&&wp=1;
   [ -d "$p/wp-content/plugins/woocommerce" ]&&wc=1;
   printf '%s|%s|%s\\n' "$n" "$wp" "$wc";
  done`;
  const out=await execSSH(req.body,cmd);
  r.json({ok:true,domains:out.trim().split('\n').filter(Boolean).map(x=>{const[n,wp,wc]=x.split('|');return{name:n,wordpress:wp==='1',woocommerce:wc==='1'}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/security/live',async(req,r)=>{
 try{
  const cmd=`printf 'CONNECTIONS\\n';
(ss -Htan 2>/dev/null||netstat -tan 2>/dev/null)|head -120;
printf '\\nWHO\\n';
(who 2>/dev/null||true)|head -40;
printf '\\nLAST\\n';
(last -i -n 30 2>/dev/null||true);
printf '\\nFAILED\\n';
(lastb -i -n 30 2>/dev/null||grep -Ei 'failed|invalid|authentication failure' "$HOME"/logs/* 2>/dev/null|tail -30||true);
printf '\\nHISTORY\\n';
(tail -n 40 "$HOME/.bash_history" 2>/dev/null||true);
printf '\\nTOP\\n';
(ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu 2>/dev/null||true)|head -35`;
  const raw=await execSSH(req.body,cmd);
  const sections={};let key='RAW';
  for(const line of raw.split('\n')){if(['CONNECTIONS','WHO','LAST','FAILED','HISTORY','TOP'].includes(line.trim())){key=line.trim();sections[key]=[]}else{sections[key]??=[];sections[key].push(line)}}
  const ips=[...new Set((sections.CONNECTIONS||[]).join('\n').match(/(?:\d{1,3}\.){3}\d{1,3}/g)||[])].filter(ip=>!['0.0.0.0','127.0.0.1'].includes(ip));
  r.json({ok:true,connections:sections.CONNECTIONS||[],who:sections.WHO||[],last:sections.LAST||[],failed:sections.FAILED||[],history:sections.HISTORY||[],top:sections.TOP||[],ips});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/audit',async(req,r)=>{
 try{
  const cmd=`printf 'PORTS\\n';(ss -lnt 2>/dev/null||netstat -lnt 2>/dev/null)|head -30;
printf '\\nLARGEST\\n';du -h --max-depth=2 "$HOME/domains" 2>/dev/null|sort -h|tail -30;
printf '\\nINODES BY DOMAIN\\n';for d in "$HOME"/domains/*;do [ -d "$d" ]&&printf '%s ' "$(basename "$d")"&&find "$d" -xdev 2>/dev/null|wc -l;done|sort -k2 -n|tail -20`;
  r.json({ok:true,report:await execSSH(req.body,cmd)});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/files',async(req,r)=>{
 try{
  const path=cleanPath(req.body.path),base='$HOME/domains';
  const cmd=`rel=${q(path)}; p="$HOME/domains"; [ -n "$rel" ]&&p="$p/$rel"; [ -d "$p" ]||exit 2; printf '__PATH__|%s\\n' "$rel"; find "$p" -mindepth 1 -maxdepth 1 -printf '%f|%y|%s\\n' 2>/dev/null|head -500`;
  const out=await execSSH(req.body,cmd),lines=out.trim().split('\n').filter(Boolean),head=lines.shift()||'';
  r.json({ok:true,path:head.startsWith('__PATH__|')?head.slice(9):path,items:lines.map(x=>{const[name,type,size]=x.split('|');return{name,type,size:Number(size)}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/files/usage',async(req,r)=>{
 try{
  const path=cleanPath(req.body.path);
  const out=await execSSH(req.body,`rel=${q(path)}; p="$HOME/domains"; [ -n "$rel" ]&&p="$p/$rel"; [ -d "$p" ]||exit 2; for x in "$p"/*;do [ -e "$x" ]||continue;k=$(du -sk "$x" 2>/dev/null|cut -f1);printf '%s|%s|%s\\n' "$k" "$(basename "$x")" "$x";done|sort -nr|head -100`);
  r.json({ok:true,items:out.trim().split('\n').filter(Boolean).map(x=>{const[kb,name,path]=x.split('|');return{kb:Number(kb||0),name,path}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

const domainLoop=(domains,body)=>{const ds=validDomains(domains);return `for n in ${ds.length?ds.map(q).join(' '):'$(find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" 2>/dev/null)'}; do p="$HOME/domains/$n/public_html"; [ -f "$p/wp-config.php" ]||continue; cd "$p"||continue; ${body}; done`};

app.post('/api/crm',async(req,r)=>{
 try{
  const out=await execSSH(req.body,domainLoop(req.body.domains,`ver=$(wp core version --skip-plugins --skip-themes 2>/dev/null||echo '?'); phpv=$(php -r 'echo PHP_VERSION;' 2>/dev/null||echo '?'); wc=NO; wp plugin is-active woocommerce --skip-themes >/dev/null 2>&1&&wc=YES; pc=$(wp plugin list --format=count --skip-themes 2>/dev/null||echo 0); pp=$(wp option get woocommerce_paypal_settings --format=json --skip-plugins --skip-themes 2>/dev/null||true); size=$(du -sh . 2>/dev/null|cut -f1); printf '%s|%s|%s|%s|%s|%s|%s\\n' "$n" "$ver" "$phpv" "$wc" "$pc" "$size" "$(printf %s "$pp"|base64 -w0 2>/dev/null||printf %s "$pp"|base64)"`));
  r.json({ok:true,sites:out.trim().split('\n').filter(Boolean).map(x=>{const[n,wordpress,php,woocommerce,plugins,size,p64]=x.split('|');let paypal={};try{paypal=JSON.parse(Buffer.from(p64||'','base64').toString()||'{}')}catch{}return{name:n,wordpress,php,woocommerce:woocommerce==='YES',plugins:Number(plugins||0),size,paypalEmail:paypal.email||'',receiverEmail:paypal.receiver_email||''}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/plugins',async(req,r)=>{
 try{
  const out=await execSSH(req.body,domainLoop(req.body.domains,`wp plugin list --fields=name,status,version --format=csv --skip-themes 2>/dev/null|tail -n +2|while IFS=, read -r a b c; do printf '%s|%s|%s|%s\\n' "$n" "$a" "$b" "$c"; done`));
  r.json({ok:true,plugins:out.trim().split('\n').filter(Boolean).map(x=>{const[domain,name,status,version]=x.split('|');return{domain,name,status,version}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/products',async(req,r)=>{
 try{
  const out=await execSSH(req.body,domainLoop(req.body.domains,`wp post list --post_type=product --post_status=publish,draft --fields=ID,post_title --format=csv 2>/dev/null|tail -n +2|head -40|while IFS=, read -r id title;do sku=$(wp post meta get "$id" _sku 2>/dev/null||true); price=$(wp post meta get "$id" _regular_price 2>/dev/null||true); stock=$(wp post meta get "$id" _stock 2>/dev/null||true); printf '%s|%s|%s|%s|%s|%s\\n' "$n" "$id" "$title" "$sku" "$price" "$stock";done`));
  r.json({ok:true,products:out.trim().split('\n').filter(Boolean).map(x=>{const[domain,id,name,sku,price,stock]=x.split('|');return{domain,id:Number(id),name,sku,price,stock}})});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

app.post('/api/jobs/preview',(req,r)=>{
 const job=req.body.job||{},domains=validDomains(job.domains);
 if(!domains.length)return r.status(400).json({ok:false,error:'Select at least one domain'});
 const allowed=['plugin_delete','paypal_update','backup_cleanup','product_create','product_csv'];
 if(!allowed.includes(job.type))return r.status(400).json({ok:false,error:'Unsupported job'});
 const token=Math.random().toString(36).slice(2,8).toUpperCase();
 r.json({ok:true,preview:{...job,domains,count:domains.length,confirmation:token,destructive:['plugin_delete','backup_cleanup'].includes(job.type)}});
});

app.post('/api/jobs/execute',async(req,r)=>{
 try{
  const job=req.body.job||{},domains=validDomains(job.domains);
  if(!domains.length||req.body.confirmation!==job.confirmation)return r.status(400).json({ok:false,error:'Confirmation token mismatch'});
  let body='';
  if(job.type==='plugin_delete'){
   const plugins=(job.plugins||[]).filter(x=>/^[a-z0-9._-]+$/i.test(x)).filter(x=>x!=='woocommerce');
   if(!plugins.length)throw new Error('No valid plugins');
   body=`for x in ${plugins.map(q).join(' ')}; do wp plugin deactivate "$x" --skip-themes >/dev/null 2>&1||true; wp plugin delete "$x" --skip-themes 2>&1|sed "s/^/$n|$x|/"; done`;
  }else if(job.type==='paypal_update'){
   if(!/^\S+@\S+\.\S+$/.test(job.email||''))throw new Error('Invalid email');
   body=`NEW=${q(job.email)} wp eval '$s=get_option("woocommerce_paypal_settings",[]); if(!is_array($s))exit(2); $s["email"]=getenv("NEW"); if(array_key_exists("receiver_email",$s))$s["receiver_email"]=getenv("NEW"); update_option("woocommerce_paypal_settings",$s); echo "updated\\n";' --skip-themes 2>&1|sed "s/^/$n|paypal|/"`;
  }else if(job.type==='backup_cleanup'){
   body=`for x in wp-content/wpvividbackups wp-content/wpvivid_staging wp-content/wpvivid_uploads wp-content/updraft wp-content/backup wp-content/backups; do [ -d "$x" ]&&{ rm -rf -- "$x"; printf '%s|backup|deleted %s\\n' "$n" "$x"; }; done`;
  }else if(job.type==='product_create'){
   const payload=Buffer.from(JSON.stringify(job.product||{})).toString('base64');
   body=`PAYLOAD=${q(payload)} wp eval '$p=json_decode(base64_decode(getenv("PAYLOAD")),true);$id=wp_insert_post(["post_title"=>$p["name"],"post_content"=>$p["description"]??"","post_status"=>$p["status"]??"publish","post_type"=>"product"]);if(!$id||is_wp_error($id))exit(2);update_post_meta($id,"_regular_price",$p["regular_price"]??"");update_post_meta($id,"_price",($p["sale_price"]??"")!==""?$p["sale_price"]:($p["regular_price"]??""));update_post_meta($id,"_sale_price",$p["sale_price"]??"");update_post_meta($id,"_sku",$p["sku"]??"");if(($p["stock"]??"")!==""){update_post_meta($id,"_manage_stock","yes");update_post_meta($id,"_stock",$p["stock"]);update_post_meta($id,"_stock_status",((int)$p["stock"]>0)?"instock":"outofstock");}echo "created|".$id."\\n";' --skip-themes 2>&1|sed "s/^/$n|product|/"`;
  }else if(job.type==='product_csv'){
   const payload=Buffer.from(String(job.csv||'')).toString('base64');
   body=`CSV=${q(payload)} wp eval '$csv=base64_decode(getenv("CSV"));$h=fopen("php://memory","r+");fwrite($h,$csv);rewind($h);$head=fgetcsv($h);while(($row=fgetcsv($h))!==false){if(count($head)!==count($row))continue;$p=array_combine($head,$row);if(empty($p["name"]))continue;$id=wp_insert_post(["post_title"=>$p["name"],"post_content"=>$p["description"]??"","post_status"=>"publish","post_type"=>"product"]);if(!$id||is_wp_error($id))continue;update_post_meta($id,"_regular_price",$p["regular_price"]??"");update_post_meta($id,"_price",$p["regular_price"]??"");update_post_meta($id,"_sku",$p["sku"]??"");if(($p["stock"]??"")!==""){update_post_meta($id,"_manage_stock","yes");update_post_meta($id,"_stock",$p["stock"]);update_post_meta($id,"_stock_status",((int)$p["stock"]>0)?"instock":"outofstock");}echo "created|".$id."|".$p["name"]."\\n";}' --skip-themes 2>&1|sed "s/^/$n|csv|/"`;
  }else throw new Error('Unsupported job');
  const out=await execSSH(req.body,domainLoop(domains,body));
  r.json({ok:true,report:out||'Completed; no matching items.'});
 }catch(e){r.status(400).json({ok:false,error:e.message})}
});

const port=Number(process.env.COMMAND_PORT||8787);
app.listen(port,'127.0.0.1',()=>console.log(`COMMAND agent http://127.0.0.1:${port}`));
