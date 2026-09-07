const ns='http://www.w3.org/2000/svg';
function shape(parent,tag,attrs){const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);document.getElementById(parent).appendChild(el)}
for(let i=0;i<156;i++){
  const a=(i*1.45-65)*Math.PI/180,r=584,len=i%6===0?18:6;
  shape('radial-ticks','line',{x1:792+Math.cos(a)*r,y1:942+Math.sin(a)*r,x2:792+Math.cos(a)*(r+len),y2:942+Math.sin(a)*(r+len),stroke:'#3263dd','stroke-width':i%6===0?1.5:.8,opacity:.24});
}
for(let i=0;i<19;i++)shape('back-lines','path',{d:`M ${-130+i*2} ${815+i*5} C ${195+i*3} ${600+i*6}, ${842-i*4} ${1490+i*3}, 1290 ${1020+i*6}`,stroke:'#689ff2','stroke-width':i%5===0?1.5:.75,opacity:.32});
for(let i=0;i<10;i++)shape('front-lines','path',{d:`M -40 ${1190+i*5} C 196 ${1396+i*2}, 146 ${1516+i*4}, 727 ${1343+i*4} C 975 ${1268+i*2}, 1094 ${1031+i*5}, 1250 ${1078+i*5}`,stroke:i%3===0?'#faffff':'#81baff','stroke-width':i%3===0?2:1,opacity:i%3===0?.95:.7});
for(let i=0;i<67;i++){
  const x=766+i*5.55,h=4+Math.pow(Math.abs(Math.sin(i*.59)*Math.cos(i*.177)),1.8)*34;
  shape('wave-bars','line',{x1:x,x2:x,y1:1440-h/2,y2:1440+h/2,stroke:i<19?'#30cdbb':'#476dec','stroke-width':1.6,opacity:.7});
}
const layers=[...document.querySelectorAll('#poster>.layer')];
for(const layer of [...layers].reverse()){
  const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=true;
  input.addEventListener('change',()=>{layer.style.visibility=input.checked?'visible':'hidden'});
  label.append(input,document.createTextNode(layer.dataset.name));document.getElementById('layer-list').append(label);
}
document.getElementById('restore').onclick=()=>{for(const layer of layers)layer.style.visibility='visible';document.querySelectorAll('#layer-list input').forEach(x=>x.checked=true)};
if(new URLSearchParams(location.search).has('export'))document.body.classList.add('export');
function fit(){if(document.body.classList.contains('export'))return;const scale=Math.min((innerWidth-365)/1200,(innerHeight-64)/1800);document.getElementById('poster').style.transform=`scale(${Math.max(.18,scale)})`;}
window.addEventListener('resize',fit);fit();
