import { intrinsics } from './builtins';
import { ParsedShaderDocument, ShaderSymbol } from './model';

/** Shared by the semantic provider, its default colors, and the highlighting tests. */
export const colorCategories = {
  function: { superType: 'function', dark: '#8FCD8F', light: '#267326', scope: 'entity.name.function' },
  type: { superType: 'type', dark: '#4EC9B0', light: '#267F99', scope: 'entity.name.type' },
  builtinType: { superType: 'type', dark: '#569CD6', light: '#0000FF', scope: 'storage.type' },
  variable: { superType: 'variable', dark: '#9CDCFE', light: '#1F377F', scope: 'variable.other.readwrite' },
  parameter: { superType: 'parameter', dark: '#9CDCFE', light: '#1F377F', scope: 'variable.parameter' },
  property: { superType: 'property', dark: '#D4D4D4', light: '#303030', scope: 'variable.other.property' },
  constant: { superType: 'variable', dark: '#4FC1FF', light: '#0070C1', scope: 'variable.other.constant' },
  macro: { superType: 'macro', dark: '#C8A2C8', light: '#795E8A', scope: 'entity.name.function.preprocessor' },
  keyword: { superType: 'keyword', dark: '#569CD6', light: '#0000FF', scope: 'keyword.other' },
  control: { superType: 'keyword', dark: '#C586C0', light: '#AF00DB', scope: 'keyword.control' },
  directive: { superType: 'keyword', dark: '#9B9B9B', light: '#656565', scope: 'keyword.preprocessor' },
  semantic: { superType: 'enumMember', dark: '#D7BA7D', light: '#795E26', scope: 'entity.name.label' },
  number: { superType: 'number', dark: '#B5CEA8', light: '#098658', scope: 'constant.numeric' },
  string: { superType: 'string', dark: '#CE9178', light: '#A31515', scope: 'string.quoted.double' },
  comment: { superType: 'comment', dark: '#6A9955', light: '#008000', scope: 'comment' },
  operator: { superType: 'operator', dark: '#D4D4D4', light: '#303030', scope: 'keyword.operator' }
} as const;

export type ColorCategory = keyof typeof colorCategories;
export interface HighlightToken { start: number; end: number; category: ColorCategory; modifiers: string[] }
export const tokenModifiers = ['declaration', 'readonly', 'defaultLibrary'];
export function colorTokenType(category: ColorCategory, light = false): string {
  return 'shader' + category[0].toUpperCase() + category.slice(1) + (light ? 'Light' : '');
}

const primitiveType = /^(?:void|bool|int|uint|dword|half|float|double|fixed|min(?:10|12|16)(?:float|int|uint))(?:[1-4](?:x[1-4])?)?$/;
const resourceType = /^(?:(?:RW|RasterizerOrdered)?(?:Texture(?:1D|2D|3D|Cube)(?:Array|MS|MSArray)?|StructuredBuffer|ByteAddressBuffer|Buffer)|(?:Append|Consume)StructuredBuffer|Sampler(?:Comparison)?State|sampler(?:1D|2D|3D|CUBE|Cube)?|vector|matrix|InputPatch|OutputPatch|TriangleStream|PointStream|LineStream)$/;
const controls = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'discard']);
const reserved = new Set(['struct', 'class', 'enum', 'cbuffer', 'tbuffer', 'typedef', 'namespace', 'static', 'const', 'uniform', 'volatile', 'precise', 'in', 'out', 'inout', 'inline', 'noinline', 'row_major', 'column_major', 'groupshared', 'true', 'false', 'register', 'packoffset', 'linear', 'centroid', 'nointerpolation', 'noperspective', 'sample', 'export', 'extern',
  'Shader', 'SubShader', 'Pass', 'Properties', 'Tags', 'Fallback', 'CustomEditor', 'UsePass', 'GrabPass', 'LOD', 'Category', 'Dependency',
  'HLSLPROGRAM', 'HLSLINCLUDE', 'ENDHLSL', 'CGPROGRAM', 'CGINCLUDE', 'ENDCG', 'GLSLPROGRAM', 'ENDGLSL',
  'Blend', 'BlendOp', 'ColorMask', 'Cull', 'ZClip', 'ZTest', 'ZWrite', 'Stencil', 'Offset', 'AlphaToMask', 'Fog', 'Lighting', 'Name',
  'Ref', 'ReadMask', 'WriteMask', 'Comp', 'CompBack', 'CompFront', 'Fail', 'ZFail', 'PassBack', 'PassFront', 'On', 'Off', 'Back', 'Front', 'Always', 'Never', 'Equal', 'NotEqual', 'Less', 'LEqual', 'Greater', 'GEqual', 'Keep', 'Replace', 'Zero', 'One', 'SrcAlpha', 'OneMinusSrcAlpha']);
