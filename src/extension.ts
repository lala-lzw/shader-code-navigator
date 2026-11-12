import * as vscode from 'vscode';
import { callAt, findIdentifierOccurrences, identifierAt, offsetToPosition } from './parser';
import { isShaderFileName, ShaderSymbolKind } from './model';
import { IndexedSymbolLocation, ShaderWorkspaceIndex } from './workspaceIndex';
import { intrinsics, keywords } from './builtins';

// Unity's official extension uses UnityShader for both ShaderLab and HLSL.
// Match file extensions too so another syntax extension can keep its language ID.
const selector: vscode.DocumentSelector = [
  { language: 'shaderlab', scheme: 'file' },
  { language: 'hlsl', scheme: 'file' },
  { language: 'UnityShader', scheme: 'file' },
  { scheme: 'file', pattern: '**/*.{shader,shaderlab,hlsl,hlsli,cginc,compute,inc}' }
];

function range(text: string, start: number, end: number): vscode.Range {
  const a = offsetToPosition(text, start), b = offsetToPosition(text, end);
  return new vscode.Range(a.line, a.character, b.line, b.character);
}
function identity(entry: IndexedSymbolLocation): string { return entry.uri.toString() + ':' + entry.symbol.selectionRange.start; }
function symbolRange(index: ShaderWorkspaceIndex, entry: IndexedSymbolLocation): vscode.Range {
  return range(index.getDocument(entry.uri)!.text, entry.symbol.selectionRange.start, entry.symbol.selectionRange.end);
}
function current(document: vscode.TextDocument, position: vscode.Position) {
  const offset = document.offsetAt(position);
  const word = identifierAt(document.getText(), offset);
  return word ? { name: document.getText().slice(word.start, word.end), range: range(document.getText(), word.start, word.end), offset } : undefined;
}
function inCode(index: ShaderWorkspaceIndex, document: vscode.TextDocument, position: vscode.Position): boolean {
  const word = current(document, position);
  const offset = word ? document.offsetAt(word.range.start) : Math.max(0, document.offsetAt(position) - 1);
  return index.getDocument(document.uri)?.parsed.code[offset] === document.getText()[offset];
}
function includeAt(index: ShaderWorkspaceIndex, document: vscode.TextDocument, position: vscode.Position) {
  const offset = document.offsetAt(position);
  return index.getIncludes(document.uri).find((include) => offset >= include.pathRange.start && offset <= include.pathRange.end);
}
function kind(value: ShaderSymbolKind): vscode.SymbolKind {
  return ({ shader: vscode.SymbolKind.Namespace, function: vscode.SymbolKind.Function, macro: vscode.SymbolKind.Constant, struct: vscode.SymbolKind.Struct, cbuffer: vscode.SymbolKind.Struct, variable: vscode.SymbolKind.Variable, property: vscode.SymbolKind.Property })[value];
}
function completionKind(value: ShaderSymbolKind): vscode.CompletionItemKind {
  return ({ shader: vscode.CompletionItemKind.Module, function: vscode.CompletionItemKind.Function, macro: vscode.CompletionItemKind.Constant, struct: vscode.CompletionItemKind.Struct, cbuffer: vscode.CompletionItemKind.Struct, variable: vscode.CompletionItemKind.Variable, property: vscode.CompletionItemKind.Property })[value];
}
function markdown(entry: IndexedSymbolLocation): vscode.MarkdownString {
  const value = new vscode.MarkdownString();
  value.appendCodeblock(entry.symbol.detail, 'hlsl');
  value.appendText(vscode.workspace.asRelativePath(entry.uri) + ':' + (entry.symbol.line + 1));
  return value;
}

