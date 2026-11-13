import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const workspace = process.env.SHADER_TEST_WORKSPACE!;
  const uri = vscode.Uri.file(path.join(workspace, 'Main.shader'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension('standalone-tools.shader-code-navigator');
  assert.ok(extension, 'Extension discovered');
  // Exercise automatic activation rather than activating it from the test itself.
  for (let n = 0; !extension.isActive && n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(extension.isActive, 'Extension activated automatically for ' + document.languageId);
  assert.strictEqual(document.languageId, process.env.SHADER_TEST_LANGUAGE ?? 'shaderlab');
  console.log('Automatic activation and providers use language ID: ' + document.languageId);
  const position = (needle: string, after = 0) => document.positionAt(document.getText().indexOf(needle) + after);
  const definitions = async (needle: string, after = 1) => await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, position(needle, after));
  const completions = async (needle: string, after: number) => (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, position(needle, after))).items;
  const label = (item: vscode.CompletionItem) => typeof item.label === 'string' ? item.label : item.label.label;
  const assertSource = async (location: vscode.Location, expected: string) => { const target = await vscode.workspace.openTextDocument(location.uri); assert.strictEqual(target.getText(location.range), expected); };

  const include = await definitions('Common.hlsl');
  assert.strictEqual(path.basename(include[0].uri.fsPath), 'Common.hlsl');
  const external = await definitions('External.hlsli');
  assert.strictEqual(path.basename(external[0].uri.fsPath), 'External.hlsli');
  const functions = await definitions('Evaluate(input');
  assert.strictEqual(functions.length, 2, 'Overloads in included file only');
  for (const entry of functions) { assert.strictEqual(path.basename(entry.uri.fsPath), 'Common.hlsl'); await assertSource(entry, 'Evaluate'); }
  const macro = await definitions('SCALE;'); await assertSource(macro[0], 'SCALE');
  const local = await definitions('strength);'); await assertSource(local[0], 'strength');
  assert.strictEqual(local[0].uri.toString(), uri.toString());
  const parameter = await definitions('input.normal'); await assertSource(parameter[0], 'input');
  const member = await definitions('input.normal', 8); await assertSource(member[0], 'normal');
  const tint = await definitions('_Tint +'); await assertSource(tint[0], '_Tint');
  const material = await definitions('_Color;', 3); await assertSource(material[0], '_Color');
  assert.strictEqual((await definitions('// Evaluate', 5)).length, 0, 'Comments have no definitions');

  const functionItems = await completions('Evaluate(input', 4);
  assert.ok(functionItems.some((item) => label(item) === 'Evaluate'));
  assert.ok(!functionItems.some((item) => label(item) === 'UnrelatedHelper'), 'No unrelated symbol pollution');
  const memberItems = await completions('input.normal', 8);
  assert.ok(memberItems.some((item) => label(item) === 'normal'));
  assert.ok(!memberItems.some((item) => label(item) === 'normalize'), 'Member list stays in struct');
  const externalItems = await completions('ExternalFactor(max', 7);
  assert.ok(externalItems.some((item) => label(item) === 'ExternalFactor'), 'External include symbols indexed');
  const fileItems = await completions('Common.hlsl', 4);
  assert.ok(fileItems.some((item) => label(item) === '/Common.hlsl'));
  const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', uri, position('Evaluate(input, strength)', 16), ',');
  assert.ok(signature.signatures.some((item) => item.label.includes('Input value, float strength')));
  assert.strictEqual(signature.activeParameter, 1);
  const nested = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', uri, position('max(1, 2)', 7), ',');
  assert.ok(nested.signatures.some((item) => item.label.startsWith('T max(')));
  assert.strictEqual(nested.activeParameter, 1);
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position('Evaluate(input', 3));
  assert.ok(hover.length > 0);
  const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position('strength);', 2));
  assert.ok(references.length >= 2);
  assert.ok(references.every((entry) => entry.uri.toString() === uri.toString()));
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
  assert.ok(symbols.some((symbol) => symbol.name === 'Fragment'));
  assert.ok(symbols.some((symbol) => symbol.name === 'UnityPerMaterial'));
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', uri);
  assert.strictEqual(links.length, 2);
  const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, position('strength);', 2), 'intensity');
  assert.ok(rename.entries().length === 1);
  assert.ok(rename.entries()[0][1].length === 2, 'Rename excludes comment and unrelated scopes');

  const semanticTokens = async () => {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', uri);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', uri);
    assert.ok(legend?.tokenTypes.length && tokens?.data.length, 'Semantic provider produces tokens in ' + document.languageId);
    const decoded: {range: vscode.Range; type: string}[] = [];
    let line = 0, character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i]; character = tokens.data[i] === 0 ? character + tokens.data[i + 1] : tokens.data[i + 1];
      decoded.push({range: new vscode.Range(line, character, line, character + tokens.data[i + 2]), type: legend.tokenTypes[tokens.data[i + 3]]});
    }
    return decoded;
  };
  const semanticAt = (tokens: Awaited<ReturnType<typeof semanticTokens>>, needle: string, after = 0) => tokens.find((token) => token.range.contains(position(needle, after)))?.type;
  let highlighted = await semanticTokens();
  assert.strictEqual(semanticAt(highlighted, 'Evaluate(input'), 'shaderFunction');
  assert.strictEqual(semanticAt(highlighted, 'Fragment(Input'), 'shaderFunction');
  assert.strictEqual(semanticAt(highlighted, 'Input input'), 'shaderType');
  assert.strictEqual(semanticAt(highlighted, 'float4 Fragment'), 'shaderBuiltinType');
  assert.strictEqual(semanticAt(highlighted, 'input.normal'), 'shaderParameter');
  assert.strictEqual(semanticAt(highlighted, 'input.normal', 7), 'shaderProperty');
  assert.strictEqual(semanticAt(highlighted, 'SCALE;'), 'shaderMacro');
  assert.strictEqual(semanticAt(highlighted, 'max(1'), 'shaderFunction');
  assert.strictEqual(semanticAt(highlighted, 'return color'), 'shaderControl');
  assert.strictEqual(semanticAt(highlighted, '// Evaluate', 4), 'shaderComment');
  assert.strictEqual(semanticAt(highlighted, 'Common.hlsl', 3), 'shaderString');
  const palette = vscode.workspace.getConfiguration('editor', {uri, languageId: document.languageId}).get<{rules: Record<string, {foreground:string}>}>('semanticTokenColorCustomizations');
  assert.strictEqual(palette?.rules.shaderFunction.foreground, '#8FCD8F', 'Green function color is contributed without changing the user theme');
  assert.strictEqual(vscode.workspace.getConfiguration('editor', {uri, languageId: document.languageId}).get('semanticHighlighting.enabled'), true);
  const styleConfig = vscode.workspace.getConfiguration('shaderNavigator.highlighting', uri);
  await styleConfig.update('style', 'theme', vscode.ConfigurationTarget.Workspace);
  highlighted = await semanticTokens();
  assert.strictEqual(semanticAt(highlighted, 'Evaluate(input'), 'function', 'Theme mode uses standard semantic types');
  await styleConfig.update('style', 'csharp', vscode.ConfigurationTarget.Workspace);
  const workbench = vscode.workspace.getConfiguration('workbench');
  const previousTheme = workbench.get<string>('colorTheme');
  await workbench.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
  for (let i = 0; vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light && i < 50; i++) { await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.strictEqual(vscode.window.activeColorTheme.kind, vscode.ColorThemeKind.Light);
  highlighted = await semanticTokens();
  assert.strictEqual(semanticAt(highlighted, 'Evaluate(input'), 'shaderFunctionLight', 'Light theme uses the readable green palette');
  await workbench.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Workspace);
  console.log('PASS: semantic colors for functions, types, parameters, properties, macros, flow, comments, includes; palette defaults, theme mode, and light palette.');

  const editor = vscode.window.activeTextEditor!;
  const insertion = document.getText().indexOf('return color;');
  await editor.edit((edit) => edit.insert(document.positionAt(insertion), 'float liveValue = 1;\n    liveV\n    '));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const live = (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, position('liveV\n', 5))).items;
  assert.ok(live.some((item) => label(item) === 'liveValue'), 'Unsaved edits update completions');
  const vectorInsertion = document.getText().indexOf('return color;');
  await editor.edit((edit) => edit.insert(document.positionAt(vectorInsertion), 'normal.xy\n    '));
  const swizzles = await completions('normal.xy\n', 9);
  assert.ok(swizzles.some((item) => label(item) === 'xyz'), 'Vector swizzle completion');
  console.log('PASS: real VS Code activation, include links, exact definitions, overloads, locals, parameters, members, cbuffer, built-ins, signatures, hover, references, rename, outline and unsaved completion.');
}
