const BASE=import.meta.env.VITE_LOCAL_AGENT_URL||'http://127.0.0.1:8787';
async function post(path,body){const r=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Agent error');return j}
export const localAgent={connect:c=>post('/api/connect',c),domains:c=>post('/api/domains',c),audit:c=>post('/api/audit',c)};
