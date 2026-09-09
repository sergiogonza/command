from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import asyncio, json, os, sqlite3, time, uuid, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
DB = ROOT / 'memory' / 'cybermind.db'
DB.parent.mkdir(parents=True, exist_ok=True)
app = FastAPI(title='Cybermind Cognitive Lab')
app.mount('/static', StaticFiles(directory=ROOT/'hud'), name='static')

class Query(BaseModel):
    text: str
    mode: str = 'AUTO'

class Feedback(BaseModel):
    trace_id: str
    value: int


def db():
    conn = sqlite3.connect(DB)
    conn.execute('''CREATE TABLE IF NOT EXISTS traces(
        trace_id TEXT PRIMARY KEY, ts REAL, query TEXT, route TEXT, brain TEXT,
        response TEXT, trace_json TEXT, feedback INTEGER DEFAULT 0)''')
    return conn


def safe_cmd(cmd):
    try:
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, timeout=2)
        return out.strip()
    except Exception as e:
        return f'error: {e}'


def metrics():
    mem = {}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if ':' in line:
                k,v = line.split(':',1); mem[k]=int(v.strip().split()[0])
    except Exception: pass
    total = mem.get('MemTotal',0); avail = mem.get('MemAvailable',0)
    ram_pct = round((1-avail/total)*100,1) if total else 0
    load = os.getloadavg()[0] if hasattr(os,'getloadavg') else 0
    return {'ram_pct':ram_pct,'ram_used_mb':round((total-avail)/1024,1) if total else 0,
            'ram_total_mb':round(total/1024,1) if total else 0,'load1':round(load,2),
            'uptime': safe_cmd(['bash','-lc','cut -d. -f1 /proc/uptime'])}

CYBER = {'ram','memoria','cpu','proceso','procesos','puerto','puertos','red','conexión','conexion','linux','mitre','sigma','cwe','capec','seguridad','cyber','ciber','servicio','log','logs','sistema'}
REASON = {'filosof','diseño','diseno','arte','idea','concepto','campaña','campana','creativ','arquitect','historia','psicolog','semánt','semantic','ontolog','fractal','música','musica'}
DIRECT = {'ram','cpu','uptime','procesos','puertos','ip','disco','temperatura'}

def route_query(q, forced='AUTO'):
    if forced in {'LOGIC','REASON','DUAL'}: return forced, {'logic':1 if forced=='LOGIC' else .2,'reason':1 if forced=='REASON' else .2,'dual':1 if forced=='DUAL' else .2}
    t=q.lower()
    d=sum(k in t for k in DIRECT); c=sum(k in t for k in CYBER); r=sum(k in t for k in REASON)
    if d and len(t.split()) <= 8: route='DIRECT'
    elif c and r: route='DUAL'
    elif c>=r and c: route='LOGIC'
    elif r: route='REASON'
    else: route='REASON'
    scores={'logic':min(.99,.25+.18*c),'reason':min(.99,.25+.18*r),'dual':min(.95,.15+.12*min(c,r))}
    return route,scores


def ontology_for(q, route):
    words=[w.strip('.,;:?!¿¡()[]').lower() for w in q.split() if len(w)>4]
    seen=[]
    for w in words:
        if w not in seen: seen.append(w)
    nodes=[{'id':'query','label':'QUERY','type':'query'}]
    edges=[]
    for i,w in enumerate(seen[:8]):
        nid=f'n{i}'; nodes.append({'id':nid,'label':w[:18],'type':'concept'})
        edges.append({'source':'query','target':nid,'relation':'activates','score':round(.92-i*.06,2)})
    extras = [('logic','LOGIC','brain')] if route in {'LOGIC','DIRECT'} else [('reason','REASON','brain')]
    if route=='DUAL': extras=[('logic','LOGIC','brain'),('reason','REASON','brain')]
    for nid,label,typ in extras:
        nodes.append({'id':nid,'label':label,'type':typ}); edges.append({'source':'query','target':nid,'relation':'routes_to','score':.95})
    return {'nodes':nodes,'edges':edges}


