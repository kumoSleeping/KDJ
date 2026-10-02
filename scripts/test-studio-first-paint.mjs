import { build } from "esbuild";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const stubs = {
  api: `export const api={libraryLyrics:()=>globalThis.studioTest.lyrics,coverUrl:()=>"/cover"}; export const visualizerApi={cover:async()=>new Blob(["cover"]),analyze:()=>{globalThis.studioTest.analyses++;return globalThis.studioTest.analysis}};`,
  visualizerStudioRenderer: `export const loadStudioImages=async()=>{globalThis.studioTest.imageLoads++;return [{}]}; export const prepareStudio=(project,images,timeline,width)=>{globalThis.studioTest.prepares++;return {project:{...project,scene:{...project.scene,canvas:{width,height:width*9/16}}},timeline}}; export const drawStudioFrame=(c,s,t)=>globalThis.studioTest.draws.push({timeline:s.timeline,time:t}); export const studioPictureSideAt=()=>"left";`,
  compositionPlayback: `export const getCompositionClock=()=>globalThis.studioTest.clock;`,
  playerSession: `export const getPlayerSession=()=>globalThis.studioTest.session; export const subscribePlayerSession=f=>{globalThis.studioTest.listeners.add(f);return()=>globalThis.studioTest.listeners.delete(f)}; export const requestPlayerCommand=command=>globalThis.studioTest.commands.push(command);`,
  playTrack: `export const playTrack=(...args)=>globalThis.studioTest.plays.push(args);`,
  playingTrack: `export const getPlayingTrack=()=>({id:globalThis.studioTest.session.trackId});`,
  visualizerExportStore: `export const useVisualizerExportStore={getState:()=>({enqueue:async()=>{}})};`,
  toastStore: `export const useToastStore={getState:()=>({show(){}})};`,
  appStore: `const state={settings:{download_dir:""}}; export const useAppStore=Object.assign(f=>{globalThis.studioTest.panelReads++;return f(state)},{getState:()=>state,setState:patch=>Object.assign(state,patch)});`,
  lyricsStore: `export const useLyricsStore=f=>f({byId:{}});`,
  videoPip: `export const useVideoPip={getState:()=>({active:false})};`,
  usePreviewFullscreen: `export const usePreviewFullscreen=()=>({fullscreen:false,applyFullscreen(){}});`,
  FloatingVideoControls: `import React from 'react'; export const FloatingVideoControls=()=>null; export const FloatingVideoScrub=props=>React.createElement('div',{role:'slider',onKeyDown:props.onKeyDown});`,
  LyricsSourcePicker: `export const LyricsSourcePicker=()=>null;`,
  ManagerMixerControls: `export const ArcKnob=()=>null;`,
};
const entry = new Module(`${process.cwd()}/tests/studioFirstPaint.test.cjs`);
entry.filename = entry.id;
entry.paths = require.resolve.paths("react");
entry._compile((await build({
  entryPoints:["tests/studioFirstPaint.test.tsx"],bundle:true,write:false,platform:"node",format:"cjs",
  external:["react","react-dom","react-dom/*","jsdom"], loader:{".css":"empty"}, define:{"import.meta.env":"{}"},
  plugins:[{name:"studio-boundaries",setup(build){
    build.onResolve({filter:/.*/},args=>{const name=args.path.split("/").at(-1);return stubs[name]?{path:name,namespace:"studio-test"}:undefined});
    build.onLoad({filter:/.*/,namespace:"studio-test"},args=>({contents:stubs[args.path]}));
  }}],
})).outputFiles[0].text,entry.filename);
