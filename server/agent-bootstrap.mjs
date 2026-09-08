import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=path.dirname(new URL(import.meta.url).pathname);
const source=path.join(dir,'agent-gateway.mjs');
const runtime=path.join(dir,'.agent-gateway.runtime.mjs');

let code=fs.readFileSync(source,'utf8');
code=code
  .replaceAll('"${PRETTY_NAME:-Linux}"','"\\${PRETTY_NAME:-Linux}"')
  .replaceAll('"${SSH_CONNECTION:-}"','"\\${SSH_CONNECTION:-}"')
  .replaceAll('"${SSH_CLIENT:-}"','"\\${SSH_CLIENT:-}"');

fs.writeFileSync(runtime,code,'utf8');
try{
  await import(pathToFileURL(runtime).href+'?v='+Date.now());
}catch(err){
  console.error('COMMAND gateway bootstrap failed:',err);
  process.exitCode=1;
}
