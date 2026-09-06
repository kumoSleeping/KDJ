import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

test('audition swaps only audio at the live position, retains video lease, and preserves pause', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const listeners = new Set(), storeListeners = new Set();
  const state = { trackId: null, currentTime: 42, playing: false, buffering: false, status: 'paused' };
  const calls = { pause: 0, play: 0, replace: [], release: [], metadata: [] };
  const p = { id: 'p', revision: 0, name: 'song', sources: [{id:'s',track_id:1}], layers:[{source_id:'s'}] };
  const editor = { activeId: 'p', draft: p, saving: 0, gesture: null, scrubbing: false, position: 42000, auditionAfterLayer: {} };
  editor.seek = ms => { editor.position = ms; };
  const store = selector => React.useSyncExternalStore(fn => { storeListeners.add(fn); return () => storeListeners.delete(fn); }, () => selector(editor));
  store.getState = () => editor;
  const publish = () => { for (const fn of listeners) fn(); };
  const player = {
    state: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async pause() { calls.pause++; state.playing=false; state.status='paused'; publish(); },
    async play() { calls.play++; state.playing=true; state.status='playing'; publish(); },
    async replaceAudio(source) { calls.replace.push({source,position:state.currentTime,playing:state.playing}); },
    async seek() { assert.fail('audition must not seek'); },
  };
  let resolveMix;
  const api = {
    async previewWorkshop(_id, _revision, after) { return after ? new Promise(resolve => { resolveMix = () => resolve({ticket:`mix-${after}`}); }) : {ticket:'video'}; },
    async releaseWorkshop(ticket) { calls.release.push(ticket); },
    async track() { return {id:1}; }, workshopAudioUrl: ticket => ticket,
  };
  const mocks = {
    react: React, './api': {api}, './unifiedPlayer': {runtimePlayer:()=>player},
    './mediaSync': {getLocalVideoClock:()=>null},
    './streamTrack': {makeCompositionPreviewTrack:()=>({id:-1}),updateCompositionPreviewAudio:(_track,url)=>calls.metadata.push(url)},
    './playTrack': {PLAY_EVENT:'play',playTrack(track) { state.trackId=track.id; state.playing=true;state.status='playing'; calls.play++; publish(); }},
    '../stores/workshopStore': {useWorkshopStore:store}, './workshop': {projectDuration:()=>180000},
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/lib/workshopPlayback.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports,require:name=>{assert.ok(name in mocks,name);return mocks[name];},window:dom.window,performance,setTimeout,clearTimeout,console});
  let playback;
  function App() { playback=exports.useWorkshopPlayback(); return null; }
  const root = createRoot(document.getElementById('root'));
  const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
  const audition = async after => React.act(async()=>{editor.auditionAfterLayer={p:after};for(const fn of storeListeners)fn();await flush();});
  try {
    await React.act(async()=>root.render(React.createElement(App)));
    await React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,140));});
    await React.act(async()=>{playback.toggle();await flush();});
    assert.equal(playback.playing,true);
    const pauseCount=calls.pause,playCount=calls.play,videoTicket=playback.ticket;
    await audition('music');
    assert.equal(playback.playing,true,'old transport continues during mix preparation');
    assert.equal(playback.ticket,videoTicket);
    await React.act(async()=>{state.currentTime=45;publish();resolveMix();await flush();});
    assert.equal(calls.replace.length,1);
    assert.equal(calls.replace[0].position,45,'switch uses the current device position, not click time');
    assert.equal(playback.time(),45000);
    assert.equal(calls.pause,pauseCount);
    assert.equal(calls.play,playCount);
    assert.equal(playback.ticket,videoTicket,'video decoder URL stays stable');
    assert.equal(calls.release.length,0,'old picture/audio lease survives preparation');
    await React.act(async()=>{playback.stop();await flush();});
    await audition(undefined);
    assert.equal(calls.replace.length,2);
    assert.equal(calls.replace[1].playing,false);
    assert.equal(playback.playing,false,'switching while paused never resumes playback');
    assert.equal(calls.play,playCount);
    // A late mix response must not override a newer return to the current mix.
    await audition('other');
    await audition(undefined);
    await React.act(async()=>{resolveMix();await flush();});
    assert.equal(calls.replace.length,2,'stale A/B requests are skipped');
  } finally {
    await React.act(async()=>root.unmount());
    assert.ok(calls.release.includes('video'));
    assert.ok(calls.release.includes('mix-music'));
    dom.window.close();
  }
});
