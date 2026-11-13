import { ParsedShaderDocument, ShaderInclude, ShaderSymbol, TextRange } from './model';

const invalidTypes = new Set(['return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'discard', 'struct', 'class', 'enum', 'cbuffer', 'tbuffer', 'define', 'include', 'pragma']);

/** Keep UTF-16 offsets stable while hiding comments and strings from symbol matching. */
export function sanitizeSource(source: string): string {
  return source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/g,
    (match) => match.replace(/[^\r\n]/g, ' '));
}

function pairs(code: string, opening: string, closing: string): Map<number, number> {
  const stack: number[] = [];
  const result = new Map<number, number>();
  for (let i = 0; i < code.length; i++) {
    if (code[i] === opening) { stack.push(i); }
    else if (code[i] === closing && stack.length) { result.set(stack.pop()!, i); }
  }
  for (const start of stack) { result.set(start, code.length); }
  return result;
}

function splitParameters(text: string): { text: string; offset: number }[] {
  const parts: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if ('(<['.includes(text[i] ?? '\0')) { depth++; }
    if (')>]'.includes(text[i] ?? '\0')) { depth--; }
    if ((text[i] === ',' && depth === 0) || i === text.length) {
      if (text.slice(start, i).trim() && text.slice(start, i).trim() !== 'void') {
        parts.push({ text: text.slice(start, i), offset: start });
      }
      start = i + 1;
    }
  }
  return parts;
}

function parseIncludes(source: string, code: string): ShaderInclude[] {
  const includes: ShaderInclude[] = [];
  const pattern = /^[ \t]*#\s*include(?:_with_pragmas)?\s*([<"])([^>"\r\n]+)[>"]/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    if (code[start + match[0].indexOf('#')] !== '#') { continue; }
    const pathStart = start + match[0].indexOf(match[2], match[0].indexOf(match[1]) + 1);
    includes.push({ path: match[2], quoted: match[1] === '"',
      range: { start, end: start + match[0].length }, pathRange: { start: pathStart, end: pathStart + match[2].length },
      line: offsetToPosition(source, start).line });
  }
  return includes;
}

