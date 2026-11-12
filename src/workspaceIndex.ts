import * as path from 'path';
import * as vscode from 'vscode';
import { isShaderFileName, ParsedShaderDocument, SHADER_EXTENSIONS, ShaderSymbol } from './model';
import { identifierAt, parseShaderDocument } from './parser';

export interface IndexedShaderDocument { uri: vscode.Uri; text: string; parsed: ParsedShaderDocument }
export interface IndexedSymbolLocation { uri: vscode.Uri; symbol: ShaderSymbol }
export interface IncludeCandidate { label: string; uri: vscode.Uri }

const key = (uri: vscode.Uri): string => process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
const slash = (text: string): string => text.replace(/\\/g, '/');

export class ShaderWorkspaceIndex {
  private readonly documents = new Map<string, IndexedShaderDocument>();
  private readonly edges = new Map<string, vscode.Uri[]>();
  private rebuilding?: Promise<void>;
  private generation = 0;
  private readonly versions = new Map<string, number>();
  private readonly preparing = new Map<string, Promise<void>>();
  public truncated = false;

  public initialize(): Promise<void> { return this.rebuild(); }

  public rebuild(): Promise<void> {
    if (this.rebuilding) { return this.rebuilding; }
    this.rebuilding = this.scan().finally(() => { this.rebuilding = undefined; });
    return this.rebuilding;
  }

  private async scan(): Promise<void> {
    this.generation++;
    this.documents.clear(); this.edges.clear(); this.truncated = false;
    this.versions.clear();
    for (const document of vscode.workspace.textDocuments) { this.storeOpen(document); }
    const config = vscode.workspace.getConfiguration('shaderNavigator');
    const excludes = config.get<string[]>('exclude', []);
    const exclude = excludes.length > 1 ? '{' + excludes.join(',') + '}' : excludes[0];
    const glob = '**/*.{'+SHADER_EXTENSIONS.map((extension) => extension.slice(1)).join(',')+'}';
    const max = Math.max(1, config.get<number>('maxFiles', 20000));
    const files = new Map<string, vscode.Uri>();
    const searches: vscode.GlobPattern[] = [glob, ...this.configuredRoots().map((root) => new vscode.RelativePattern(root, glob))];
    for (const search of searches) {
      for (const uri of await vscode.workspace.findFiles(search, exclude, max + 1)) { files.set(key(uri), uri); }
    }
    this.truncated = files.size > max;
    const uris = [...files.values()].slice(0, max);
    for (let i = 0; i < uris.length; i += 24) { await Promise.all(uris.slice(i, i + 24).map((uri) => this.read(uri))); }
    for (const document of vscode.workspace.textDocuments) { this.storeOpen(document); }
    await this.refreshIncludes();
  }

