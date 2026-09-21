// Deterministic, manually composed dry-brush marks; no generated image textures.
const ns='http://www.w3.org/2000/svg';let seed=20260907;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const brush=document.getElementById('dry-brush');
for(let i=0;i<240;i++){
  const x=70+random()*1050,y=88+random()*294,w=9+random()*85,h=.3+random()*1.2;
  const el=document.createElementNS(ns,'path');el.setAttribute('d',`M${x},${y}q${w*.43},${-h} ${w},${h*.3}`);el.setAttribute('fill','none');el.setAttribute('stroke',i%3?'#e8f0ed':'#476889');el.setAttribute('stroke-width',h);el.setAttribute('opacity',.07+random()*.18);brush.append(el);
}
const layers=[...document.querySelectorAll('#poster>.layer')];
for(const layer of [...layers].reverse()){
  const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=true;input.onchange=()=>layer.style.visibility=input.checked?'visible':'hidden';label.append(input,document.createTextNode(layer.dataset.name));document.getElementById('layer-list').append(label);
}
document.getElementById('restore').onclick=()=>{layers.forEach(l=>l.style.visibility='visible');document.querySelectorAll('#layer-list input').forEach(i=>i.checked=true)};
if(new URLSearchParams(location.search).has('export'))document.body.classList.add('export');
function fit(){if(document.body.classList.contains('export'))return;document.getElementById('poster').style.transform=`scale(${Math.max(.18,Math.min((innerWidth-365)/1200,(innerHeight-64)/1800))})`;}
window.addEventListener('resize',fit);fit();
