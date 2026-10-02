// Runs the actual renderer in an already running Tauri dev shell via temporary HMR.
// No audio, library access, persisted settings, second app, or generated media files.
// Usage: node scripts/benchmark-visualizer.mjs
// KDJ_VIZ_BASELINE_REF selects the Git renderer to compare (default HEAD).
// KDJ_VIZ_COMPARE_ONLY=1 skips timing; KDJ_VIZ_COMPARE_IMAGE saves a comparison PNG.
import fs from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const entry = new URL('../src/main.tsx', import.meta.url);
const names = ['paintLeftLayers', 'paintRightImage', 'paintLights', 'paintArc', 'paintSmallSpectrum', 'paintLyrics', 'paintDisc'];
const source = `
import { prepareStudio, drawStudioFrame } from './src/lib/visualizerStudioRenderer';
import { createVisualizerProject, syncVisualizerImages } from './src/lib/visualizerStudio';
import * as baseline from 'studio-baseline';
export async function run() {
  if (!('__TAURI_INTERNALS__' in window) || new URLSearchParams(location.search).has('window')) return;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#151d22;display:grid;place-items:center;pointer-events:none';
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain'; host.append(canvas);
  document.body.append(host);
  const root=document.getElementById('root'), display=root?.style.display;
  if(root)root.style.display='none';
  try {
    if(!COMPARE_ONLY){
    await new Promise(r=>setTimeout(r,2000));
    await fetch(REPORT,{method:'POST',body:JSON.stringify({phase:'start',width:0})});
    await new Promise(r=>setTimeout(r,3000));
    await fetch(REPORT,{method:'POST',body:JSON.stringify({phase:'end',width:0})});
    }
    const art = document.createElement('canvas'); art.width = art.height = 768;
    const ac = art.getContext('2d'), gradient = ac.createLinearGradient(0,0,768,768);
    gradient.addColorStop(0,'#10384f'); gradient.addColorStop(.5,'#69b9a8'); gradient.addColorStop(1,'#ece1bc');
    ac.fillStyle=gradient; ac.fillRect(0,0,768,768);
    for(let i=0;i<120;i++){ac.fillStyle='rgba(255,255,255,.14)';ac.fillRect((i*71)%768,(i*139)%768,90,4);}
    const project=createVisualizerProject({id:1,path:'',title:'Visualizer performance',artist:'KDJ',album:'',filename:'fixture'});
    syncVisualizerImages(project,1);project.lyrics.mode='scroll';
    project.lyrics.lrc='[00:00]实时可视化性能测试\\n[00:03]背景、频谱和歌词\\n[00:06]保持一致的时间和画面\\n[00:09]Performance test';
    const timeline={version:1,sample_rate:22050,sample_count:22050*12,fps:60,frames:Array.from({length:720},(_,i)=>({bands:Array.from({length:64},(_,b)=>.25+.2*Math.sin(i*.09+b*.22)),bass:.3,rms:.2,onset:i%30===0?.8:0}))};
    const results=[];
    for(const width of COMPARE_ONLY?[]:[960,1440]) {
      for(const [label,renderer,fps] of [['baseline',baseline,60],['current', {prepareStudio,drawStudioFrame},60],['current', {prepareStudio,drawStudioFrame},30]]) {
      const prepared=renderer.prepareStudio(project,[art],timeline,width);
      canvas.width=prepared.project.scene.canvas.width;canvas.height=prepared.project.scene.canvas.height;
      const c=canvas.getContext('2d',{alpha:false});
      const samples=[],gaps=[]; let previous=0, deadline=0, i=0;
      while(i<fps*4) {
        await new Promise(requestAnimationFrame);
        const now=performance.now();if(now<deadline-.5)continue;
        deadline=deadline===0 || now-deadline>200 ? now+1000/fps : deadline+1000/fps;
        if(i>=fps && previous)gaps.push(now-previous);previous=now;
        if(i===fps){globalThis.__studioProfile={};await fetch(REPORT,{method:'POST',body:JSON.stringify({phase:'start',width,label,fps})});}
        const start=performance.now();renderer.drawStudioFrame(c,prepared,i/fps);
        if(i>=fps)samples.push(performance.now()-start);i++;
      }
      await fetch(REPORT,{method:'POST',body:JSON.stringify({phase:'end',width,label,fps})});
      samples.sort((a,b)=>a-b);gaps.sort((a,b)=>a-b);
      results.push({width,label,fps,frames:samples.length,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,p95Ms:samples[Math.floor(samples.length*.95)],frameGapP95:gaps[Math.floor(gaps.length*.95)],sections:structuredClone(globalThis.__studioProfile)});
      }
    }
    const comparisons=[];let snapshot;
    for(const width of [640,1440]) {
      const prepared=prepareStudio(project,[art],timeline,width), original=baseline.prepareStudio(project,[art],timeline,width);
      for(const time of [2,3.1,3.5,9.7,1,3.1]) {
      {
        const reference=document.createElement('canvas'),current=document.createElement('canvas');
        reference.width=current.width=prepared.project.scene.canvas.width;reference.height=current.height=prepared.project.scene.canvas.height;
        const rc=reference.getContext('2d',{willReadFrequently:true}),cc=current.getContext('2d',{willReadFrequently:true});
        baseline.drawStudioFrame(rc,original,time);drawStudioFrame(cc,prepared,time);
        if(SAVE_IMAGE && width===1440 && time===2){
          const image=document.createElement('canvas');image.width=1440;image.height=810;
          const ic=image.getContext('2d');ic.drawImage(reference,0,0,720,405);ic.drawImage(current,720,0,720,405);
          ic.drawImage(reference,reference.width*.45,0,reference.width*.25,reference.height,0,405,720,405);
          ic.drawImage(current,current.width*.45,0,current.width*.25,current.height,720,405,720,405);
          snapshot=image.toDataURL('image/png');
        }
        const a=rc.getImageData(0,0,reference.width,reference.height).data,b=cc.getImageData(0,0,current.width,current.height).data;
        let difference=0,large=0;for(let i=0;i<a.length;i+=4){let error=0;for(let k=0;k<3;k++)error+=Math.abs(a[i+k]-b[i+k]);difference+=error;if(error/3>20)large++;}
        comparisons.push({width,time,meanChannelError:difference/(a.length/4*3),fractionAbove20:large/(a.length/4)});
        if(difference/(a.length/4*3)>1 || large/(a.length/4)>.005)throw new Error('Visual comparison exceeded tolerance: '+JSON.stringify(comparisons.at(-1)));
      }
      }
    }
    await fetch(REPORT,{method:'POST',body:JSON.stringify({userAgent:navigator.userAgent,results,comparisons,snapshot})});
  }catch(error){await fetch(REPORT,{method:'POST',body:JSON.stringify({error:String(error)})});}
  finally{host.remove();if(root)root.style.display=display;delete globalThis.__studioProfile;}
}
`;
let resolveResult;
const result = new Promise(resolve => { resolveResult = resolve; });
let bundle = '';
const cpu=[];let start;
function snapshot(){
  const rows=execFileSync('ps',['-axo','pid=,time=,comm='],{encoding:'utf8'}).split('\n');
  const processes={};
  for(const row of rows){const m=row.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);if(!m || !/com\.apple\.WebKit\.(GPU|WebContent)$|KDJ Dev.app\/Contents\/MacOS/.test(m[3]))continue;
    const parts=m[2].split(':').map(Number);let seconds=0;for(const value of parts)seconds=seconds*60+value;processes[m[1]]=seconds;
  }
  return {time:performance.now(),processes};
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    let body = ''; for await (const part of req) body += part;
    const data=JSON.parse(body);
    if(data.phase){const current=snapshot();if(data.phase==='start')start=current;
      else {const seconds=(current.time-start.time)/1000;const perProcess={};for(const [pid,time]of Object.entries(current.processes))if(start.processes[pid]!==undefined)perProcess[pid]=100*(time-start.processes[pid])/seconds;cpu.push({width:data.width,label:data.label,fps:data.fps,seconds,percent:Object.values(perProcess).reduce((a,b)=>a+b,0),perProcess});}
      res.end('ok');return;
    }
    if(data.snapshot && process.env.KDJ_VIZ_COMPARE_IMAGE)await fs.writeFile(process.env.KDJ_VIZ_COMPARE_IMAGE,Buffer.from(data.snapshot.split(',')[1],'base64'));
    delete data.snapshot;
    res.end('ok'); resolveResult({...data,cpuScope:'All WebKit GPU/WebContent processes plus KDJ Dev; compare idle and active in an otherwise quiet session',cpu});
  } else { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const marker = `\n// Temporary visualizer benchmark; removed by scripts/benchmark-visualizer.mjs.\nif (import.meta.env.DEV) { const benchmarkUrl = ${JSON.stringify(url)}; void import(/* @vite-ignore */ benchmarkUrl).then(m => m.run()); }\n`;
let timer;
let rejectAbort;
const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
const abort=()=>rejectAbort(Error('Benchmark interrupted'));
process.once('SIGINT',abort);process.once('SIGTERM',abort);
function instrument(contents){
  for(const name of names){
    contents=contents.replace('function '+name+'(', 'function unprofiled_'+name+'(');
    contents+=`\nfunction ${name}(...args:any[]){const start=performance.now();try{return unprofiled_${name}(...args)}finally{const p=globalThis.__studioProfile;if(p)p['${name}']=(p['${name}']||0)+performance.now()-start;}}`;
  }
  return contents;
}
try {
  bundle = (await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false,define:{REPORT:JSON.stringify(url),COMPARE_ONLY:String(process.env.KDJ_VIZ_COMPARE_ONLY==='1'),SAVE_IMAGE:String(!!process.env.KDJ_VIZ_COMPARE_IMAGE)},plugins:[{
    name:'profile-studio',setup(b){
    b.onResolve({filter:/^studio-baseline$/},()=>({path:'studio-baseline',namespace:'baseline'}));
    b.onLoad({filter:/.*/,namespace:'baseline'},()=>({contents:instrument(execFileSync('git',['show', (process.env.KDJ_VIZ_BASELINE_REF || 'HEAD')+':src/lib/visualizerStudioRenderer.ts'],{encoding:'utf8'})),loader:'ts',resolveDir:new URL('../src/lib/',import.meta.url).pathname}));
    b.onLoad({filter:/visualizerStudioRenderer\.ts$/},async args=>{
      const contents=instrument(await fs.readFile(args.path,'utf8'));
      return {contents,loader:'ts'};
    });}
  }]})).outputFiles[0].text;
  await fs.appendFile(entry, marker);
  const report = await Promise.race([result,aborted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Tauri benchmark timed out; keep the dev window visible')),90000);})]);
  console.log(JSON.stringify(report,null,2));
  if(report.error) process.exitCode=1;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
  const current=await fs.readFile(entry,'utf8');
  if(current.includes(marker))await fs.writeFile(entry,current.replace(marker,''));
  server.closeAllConnections();server.close();
}