export function parseShaderDocument(source: string): ParsedShaderDocument {
  const sanitized = sanitizeSource(source);
  // Directives contain argument-like text that must not be mistaken for declarations.
  const code = sanitized.replace(/^[ \t]*#[^\r\n]*(?:\\\r?\n[^\r\n]*)*/gm, (text) => text.replace(/[^\r\n]/g, ' '));
  const braces = pairs(code, '{', '}');
  const parentheses = pairs(code, '(', ')');
  const symbols: ShaderSymbol[] = [];
  const occupied = new Set<number>();
  const parameterRanges: TextRange[] = [];
  const functions: { body: TextRange; symbol: ShaderSymbol }[] = [];
  const aggregates: { body: TextRange; name: string; kind: 'struct' | 'cbuffer' }[] = [];
  const add = (name: string, kind: ShaderSymbol['kind'], start: number, end: number, detail: string, extra: Partial<ShaderSymbol> = {}): ShaderSymbol => {
    const symbol: ShaderSymbol = { name, kind, detail, range: { start, end }, selectionRange: { start, end: start + name.length }, line: offsetToPosition(source, start).line, ...extra };
    if (!occupied.has(start)) { symbols.push(symbol); occupied.add(start); }
    return symbol;
  };

  for (const match of source.matchAll(/\bShader\s*"([^"]+)"/g)) {
    if (sanitized[match.index!] !== 'S') { continue; }
    const start = match.index! + match[0].indexOf('"') + 1;
    add(match[1], 'shader', start, start + match[1].length, 'Shader "' + match[1] + '"');
  }
  for (const match of sanitized.matchAll(/^[ \t]*#\s*define[ \t]+([A-Za-z_]\w*)(\([^\r\n)]*\))?[^\r\n]*/gm)) {
    const start = match.index! + match[0].indexOf(match[1], match[0].indexOf('define') + 6);
    add(match[1], 'macro', start, match.index! + match[0].length, source.slice(match.index!, match.index! + match[0].length).trim());
  }
  for (const match of code.matchAll(/\b(struct|class|enum|cbuffer|tbuffer)\s+([A-Za-z_]\w*)(?:\s*:\s*[A-Za-z_]\w*)?\s*\{/g)) {
    const opening = match.index! + match[0].lastIndexOf('{');
    const end = Math.min(source.length, (braces.get(opening) ?? source.length) + 1);
    const kind = /buffer/.test(match[1]) ? 'cbuffer' : 'struct';
    aggregates.push({ body: { start: opening, end }, name: match[2], kind });
    add(match[2], kind, match.index! + match[0].indexOf(match[2], match[1].length), end, match[1] + ' ' + match[2]);
  }
  for (const match of code.matchAll(/\bCBUFFER_START\s*\(\s*([A-Za-z_]\w*)\s*\)/g)) {
    const start = match.index! + match[0].indexOf(match[1], match[0].indexOf('('));
    const tail = code.indexOf('CBUFFER_END', start);
    add(match[1], 'cbuffer', start, tail < 0 ? source.length : tail + 11, 'CBUFFER_START(' + match[1] + ')');
  }
  for (const match of code.matchAll(/\b(_[A-Za-z_]\w*)\s*\(([^\r\n]*?)\)\s*=/g)) {
    add(match[1], 'property', match.index!, match.index! + match[0].length, source.slice(match.index!, match.index! + match[0].length).trim());
  }

  // A return type plus a matched parameter list distinguishes declarations from calls.
  for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1];
    const start = match.index!;
    const prefix = code.slice(Math.max(0, start - 256), start);
    const returnMatch = /\b([A-Za-z_]\w*(?:\s*<[^;{}\r\n]*>)?)\s+$/.exec(prefix);
    if (!returnMatch || invalidTypes.has(returnMatch[1]) || invalidTypes.has(name)) { continue; }
    const opening = start + match[0].lastIndexOf('(');
    const closing = parentheses.get(opening);
    if (closing === undefined || closing === source.length) { continue; }
    const tail = /^\s*(?::\s*[A-Za-z_]\w*(?:\s*\([^)]*\))?)?\s*([;{])/.exec(code.slice(closing + 1));
    if (!tail) { continue; }
    const isPrototype = tail[1] === ';';
    const bodyStart = closing + 1 + tail[0].lastIndexOf(tail[1]);
    const end = isPrototype ? bodyStart + 1 : Math.min(source.length, (braces.get(bodyStart) ?? source.length) + 1);
    const parameterText = code.slice(opening + 1, closing);
    const parameters = splitParameters(parameterText).map((part) => {
      const declaration = /\b(?:(?:inout|in|out|const|uniform|precise|linear|centroid|nointerpolation|sample)\s+)*([A-Za-z_]\w*(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)/.exec(part.text);
      return declaration ? { name: declaration[2], typeName: declaration[1], label: part.text.trim(), start: opening + 1 + part.offset + declaration.index + declaration[0].lastIndexOf(declaration[2]) } : undefined;
    }).filter((item): item is NonNullable<typeof item> => item !== undefined);
    const detail = returnMatch[1] + ' ' + name + '(' + parameterText.trim().replace(/\s+/g, ' ') + ')';
    const symbol = add(name, 'function', start, end, detail, { typeName: returnMatch[1], parameters, isPrototype });
    parameterRanges.push({ start: opening, end: closing });
    if (!isPrototype) {
      functions.push({ body: { start: bodyStart, end }, symbol });
      for (const parameter of parameters) {
        add(parameter.name, 'variable', parameter.start, parameter.start + parameter.name.length, parameter.label, { typeName: parameter.typeName, scope: { start: opening, end }, containerName: name, isParameter: true });
      }
    }
  }

  for (const match of code.matchAll(/\b(?:(?:static|const|uniform|volatile|precise|row_major|column_major|inout|in|out|groupshared)\s+)*([A-Za-z_]\w*(?:\s*<[^;{}\r\n>]+>)?)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?=[:=;,)]|$)/g)) {
    const typeName = match[1];
    const start = match.index! + match[0].indexOf(match[2], match[0].indexOf(typeName) + typeName.length);
    if (invalidTypes.has(typeName) || occupied.has(start) || parameterRanges.some((range) => start > range.start && start < range.end)) { continue; }
    const containingFunction = functions.find((item) => start > item.body.start && start < item.body.end);
    const aggregate = aggregates.find((item) => start > item.body.start && start < item.body.end);
    let scope: TextRange | undefined;
    if (containingFunction) {
      const enclosing = [...braces.entries()].filter(([open, close]) => open < start && close >= start).sort((a, b) => b[0] - a[0])[0];
      scope = { start: enclosing?.[0] ?? containingFunction.body.start, end: Math.min(source.length, (enclosing?.[1] ?? containingFunction.body.end) + 1) };
    }
    add(match[2], 'variable', start, start + match[2].length, typeName + ' ' + match[2], { typeName, scope, containerName: containingFunction?.symbol.name ?? aggregate?.name, isMember: aggregate?.kind === 'struct' && !containingFunction, isReadonly: /\bconst\b/.test(match[0].slice(0, match[0].indexOf(typeName))) });
  }
  symbols.sort((left, right) => left.selectionRange.start - right.selectionRange.start);
  return { symbols, includes: parseIncludes(source, sanitized), code: sanitized };
}

export function findIdentifierOccurrences(source: string, name: string): TextRange[] {
  if (!/^[A-Za-z_]\w*$/.test(name)) { return []; }
  return [...sanitizeSource(source).matchAll(new RegExp('\\b' + name + '\\b', 'g'))].map((match) => ({ start: match.index!, end: match.index! + name.length }));
}

export function identifierAt(source: string, offset: number): TextRange | undefined {
  if (offset < 0 || offset > source.length) { return undefined; }
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) { start--; }
  while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) { end++; }
  return start === end || !/^[A-Za-z_]\w*$/.test(source.slice(start, end)) ? undefined : { start, end };
}

/** Find the active call, ignoring commas in nested calls, indexing and constructors. */
export function callAt(code: string, offset: number): { name: string; parameter: number } | undefined {
  let depth = 0;
  let parameter = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (')]'.includes(code[i])) { depth++; }
    else if ('(['.includes(code[i])) {
      if (depth > 0) { depth--; }
      else if (code[i] === '(') {
        const match = /([A-Za-z_]\w*)\s*$/.exec(code.slice(0, i));
        return match ? { name: match[1], parameter } : undefined;
      }
    } else if (code[i] === ',' && depth === 0) { parameter++; }
    else if (';{}'.includes(code[i]) && depth === 0) { return undefined; }
  }
  return undefined;
}

export function positionToOffset(source: string, line: number, character: number): number {
  let offset = 0;
  for (let n = 0; n < line; n++) {
    const next = source.indexOf('\n', offset);
    if (next < 0) { return source.length; }
    offset = next + 1;
  }
  const lineEnd = source.indexOf('\n', offset);
  return Math.min(lineEnd < 0 ? source.length : lineEnd, offset + character);
}

export function offsetToPosition(source: string, offset: number): { line: number; character: number } {
  const bounded = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let start = 0;
  for (let i = 0; i < bounded; i++) { if (source[i] === '\n') { line++; start = i + 1; } }
  return { line, character: bounded - start };
}
