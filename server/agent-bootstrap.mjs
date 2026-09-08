import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=path.dirname(new URL(import.meta.url).pathname);
const source=path.join(dir,'agent-gateway.mjs');
const runtime=path.join(dir,'.agent-gateway.runtime.mjs');

let code=fs.readFileSync(source,'utf8');

// Shell parameter expansion inside JS template literals must be escaped so Node
// does not try to parse it as JavaScript interpolation.
code=code
  .replaceAll('"${PRETTY_NAME:-Linux}"','"\\${PRETTY_NAME:-Linux}"')
  .replaceAll('"${SSH_CONNECTION:-}"','"\\${SSH_CONNECTION:-}"')
  .replaceAll('"${SSH_CLIENT:-}"','"\\${SSH_CLIENT:-}"');

// The browser runs Vite on localhost:5173 while the agent listens on 127.0.0.1:8787.
// Add CORS at the outer gateway so *every* direct response and every proxied response
// carries the required headers. Also answer OPTIONS preflight locally.
code=code.replace(
  "const server=http.createServer(async(req,res)=>{",
  `const server=http.createServer(async(req,res)=>{\n  res.setHeader('Access-Control-Allow-Origin','*');\n  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');\n  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');\n  res.setHeader('Access-Control-Max-Age','86400');\n  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}`
);

// Proxy responses need CORS too because writeHead(status, upstreamHeaders) can
// otherwise replace the outer headers on some Node versions.
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