  private storeOpen(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || !isShaderFileName(document.fileName)) { return; }
    const text = document.getText();
    this.documents.set(key(document.uri), { uri: document.uri, text, parsed: parseShaderDocument(text) });
    this.versions.set(key(document.uri), document.version);
  }

  public async ensureDocument(document: vscode.TextDocument): Promise<void> {
    if (!isShaderFileName(document.fileName)) { return; }
    const documentKey = key(document.uri);
    const previous = this.preparing.get(documentKey);
    if (previous) { await previous; }
    if (this.getDocument(document.uri) && this.versions.get(documentKey) === document.version && this.edges.has(documentKey)) { return; }
    const pending = this.updateDocument(document);
    this.preparing.set(documentKey, pending);
    try { await pending; } finally { if (this.preparing.get(documentKey) === pending) { this.preparing.delete(documentKey); } }
  }

  public async updateDocument(document: vscode.TextDocument): Promise<void> {
    if (!isShaderFileName(document.fileName) || document.uri.scheme !== 'file') { return; }
    this.storeOpen(document);
    await this.loadIncludes(document.uri, new Set());
  }

  public async updateDocumentFromUri(uri: vscode.Uri): Promise<void> {
    if (!isShaderFileName(uri.fsPath)) { return; }
    await this.read(uri);
    await this.loadIncludes(uri, new Set());
  }

  public removeDocument(uri: vscode.Uri): void { this.documents.delete(key(uri)); this.edges.delete(key(uri)); this.versions.delete(key(uri)); }
  public getDocument(uri: vscode.Uri): IndexedShaderDocument | undefined { return this.documents.get(key(uri)); }
  public getAllDocuments(): IndexedShaderDocument[] { return [...this.documents.values()]; }
  public getIncludes(uri: vscode.Uri) { return this.getDocument(uri)?.parsed.includes ?? []; }

  public getSymbols(name?: string): IndexedSymbolLocation[] {
    return this.getAllDocuments().flatMap((document) => document.parsed.symbols.filter((symbol) => !name || symbol.name === name).map((symbol) => ({ uri: document.uri, symbol })));
  }

  /** Only the current translation unit, its includes, and live lexical scopes are visible. */
  public visible(uri: vscode.Uri, offset: number): IndexedSymbolLocation[] {
    const closure = new Set<string>();
    const visit = (current: vscode.Uri) => {
      if (closure.has(key(current))) { return; }
      closure.add(key(current));
      for (const include of this.edges.get(key(current)) ?? []) { visit(include); }
    };
    visit(uri);
    const result: IndexedSymbolLocation[] = [];
    for (const current of closure) {
      const document = this.documents.get(current);
      if (!document) { continue; }
      for (const symbol of document.parsed.symbols) {
        if (symbol.isMember) { continue; }
        if (symbol.scope && (current !== key(uri) || offset < symbol.scope.start || offset > symbol.scope.end || offset < symbol.selectionRange.start)) { continue; }
        result.push({ uri: document.uri, symbol });
      }
    }
    return result.sort((a, b) => (a.symbol.scope ? (a.symbol.scope.end - a.symbol.scope.start) : Number.MAX_SAFE_INTEGER) - (b.symbol.scope ? (b.symbol.scope.end - b.symbol.scope.start) : Number.MAX_SAFE_INTEGER));
  }

  public resolve(uri: vscode.Uri, offset: number, name: string): IndexedSymbolLocation[] {
    const declaration = this.getDocument(uri)?.parsed.symbols.find((symbol) => symbol.isMember && symbol.name === name && offset >= symbol.selectionRange.start && offset <= symbol.selectionRange.end);
    if (declaration) { return [{ uri, symbol: declaration }]; }
    const member = this.members(uri, offset);
    const candidates = (member ?? this.visible(uri, offset)).filter((entry) => entry.symbol.name === name);
    if (candidates[0]?.symbol.scope) { return [candidates[0]]; }
    const implementations = candidates.filter((entry) => !entry.symbol.isPrototype);
    return implementations.length ? implementations : candidates;
  }

  /** Resolve a simple member chain by the declared type of its first identifier. */
  public members(uri: vscode.Uri, offset: number): IndexedSymbolLocation[] | undefined {
    const receiver = this.receiver(uri, offset);
    return receiver === undefined ? undefined : this.fields(receiver?.symbol.typeName ?? '', uri, offset);
  }

  public memberType(uri: vscode.Uri, offset: number): string | undefined {
    return this.receiver(uri, offset)?.symbol.typeName;
  }

  private receiver(uri: vscode.Uri, offset: number): IndexedSymbolLocation | null | undefined {
    const document = this.getDocument(uri);
    if (!document) { return undefined; }
    const identifier = identifierAt(document.text, offset);
    const before = document.parsed.code.slice(0, identifier?.start ?? offset);
    const access = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*$/.exec(before);
    if (!access) { return undefined; }
    const chain = access[1].split(/\s*\.\s*/);
    let current = this.visible(uri, offset).find((entry) => entry.symbol.name === chain[0]);
    for (let i = 1; current && i < chain.length; i++) { current = this.fields(current.symbol.typeName ?? '', uri, offset).find((entry) => entry.symbol.name === chain[i]); }
    return current ?? null;
  }

  private fields(typeName: string, uri: vscode.Uri, offset: number): IndexedSymbolLocation[] {
    const typeUris = new Set(this.visible(uri, offset).filter((entry) => entry.symbol.kind === 'struct' && entry.symbol.name === typeName).map((entry) => key(entry.uri)));
    return this.getSymbols().filter((entry) => typeUris.has(key(entry.uri)) && entry.symbol.isMember && entry.symbol.containerName === typeName);
  }

  public async resolveInclude(from: vscode.Uri, text: string): Promise<vscode.Uri | undefined> {
    const include = slash(text);
    // A leading slash can be a shader compiler virtual root rather than a disk root.
    const virtualPath = include.replace(/^\/+/, '');
    const roots = [path.dirname(from.fsPath), ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath), ...this.configuredRoots()];
    const candidates = path.isAbsolute(include)
      ? [include, ...(/^\/[^/]/.test(include) ? roots.map((root) => path.resolve(root, virtualPath)) : [])]
      : roots.map((root) => path.resolve(root, include));
    for (const candidate of candidates) {
      const uri = vscode.Uri.file(candidate);
      if (this.documents.has(key(uri)) || await this.isFile(uri)) { return uri; }
    }
    // Versioned embedded packages use the same public include path as unversioned packages.
    const matches = this.getAllDocuments().filter((document) => {
      const relative = slash(vscode.workspace.asRelativePath(document.uri, false)).replace(/(Packages\/[^/]+)@[^/]+\//, '$1/');
      return relative === include || relative === virtualPath || path.basename(document.uri.fsPath) === virtualPath;
    });
    return matches.length === 1 ? matches[0].uri : undefined;
  }

  public async findIncludeCandidates(from: vscode.Uri, prefix: string): Promise<IncludeCandidate[]> {
    const roots = [path.dirname(from.fsPath), ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath), ...this.configuredRoots()];
    const result = new Map<string, IncludeCandidate>();
    for (const document of this.documents.values()) {
      if (key(from) === key(document.uri)) { continue; }
      for (const root of roots) {
        const relative = slash(path.relative(root, document.uri.fsPath));
        const label = (prefix.startsWith('/') ? '/' : '') + relative;
        if (!path.isAbsolute(relative) && !relative.startsWith('../') && label.toLowerCase().startsWith(slash(prefix).toLowerCase())) {
          result.set(label, { label, uri: document.uri });
        }
      }
    }
    return [...result.values()].sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label)).slice(0, 200);
  }

  public async refreshIncludes(): Promise<void> {
    const visited = new Set<string>();
    for (const document of this.getAllDocuments()) { await this.loadIncludes(document.uri, visited); }
  }

  private async loadIncludes(uri: vscode.Uri, visited: Set<string>): Promise<void> {
    if (visited.has(key(uri))) { return; }
    visited.add(key(uri));
    const document = this.getDocument(uri);
    if (!document) { return; }
    const targets: vscode.Uri[] = [];
    for (const include of document.parsed.includes) {
      const target = await this.resolveInclude(uri, include.path);
      if (!target) { continue; }
      targets.push(target);
      if (!this.documents.has(key(target))) {
        if (this.documents.size >= vscode.workspace.getConfiguration('shaderNavigator').get<number>('maxFiles', 20000)) { this.truncated = true; continue; }
        await this.read(target);
      }
      await this.loadIncludes(target, visited);
    }
    this.edges.set(key(uri), targets);
  }

  private async read(uri: vscode.Uri): Promise<void> {
    const generation = this.generation;
    const open = vscode.workspace.textDocuments.find((document) => key(document.uri) === key(uri));
    if (open) { this.storeOpen(open); return; }
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (generation === this.generation) {
        const live = vscode.workspace.textDocuments.find((document) => key(document.uri) === key(uri));
        if (live) { this.storeOpen(live); }
        else { this.documents.set(key(uri), { uri, text, parsed: parseShaderDocument(text) }); }
      }
    } catch { this.removeDocument(uri); }
  }

  private configuredRoots(): string[] {
    const roots: string[] = [];
    for (const configured of vscode.workspace.getConfiguration('shaderNavigator').get<string[]>('includePaths', [])) {
      const expanded = configured.replace(/^~(?=[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '');
      if (path.isAbsolute(expanded)) { roots.push(expanded); }
      else {
        for (const folder of vscode.workspace.workspaceFolders ?? []) { roots.push(path.resolve(folder.uri.fsPath, expanded.replace(/\$\{workspaceFolder\}[\\/]?/, ''))); }
      }
    }
    return [...new Set(roots)];
  }

  private async isFile(uri: vscode.Uri): Promise<boolean> {
    try { return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0; }
    catch { return false; }
  }
}
