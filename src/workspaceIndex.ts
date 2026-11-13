import * as path from 'path';
import * as vscode from 'vscode';
import { isShaderFileName, ParsedShaderDocument, SHADER_EXTENSIONS, ShaderSymbol } from './model';
import { identifierAt, parseShaderDocument } from './parser';

export interface IndexedShaderDocument { uri: vscode.Uri; text: string; parsed: ParsedShaderDocument }
export interface IndexedSymbolLocation { uri: vscode.Uri; symbol: ShaderSymbol }
export interface IncludeCandidate { label: string; uri: vscode.Uri }
export interface IndexProgress {
  id: number; background: boolean; title: string;
  phase: 'discovering' | 'parsing' | 'includes' | 'done' | 'cancelled' | 'failed';
  completed: number; total: number; file?: string; cancel?: () => void;
}
export interface IndexStatistics { parses: number; reads: number; statChecks: number; cacheHits: number }

const key = (uri: vscode.Uri): string => process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
const slash = (text: string): string => text.replace(/\\/g, '/');
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Session caches are invalidated by document versions, include edits, and file-system events. */
export class ShaderWorkspaceIndex implements vscode.Disposable {
  private readonly documents = new Map<string, IndexedShaderDocument>();
  private readonly edges = new Map<string, vscode.Uri[]>();
  private readonly knownFiles = new Map<string, vscode.Uri>();
  private readonly aliases = new Map<string, vscode.Uri[]>();
  private readonly versions = new Map<string, number>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly resolutions = new Map<string, Promise<vscode.Uri | undefined>>();
  private readonly ready = new Set<string>();
  private readonly visibility = new Map<string, { revision: number; symbols: IndexedSymbolLocation[] }>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly progress = new vscode.EventEmitter<IndexProgress>();
  public readonly onDidChange = this.changed.event;
  public readonly onDidProgress = this.progress.event;
  private readonly stats: IndexStatistics = { parses: 0, reads: 0, statChecks: 0, cacheHits: 0 };
  private rebuilding?: Promise<void>;
  private revision = 0;
  private graphEpoch = 0;
  private nextJob = 0;
  private foreground = 0;
  private readonly idleWaiters = new Set<() => void>();
  private disposed = false;
  public truncated = false;
  public paused = false;

  public initialize(): Promise<void> { return this.rebuild(); }
  public getStatistics(): IndexStatistics { return { ...this.stats }; }
  public getDocumentCount(): number { return this.documents.size; }
  public isReady(uri: vscode.Uri): boolean { return this.ready.has(key(uri)); }

  public rebuild(): Promise<void> {
    if (this.rebuilding) { return this.rebuilding; }
    this.rebuilding = this.scan().finally(() => { this.rebuilding = undefined; });
    return this.rebuilding;
  }

  private async scan(): Promise<void> {
    let cancelled = false;
    const job: IndexProgress = { id: ++this.nextJob, background: true, title: 'Shader Navigator: 扫描工作区', phase: 'discovering', completed: 0, total: 0, cancel: () => { cancelled = true; } };
    this.truncated = false; this.paused = false;
    const cachedBeforeScan = new Set(this.documents.keys());
    this.invalidateResolution();
    // The active document is available before discovery or unrelated parsing begins.
    for (const document of vscode.workspace.textDocuments) { this.ensureLocalDocument(document); }
    this.progress.fire({ ...job });
    try {
      const config = vscode.workspace.getConfiguration('shaderNavigator');
      const excludes = config.get<string[]>('exclude', []);
      const exclude = excludes.length > 1 ? '{' + excludes.join(',') + '}' : excludes[0];
      const glob = '**/*.{'+SHADER_EXTENSIONS.map(extension => extension.slice(1)).join(',')+'}';
      const max = Math.max(1, config.get<number>('maxFiles', 20000));
      const files = new Map<string, vscode.Uri>();
      for (const search of [glob, ...this.configuredRoots().map(root => new vscode.RelativePattern(root, glob))]) {
        if (cancelled || this.disposed) { break; }
        for (const uri of await vscode.workspace.findFiles(search, exclude, max + 1)) { files.set(key(uri), uri); }
      }
      this.truncated = files.size > max;
      const uris = [...files.values()].slice(0, max);
      this.knownFiles.clear(); this.aliases.clear();
      for (const uri of uris) { this.rememberFile(uri); }
      // Retry includes that were unresolved before discovery, without throwing away parsed files.
      this.invalidateResolution();
      const openKeys = new Set(vscode.workspace.textDocuments.map(document => key(document.uri)));
      for (const [documentKey, document] of this.documents) {
        if (!files.has(documentKey) && !openKeys.has(documentKey) && vscode.workspace.getWorkspaceFolder(document.uri)) { this.removeDocument(document.uri); }
      }
      job.phase = 'parsing'; job.total = uris.length;
      this.progress.fire({ ...job });
      for (const document of vscode.workspace.textDocuments) { this.warmDocument(document); }
      // Small batches yield to editor requests. Dependency jobs take priority over background work.
      for (let i = 0; i < uris.length && !cancelled && !this.disposed; i += 4) {
        if (this.foreground) { await new Promise<void>(resolve => this.idleWaiters.add(resolve)); }
        if (cancelled || this.disposed) { break; }
        await Promise.all(uris.slice(i, i + 4).map(uri => this.read(uri, cachedBeforeScan.has(key(uri)))));
        job.completed = Math.min(i + 4, uris.length); job.file = uris[job.completed - 1]?.fsPath;
        this.progress.fire({ ...job });
        await nextTurn();
      }
      this.paused = cancelled;
      job.phase = cancelled || this.disposed ? 'cancelled' : 'done';
      this.progress.fire({ ...job });
      this.changed.fire();
    } catch (error) {
      this.progress.fire({ ...job, phase: 'failed' });
      throw error;
    }
  }