def direct_answer(q):
    t=q.lower()
    m=metrics()
    if 'ram' in t or 'memoria' in t:
        return f"RAM actual: {m['ram_used_mb']} MB de {m['ram_total_mb']} MB ({m['ram_pct']}%)."
    if 'uptime' in t:
        return f"Uptime: {m['uptime']} segundos."
    if 'proceso' in t:
        return safe_cmd(['bash','-lc','ps -eo pid,comm,%mem,%cpu --sort=-%mem | head -n 8'])
    if 'puerto' in t:
        return safe_cmd(['bash','-lc','ss -lntup 2>/dev/null | head -n 20'])
    return json.dumps(m, ensure_ascii=False)


def simulated_brain(q, route):
    if route=='LOGIC':
        return "Cerebro LOGIC seleccionado. Analizaré primero datos observables, métricas, historial y fuentes Cyber RAG; después separaré OBSERVADO / INTERPRETACIÓN / RIESGO / RECOMENDACIÓN."
    if route=='REASON':
        return "Cerebro REASON seleccionado. Construiré relaciones semánticas y ontológicas entre conceptos, recuperaré memoria y conocimiento relevante, y sintetizaré una respuesta conceptual."
    return "Modo DUAL seleccionado. LOGIC producirá una salida estructurada primero; REASON recibirá ese resultado para elaborar una interpretación más amplia."

@app.get('/')
def home(): return FileResponse(ROOT/'hud'/'index.html')

@app.get('/api/metrics')
def api_metrics(): return metrics()

@app.post('/api/query')
def query(payload: Query):
    trace_id='Q-'+uuid.uuid4().hex[:8].upper(); start=time.perf_counter(); events=[]
    def ev(component,event,data=None):
        events.append({'t_ms':round((time.perf_counter()-start)*1000,2),'component':component,'event':event,'data':data or {}})
    ev('router','query_received',{'text':payload.text})
    route,scores=route_query(payload.text,payload.mode); ev('router','route_selected',{'route':route,'scores':scores})
    graph=ontology_for(payload.text,route); ev('ontology','graph_built',{'nodes':len(graph['nodes']),'edges':len(graph['edges'])})
    if route=='DIRECT':
        response=direct_answer(payload.text); brain='TOOLS'; ev('tools','direct_execution',{'route':'DIRECT'})
    else:
        brain='QWEN_LOGIC' if route=='LOGIC' else ('MINICPM_REASON' if route=='REASON' else 'DUAL')
        ev('memory','search',{'quantitative_hits':2 if route in {'LOGIC','DUAL'} else 0,'semantic_hits':3 if route in {'REASON','DUAL'} else 0})
        ev('rag','retrieve',{'cyber':4 if route in {'LOGIC','DUAL'} else 0,'knowledge':5 if route in {'REASON','DUAL'} else 0})
        ev('model','simulated_generation',{'brain':brain,'status':'stub_ready_for_llama_cpp'})
        response=simulated_brain(payload.text,route)
    ev('validator','complete',{'status':'PASS'})
    trace={'trace_id':trace_id,'query':payload.text,'route':route,'scores':scores,'brain':brain,'events':events,'graph':graph,'metrics':metrics()}
    conn=db(); conn.execute('INSERT INTO traces(trace_id,ts,query,route,brain,response,trace_json) VALUES(?,?,?,?,?,?,?)',(trace_id,time.time(),payload.text,route,brain,response,json.dumps(trace,ensure_ascii=False))); conn.commit(); conn.close()
    return {'trace_id':trace_id,'route':route,'brain':brain,'response':response,'trace':trace}

@app.post('/api/feedback')
def feedback(payload: Feedback):
    val=1 if payload.value>0 else -1
    conn=db(); conn.execute('UPDATE traces SET feedback=? WHERE trace_id=?',(val,payload.trace_id)); conn.commit(); conn.close()
    return {'ok':True,'trace_id':payload.trace_id,'feedback':val}

@app.websocket('/ws/metrics')
async def ws_metrics(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_json(metrics()); await asyncio.sleep(1)
    except WebSocketDisconnect: pass
