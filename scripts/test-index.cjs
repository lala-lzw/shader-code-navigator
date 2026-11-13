const assert = require('assert');
const path = require('path');
const Module = require('module');
const {performance} = require('perf_hooks');
const root = path.resolve('virtual-index-fixture');
const uri = file => ({fsPath:path.resolve(root,file),scheme:'file',toString(){return 'file:///'+this.fsPath.replace(/\\/g,'/');}});
class Emitter {
  listeners = new Set();
  event = listener => {this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};
  fire(value){for(const listener of this.listeners){listener(value);}}
  dispose(){this.listeners.clear();}
}
const disk = new Map();
const counters = {reads:0,stats:0};
let discoveryGate, readGate;
const documents = [];
const config = {exclude:[],maxFiles:20000,includePaths:[]};
const commandHandlers=new Map(), notifications=[];
const status={text:'',tooltip:'',show(){},hide(){},dispose(){}};
const mock = {
  EventEmitter:Emitter, Uri:{file:uriPath=>uri(path.relative(root,uriPath))}, FileType:{File:1},
  RelativePattern:class {constructor(base,pattern){this.base=base;this.pattern=pattern;}},
  StatusBarAlignment:{Left:1},ProgressLocation:{Notification:15},
  commands:{registerCommand:(name,handler)=>{commandHandlers.set(name,handler);return {dispose:()=>commandHandlers.delete(name)};},executeCommand:()=>{}},
  window:{visibleTextEditors:[],activeTextEditor:undefined,
    createStatusBarItem:()=>status,
    onDidChangeActiveTextEditor:()=>({dispose(){}}),
    withProgress:(options,task)=>{
      const notification={options,reports:[],done:false,cancel:undefined};notifications.push(notification);
      return task({report:value=>notification.reports.push(value)},{onCancellationRequested:handler=>{notification.cancel=handler;return {dispose(){}};}}).then(()=>{notification.done=true;});
    }
  },
  workspace:{
    textDocuments:documents,workspaceFolders:[{uri:uri('')}],
    getConfiguration:()=>({get:(name,fallback)=>config[name]??fallback}),
    getWorkspaceFolder:target=>target.fsPath.startsWith(root+path.sep)?{uri:uri('')}:undefined,
    asRelativePath:target=>path.relative(root,target.fsPath),
    findFiles:async()=>{if(discoveryGate){await discoveryGate;}return [...disk.keys()].map(file=>uri(file));},
    fs:{
      stat:async target=>{counters.stats++;if(!disk.has(path.relative(root,target.fsPath))){throw new Error('not found');}return {type:1};},
      readFile:async target=>{counters.reads++;if(readGate){await readGate;}const value=disk.get(path.relative(root,target.fsPath));if(value===undefined){throw new Error('not found');}return Buffer.from(value);}
    }
  }
};
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){return request==='vscode'?mock:originalLoad.call(this,request,parent,isMain);};
const {ShaderWorkspaceIndex}=require('../out/workspaceIndex');
const {ShaderIndexProgress}=require('../out/indexProgress');
Module._load=originalLoad;
function open(file,text){const document={uri:uri(file),fileName:uri(file).fsPath,version:1,getText:()=>document.text,text};documents.push(document);disk.set(file,text);return document;}
const wait=()=>new Promise(resolve=>setImmediate(resolve));

