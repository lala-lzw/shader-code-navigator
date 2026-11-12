export type ShaderSymbolKind =
  | 'shader'
  | 'function'
  | 'macro'
  | 'struct'
  | 'cbuffer'
  | 'variable'
  | 'property';

export interface TextRange {
  start: number;
  end: number;
}

export interface ShaderInclude {
  path: string;
  range: TextRange;
  pathRange: TextRange;
  quoted: boolean;
  line: number;
}

export interface ShaderSymbol {
  name: string;
  kind: ShaderSymbolKind;
  detail: string;
  range: TextRange;
  selectionRange: TextRange;
  line: number;
  containerName?: string;
  typeName?: string;
  scope?: TextRange;
  parameters?: { name: string; label: string; typeName: string }[];
  isMember?: boolean;
  isPrototype?: boolean;
}

export interface ParsedShaderDocument {
  symbols: ShaderSymbol[];
  includes: ShaderInclude[];
  code: string;
}

export const SHADER_EXTENSIONS = [
  '.shader',
  '.shaderlab',
  '.hlsl',
  '.hlsli',
  '.cginc',
  '.compute',
  '.inc'
] as const;

export function isShaderFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SHADER_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