  /** Immediate local parse; coloring and outline do not wait for the include graph. */
  public ensureLocalDocument(document: vscode.TextDocument): void {
    if (this.disposed || document.uri.scheme !== 'file' || !isShaderFileName(document.fileName)) { return; }
    const documentKey = key(document.uri);
    if (this.versions.get(documentKey) === document.version && this.documents.has(documentKey)) { this.stats.cacheHits++; return; }
    this.store(document.uri, document.getText());
    this.versions.set(documentKey, document.version);
  }

  /** Start one shared dependency job; synchronous features can use local data meanwhile. */
  public warmDocument(document: vscode.TextDocument): void {
    if (!isShaderFileName(document.fileName) || document.uri.scheme !== 'file' || this.disposed) { return; }
    this.ensureLocalDocument(document);
    void this.ensureDocument(document).catch(error => console.warn('[Shader Navigator] Include loading failed: ' + String(error)));
  }

  public async ensureDocument(document: vscode.TextDocument): Promise<void> {
    if (!isShaderFileName(document.fileName) || document.uri.scheme !== 'file' || this.disposed) { return; }
    this.ensureLocalDocument(document);
    const documentKey = key(document.uri);
    while (!this.ready.has(documentKey) && !this.disposed) {
      const previous = this.preparing.get(documentKey);
      if (previous) { await previous; this.ensureLocalDocument(document); continue; }
      const pending = this.prepareGraph([document.uri], 'Shader Navigator: 加载 ' + path.basename(document.fileName));
      this.preparing.set(documentKey, pending);
      try { await pending; } finally { if (this.preparing.get(documentKey) === pending) { this.preparing.delete(documentKey); } }
      this.ensureLocalDocument(document);
    }
  }

  public updateDocument(document: vscode.TextDocument): Promise<void> { return this.ensureDocument(document); }

  public async updateDocumentFromUri(uri: vscode.Uri): Promise<void> {
    if (!isShaderFileName(uri.fsPath)) { return; }
    const existed = this.knownFiles.has(key(uri));
    await this.read(uri, true);
    // A body-only edit cannot change include resolution. File creation/removal can.
    if (existed !== this.knownFiles.has(key(uri))) { this.invalidateResolution(); }
    for (const editor of vscode.window.visibleTextEditors) { this.warmDocument(editor.document); }
  }

  public removeDocument(uri: vscode.Uri): void {
    const documentKey = key(uri);
    this.documents.delete(documentKey); this.knownFiles.delete(documentKey);
    this.edges.delete(documentKey); this.versions.delete(documentKey);
    this.rebuildAliases(); this.invalidateResolution(); this.touch();
  }
  public getDocument(uri: vscode.Uri): IndexedShaderDocument | undefined { return this.documents.get(key(uri)); }
  public getAllDocuments(): IndexedShaderDocument[] { return [...this.documents.values()]; }
  public getIncludes(uri: vscode.Uri) { return this.getDocument(uri)?.parsed.includes ?? []; }