const macroKeywords = new Set(['CBUFFER_START', 'CBUFFER_END']);
const lexer = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|#[ \t]*[A-Za-z_]\w*|\b0[xX][0-9A-Fa-f]+[uUlL]*\b|(?:\b\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fFhHuUlL]*|\b[A-Za-z_]\w*\b|[+\-*\/%=<>!&|^~?:]+/g;

function symbolCategory(symbol: ShaderSymbol): ColorCategory {
  switch (symbol.kind) {
    case 'function': return 'function';
    case 'struct': case 'cbuffer': return 'type';
    case 'macro': return 'macro';
    case 'property': return 'property';
    default: return symbol.isParameter ? 'parameter' : symbol.isReadonly ? 'constant' : symbol.isMember || !symbol.scope ? 'property' : 'variable';
  }
}

/** Tokenize once: comments/strings own their complete ranges; identifiers use indexed symbols. */
export function classifyShader(source: string, parsed: ParsedShaderDocument, included: ShaderSymbol[] = []): HighlightToken[] {
  const declarations = new Map(parsed.symbols.filter((symbol) => symbol.kind !== 'shader').map((symbol) => [symbol.selectionRange.start, symbol]));
  const names = new Map<string, ShaderSymbol[]>();
  for (const symbol of [...parsed.symbols, ...included]) {
    if (symbol.kind === 'shader') { continue; }
    const list = names.get(symbol.name) ?? [];
    list.push(symbol); names.set(symbol.name, list);
  }
  const result: HighlightToken[] = [];
  for (const match of source.matchAll(lexer)) {
    const text = match[0], start = match.index!, end = start + text.length;
    if (parsed.includes.some((include) => start < include.pathRange.end + 1 && end > include.pathRange.start - 1)) { continue; }
    let category: ColorCategory;
    const modifiers: string[] = [];
    if (text.startsWith('//') || text.startsWith('/*')) { category = 'comment'; }
    else if (text[0] === '"' || text[0] === "'") { category = 'string'; }
    else if (text[0] === '#') { category = 'directive'; }
    else if (/^(?:\d|\.\d)/.test(text)) { category = 'number'; }
    else if (!/^[A-Za-z_]\w*$/.test(text)) { category = 'operator'; }
    else if (controls.has(text)) { category = 'control'; }
    else if (primitiveType.test(text)) { category = 'builtinType'; modifiers.push('defaultLibrary'); }
    else if (resourceType.test(text)) { category = 'type'; modifiers.push('defaultLibrary'); }
    else if (reserved.has(text)) { category = 'keyword'; }
    else {
      const before = parsed.code.slice(Math.max(0, start - 80), start);
      const memberAccess = /\.\s*$/.test(before);
      const declaration = declarations.get(start);
      const candidates = (names.get(text) ?? []).filter((symbol) => {
        if (memberAccess) { return !!symbol.isMember; }
        return !symbol.isMember && (!symbol.scope || (start >= symbol.selectionRange.start && start >= symbol.scope.start && start < symbol.scope.end));
      }).sort((a, b) => (a.scope ? a.scope.end - a.scope.start : Infinity) - (b.scope ? b.scope.end - b.scope.start : Infinity));
      const symbol = declaration ?? candidates[0];
      if (symbol) {
        category = symbolCategory(symbol);
        if (declaration) { modifiers.push('declaration'); }
        if (symbol.isReadonly || symbol.kind === 'macro') { modifiers.push('readonly'); }
      } else if (macroKeywords.has(text)) { category = 'macro'; modifiers.push('defaultLibrary'); }
      else if (memberAccess) { category = /^\s*\(/.test(parsed.code.slice(end)) ? 'function' : 'property'; }
      else if (intrinsics[text]) { category = 'function'; modifiers.push('defaultLibrary'); }
      else if (/:\s*$/.test(before) && !/::\s*$/.test(before)) { category = 'semantic'; }
      else if (/\[\s*$/.test(before) && /^\s*\(/.test(parsed.code.slice(end))) { category = 'type'; }
      else if (/^\s*\(/.test(parsed.code.slice(end))) { category = 'function'; }
      else { continue; } // Unknown identifiers retain grammar/theme colors instead of guessing from case.
    }
    result.push({ start, end, category, modifiers });
  }
  for (const include of parsed.includes) {
    result.push({ start: include.pathRange.start - 1, end: include.pathRange.end + 1, category: 'string', modifiers: [] });
  }
  return result.sort((a, b) => a.start - b.start);
}
