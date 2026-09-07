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
  syncOutputFormat,
  validateProject,
} from "../src/lib/workshop";
import type { CompositionProject, WorkshopClip } from "../src/types/workshop";
import { addWorkshopMarker, removeWorkshopMarker, workshopMarkerColor } from "../src/lib/workshopMarkers";
import { workshopFadeCurvePath } from "../src/lib/workshopFadeCurve";
import { setVideoTransition, videoProject, videoTransitionSpan } from "../src/lib/workshopTransitions";
import { prepareVideoClips } from "../src/lib/workshopPreviewPolicy";

test("video joints borrow handles without moving cuts or changing audio", () => {
  let p = project();
  const left = p.layers[0].clips[0];
  left.speed = {preset:"constant", start:1, middle:1, end:1, domain_start_ms:0, domain_end_ms:10000};
  left.source_out_ms = 3000;
  left.fades.span_ms = 3000;
  const right = {...structuredClone(left), id:"right", start_ms:3000, source_in_ms:6000, source_out_ms:9000};
  p.layers[0].clips.push(right);
  const original = structuredClone(p);
  for (const alignment of [-1,0,1] as const) {
    p = setVideoTransition(original, "right", {duration_ms:1000, alignment});
    const visual = videoProject(p), [a,b] = visual.layers[0].clips;
    const before = (1-alignment)*500, after = 1000-before;
    assert.equal(a.source_out_ms, 3000+after);
    assert.equal(b.start_ms, 3000-before);
    assert.equal(b.source_in_ms, 6000-before);
    assert.equal(fadeAlpha(b, 500), .5);
    assert.equal(a.fades.video_out_ms, 0, "opaque outgoing plane prevents a black dip");
    assert.equal(projectDuration(visual), projectDuration(p));
    assert.deepEqual(p.layers[0].clips.map(c=>[c.start_ms,c.source_in_ms,c.source_out_ms,c.sound,c.fades]),
      original.layers[0].clips.map(c=>[c.start_ms,c.source_in_ms,c.source_out_ms,c.sound,c.fades]));
    assert.equal(validateProject(p), "");
  }
  p = setVideoTransition(original,"right",{duration_ms:1000,alignment:0});
  const visual = videoProject(p);
  assert.deepEqual(prepareVideoClips(visual,3000).map(c=>c.id), [left.id,"right"], "incoming picture is above outgoing and both are decoded");
  assert.deepEqual(setVideoTransition(p,"right",null),original);
  const split = splitClip(p, "right", 4000);
  assert.equal(split.layers[0].clips[2].video_transition, undefined, "splitting does not duplicate an incoming transition");
  p.layers[0].clips[0].speed.domain_end_ms=3100;
  assert.deepEqual(videoTransitionSpan(...p.layers[0].clips as [WorkshopClip,WorkshopClip]),{before:100,after:100});
  p.layers[0].clips[1].start_ms+=1;
  assert.equal(videoTransitionSpan(...p.layers[0].clips as [WorkshopClip,WorkshopClip]),null);
});

test("short fade curves on long clips meet their actual endpoints", () => {
  const c = clip();
  c.source_out_ms = 120000;
  c.speed = {preset: "constant", start: 1, middle: 1, end: 1, domain_start_ms: 0, domain_end_ms: 120000};
  c.fades = {offset_ms: 0, span_ms: 120000, audio_in_ms: 570, audio_out_ms: 280,
    video_in_ms: 570, video_out_ms: 280, linear: false};
  for (const audio of [true, false]) {
    const points = workshopFadeCurvePath(c, audio).split(" ").map(p => p.slice(1).split(",").map(Number));
    assert.ok(points.length <= 66, "curve cost is independent of clip length");
    assert.ok(points.some(([x, y]) => Math.abs(x - 570 / 120000 * 100) < 1e-9 && y === 4), "fade-in reaches unity at the handle, not the next whole-clip sample");
    assert.ok(points.some(([x, y]) => Math.abs(x - (120000 - 280) / 120000 * 100) < 1e-9 && y === 4));
    assert.equal(points[0][1], 27);
    assert.equal(points.at(-1)![1], 27);
  }
  c.fades.offset_ms = 200;
  for (const linear of [true, false]) {
    c.fades.linear = linear;
    const points = workshopFadeCurvePath(c, true).split(" ").map(p => p.slice(1).split(",").map(Number));
    assert.equal(points[0][1], 27 - fadeAlpha(c, 0, true) * 23, "trimmed fades retain inherited phase");
    assert.ok(points.some(([x, y]) => Math.abs(x - 370 / 120000 * 100) < 1e-9 && y === 4));
  }
  Object.assign(c.fades, {audio_in_ms: 0, audio_out_ms: 0});
  assert.equal(workshopFadeCurvePath(c, true), "M0,4 L100,4", "zero fades render flat");
});

