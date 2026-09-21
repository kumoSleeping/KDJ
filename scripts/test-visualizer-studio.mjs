// Isolated React + native FFmpeg acceptance. No production library access.
// Usage: node scripts/test-visualizer-studio.mjs /new/output/directory [cover.png]
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import WebSocket from 'ws';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv[2])throw new Error('Provide a new output directory');
const out=path.resolve(process.argv[2]);await fs.mkdir(out);
const art=path.resolve(process.argv[3]||path.join(root,'design/posters/blue-flow-layered/assets/chihaya-painted.png'));await fs.access(art);
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'kdj-studio-test-')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let native,chrome,server,ws,timer,info;
async function stop(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGTERM');for(let i=0;i<30&&p.exitCode===null&&p.signalCode===null;i++)await sleep(100);if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');}
try{
execFileSync(path.join(root,'target/debug/examples/audio_visualizer'),['--prepare-demo',path.join(tmp,'media')]);
await build({entryPoints:[path.join(root,'tests/visualizerStudio.browser.tsx')],outfile:path.join(tmp,'ui.js'),bundle:true,platform:'browser',format:'iife',target:'es2022',define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false','import.meta.env.PROD':'true'},logLevel:'silent'});
let launchError;const log=[];
native=spawn(path.join(root,'target/debug/examples/visualizer_studio_acceptance'),[path.join(tmp,'api'),path.join(tmp,'media/audio.wav')],{stdio:['ignore','pipe','pipe']});
native.on('error',e=>launchError=e);native.stdout.on('data',b=>log.push(b.toString()));native.stderr.on('data',b=>log.push(b.toString()));
for(let i=0;i<300&&!info;i++){if(launchError)throw launchError;if(native.exitCode!==null)throw new Error(log.join(''));try{info=JSON.parse(await fs.readFile(path.join(tmp,'api/bridge.json'),'utf8'));}catch{await sleep(100);}}
if(!info)throw new Error('Test server not ready');
const backend=new URL(info.baseUrl),files=new Map([['/ui.js',[path.join(tmp,'ui.js'),'text/javascript']],['/ui.css',[path.join(tmp,'ui.css'),'text/css']],['/cover.png',[art,'image/png']],['/studio-software.mp4',[path.join(info.directory,'studio-software.mp4'),'video/mp4']]]);
// This proxy only forwards to the generated test server. Bearer auth is unchanged.
server=http.createServer(async(req,res)=>{try{
if(req.url.startsWith('/api/')){const headers={...req.headers,host:backend.host};delete headers.origin;const u=http.request(new URL(req.url,backend),{method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});u.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.on('close',()=>u.destroy());req.pipe(u);return;}
if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><style>body{margin:0;background:#10191f}</style><script src="/ui.js" defer></script>');return;}
if(req.url==='/bridge.json'){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(info));return;}
const f=files.get(req.url);if(!f){res.writeHead(404);res.end();return;}const [name,type]=f,{size}=await fs.stat(name),r=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),a=r?Number(r[1]):0,b=r?.[2]?Math.min(+r[2],size-1):size-1;
if(a>b||a>=size){res.writeHead(416);res.end();return;}res.writeHead(r?206:200,{'content-type':type,'content-length':b-a+1,'accept-ranges':'bytes',...(r?{'content-range':`bytes ${a}-${b}/${size}`}:{})});createReadStream(name,{start:a,end:b}).on('error',()=>res.destroy()).pipe(res);
}catch(e){if(!res.headersSent)res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=path.join(tmp,'profile');chrome=spawn(process.env.KDJ_TEST_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--window-size=1440,1200',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore'});chrome.on('error',e=>launchError=e);
let port;for(let i=0;i<200&&!port;i++){if(launchError)throw launchError;try{port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await sleep(100);}}if(!port)throw new Error('Browser not ready');
const tab=(await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())).find(t=>t.type==='page');ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});let id=0;const pending=new Map();
ws.on('message',b=>{const m=JSON.parse(b),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});
const evaluate=async(expression,awaitPromise=false)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
const work=async()=>{
while(!await evaluate('!!globalThis.studioAcceptance'))await sleep(100);
const result=await evaluate('globalThis.studioAcceptance',true);
const frame=await evaluate('globalThis.studioFrame');if(frame)await fs.writeFile(path.join(out,'reference-frame.png'),Buffer.from(frame.split(',')[1],'base64'));
const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,'editor-panel.png'),Buffer.from(shot.data,'base64'));
if(result.ok){const focus='Array.from(document.querySelectorAll(".kd-viz-range")).find(e=>e.textContent.includes("水平焦点")).querySelector("input").value',before=await evaluate(focus),p=await evaluate('(()=>{const r=document.querySelector(".kd-viz-preview canvas").getBoundingClientRect();return{x:r.x+r.width*.7,y:r.y+r.height*.5}})()');await call('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+35,y:p.y+12,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+35,y:p.y+12,button:'left',clickCount:1});await sleep(200);const after=await evaluate(focus);result.pointerDrag={before,after,changed:before!==after};result.ok=before!==after;const remaining=await fs.readdir(info.directory);result.noCanceledOutput=!remaining.includes('canceled.mp4');result.noScratchDirectories=!remaining.some(n=>n.startsWith('.kdj-composition-'));result.ok&&=result.noCanceledOutput&&result.noScratchDirectories;}
await fs.writeFile(path.join(out,'acceptance.json'),JSON.stringify(result,null,2));return result;};
const result=await Promise.race([work(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Acceptance timed out')),240000))]);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}finally{
clearTimeout(timer);ws?.terminate();await stop(chrome);await stop(native);server?.closeAllConnections();server?.close();
if(info)for(const name of ['studio-software.mp4','studio-auto-60.mp4']){try{await fs.copyFile(path.join(info.directory,name),path.join(out,name));}catch{}}
await fs.writeFile(path.join(out,'fixture-note.txt'),'Test artwork: existing repository image. Audio: generated eight-second signal, not the reference song. Production library/media unchanged.\n');await fs.rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
