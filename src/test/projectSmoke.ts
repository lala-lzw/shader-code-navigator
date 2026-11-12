import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseShaderDocument } from '../parser';

export async function run(): Promise<void> {
  const uri = vscode.Uri.file(process.env.SHADER_TEST_REAL_FILE!);
  let document = await vscode.workspace.openTextDocument(uri);
  document = await vscode.languages.setTextDocumentLanguage(document, 'UnityShader');
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension('standalone-tools.shader-code-navigator')!;
  for (let i = 0; !extension.isActive && i < 150; i++) { await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.ok(extension.isActive, 'Automatic activation for the real UnityShader document');
  console.log('Real file language: ' + document.languageId);
  const parsed = parseShaderDocument(document.getText());
  const first = parsed.includes[0];
  const includeTargets = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider',uri,document.positionAt(first.pathRange.start + 2));
  assert.ok(includeTargets.length, 'Real include definition resolves');
  console.log('Real include jump: ' + first.path + ' -> ' + includeTargets[0].uri.fsPath);
  const functionSymbol = parsed.symbols.find(symbol=>symbol.kind==='function' && document.getText().lastIndexOf(symbol.name + '(') > symbol.selectionRange.start);
  assert.ok(functionSymbol, 'File contains a callable function');
  const callOffset = document.getText().lastIndexOf(functionSymbol.name+'(');
  const functionTargets = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider',uri,document.positionAt(callOffset + 2));
  assert.ok(functionTargets.length, 'Real function jump resolves');
  const target = functionTargets.find(location=>location.uri.toString()===uri.toString());
  assert.ok(target, 'Function target is in the correct file');
  assert.strictEqual(document.getText(target.range),functionSymbol.name);
  const suggestions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',uri,document.positionAt(callOffset + 4));
  assert.ok(suggestions.items.some(item=>(typeof item.label==='string'?item.label:item.label.label)===functionSymbol.name), 'Real half-written name completion works');
  console.log('Real function jump and completion: ' + functionSymbol.name + ' -> line ' + (target.range.start.line+1));
  console.log('PASS: current project file works in UnityShader mode without modifying the file.');
}
