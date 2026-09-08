const BASE=(import.meta.env.VITE_CONTROL_API_URL||'').replace(/\/$/,'');
export async function api(path,options={}){
 if(!BASE) throw new Error('VITE_CONTROL_API_URL is not configured');
 const r=await fetch(BASE+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
 if(!r.ok) throw new Error(await r.text()||('HTTP '+r.status));
 return r.json();
}
export const control={
 testConnection:(body)=>api('/v1/connect/test',{method:'POST',body:JSON.stringify(body)}),
 servers:()=>api('/v1/servers'),
 createJob:(body)=>api('/v1/jobs',{method:'POST',body:JSON.stringify(body)}),
 claudePlan:(body)=>api('/v1/claude/plan',{method:'POST',body:JSON.stringify(body)})
};
