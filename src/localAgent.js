const BASE=import.meta.env.VITE_LOCAL_AGENT_URL||'http://127.0.0.1:8787';
async function post(path,body){const r=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Agent error');return j}
export const localAgent={
 connect:c=>post('/api/connect',c),
 domains:c=>post('/api/domains',c),
 security:c=>post('/api/security/live',c),
 crm:(c,domains=[])=>post('/api/crm',{...c,domains}),
 plugins:(c,domains=[])=>post('/api/plugins',{...c,domains}),
 files:(c,path='')=>post('/api/files',{...c,path}),
 fileUsage:(c,path='')=>post('/api/files/usage',{...c,path}),
 products:(c,domains=[])=>post('/api/products',{...c,domains}),
 audit:c=>post('/api/audit',c),
 preview:(c,job)=>post('/api/jobs/preview',{...c,job}),
 execute:(c,job,confirmation)=>post('/api/jobs/execute',{...c,job,confirmation})
};