(async()=>{
  disk.set('Shared.hlsl','float SharedValue(float value) { return value; }');
  for(let i=0;i<40;i++){disk.set('Library'+i+'.hlsl','#include "Shared.hlsl"\nfloat Library'+i+'(float value) { return SharedValue(value); }');}
  const main=open('Main.shader',Array.from({length:40},(_,i)=>'#include "Library'+i+'.hlsl"').join('\n')+'\nfloat MainFunction(float value) { return Library0(value); }');
  const index=new ShaderWorkspaceIndex();
  mock.window.activeTextEditor={document:main};
  const progressUI=new ShaderIndexProgress(index);
  const events=[];index.onDidProgress(state=>events.push(state));
  let releaseRead;
  readGate=new Promise(resolve=>{releaseRead=resolve;});
  index.warmDocument(main);
  assert.ok(status.text.includes('include'),'Foreground include phase is visible immediately');
  commandHandlers.get('shaderNavigator.showProgress')();
  assert.strictEqual(notifications.length,1,'Status item opens the progress notification');
  assert.ok(index.getDocument(main.uri).parsed.symbols.some(symbol=>symbol.name==='MainFunction'),'Local symbols are present while reads are blocked');
  assert.strictEqual(index.isReady(main.uri),false);
  const pending=[index.ensureDocument(main),index.ensureDocument(main),index.ensureDocument(main)];
  await wait();
  releaseRead();readGate=undefined;
  const cold=performance.now();
  await Promise.all(pending);
  await wait();
  assert.ok(notifications[0].reports.some(value=>value.message.includes('40/')||value.message.includes('41/')),'Notification reports actual dependency counts');
  assert.ok(notifications[0].done,'Finished work closes its notification');
  console.log('Include graph ready in '+(performance.now()-cold).toFixed(1)+' ms; disk reads='+counters.reads);
  assert.strictEqual(counters.reads,41,'Shared includes and concurrent requests read each dependency once');
  assert.ok(index.resolve(main.uri,main.text.indexOf('Library0(value)'), 'Library0').length);
  const initial=index.getStatistics(), io={...counters};
  for(let i=0;i<10;i++){main.version++;main.text+='\n// body edit '+i;await index.ensureDocument(main);}
  assert.strictEqual(counters.reads,io.reads,'Body edits do not read dependencies again');
  assert.strictEqual(counters.stats,io.stats,'Body edits do not repeat include filesystem probes');
  assert.strictEqual(index.getStatistics().parses-initial.parses,10,'Each document version is parsed once');
  await Promise.all([index.ensureDocument(main),index.ensureDocument(main)]);
  assert.strictEqual(index.getStatistics().parses-initial.parses,10,'Repeated provider requests share parsed results');
  const reopened={...main,version:100};reopened.getText=()=>main.text;
  await index.ensureDocument(reopened);
  assert.strictEqual(index.getStatistics().parses-initial.parses,10,'Reopening identical content reuses the parse');

  disk.set('Shared.hlsl','float ChangedShared(float value) { return value; }');
  await index.updateDocumentFromUri(uri('Shared.hlsl'));
  await index.ensureDocument(main);
  assert.ok(index.resolve(main.uri,main.text.length,'ChangedShared').length,'Dependency file edits update visible symbols');
  disk.set('Extra.hlsl','#include "Main.shader"\nfloat ExtraValue(){return 1;}');
  main.version++;main.text='#include "Extra.hlsl"\n'+main.text;
  await index.ensureDocument(main);
  assert.ok(index.resolve(main.uri,main.text.length,'ExtraValue').length,'Changed include lists and cycles resolve');
  index.removeDocument(uri('Extra.hlsl'));disk.delete('Extra.hlsl');
  await index.ensureDocument(main);
  assert.strictEqual(index.resolve(main.uri,main.text.length,'ExtraValue').length,0,'Deleted includes do not retain symbols');
  disk.set('Extra.hlsl','float RestoredValue(){return 2;}');
  await index.updateDocumentFromUri(uri('Extra.hlsl'));
  await index.ensureDocument(main);
  assert.ok(index.resolve(main.uri,main.text.length,'RestoredValue').length,'Created files invalidate cached misses');
  assert.ok(events.some(state=>state.phase==='includes'&&state.total>1),'Include progress reports discovered dependencies');
  const ids=new Set(events.filter(state=>state.phase==='includes').map(state=>state.id));
  for(const id of ids){assert.ok(events.some(state=>state.id===id&&state.phase==='done'),'Every progress job finishes');}

  for(let i=0;i<120;i++){disk.set('Unrelated'+i+'.hlsl','float Unrelated'+i+'(){return 0;}');}
  let releaseDiscovery;
  discoveryGate=new Promise(resolve=>{releaseDiscovery=resolve;});
  const scan=index.initialize();
  commandHandlers.get('shaderNavigator.showProgress')();
  assert.ok(notifications[1].options.cancellable,'Workspace notification offers cancellation');
  await wait();
  assert.ok(index.getDocument(main.uri),'Workspace discovery does not clear usable local symbols');
  assert.ok(events.some(state=>state.phase==='discovering'));
  const beforeScanRead=counters.reads;
  await index.ensureDocument(main);
  assert.ok(counters.reads-beforeScanRead<=1,'Foreground cache remains usable before discovery completes');
  index.onDidProgress(state=>{if(state.background&&state.phase==='parsing'&&state.completed>=4){notifications[1].cancel();}});
  releaseDiscovery();discoveryGate=undefined;
  await scan;
  assert.ok(index.paused,'Background scan can be cancelled');
  assert.ok(events.some(state=>state.phase==='cancelled'));
  assert.ok(index.getDocument(main.uri),'Cancellation preserves the current document');
  await wait();
  assert.ok(notifications[1].done,'Cancelled scan closes its progress notification');
  await index.ensureDocument(main);
  assert.ok(index.resolve(main.uri,main.text.length,'RestoredValue').length,'Active document stays usable after cancelling background work');
  progressUI.dispose();index.dispose();
  console.log('PASS: immediate local symbols, coalesced reads, edit/reopen caches, invalidation, cycles, real progress counts and background cancellation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
