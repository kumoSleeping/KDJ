// Render the editable CSS composition and package its separate layers as a PSD.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = '/Users/kumo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/';
const { chromium } = require(runtime + 'playwright');
const sharp = require(runtime + 'sharp');
const out = path.join(__dirname, 'exports');
const layerDir = path.join(out, 'layers');
fs.mkdirSync(layerDir, { recursive: true });
const u16 = n => { const b=Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const i16 = n => { const b=Buffer.alloc(2); b.writeInt16BE(n); return b; };
const u32 = n => { const b=Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const concat = a => Buffer.concat(a);
function packBits(row) {
  const chunks=[]; let i=0;
  while(i<row.length){
    let n=1; while(i+n<row.length && n<128 && row[i+n]===row[i])n++;
    if(n>=3){chunks.push(Buffer.from([257-n,row[i]]));i+=n;continue;}
    const start=i; i+=n;
    while(i<row.length && i-start<128){let r=1;while(i+r<row.length&&r<3&&row[i+r]===row[i])r++;if(r>=3)break;i++;}
    chunks.push(Buffer.from([i-start-1]),row.subarray(start,i));
  }
  return concat(chunks);
}
function channelBytes(raw,w,h,c){
  const rows=[];const lengths=[];
  for(let y=0;y<h;y++){const row=Buffer.alloc(w);for(let x=0;x<w;x++)row[x]=raw[(y*w+x)*4+c];const r=packBits(row);rows.push(r);lengths.push(u16(r.length));}
  return concat([u16(1),...lengths,...rows]);
}
async function makeLayer(file,name){
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=0,b=0;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x+1);b=Math.max(b,y+1);}
  if(r<=l){l=t=0;r=b=1;}
  const w=r-l,h=b-t,raw=Buffer.alloc(w*h*4);
  for(let y=0;y<h;y++)data.copy(raw,y*w*4,((y+t)*info.width+l)*4,((y+t)*info.width+r)*4);
  const channels=[0,1,2,3].map(c=>channelBytes(raw,w,h,c));
  const nb=Buffer.from(name,'ascii');const pascal=Buffer.alloc(Math.ceil((nb.length+1)/4)*4);pascal[0]=nb.length;nb.copy(pascal,1);
  const extra=concat([u32(0),u32(0),pascal]);
  const record=concat([u32(t),u32(l),u32(b),u32(r),u16(4),...channels.map((c,i)=>concat([i16(i===3?-1:i),u32(c.length)])),Buffer.from('8BIM'+(name.includes('directional form shadows')?'mul ':'norm')),Buffer.from([255,0,0,0]),u32(extra.length),extra]);
  return {record,channels};
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1200,height:1800},deviceScaleFactor:2});
  const page=await context.newPage();
  await page.goto(pathToFileURL(path.join(__dirname,'poster.html')).href+'?export');
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
  const full=path.join(out,'KDJ-directional-light-2400x3600.png');
  await page.screenshot({path:full,omitBackground:true});
  await sharp(full).resize(1200,1800).png().toFile(path.join(out,'KDJ-directional-light-preview.png'));
  const names=await page.evaluate(()=>[...document.querySelectorAll('#poster>.layer')].map(el=>el.dataset.name));
  const layerFiles=[];
  for(let i=0;i<names.length;i++){
    await page.evaluate(index=>{document.querySelectorAll('#poster > .layer').forEach((el,j)=>el.style.visibility=j===index?'visible':'hidden');},i);
    const file=path.join(layerDir,String(i+1).padStart(2,'0')+'.png');
    await page.screenshot({path:file,omitBackground:true});layerFiles.push(file);
  }
  await browser.close();
  const layers=[];for(let i=0;i<names.length;i++)layers.push(await makeLayer(layerFiles[i],names[i]));
  let layerInfo=concat([i16(layers.length),...layers.map(l=>l.record),...layers.flatMap(l=>l.channels)]);
  if(layerInfo.length%2)layerInfo=concat([layerInfo,Buffer.alloc(1)]);
  const section=concat([u32(layerInfo.length),layerInfo,u32(0)]);
  const {data,info}=await sharp(full).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const merged=[];for(let c=0;c<3;c++){const plane=Buffer.alloc(info.width*info.height);for(let i=0;i<plane.length;i++)plane[i]=data[i*4+c];merged.push(plane);}
  const header=concat([Buffer.from('8BPS'),u16(1),Buffer.alloc(6),u16(3),u32(info.height),u32(info.width),u16(8),u16(3)]);
  fs.writeFileSync(path.join(out,'KDJ-directional-light-layered.psd'),concat([header,u32(0),u32(0),u32(section.length),section,u16(0),...merged]));
  fs.writeFileSync(path.join(out,'layer-index.json'),JSON.stringify(names.map((name,i)=>({name,file:'layers/'+String(i+1).padStart(2,'0')+'.png'})),null,2));
  console.log('Exported PNG, preview, layer PNGs and layered PSD.');
})().catch(e=>{console.error(e);process.exitCode=1;});