test("audio and picture fades draw only changing gain/opacity, never a full-width unity line", () => {
  for (const audio of [false, true]) {
    const c = clip();
    c.fades = {offset_ms: 0, span_ms: clipDuration(c), audio_in_ms: 0, audio_out_ms: 0,
      video_in_ms: 0, video_out_ms: 0, linear: false};
    assert.equal(workshopFadeCurvePath(c, audio, true), "");
    c.fades[audio ? "audio_in_ms" : "video_in_ms"] = 300;
    c.fades[audio ? "audio_out_ms" : "video_out_ms"] = 500;
    const path = workshopFadeCurvePath(c, audio, true);
    assert.equal(path.split("M").length - 1, 2, "separate fade-in and fade-out strokes, with no plateau joining them");
    const points = path.split(" ").map(p => p.slice(1).split(",").map(Number));
    assert.ok(points.every(([x]) => x <= 300 / clipDuration(c) * 100 || x >= (1 - 500 / clipDuration(c)) * 100));
    for (const [x, y] of points) {
      assert.ok(Math.abs(y - (27 - fadeAlpha(c, x / 100 * clipDuration(c), audio) * 23)) < 1e-9,
        "visible curves still follow the actual envelope");
    }
    c.fades.offset_ms = 600;
    c.fades.span_ms += 1200;
    assert.equal(workshopFadeCurvePath(c, audio, true), "", "inherited fades outside a cut are invisible");
  }
});

test("markers use stable sequential colors and absolute project time", () => {
  const original = project();
  let p = addWorkshopMarker(original, 2500.123);
  p = addWorkshopMarker(p, 1000);
  assert.deepEqual(p.markers?.map(m => [m.number, m.position_ms]), [[1,2500.123],[2,1000]]);
  assert.equal(original.markers, undefined);
  assert.equal(addWorkshopMarker(p, 1000), p, "same position does not stack markers");
  assert.equal(addWorkshopMarker(p, NaN), p);
  assert.equal(addWorkshopMarker(p, -1).markers?.at(-1)?.position_ms, 0);
  assert.ok(Math.abs(addWorkshopMarker(p, 1e9).markers!.at(-1)!.position_ms - projectDuration(p)) < .001);
  const remaining = removeWorkshopMarker(p, p.markers![0].id);
  assert.equal(addWorkshopMarker(remaining, 500).markers?.at(-1)?.number, 3);
  assert.equal(workshopMarkerColor(1), workshopMarkerColor(8));
  assert.notEqual(workshopMarkerColor(1), workshopMarkerColor(2));
  assert.equal(validateProject(p), "");
  assert.equal(validateProject({...p, markers: [...p.markers!, p.markers![0]]}), "标记参数无效");
  for (const position_ms of [NaN, Infinity, -1, 21_600_001]) {
    assert.equal(validateProject({...p, markers: [{id:"invalid", number:1, position_ms}]}), "标记参数无效");
  }
});
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
test("output format follows the last picture clip, retaining explicit audio formats", () => {
  for (const kind of ["video", "image", "gif"] as const) {
    const before = project();
    before.sources[0].kind = kind;
    before.sources[0].video = kind === "video";
    before.output.format = "mp4";
    for (const emptyLayer of [false, true]) {
      const after = structuredClone(before);
      if (emptyLayer) after.layers[0].clips = [];
      else after.layers = [];
      syncOutputFormat(after, before);
      assert.equal(after.output.format, "wav", "unused visual sources do not count");
      const restored = structuredClone(before);
      restored.output.format = after.output.format;
      syncOutputFormat(restored, after);
      assert.equal(restored.output.format, "mp4", "restoring a picture enables video");
    }
    const partial = structuredClone(before);
    partial.layers[0].clips[0].picture.opacity = 0;
    syncOutputFormat(partial, before);
    assert.equal(partial.output.format, "mp4", "transparent pictures remain visual content");
    for (const format of ["wav", "flac", "mp3"] as const) {
      const audioChoice = structuredClone(before);
      audioChoice.output.format = format;
      const after = structuredClone(audioChoice);
      after.layers = [];
      syncOutputFormat(after, audioChoice);
      assert.equal(after.output.format, format);
      syncOutputFormat(after, before);
      assert.equal(after.output.format, format, "explicit edit takes precedence");
    }
  }
});

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
  const p = project(), next = duplicateClip(p, "clip");
  assert.equal(next.layers.length, 2);
  assert.notEqual(next.layers[1].clips[0].id, "clip");
  next.layers[1].clips[0].picture.opacity = 0.2;
  assert.equal(p.layers[0].clips[0].picture.opacity, 1);
  assert.equal(next.layers[0].clips[0].picture.opacity, 1);
  const moved = moveLayer(next, next.layers[1].id, 0);
  assert.equal(moved.layers[1].id, "layer");
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

