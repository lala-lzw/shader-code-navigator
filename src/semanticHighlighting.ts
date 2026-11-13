import * as vscode from 'vscode';
import { classifyShader, colorCategories, colorTokenType, tokenModifiers } from './highlighting';
import { isShaderFileName } from './model';
import { ShaderWorkspaceIndex } from './workspaceIndex';

export const shaderTokenLegend = new vscode.SemanticTokensLegend([
  ...Object.keys(colorCategories).map((category) => colorTokenType(category as keyof typeof colorCategories)),
  ...Object.keys(colorCategories).map((category) => colorTokenType(category as keyof typeof colorCategories, true)),
  ...new Set(Object.values(colorCategories).map((category) => category.superType))
], tokenModifiers);

/** Same classification in each language mode, with optional Shader-only palette overrides. */
export class ShaderSemanticHighlighting implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeSemanticTokens = this.changed.event;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  public constructor(private readonly index: ShaderWorkspaceIndex) {}

  public refresh(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.changed.fire(); }, 100);
  }

  public async provideDocumentSemanticTokens(document: vscode.TextDocument, cancellation: vscode.CancellationToken): Promise<vscode.SemanticTokens | undefined> {
    const config = vscode.workspace.getConfiguration('shaderNavigator.highlighting', document.uri);
    if (!isShaderFileName(document.fileName) || !config.get<boolean>('enabled', true)) { return undefined; }
    const version = document.version;
    this.index.ensureLocalDocument(document);
    this.index.warmDocument(document);
    if (cancellation.isCancellationRequested || document.version !== version) { return undefined; }
    const indexed = this.index.getDocument(document.uri);
    if (!indexed) { return undefined; }
    const themeKind = vscode.window.activeColorTheme.kind;
    const customPalette = config.get<string>('style', 'csharp') === 'csharp' && themeKind !== vscode.ColorThemeKind.HighContrast && themeKind !== vscode.ColorThemeKind.HighContrastLight;
    const light = themeKind === vscode.ColorThemeKind.Light;
    const included = this.index.visible(document.uri, 0).filter((entry) => entry.uri.toString() !== document.uri.toString()).map((entry) => entry.symbol);
    const builder = new vscode.SemanticTokensBuilder(shaderTokenLegend);
    for (const token of classifyShader(indexed.text, indexed.parsed, included)) {
      const type = customPalette ? colorTokenType(token.category, light) : colorCategories[token.category].superType;
      // Semantic tokens cannot cross a line break. Preserve CRLF/UTF-16 positions.
      let start = token.start;
      while (start < token.end) {
        const position = document.positionAt(start);
        const line = document.lineAt(position.line);
        const end = Math.min(token.end, document.offsetAt(line.range.end));
        if (end > start) { builder.push(new vscode.Range(position, document.positionAt(end)), type, token.modifiers); }
        const next = document.offsetAt(line.rangeIncludingLineBreak.end);
        if (next <= start) { break; }
        start = next;
      }
    }
    return builder.build();
  }

  public dispose(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.changed.dispose();
  }
}
