import assert from "node:assert/strict";
import test from "node:test";
import { WorkshopSeekGate } from "../src/lib/workshopPreviewPolicy";
import {
  adjustClip,
  clipDuration,
  deleteClip,
  duplicateClip,
  fadeAlpha,
  findClip,
  moveLayer,
  outputAt,
  projectDuration,
  resetFadeSpan,
  snapTime,
  sourceAt,
  splitClip,
  validateProject,
} from "../src/lib/workshop";
import type { CompositionProject, WorkshopClip } from "../src/types/workshop";
function clip(id = "clip"): WorkshopClip {
  return {
    id,
    source_id: "source",
    start_ms: 0,
    source_in_ms: 0,
    source_out_ms: 10000,
    speed: {
      preset: "pulse",
      start: 0.5,
      middle: 2,
      end: 0.5,
      domain_start_ms: 0,
      domain_end_ms: 10000,
    },
    picture: { x: 0.5, y: 0.5, scale: 1, opacity: 1 },
    sound: { muted: false, gain: 1, manual: false },
    fades: {
      offset_ms: 0,
      span_ms: 10000,
      video_in_ms: 300,
      video_out_ms: 300,
      audio_in_ms: 100,
      audio_out_ms: 100,
      linear: false,
    },
  };
}
function project(): CompositionProject {
  const c = clip();
  c.fades.span_ms = clipDuration(c);
  return {
    id: "project",
    revision: 0,
    name: "作品",
    sources: [
      {
        id: "source",
        track_id: 1,
        path: "/source.mp4",
        title: "动画",
        duration_ms: 10000,
        video: true,
        audio: true,
        width: 160,
        height: 90,
        fps: 25,
        signature: "",
      },
    ],
    layers: [{ id: "layer", source_id: "source", clips: [c] }],
    canvas: { width: 160, height: 90, fps: 25, initialized: true },
    output: {
      name: "作品",
      directory: "/output",
      in_ms: 0,
      out_ms: null,
      quality: 20,
      acceleration: "auto",
    },
    migrated_from: null,
  };
}
test("split and trim preserve the parent speed curve and outer fades", () => {
  const p = project(),
    c = p.layers[0].clips[0],
    cut = clipDuration(c) * 0.43,
    next = splitClip(p, c.id, cut),
    [left, right] = next.layers[0].clips;
  assert.equal(next.layers[0].clips.length, 2);
  assert.notEqual(left.id, right.id);
  assert.ok(
    Math.abs(clipDuration(left) + clipDuration(right) - clipDuration(c)) < 1e-6,
  );
  for (const t of [0, 20, 100, 500]) {
    assert.ok(Math.abs(sourceAt(right, t) - sourceAt(c, cut + t)) < 1e-6);
    assert.equal(fadeAlpha(right, t), fadeAlpha(c, cut + t));
  }
  assert.equal(left.fades.span_ms, c.fades.span_ms);
  assert.equal(right.fades.offset_ms, cut);
  assert.equal(validateProject(next), "");
});
test("time mapping round trips at every part of a pulse", () => {
  const c = clip();
  for (let ms = 0; ms <= 10000; ms += 37)
    assert.ok(Math.abs(sourceAt(c, outputAt(c, ms)) - ms) < 1e-6);
});
test("deletion holds the musical placement; ripple affects only subsequent clips in its row", () => {
  const p = project(),
    c = p.layers[0].clips[0],
    cut = clipDuration(c) / 2,
    next = splitClip(p, c.id, cut),
    right = next.layers[0].clips[1];
  next.layers.push({
    id: "another",
    source_id: "source",
    clips: [{ ...clip("other"), start_ms: 5000 }],
  });
  const plain = deleteClip(next, c.id),
    ripple = deleteClip(next, c.id, true);
  assert.equal(plain.layers[0].clips[0].start_ms, cut);
  assert.equal(ripple.layers[0].clips[0].start_ms, 0);
  assert.equal(ripple.layers[1].clips[0].start_ms, 5000);
  assert.equal(plain.layers[0].clips[0].source_in_ms, right.source_in_ms);
});
test("repeated occurrences and copied fragments are independent", () => {
  const p = project(),
    next = duplicateClip(p, "clip");
  assert.equal(next.layers.length, 2);
  assert.notEqual(next.layers[0].clips[0].id, "clip");
  next.layers[0].clips[0].picture.opacity = 0.2;
  assert.equal(p.layers[0].clips[0].picture.opacity, 1);
  assert.equal(next.layers[1].clips[0].picture.opacity, 1);
  const moved = moveLayer(next, next.layers[0].id, 1);
  assert.equal(moved.layers[0].id, "layer");
});
test("speed changes detect overlap without moving other clips", () => {
  const p = project(),
    c = p.layers[0].clips[0];
  c.speed = { ...c.speed, preset: "constant", start: 2 };
  resetFadeSpan(c);
  p.layers[0].clips.push({ ...structuredClone(c), id: "tail", start_ms: 5000 });
  assert.equal(validateProject(p), "");
  c.speed.start = 1;
  resetFadeSpan(c);
  assert.match(validateProject(p), /重叠/);
  assert.equal(p.layers[0].clips[1].start_ms, 5000);
});
test("frame nudge, source trims, zero clamp and snap boundaries", () => {
  const p = project(),
    c = p.layers[0].clips[0];
  c.speed = { ...c.speed, preset: "constant", start: 1 };
  resetFadeSpan(c);
  let next = adjustClip(p, "clip", "in", 400);
  assert.equal(findClip(next, "clip")!.source_in_ms, 400);
  assert.equal(findClip(next, "clip")!.start_ms, 400);
  assert.equal(clipDuration(findClip(next, "clip")!), 9600);
  next = adjustClip(next, "clip", "in", -400);
  assert.equal(clipDuration(findClip(next, "clip")!), 10000);
  assert.equal(
    findClip(adjustClip(p, "clip", "move", -40), "clip")!.start_ms,
    0,
  );
  assert.equal(snapTime(p, 4987, "clip", 5000, 20), 5000);
  assert.equal(snapTime(p, 4900, "clip", 5000, 20), 4900);
  assert.equal(projectDuration(p), 10000);
});
test("fades mirror smoothly and split cut does not add opacity dip", () => {
  const c = clip();
  assert.equal(fadeAlpha(c, 75), 0.15625);
  assert.equal(fadeAlpha(c, 75), fadeAlpha(c, 9925));
  const p = project(),
    next = splitClip(p, "clip", 2000);
  assert.equal(fadeAlpha(next.layers[0].clips[1], 0), 1);
});
test("preview seek coalesces rapid drags and never interrupts an in-flight decode", () => {
  const gate = new WorkshopSeekGate(), video = {currentTime: 0, seeking: false};
  assert.equal(gate.request(video, 5, false, 30, 0), 5);
  video.seeking = true;
  for (let i = 1; i < 100; i++) assert.equal(gate.request(video, 5 + i / 10, false, 30, i * 16), null);
  video.seeking = false; video.currentTime = 5;
  assert.equal(gate.request(video, 15, false, 30, 1600), 15);
  assert.equal(gate.request(video, 16, false, 30, 1616), null);
  assert.equal(gate.request(video, 16, false, 30, 1680), 16);
  assert.equal(gate.request(video, 17, true, 30, 1800), null);
  assert.equal(gate.request(video, 17, true, 30, 2200), 17);
});