import { editRanges, projectBeats, rebuildGridRegion, analysisGrid, layerWaveform } from "../src/lib/workstation";
test("bar editing joins one occupied track and preserves multitrack positions",()=>{
  const p=project();p.sources[0].video=false;p.sources[0].kind="audio";
  const c=p.layers[0].clips[0];c.speed={...c.speed,preset:"constant",start:1,middle:1,end:1};
  let next=editRanges(p,p.layers[0].id,[[2000,4000],[6000,8000]],"delete");
  assert.deepEqual(next.layers[0].clips.map(c=>[c.start_ms,c.source_in_ms,c.source_out_ms]),[[0,0,2000],[2000,4000,6000],[4000,8000,10000]]);
  p.layers.push({...structuredClone(p.layers[0]),id:"other",clips:[{...structuredClone(c),id:"other-clip"}]});
  next=editRanges(p,p.layers[0].id,[[2000,4000]],"delete");assert.equal(next.layers[0].clips[1].start_ms,4000);assert.deepEqual(next.layers[1],p.layers[1]);
  next=editRanges(p,p.layers[0].id,[[2000,4000],[6000,8000]],"keep");assert.deepEqual(next.layers[0].clips.map(c=>c.start_ms),[2000,6000]);
});
test("audio splits are sample precise and new copies append",()=>{
  const p=project();p.sources[0].video=false;p.sources[0].kind="audio";
  const c=p.layers[0].clips[0];c.speed={...c.speed,preset:"constant",start:1};
  const next=splitClip(p,c.id,1);assert.equal(next.layers[0].clips.length,2);
  assert.equal(duplicateClip(p,c.id).layers[0].id,p.layers[0].id);
});
test("bar grid maps source beats through trims and tempo without editing media",()=>{
  const p=project(),c=p.layers[0].clips[0];c.speed={...c.speed,preset:"constant",start:2};c.source_in_ms=2000;c.start_ms=1000;
  const grid=analysisGrid({revision:"v4",precise:false,duration:10,bpm:120,confidence:1,beats:Array.from({length:20},(_,i)=>i*.5),downbeats:[0,2,4,6,8],downbeat_confidence:1,segments:[{start_seconds:0,end_seconds:10,bpm:120,confidence:1}],coverage:[[0,10]]},"source");
  const beats=projectBeats(p.layers[0],grid);assert.equal(beats[0].time,1000);assert.equal(beats[1].time,1250);assert.equal(beats[0].bar,2);
  const changed=rebuildGridRegion(grid,0,100,.1);assert.equal(changed.locked,true);assert.equal(changed.beats[0],.1);assert.equal(grid.segments[0].bpm,120);assert.equal(c.source_in_ms,2000);
});
test("edited waveform leaves real gaps and reads the retained source interval",()=>{
  const p=project(),c=p.layers[0].clips[0];c.speed={...c.speed,preset:"constant",start:1};c.start_ms=2000;c.source_in_ms=2000;c.source_out_ms=4000;
  const w={track_id:1,duration:10,amp:[.1,.2,.3,.4,.5,.6,.7,.8,.9,1],r:Array(10).fill(255),g:Array(10).fill(0),b:Array(10).fill(0)};
  const result=layerWaveform(w,p.layers[0],0,4000,4);assert.equal(result.amp[0],0);assert.equal(result.amp[1],0);assert.ok(Math.abs(result.amp[2]-.3)<1e-6);
});
