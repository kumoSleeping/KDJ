import { build } from 'esbuild';
import { createRequire, Module } from 'node:module';
const require = createRequire(import.meta.url);
const stubs = {
  unifiedPlayer: `export const getLiveDeckClock=()=>globalThis.waveTest.gap?null:globalThis.waveTest.clock; export const runtimePlayer=()=>({state:()=>({decks:[0,1].map(()=>globalThis.waveTest.gap?{trackId:null}:globalThis.waveTest.clock)})}); export const subscribeLivePlaybackClock=f=>{globalThis.waveTest.listeners.add(f);return()=>globalThis.waveTest.listeners.delete(f)};`,
  useStaticPlaybackWaveform: `export const useStaticPlaybackWaveform=()=>({detail:globalThis.waveTest.wave,loading:!globalThis.waveTest.wave,error:''});`,
  themePack: `export const useThemePack=f=>f({epoch:0});`,
  WaveformCanvas: `export const drawWaveformCanvas=(canvas,wave,width,height,known,start,end)=>{canvas.width=width;canvas.height=height;globalThis.waveTest.draws.push({start,end,track:wave.track_id});};`,
  Waveform: `export const SEEK_EVENT='kd:seek';`,
};
const entry = new Module(`${process.cwd()}/tests/scrollingWaveform.test.cjs`);
entry.filename = entry.id; entry.paths = require.resolve.paths('react');
entry._compile((await build({entryPoints:['tests/scrollingWaveform.test.tsx'],bundle:true,write:false,platform:'node',format:'cjs',
  external:['react','react-dom','react-dom/*','jsdom'],loader:{'.css':'empty'},define:{'import.meta.env':'{}'},
  plugins:[{name:'wave-boundaries',setup(b){
    b.onResolve({filter:/.*/},args=>{const name=args.path.split('/').at(-1);return stubs[name]?{path:name,namespace:'wave-test'}:undefined});
    b.onLoad({filter:/.*/,namespace:'wave-test'},args=>({contents:stubs[args.path]}));
  }}],
})).outputFiles[0].text,entry.filename);