test("editing a sliced fade does not resurrect a fade at the opposite cut", async () => {
  const {setClipFade, visibleFade} = await import("../src/lib/workshop");
  const c = clip(); c.speed = {...c.speed,preset:"constant",start:1};
  c.source_in_ms = 4000; c.source_out_ms = 8000;
  c.fades = {...c.fades, offset_ms:4000,span_ms:10000,video_in_ms:300,video_out_ms:300};
  assert.equal(visibleFade(c,false),0);
  setClipFade(c,true,false,500);
  assert.equal(fadeAlpha(c,0),1);
  assert.equal(c.fades.video_in_ms,0);
  assert.ok(Math.abs(fadeAlpha(c,3750) - .5) < .001);
  setClipFade(c,false,true,500);
  assert.ok(Math.abs(fadeAlpha(c,250,true) - .5) < .001);
});
test("prewarming is bounded and keeps the next clip alive across an exact cut", async () => {
  const {prepareVideoClips} = await import("../src/lib/workshopPreviewPolicy");
  const a = clip("a"); a.speed = {...a.speed,preset:"constant",start:1}; a.source_out_ms = 1000;
  const b = {...structuredClone(a),id:"b",start_ms:1000};
  const far = {...structuredClone(a),id:"far",start_ms:5000};
  const p = {sources:[{id:"source",video:true}],layers:[{source_id:"source",clips:[a,b,far]}]} as CompositionProject;
  assert.deepEqual(prepareVideoClips(p,500).map(c=>c.id).sort(),["a","b"]);
  assert.deepEqual(prepareVideoClips(p,1000).map(c=>c.id),["b"]);
  const short = {...structuredClone(a),id:"short",start_ms:1000,source_out_ms:15};
  const after = {...structuredClone(a),id:"after",start_ms:1015};
  p.layers[0].clips = [a,short,after,far];
  assert.deepEqual(prepareVideoClips(p,900).map(c=>c.id).sort(),["a","after","short"],
    "the clip after a subframe edit is decoded before the current clip ends");
  assert.deepEqual(prepareVideoClips(p,1016).map(c=>c.id),["after"]);
});