function referenceLocations(index: ShaderWorkspaceIndex, document: vscode.TextDocument, position: vscode.Position, includeDeclaration: boolean): vscode.Location[] {
  const word = current(document, position);
  if (!word || !inCode(index, document, position)) { return []; }
  const targets = index.resolve(document.uri, word.offset, word.name);
  const ids = new Set(targets.map(identity));
  if (!ids.size) { return []; }
  const result: vscode.Location[] = [];
  for (const candidate of index.getAllDocuments()) {
    for (const occurrence of findIdentifierOccurrences(candidate.text, word.name)) {
      if (index.resolve(candidate.uri, occurrence.start, word.name).some((entry) => ids.has(identity(entry)))) {
        const isDeclaration = targets.some((entry) => entry.uri.toString() === candidate.uri.toString() && entry.symbol.selectionRange.start === occurrence.start);
        if (includeDeclaration || !isDeclaration) { result.push(new vscode.Location(candidate.uri, range(candidate.text, occurrence.start, occurrence.end))); }
      }
    }
  }
  return result;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new ShaderWorkspaceIndex();
  const output = vscode.window.createOutputChannel('Shader Code Navigator');
  output.appendLine('Shader Code Navigator ' + context.extension.packageJSON.version + ' activated.');
  let scanning = true;
  const prepare = async (document: vscode.TextDocument) => { await index.ensureDocument(document); };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'shaderNavigator.rebuildIndex';
  const updateStatus = () => {
    status.text = (scanning ? '$(sync~spin)' : '$(symbol-namespace)') + ' Shader: ' + index.getAllDocuments().length + (index.truncated ? '+' : '');
    status.tooltip = index.truncated ? 'Index limit reached. Increase shaderNavigator.maxFiles.' : 'Shader Code Navigator: rebuild index';
    if (vscode.window.activeTextEditor && isShaderFileName(vscode.window.activeTextEditor.document.fileName)) { status.show(); } else { status.hide(); }
  };
  updateStatus();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{shader,shaderlab,hlsl,hlsli,cginc,compute,inc}');
  context.subscriptions.push(status, watcher, output,
    watcher.onDidCreate(async (uri) => { await index.updateDocumentFromUri(uri); await index.refreshIncludes(); updateStatus(); }),
    watcher.onDidChange(async (uri) => { await index.updateDocumentFromUri(uri); updateStatus(); }),
    watcher.onDidDelete(async (uri) => { index.removeDocument(uri); await index.refreshIncludes(); updateStatus(); }),
    vscode.workspace.onDidOpenTextDocument(async (document) => { await index.updateDocument(document); updateStatus(); }),
    vscode.workspace.onDidChangeTextDocument(async (event) => { await index.updateDocument(event.document); }),
    vscode.workspace.onDidCloseTextDocument(async (document) => { await index.updateDocumentFromUri(document.uri); }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => { await index.rebuild(); updateStatus(); }),
    vscode.workspace.onDidChangeConfiguration(async (event) => { if (event.affectsConfiguration('shaderNavigator')) { await index.rebuild(); updateStatus(); } }),
    vscode.commands.registerCommand('shaderNavigator.rebuildIndex', async () => { await index.rebuild(); updateStatus(); void vscode.window.showInformationMessage('Shader Navigator indexed ' + index.getAllDocuments().length + ' files.' + (index.truncated ? ' Index limit reached.' : '')); }),
    vscode.commands.registerCommand('shaderNavigator.openSymbolSearch', () => vscode.commands.executeCommand('workbench.action.showAllSymbols')),
    vscode.commands.registerCommand('shaderNavigator.diagnose', async () => {
      const document = vscode.window.activeTextEditor?.document;
      output.show(true);
      if (!document || !isShaderFileName(document.fileName)) { output.appendLine('Open a Shader/HLSL file first.'); return; }
      await prepare(document);
      output.appendLine('Active file: ' + document.fileName + '\nLanguage: ' + document.languageId + '\nProvider match: ' + vscode.languages.match(selector, document) + '\nIndexed files: ' + index.getAllDocuments().length + '\nSymbols in active file: ' + (index.getDocument(document.uri)?.parsed.symbols.length ?? 0));
      for (const include of index.getIncludes(document.uri)) { output.appendLine('Include ' + include.path + ' -> ' + ((await index.resolveInclude(document.uri, include.path))?.fsPath ?? 'unresolved')); }
    }),
    vscode.languages.registerDefinitionProvider(selector, { async provideDefinition(document, position) {
      await prepare(document);
      const include = includeAt(index, document, position);
      if (include) { const target = await index.resolveInclude(document.uri, include.path); return target ? new vscode.Location(target, new vscode.Position(0, 0)) : undefined; }
      const word = current(document, position);
      return word && inCode(index, document, position) ? index.resolve(document.uri, word.offset, word.name).map((entry) => new vscode.Location(entry.uri, symbolRange(index, entry))) : [];
    }}),
    vscode.languages.registerCompletionItemProvider(selector, { async provideCompletionItems(document, position) {
      await prepare(document);
      const before = document.lineAt(position.line).text.slice(0, position.character);
      const include = /#\s*include(?:_with_pragmas)?\s*[<"]([^>"]*)$/.exec(before);
      if (include) {
        const rest = document.lineAt(position.line).text.slice(position.character).match(/^[^>"\r\n]*/)?.[0] ?? '';
        const replace = new vscode.Range(position.line, position.character - include[1].length, position.line, position.character + rest.length);
        return (await index.findIncludeCandidates(document.uri, include[1])).map((candidate) => { const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.File); item.range = replace; item.detail = candidate.uri.fsPath; return item; });
      }
      if (!inCode(index, document, position)) { return []; }
      const word = current(document, position);
      const offset = document.offsetAt(position);
      const prefix = word ? document.getText(new vscode.Range(word.range.start, position)) : '';
      const members = index.members(document.uri, offset);
      const items: vscode.CompletionItem[] = [];
      const seen = new Set<string>();
      for (const entry of members ?? index.visible(document.uri, offset)) {
        if (seen.has(entry.symbol.name) || !entry.symbol.name.toLowerCase().startsWith(prefix.toLowerCase())) { continue; }
        seen.add(entry.symbol.name);
        const item = new vscode.CompletionItem(entry.symbol.name, completionKind(entry.symbol.kind));
        item.range = word?.range; item.detail = entry.symbol.detail; item.documentation = markdown(entry); item.sortText = '0_' + entry.symbol.name;
        if (entry.symbol.kind === 'function' && !/^\s*\(/.test(document.getText().slice(word ? document.offsetAt(word.range.end) : offset))) {
          const snippet = new vscode.SnippetString(entry.symbol.name + '(');
          entry.symbol.parameters?.forEach((parameter, i) => { if (i) { snippet.appendText(', '); } snippet.appendPlaceholder(parameter.name); });
          snippet.appendText(')'); snippet.appendTabstop(0); item.insertText = snippet;
          item.command = { command: 'editor.action.triggerParameterHints', title: 'Parameter hints' };
        }
        items.push(item);
      }
      const vector = /^(?:float|half|fixed|int|uint|bool|double|min16float)([2-4])$/.exec(index.memberType(document.uri, offset) ?? '');
      if (vector) {
        for (const alphabet of ['xyzw', 'rgba']) {
          const components = alphabet.slice(0, Number(vector[1])).split('');
          let combinations = [''];
          for (let size = 1; size <= 4; size++) {
            combinations = combinations.flatMap((value) => components.map((component) => value + component));
            for (const name of combinations.filter((value) => value.startsWith(prefix))) {
              const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
              item.detail = 'HLSL vector swizzle'; item.range = word?.range; item.sortText = String(size) + name; items.push(item);
            }
          }
        }
      }
      if (members === undefined) {
        for (const name of [...Object.keys(intrinsics), ...keywords]) {
          if (seen.has(name) || !name.toLowerCase().startsWith(prefix.toLowerCase())) { continue; }
          seen.add(name);
          const item = new vscode.CompletionItem(name, intrinsics[name] ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Keyword);
          item.range = word?.range; item.detail = intrinsics[name]?.join('\n') ?? 'HLSL / ShaderLab'; item.sortText = '1_' + name; items.push(item);
        }
      }
      return items;
    }}, '.', '"', '<', '/'),
    vscode.languages.registerHoverProvider(selector, { async provideHover(document, position) {
      await prepare(document);
      const include = includeAt(index, document, position);
      if (include) { const target = await index.resolveInclude(document.uri, include.path); return new vscode.Hover(target ? target.fsPath : 'Include not found. Configure shaderNavigator.includePaths.', range(document.getText(), include.pathRange.start, include.pathRange.end)); }
      const word = current(document, position);
      if (!word || !inCode(index, document, position)) { return undefined; }
      const resolved = index.resolve(document.uri, word.offset, word.name);
      const contents = resolved.length ? resolved.slice(0, 8).map(markdown) : (intrinsics[word.name] ?? []).map((signature) => new vscode.MarkdownString().appendCodeblock(signature, 'hlsl'));
      return contents.length ? new vscode.Hover(contents, word.range) : undefined;
    }}),
    vscode.languages.registerSignatureHelpProvider(selector, { async provideSignatureHelp(document, position) {
      await prepare(document);
      const call = callAt(index.getDocument(document.uri)?.parsed.code ?? '', document.offsetAt(position));
      if (!call) { return undefined; }
      const functions = index.visible(document.uri, document.offsetAt(position)).filter((entry) => entry.symbol.name === call.name && entry.symbol.kind === 'function');
      const labels = [...new Set(functions.map((entry) => entry.symbol.detail).concat(intrinsics[call.name] ?? []))];
      if (!labels.length) { return undefined; }
      const help = new vscode.SignatureHelp();
      help.signatures = labels.map((label) => { const signature = new vscode.SignatureInformation(label); const params = label.match(/\((.*)\)/)?.[1]; signature.parameters = params ? params.split(/,(?![^<]*>)/).map((parameter) => new vscode.ParameterInformation(parameter.trim())) : []; return signature; });
      help.activeSignature = Math.max(0, help.signatures.findIndex((signature) => signature.parameters.length > call.parameter));
      help.activeParameter = call.parameter;
      return help;
    }}, '(', ','),
    vscode.languages.registerDocumentLinkProvider(selector, { async provideDocumentLinks(document) {
      await prepare(document);
      const links: vscode.DocumentLink[] = [];
      for (const include of index.getIncludes(document.uri)) { const target = await index.resolveInclude(document.uri, include.path); if (target) { links.push(new vscode.DocumentLink(range(document.getText(), include.pathRange.start, include.pathRange.end), target)); } }
      return links;
    }}),
    vscode.languages.registerReferenceProvider(selector, { async provideReferences(document, position, referenceContext) { await prepare(document); return referenceLocations(index, document, position, referenceContext.includeDeclaration); }}),
    vscode.languages.registerRenameProvider(selector, {
      async prepareRename(document, position) { await prepare(document); const word = current(document, position); if (!word || !inCode(index, document, position) || index.resolve(document.uri, word.offset, word.name).length !== 1) { throw new Error('Rename requires one unambiguous symbol definition.'); } return word.range; },
      async provideRenameEdits(document, position, newName) { await prepare(document); if (!/^[A-Za-z_]\w*$/.test(newName)) { throw new Error('Use a valid HLSL identifier.'); } const word = current(document, position); if (!word || index.resolve(document.uri, word.offset, word.name).length !== 1) { throw new Error('Ambiguous symbol.'); } const edit = new vscode.WorkspaceEdit(); for (const location of referenceLocations(index, document, position, true)) { edit.replace(location.uri, location.range, newName); } return edit; }
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, { async provideDocumentSymbols(document) {
      await prepare(document);
      return (index.getDocument(document.uri)?.parsed.symbols ?? []).filter((symbol) => !symbol.scope).map((symbol) => new vscode.DocumentSymbol(symbol.name, symbol.detail, kind(symbol.kind), range(document.getText(), symbol.range.start, symbol.range.end), range(document.getText(), symbol.selectionRange.start, symbol.selectionRange.end)));
    }}),
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols(query) {
      return index.getSymbols().filter((entry) => !entry.symbol.scope && !entry.symbol.isMember && entry.symbol.name.toLowerCase().includes(query.toLowerCase())).slice(0, 1000).map((entry) => new vscode.SymbolInformation(entry.symbol.name, kind(entry.symbol.kind), entry.symbol.containerName ?? '', new vscode.Location(entry.uri, symbolRange(index, entry))));
    }})
  );
  // Register providers before a potentially large workspace scan. Requests prepare
  // the active file and its includes without waiting for unrelated files.
  void index.initialize().then(() => {
    scanning = false;
    updateStatus();
    output.appendLine('Workspace index ready: ' + index.getAllDocuments().length + ' files.');
  }, (error) => {
    scanning = false;
    updateStatus();
    output.appendLine('Workspace scan failed: ' + String(error));
    void vscode.window.showErrorMessage('Shader Navigator: workspace scan failed. See Output > Shader Code Navigator.');
  });
}
export function deactivate(): void { /* Subscriptions belong to VS Code's extension context. */ }
