import React,{useState}from'react';import{Server,ShieldCheck,Boxes,Database,Package,ShoppingCart,Terminal,HardDrive,Activity,Mail,LockKeyhole,RefreshCcw,Trash2,Plus,Upload,ChevronRight,Minimize2,Maximize2}from'lucide-react';

const servers=[
{name:'VPS-01',host:'srv-01',status:'online',cpu:21,ram:48,disk:63,inodes:41,domains:28},
{name:'VPS-02',host:'srv-02',status:'online',cpu:17,ram:39,disk:51,inodes:62,domains:31},
{name:'VPS-03',host:'srv-03',status:'warning',cpu:72,ram:84,disk:88,inodes:91,domains:24}
];
const domains=[
{name:'gotechnode.shop',vps:'VPS-02',wp:'6.x',wc:true,plugins:24,products:317,orders:4485,health:94},
{name:'getdigitalgrid.shop',vps:'VPS-01',wp:'6.x',wc:true,plugins:19,products:204,orders:3310,health:88},
{name:'shop-alpha.test',vps:'VPS-03',wp:'6.x',wc:true,plugins:31,products:488,orders:5102,health:71}
];

function Meter({value}){return <div className="meter"><span style={{width:value+'%'}}/></div>}
function Window({title,children,wide}){const[min,setMin]=useState(false);return <section className={'window '+(wide?'wide':'')}><header><span>{title}</span><div><button onClick={()=>setMin(!min)}>{min?<Maximize2 size={14}/>:<Minimize2 size={14}/>}</button></div></header>{!min&&<div className="window-body">{children}</div>}</section>}
function Stat({icon:Icon,label,value,sub}){return <div className="stat"><Icon size={18}/><div><small>{label}</small><strong>{value}</strong><em>{sub}</em></div></div>}

export default function App(){
 const[selected,setSelected]=useState(domains[0]);
 const[action,setAction]=useState('');
 const[ssh,setSsh]=useState({host:'',user:'',password:''});
 return <div className="app">
  <aside>
   <div className="brand">NOC//COMMAND</div>
   {[
    ['Overview',Activity],['Servers',Server],['Domains',Database],['Security',ShieldCheck],['Files',HardDrive],
    ['Plugins',Boxes],['Products',Package],['Orders',ShoppingCart],['Credentials',LockKeyhole],['Terminal',Terminal]
   ].map(([x,I],i)=><button className={i===0?'active':''} key={x}><I size={17}/>{x}</button>)}
   <div className="aside-foot">NETLIFY HUD<br/><span>CONTROL PLANE UI</span></div>
  </aside>

  <main>
   <div className="topbar"><div><h1>Infrastructure Command Center</h1><p>Multi-VPS · WordPress · WooCommerce · Security · Operations</p></div><div className="live"><span/>LIVE TELEMETRY</div></div>

   <div className="stats">
    <Stat icon={Server} label="SERVERS" value="3" sub="2 healthy · 1 warning"/>
    <Stat icon={Database} label="DOMAINS" value="83" sub="WooCommerce estate"/>
    <Stat icon={ShieldCheck} label="SECURITY" value="87/100" sub="Global score"/>
    <Stat icon={HardDrive} label="INODES" value="64%" sub="Estate average"/>
    <Stat icon={Activity} label="UPTIME" value="99.94%" sub="30 days"/>
   </div>

   <div className="grid">
    <Window title="SERVER MATRIX">
     {servers.map(s=><div className="server-row" key={s.name}><div className="server-title"><b>{s.name}</b><span className={'dot '+s.status}/>{s.host}</div><div className="server-metrics">
      <label>CPU {s.cpu}%<Meter value={s.cpu}/></label><label>RAM {s.ram}%<Meter value={s.ram}/></label>
      <label>DISK {s.disk}%<Meter value={s.disk}/></label><label>INODES {s.inodes}%<Meter value={s.inodes}/></label>
     </div><small>{s.domains} domains</small></div>)}
    </Window>

    <Window title="SSH CONTROL BRIDGE">
     <div className="form-grid">
      <label>SSH host<input value={ssh.host} onChange={e=>setSsh({...ssh,host:e.target.value})} placeholder="123.45.67.89:22"/></label>
      <label>User<input value={ssh.user} onChange={e=>setSsh({...ssh,user:e.target.value})} placeholder="admin"/></label>
      <label>Password<input type="password" value={ssh.password} onChange={e=>setSsh({...ssh,password:e.target.value})} placeholder="••••••••"/></label>
     </div>
     <div className="notice">Credentials are sent only to your private worker API. Do not store them in the frontend or repository.</div>
     <button className="primary">CONNECT & INVENTORY</button>
    </Window>

    <Window title="DOMAIN ESTATE" wide>
     <div className="table">
      <div className="tr head"><span>Domain</span><span>VPS</span><span>Plugins</span><span>Products</span><span>Orders</span><span>Health</span></div>
      {domains.map(d=><button className={'tr '+(selected.name===d.name?'selected':'')} key={d.name} onClick={()=>setSelected(d)}>
       <span>{d.name}</span><span>{d.vps}</span><span>{d.plugins}</span><span>{d.products}</span><span>{d.orders}</span><span>{d.health}% <ChevronRight size={14}/></span>
      </button>)}
     </div>
    </Window>

    <Window title={'DOMAIN OPS // '+selected.name}>
     <div className="ops">
      <button onClick={()=>setAction('maintenance')}><RefreshCcw/>Maintenance</button>
      <button onClick={()=>setAction('plugins')}><Trash2/>Bulk plugins</button>
      <button onClick={()=>setAction('products')}><Plus/>Bulk products</button>
      <button onClick={()=>setAction('orders')}><ShoppingCart/>Test orders</button>
      <button onClick={()=>setAction('paypal')}><Mail/>PayPal email</button>
      <button onClick={()=>setAction('credentials')}><LockKeyhole/>Users/passwords</button>
      <button onClick={()=>setAction('backups')}><HardDrive/>Delete WPVivid backups</button>
      <button onClick={()=>setAction('stock')}><Package/>Stock repair</button>
     </div>
     <div className="action-view">Selected action: <b>{action||'none'}</b></div>
    </Window>

    <Window title="SECURITY POSTURE">
     <div className="security-grid">
      <div><span>SSH hardening</span><b>GOOD</b></div><div><span>Open ports</span><b>7</b></div>
      <div><span>Outdated packages</span><b>12</b></div><div><span>Failed logins</span><b>3</b></div>
      <div><span>Writable files</span><b>9</b></div><div><span>Firewall</span><b>ACTIVE</b></div>
     </div>
     <button className="secondary">RUN READ-ONLY AUDIT</button>
    </Window>

    <Window title="CLAUDE OPERATOR" wide>
     <div className="terminal">
      <div className="terminal-log">
       <p><span>system</span> control plane ready</p>
       <p><span>agent</span> awaiting approved infrastructure action</p>
       <p><span>policy</span> destructive jobs require explicit confirmation</p>
      </div>
      <div className="prompt"><span>claude://</span><input placeholder="Ej: revisa todos los VPS y dime qué dominios tienen inodos > 80%"/><button>RUN</button></div>
     </div>
    </Window>
   </div>
  </main>
 </div>
}