test("GIF display duration, split phase and extension are independent of one animation cycle", () => {
  const p=project(), c=p.layers[0].clips[0];
  p.sources[0]={...p.sources[0],kind:"gif",video:false,audio:false,duration_ms:300,frame_ends_ms:[100,300]};
  c.source_out_ms=300; c.speed={preset:"constant",start:1,middle:1,end:1,domain_start_ms:0,domain_end_ms:300};
  c.display_duration_ms=5000;c.animation_offset_ms=0;resetFadeSpan(c);
  assert.equal(validateProject(p),"");
  const edge=adjustClip(p,c.id,"in",100).layers[0].clips[0];
  assert.equal(fadeAlpha(edge,0),fadeAlpha(c,100),"trim keeps the visible envelope phase");
  const cut=splitClip(p,c.id,1320), [a,b]=cut.layers[0].clips;
  assert.equal(clipDuration(a),1320);assert.equal(clipDuration(b),3680);
  assert.equal(sourceAt(b,200),1520);
  assert.equal(fadeAlpha(b,200),fadeAlpha(c,1520));
  const extended=adjustClip(cut,b.id,"out",6000);
  assert.equal(clipDuration(extended.layers[0].clips[1]),9680);
  assert.equal(validateProject(extended),"");
  const trimmed=adjustClip(extended,b.id,"in",400);
  assert.equal(sourceAt(trimmed.layers[0].clips[1],0),1720);
  assert.equal(trimmed.layers[0].clips[1].start_ms,1720);
  assert.equal(duplicateClip(p,c.id).layers[0].clips[0].display_duration_ms,5000);
});

test("image geometry crops before fitting and GIF frame lookup honors unequal delays", async () => {
  const {pictureBox,gifFrame}=await import("../src/lib/workshopPicture");
  const p=project(),c=p.layers[0].clips[0];p.sources[0].kind="image";p.sources[0].video=false;
  c.picture={x:.5,y:.5,scale:1,opacity:.5,crop:[.25,0,.25,0],rotation:90,flip_x:true};
  const box=pictureBox(p,c,p.sources[0]);
  assert.equal(box.sw,80);assert.equal(box.sh,90);assert.equal(box.width,.5);assert.equal(box.rotation,90);
  assert.deepEqual([0,99,100,299,300,450].map(t=>gifFrame([100,300],t).index),[0,0,1,1,0,1]);
  c.picture.crop=[.5,0,.5,0];assert.match(validateProject(p),/裁剪/);
});

test("picture edges stay inside the canvas at 0 and 100 percent, including cropped rotated images", async () => {
  const { pictureBox } = await import("../src/lib/workshopPicture");
  const p = project(), c = p.layers[0].clips[0], s = p.sources[0];
  for (const kind of ["image", "gif", "video"] as const) {
    s.kind = kind; s.video = kind === "video";
    for (const rotation of kind === "video" ? [0] : [0, 90, -45]) {
      for (const position of [0, .5, 1]) {
        c.picture = { x: position, y: position, scale: .5, opacity: 1, rotation, crop: [.1, .1, .2, 0] };
        const b = pictureBox(p, c, s), angle = rotation * Math.PI / 180;
        const width = b.width * p.canvas.width, height = b.height * p.canvas.height;
        const rw = width * Math.abs(Math.cos(angle)) + height * Math.abs(Math.sin(angle));
        const rh = width * Math.abs(Math.sin(angle)) + height * Math.abs(Math.cos(angle));
        const left = b.x * p.canvas.width + (width-rw)/2;
        const top = b.y * p.canvas.height + (height-rh)/2;
        assert.ok(left >= -1e-9 && top >= -1e-9, `${kind} ${rotation} ${position}: top-left stays inside`);
        assert.ok(left+rw <= p.canvas.width+1e-9 && top+rh <= p.canvas.height+1e-9);
        const gapX = position === 1 ? p.canvas.width-left-rw : position === 0 ? left : Math.abs(left-(p.canvas.width-rw)/2);
        const gapY = position === 1 ? p.canvas.height-top-rh : position === 0 ? top : Math.abs(top-(p.canvas.height-rh)/2);
        assert.ok(gapX < 1 && gapY < 1, "edges align within export pixel rounding; 50% remains centered");
      }
    }
  }
});
