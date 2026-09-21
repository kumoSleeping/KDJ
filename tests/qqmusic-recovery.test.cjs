#!/usr/bin/env node
'use strict';
// Real TypeScript modules, mocked HTTP/storage/player. No QQ account, device, or live playback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function fixture() {
  const modules = new Map(), storage = new Map(), calls = [];
  const state = { current: null, calls, reply: async () => ({ url: `http://127.0.0.1/mock/${calls.length}`, waveform_token: 'fixture', cached: false, requested_quality: 'flac', actual_quality: '320', attempt_id: '0123456789abcdef' }) };
  const stubs = {
    './api': { api: { songPreview: (...args) => { calls.push(args); return state.reply(...args); } } },
    './format': { thumbUrl: value => value },
    './playbackTrackSource': { usesRemotePlaybackSource: () => true },
    './storageWrite': { discardLocalStorageWrite() {}, readLocalStorage: key => storage.get(key) ?? null,
      removeLocalStorage: key => storage.delete(key), writeLocalStorageNow: (key,value) => storage.set(key,value), writeLocalStorageSoon: (key,value) => storage.set(key,value) },
    './playTrack': { playTrack: track => { state.current = track; } },
    '@tauri-apps/api/event': { emitTo: async () => {} },
  };
  function load(name) {
    if (stubs[name]) return stubs[name];
    if (modules.has(name)) return modules.get(name).exports;
    if (!['./streamTrack','./songPreview','./playerSession','./streamRecovery'].includes(name)) throw new Error(`Unexpected import ${name}`);
    const filename = path.join(root,'src/lib',`${name.slice(2)}.ts`);
    const code = ts.transpileModule(fs.readFileSync(filename,'utf8'), { compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS} }).outputText;
    const module = { exports: {} }; modules.set(name,module);
    vm.runInNewContext(code,{module,exports:module.exports,require:load,console,performance,URL,setTimeout,clearTimeout,
      window:{dispatchEvent(){},setTimeout,clearTimeout},CustomEvent:class {constructor(type,init){this.type=type;this.detail=init?.detail;}}},{filename});
    return module.exports;
  }
  state.stream=load('./streamTrack'); state.preview=load('./songPreview'); state.session=load('./playerSession'); state.policy=load('./streamRecovery').streamRecoveryPolicy;
  return state;
}
function source(key) { return {platform:'qqm',key,title:key,artists:['fixture'],album:'',duration:180,cover:'',max_quality:'320',vip:false,payload:{}}; }
async function playing(f, key='A') {
  await f.preview.playSongPreview({source:source(key),title:key,artist:'fixture',queue:[{source:source('B'),title:'B',artist:'fixture'},{source:source('C'),title:'C',artist:'fixture'}]});
  await f.stream.preloadStreamTrack(f.current); return f.current;
}
test('automatic recovery retains track id, successor queue and metadata; budget is not reset',async()=>{
  const f=fixture(), original=await playing(f), id=original.id;
  assert.equal(f.stream.prepareStreamTrackRecovery(original,'network failed'),true);
  await f.stream.preloadStreamTrack(original);
  assert.equal(f.current.id,id); assert.equal(f.stream.streamNextTrack(original).title,'B');
  assert.equal(f.stream.streamNextTrack(f.stream.streamNextTrack(original)).title,'C');
  assert.equal(f.stream.prepareStreamTrackRecovery(original,'network failed'),false);
  const request=f.calls.at(-1); assert.equal(request[1],false); assert.equal(request[2],true);
  assert.equal(f.stream.streamMeta(original).actualQuality,'320'); assert.equal(f.stream.streamMeta(original).requestedQuality,'flac');
});
test('failed automatic recovery still belongs to the captured original id and cannot loop',async()=>{
  const f=fixture(), original=await playing(f), capturedId=original.id;
  assert.equal(f.stream.prepareStreamTrackRecovery(original,'network failed'),true);
  f.reply=async()=>{throw new Error('fixture unavailable');};
  await assert.rejects(()=>f.stream.preloadStreamTrack(original),/fixture unavailable/);
  assert.equal(f.current.id,capturedId); assert.equal(f.stream.streamNextTrack(original).title,'B');
  assert.equal(f.stream.prepareStreamTrackRecovery(original,'network failed'),false);
});
test('only a confirmed cached decode failure invalidates persistent cache',async()=>{
  for (const [cached,failure,expected] of [[true,'network failed',false],[true,'decode failed',true],[false,'decode failed',false]]) {
    const f=fixture(); f.reply=async()=>({url:'http://127.0.0.1/fixture',waveform_token:'x',cached});
    const track=await playing(f); assert.equal(f.stream.prepareStreamTrackRecovery(track,failure),true);
    await f.stream.preloadStreamTrack(track); assert.equal(f.calls.at(-1)[1],expected);
  }
});
test('authorization, rate-limit and device failures do not re-request the provider',async()=>{
  for(const error of ['AUTH_EXPIRED','RATE_LIMITED','HTTP 429','ACCOUNT_CHANGED','audio device failed','声卡输出设备异常','登录凭证已过期，请重新扫码']) {
    const f=fixture(), track=await playing(f), before=f.calls.length;
    assert.equal(f.stream.prepareStreamTrackRecovery(track,error),false,error); assert.equal(f.calls.length,before);
  }
  assert.equal(fixture().policy('QQ 音乐网络连接失败；登录状态已保留').retry,true);
});
test('parallel preloads share one provider request',async()=>{
  const f=fixture(); let resolve; f.reply=()=>new Promise(r=>{resolve=r;});
  const track=f.stream.makePendingSongStreamTrack(source('D'));
  const requests=[f.stream.preloadStreamTrack(track),f.stream.preloadStreamTrack(track),f.stream.preloadStreamTrack(track)];
  assert.equal(f.calls.length,1); assert.equal(f.stream.prepareStreamTrackRecovery(track,'network failed'),false);
  resolve({url:'http://127.0.0.1/d',waveform_token:'d'}); await Promise.all(requests);
});
test('completion of an old preload does not select or play an obsolete track',async()=>{
  const f=fixture(); let resolve; f.reply=()=>new Promise(r=>{resolve=r;});
  const old=f.stream.makePendingSongStreamTrack(source('old')), next=f.stream.makePendingSongStreamTrack(source('new'));
  f.current=old; const loading=f.stream.preloadStreamTrack(old); f.current=next;
  resolve({url:'http://127.0.0.1/old',waveform_token:'old'}); await loading;
  assert.equal(f.current.id,next.id); assert.notEqual(f.current.id,old.id);
});
test('notice wording cannot replace the authoritative player failure state',()=>{
  const f=fixture();
  assert.equal(f.session.playerSessionFailed(42,null,'playing','暂停当前播放失败：模拟命令错误'),false);
  assert.equal(f.session.playerSessionFailed(42,42,'playing',''),true);
  assert.equal(f.session.playerSessionFailed(42,null,'error',''),true);
  assert.equal(f.session.playerSessionFailed(42,41,'playing','无法播放'),false);
});
