import express from 'express';
import cors from 'cors';
import { Client } from 'ssh2';

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'1mb'}));

const execSSH=({host,port=22,user,password},command)=>new Promise((resolve,reject)=>{
 const c=new Client();
 const timer=setTimeout(()=>{c.end();reject(new Error('SSH timeout'));},15000);
 c.on('ready',()=>c.exec(command,(err,stream)=>{
  if(err){clearTimeout(timer);c.end();return reject(err)}
  let out='',stderr='';
  stream.on('data',d=>out+=d).stderr.on('data',d=>stderr+=d);
  stream.on('close',code=>{clearTimeout(timer);c.end();code===0?resolve(out):reject(new Error(stderr||`exit ${code}`))});
 })).on('error',e=>{clearTimeout(timer);reject(e)}).connect({host,port:Number(port)||22,username:user,password,readyTimeout:12000});
});

const INVENTORY=`printf 'HOSTNAME=';hostname; printf 'UPTIME=';uptime -p 2>/dev/null||uptime; printf 'LOAD=';cat /proc/loadavg 2>/dev/null|cut -d' ' -f1-3; printf 'MEM=';free -m|awk '/Mem:/{print $2","$3","$7}'; printf 'DISK=';df -P /|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}'; printf 'INODES=';df -Pi /|awk 'NR==2{gsub("%","",$5);print $2","$3","$4","$5}'; printf 'OS=';(. /etc/os-release 2>/dev/null;echo "$PRETTY_NAME"); printf 'DOMAINS=';find "$HOME/domains" -mindepth 1 -maxdepth 1 -type d 2>/dev/null|wc -l`;
function parse(s){const o={};for(const l of s.trim().split('\n')){const i=l.indexOf('=');if(i>0)o[l.slice(0,i)]=l.slice(i+1)}const mem=(o.MEM||'0,0,0').split(',').map(Number),disk=(o.DISK||'0,0,0,0').split(',').map(Number),ino=(o.INODES||'0,0,0,0').split(',').map(Number);return {hostname:o.HOSTNAME,os:o.OS,uptime:o.UPTIME,load:o.LOAD,memory:{total:mem[0],used:mem[1],available:mem[2],percent:mem[0]?Math.round(mem[1]/mem[0]*100):0},disk:{total:disk[0],used:disk[1],available:disk[2],percent:disk[3]},inodes:{total:ino[0],used:ino[1],available:ino[2],percent:ino[3]},domains:Number(o.DOMAINS||0)}}

app.get('/api/health',(_,res)=>res.json({ok:true,mode:'localhost-control-agent'}));
app.post('/api/connect',async(req,res)=>{try{const data=parse(await execSSH(req.body,INVENTORY));res.json({ok:true,data})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.post('/api/domains',async(req,res)=>{try{const cmd=`for d in "$HOME"/domains/*; do [ -d "$d/public_html" ] || continue; n=$(basename "$d"); wp=0; wc=0; [ -f "$d/public_html/wp-config.php" ]&&wp=1; [ -d "$d/public_html/wp-content/plugins/woocommerce" ]&&wc=1; printf '%s|%s|%s\\n' "$n" "$wp" "$wc"; done`;const out=await execSSH(req.body,cmd);res.json({ok:true,domains:out.trim().split('\n').filter(Boolean).map(x=>{const[n,wp,wc]=x.split('|');return{name:n,wordpress:wp==='1',woocommerce:wc==='1'}})})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.post('/api/audit',async(req,res)=>{try{const cmd=`printf 'PORTS\\n'; (ss -lnt 2>/dev/null||netstat -lnt 2>/dev/null)|head -30; printf '\\nUPDATES\\n'; (apt list --upgradable 2>/dev/null||true)|head -30; printf '\\nLARGEST\\n'; du -x -h --max-depth=2 "$HOME/domains" 2>/dev/null|sort -h|tail -20`;res.json({ok:true,report:await execSSH(req.body,cmd)})}catch(e){res.status(400).json({ok:false,error:e.message})}});

const port=Number(process.env.COMMAND_PORT||8787);app.listen(port,'127.0.0.1',()=>console.log(`COMMAND agent http://127.0.0.1:${port}`));