  public getSymbols(name?: string): IndexedSymbolLocation[] {
    return this.getAllDocuments().flatMap(document => document.parsed.symbols.filter(symbol => !name || symbol.name === name).map(symbol => ({ uri: document.uri, symbol })));
  }

  /** A translation unit's global symbols are cached; lexical locals are filtered per request. */
  public visible(uri: vscode.Uri, offset: number): IndexedSymbolLocation[] {
    const documentKey = key(uri);
    let cached = this.visibility.get(documentKey);
    if (!cached || cached.revision !== this.revision) {
      const closure = new Set<string>();
      const queue = [uri];
      const symbols: IndexedSymbolLocation[] = [];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i], currentKey = key(current);
        if (closure.has(currentKey)) { continue; }
        closure.add(currentKey);
        const document = this.documents.get(currentKey);
        if (document) { for (const symbol of document.parsed.symbols) { if (!symbol.isMember && (!symbol.scope || currentKey === documentKey)) { symbols.push({uri:current, symbol}); } } }
        queue.push(...(this.edges.get(currentKey) ?? []));
      }
      cached = {revision:this.revision, symbols}; this.visibility.set(documentKey, cached);
    }
    return cached.symbols.filter(entry => !entry.symbol.scope || (offset >= entry.symbol.selectionRange.start && offset >= entry.symbol.scope.start && offset <= entry.symbol.scope.end))
      .sort((a,b) => (a.symbol.scope ? a.symbol.scope.end-a.symbol.scope.start : Number.MAX_SAFE_INTEGER) - (b.symbol.scope ? b.symbol.scope.end-b.symbol.scope.start : Number.MAX_SAFE_INTEGER));
  }

  public resolve(uri: vscode.Uri, offset: number, name: string): IndexedSymbolLocation[] {
    const declaration = this.getDocument(uri)?.parsed.symbols.find(symbol => symbol.isMember && symbol.name === name && offset >= symbol.selectionRange.start && offset <= symbol.selectionRange.end);
    if (declaration) { return [{ uri, symbol: declaration }]; }
    const candidates = (this.members(uri, offset) ?? this.visible(uri, offset)).filter(entry => entry.symbol.name === name);
    if (candidates[0]?.symbol.scope) { return [candidates[0]]; }
    const implementations = candidates.filter(entry => !entry.symbol.isPrototype);
    return implementations.length ? implementations : candidates;
  }

  public members(uri: vscode.Uri, offset: number): IndexedSymbolLocation[] | undefined {
    const receiver = this.receiver(uri, offset);
    return receiver === undefined ? undefined : this.fields(receiver?.symbol.typeName ?? '', uri, offset);
  }
  public memberType(uri: vscode.Uri, offset: number): string | undefined { return this.receiver(uri, offset)?.symbol.typeName; }

  private receiver(uri: vscode.Uri, offset: number): IndexedSymbolLocation | null | undefined {
    const document = this.getDocument(uri);
    if (!document) { return undefined; }
    const identifier = identifierAt(document.text, offset);
    const access = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$/.exec(document.parsed.code.slice(0, identifier?.start ?? offset));
    if (!access) { return undefined; }
    const chain = access[1].split(/\s*\.\s*/);
    let current = this.visible(uri, offset).find(entry => entry.symbol.name === chain[0]);
    for (let i = 1; current && i < chain.length; i++) { current = this.fields(current.symbol.typeName ?? '', uri, offset).find(entry => entry.symbol.name === chain[i]); }
    return current ?? null;
  }

  private fields(typeName: string, uri: vscode.Uri, offset: number): IndexedSymbolLocation[] {
    const typeUris = new Map(this.visible(uri, offset).filter(entry => entry.symbol.kind === 'struct' && entry.symbol.name === typeName).map(entry => [key(entry.uri),entry.uri]));
    return [...typeUris.values()].flatMap(current => (this.getDocument(current)?.parsed.symbols ?? []).filter(symbol => symbol.isMember && symbol.containerName === typeName).map(symbol=>({uri:current,symbol})));
  }

  public resolveInclude(from: vscode.Uri, text: string): Promise<vscode.Uri | undefined> {
    const cacheKey = key(vscode.Uri.file(path.dirname(from.fsPath))) + '|' + text;
    let pending = this.resolutions.get(cacheKey);
    if (!pending) { pending = this.findInclude(from,text); this.resolutions.set(cacheKey,pending); }
    else { this.stats.cacheHits++; }
    return pending;
  }

  private async findInclude(from: vscode.Uri, text: string): Promise<vscode.Uri | undefined> {
    const include = slash(text), virtualPath = include.replace(/^\/+/, '');
    const roots = [path.dirname(from.fsPath), ...(vscode.workspace.workspaceFolders ?? []).map(folder=>folder.uri.fsPath), ...this.configuredRoots()];
    const candidates = path.isAbsolute(include) ? [include, ...(/^\/[^/]/.test(include) ? roots.map(root=>path.resolve(root,virtualPath)) : [])] : roots.map(root=>path.resolve(root,include));
    for (const candidate of [...new Set(candidates)]) {
      const uri=vscode.Uri.file(candidate);
      if (this.knownFiles.has(key(uri)) || this.documents.has(key(uri)) || await this.isFile(uri)) { return uri; }
    }
    const matches=new Map<string,vscode.Uri>();
    for (const alias of new Set([include,virtualPath])) { for (const uri of this.aliases.get(alias) ?? []) { matches.set(key(uri),uri); } }
    return matches.size===1 ? [...matches.values()][0] : undefined;
  }

  public async findIncludeCandidates(from: vscode.Uri, prefix: string): Promise<IncludeCandidate[]> {
    const roots=[path.dirname(from.fsPath), ...(vscode.workspace.workspaceFolders ?? []).map(folder=>folder.uri.fsPath), ...this.configuredRoots()];
    const result=new Map<string,IncludeCandidate>();
    for (const uri of this.knownFiles.values()) {
      if (key(from)===key(uri)) { continue; }
      for (const root of roots) {
        const relative=slash(path.relative(root,uri.fsPath)), label=(prefix.startsWith('/')?'/':'')+relative;
        if (!path.isAbsolute(relative) && !relative.startsWith('../') && label.toLowerCase().startsWith(slash(prefix).toLowerCase())) { result.set(label,{label,uri}); }
      }
    }
    return [...result.values()].sort((a,b)=>a.label.length-b.label.length||a.label.localeCompare(b.label)).slice(0,200);
  }

  /** Expensive workspace-wide linking is reserved for explicit references/rename requests. */
  public async refreshIncludes(): Promise<void> {
    if (this.rebuilding) { await this.rebuilding; }
    await this.prepareGraph(this.getAllDocuments().map(document=>document.uri),'Shader Navigator: 链接 include 引用');
  }

  private async prepareGraph(roots: vscode.Uri[], title: string): Promise<void> {
    const epoch=this.graphEpoch;
    const visited=new Set<string>(), queued=new Set(roots.map(key)), queue=[...roots];
    const job: IndexProgress={id:++this.nextJob,background:false,title,phase:'includes',completed:0,total:queue.length};
    let failed = false;
    this.foreground++; this.progress.fire({...job});
    try {
      for(let i=0;i<queue.length && !this.disposed;i++) {
        const uri=queue[i], documentKey=key(uri);
        visited.add(documentKey);
        const document=this.documents.get(documentKey);
        if (document && !this.ready.has(documentKey)) {
          let targets=this.edges.get(documentKey);
          if (!targets) {
            const resolved=await Promise.all(document.parsed.includes.map(include=>this.resolveInclude(uri,include.path)));
            // An edit while resolving must never install edges for an older document.
            if (this.documents.get(documentKey)!==document || epoch!==this.graphEpoch) { return; }
            targets=resolved.filter((target):target is vscode.Uri=>target!==undefined);
            this.edges.set(documentKey,targets); this.touch();
          }
          const missing: vscode.Uri[] = [];
          const max = vscode.workspace.getConfiguration('shaderNavigator').get<number>('maxFiles',20000);
          for (const target of targets) {
            if (!this.documents.has(key(target))) {
              if (this.documents.size + missing.length >= max) { this.truncated=true; continue; }
              if (!missing.some(current=>key(current)===key(target))) { missing.push(target); }
            }
            if (!queued.has(key(target))) {queued.add(key(target));queue.push(target);}
          }
          job.total=queue.length;job.file=uri.fsPath;this.progress.fire({...job});
          for (let batch=0;batch<missing.length;batch+=4) {
            await Promise.all(missing.slice(batch,batch+4).map(target=>this.read(target)));
            await nextTurn();
          }
        }
        job.completed=i+1;job.total=queue.length;job.file=uri.fsPath;
        this.progress.fire({...job});
        // Yield regularly even if every dependency is already in memory.
        if ((i+1)%8===0) {await nextTurn();}
      }
      if(epoch===this.graphEpoch && !this.disposed){for(const documentKey of visited){this.ready.add(documentKey);}}
    } catch (error) {
      failed = true; throw error;
    } finally {
      this.progress.fire({...job,phase:failed?'failed':'done'});
      this.changed.fire();
      if(--this.foreground===0){for(const resolve of this.idleWaiters){resolve();}this.idleWaiters.clear();}
    }
  }

  private store(uri:vscode.Uri,text:string):void {
    const previous=this.documents.get(key(uri));
    if(previous?.text===text){this.stats.cacheHits++;return;}
    const parsed=parseShaderDocument(text); this.stats.parses++;
    if(previous && previous.parsed.includes.map(include=>include.path).join('\0')!==parsed.includes.map(include=>include.path).join('\0')){
      this.edges.delete(key(uri));this.ready.clear();this.graphEpoch++;
    }
    this.documents.set(key(uri),{uri,text,parsed});this.rememberFile(uri);this.touch();
  }

  private async read(uri:vscode.Uri,refresh=false):Promise<void> {
    const open=vscode.workspace.textDocuments.find(document=>key(document.uri)===key(uri));
    if(open){this.ensureLocalDocument(open);return;}
    if(this.documents.has(key(uri))&&!refresh){this.stats.cacheHits++;return;}
    const previous=this.reading.get(key(uri));if(previous){await previous;return;}
    const pending=(async()=>{
      try{
        this.stats.reads++;
        const text=Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const live=vscode.workspace.textDocuments.find(document=>key(document.uri)===key(uri));
        if(live){this.ensureLocalDocument(live);}else if(!this.disposed){this.store(uri,text);}
      }catch{this.documents.delete(key(uri));this.knownFiles.delete(key(uri));this.edges.delete(key(uri));this.versions.delete(key(uri));this.rebuildAliases();this.touch();}
    })();
    this.reading.set(key(uri),pending);
    try{await pending;}finally{this.reading.delete(key(uri));}
  }

  private rememberFile(uri:vscode.Uri):void {
    if(this.knownFiles.has(key(uri))){return;}
    this.knownFiles.set(key(uri),uri);
    for(const alias of this.fileAliases(uri)){
      const values=this.aliases.get(alias)??[];values.push(uri);this.aliases.set(alias,values);
    }
  }
  private fileAliases(uri:vscode.Uri):string[]{
    const relative=slash(vscode.workspace.asRelativePath(uri,false));
    return [...new Set([path.basename(uri.fsPath),relative,relative.replace(/(Packages\/[^/]+)@[^/]+\//,'$1/')])];
  }
  private rebuildAliases():void {this.aliases.clear();for(const uri of this.knownFiles.values()){for(const alias of this.fileAliases(uri)){const values=this.aliases.get(alias)??[];values.push(uri);this.aliases.set(alias,values);}}}
  private invalidateResolution():void {this.resolutions.clear();this.edges.clear();this.ready.clear();this.graphEpoch++;this.touch();}
  private touch():void {this.revision++;this.visibility.clear();}

  private configuredRoots():string[]{
    const roots:string[]=[];
    for(const configured of vscode.workspace.getConfiguration('shaderNavigator').get<string[]>('includePaths',[])){
      const expanded=configured.replace(/^~(?=[\\/])/,process.env.USERPROFILE??process.env.HOME??'');
      if(path.isAbsolute(expanded)){roots.push(expanded);}else{for(const folder of vscode.workspace.workspaceFolders??[]){roots.push(path.resolve(folder.uri.fsPath,expanded.replace(/\$\{workspaceFolder\}[\\/]?/,'')));}}
    }
    return [...new Set(roots)];
  }
  private async isFile(uri:vscode.Uri):Promise<boolean>{try{this.stats.statChecks++;return((await vscode.workspace.fs.stat(uri)).type&vscode.FileType.File)!==0;}catch{return false;}}
  public dispose():void {this.disposed=true;for(const resolve of this.idleWaiters){resolve();}this.idleWaiters.clear();this.changed.dispose();this.progress.dispose();}
}
