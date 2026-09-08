const BASE=import.meta.env.VITE_LOCAL_AGENT_URL||'http://127.0.0.1:8787';
async function post(path,body){const r=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Agent error');return j}
async function uploadPlugin(c,domains,file,activate=true){const fd=new FormData();fd.append('host',c.host);fd.append('port',String(c.port||22));fd.append('user',c.user);fd.append('password',c.password);fd.append('domains',JSON.stringify(domains));fd.append('activate',String(activate));fd.append('file',file);const r=await fetch(BASE+'/api/plugins/upload',{method:'POST',body:fd});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Upload failed');return j}
export const localAgent={
 connect:c=>post('/api/connect',c),domains:c=>post('/api/domains',c),security:c=>post('/api/security/live',c),
 crm:(c,domains=[])=>post('/api/crm',{...c,domains}),payments:(c,domains=[])=>post('/api/payments',{...c,domains}),plugins:(c,domains=[])=>post('/api/plugins',{...c,domains}),
 uploadPlugin,
 files:(c,path='')=>post('/api/files',{...c,path}),fileUsage:(c,path='')=>post('/api/files/usage',{...c,path}),products:(c,domains=[])=>post('/api/products',{...c,domains}),commerce:(c,domains=[])=>post('/api/commerce/summary',{...c,domains}),orders:(c,domains=[])=>post('/api/commerce/orders',{...c,domains}),customers:(c,domains=[])=>post('/api/commerce/customers',{...c,domains}),audit:c=>post('/api/audit',c),
 preview:(c,job)=>post('/api/jobs/preview',{...c,job}),execute:(c,job,confirmation)=>post('/api/jobs/execute',{...c,job,confirmation})
};
