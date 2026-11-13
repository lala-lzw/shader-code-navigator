import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { classifyShader, colorCategories, colorTokenType } from '../highlighting';
import { parseShaderDocument } from '../parser';

const library = parseShaderDocument('struct Input { float3 normal; };\nfloat3 Illuminate(Input value) { return value.normal; }\n#define USE_FOG 1');
const source = `#include <Common.hlsl>
#define SCALE(value) ((value) * 2)
struct Vertex { float3 position : POSITION; };
float4 Shade(Input input, float weight) : SV_Target {
    const float factor = 1.5e-2f;
    float UPPER_VALUE = weight;
    float3 color = Illuminate(input) * factor;
    if (weight > 0) { color = normalize(input.normal); }
    for (int i = 0; i < 2; i++) { color += i; }
    // Illuminate(input), if(weight), SCALE(1) must stay a comment.
    /* Shade(input)
       float4 fake = 1; */
    return float4(color, SCALE(UPPER_VALUE));
}
Shader "Sample/Illuminate()" { }
`;
const parsed = parseShaderDocument(source);
const tokens = classifyShader(source, parsed, library.symbols);
const tokenAt = (needle: string, after = 0) => {
  const offset = source.indexOf(needle) + after;
  assert.ok(offset >= 0, 'Test marker exists: ' + needle);
  const token = tokens.find((value) => value.start <= offset && value.end > offset);
  assert.ok(token, 'Classified token at ' + needle);
  return token;
};
assert.strictEqual(tokenAt('Shade(Input').category, 'function');
assert.ok(tokenAt('Shade(Input').modifiers.includes('declaration'));
assert.strictEqual(tokenAt('Illuminate(input)').category, 'function');
assert.strictEqual(tokenAt('normalize(').category, 'function');
assert.ok(tokenAt('normalize(').modifiers.includes('defaultLibrary'));
assert.strictEqual(tokenAt('if (').category, 'control');
assert.strictEqual(tokenAt('for (').category, 'control');
assert.strictEqual(tokenAt('return float4').category, 'control');
assert.strictEqual(tokenAt('float4(color').category, 'builtinType');
assert.strictEqual(tokenAt('Input input').category, 'type');
assert.strictEqual(tokenAt('Vertex {').category, 'type');
assert.strictEqual(tokenAt('input.normal').category, 'parameter');
assert.strictEqual(tokenAt('input.normal', 6).category, 'property');
assert.strictEqual(tokenAt('color = normalize').category, 'variable');
assert.strictEqual(tokenAt('factor;').category, 'constant');
assert.strictEqual(tokenAt('UPPER_VALUE =').category, 'variable', 'Uppercase variables are not macros');
assert.strictEqual(tokenAt('SCALE(UPPER').category, 'macro');
assert.strictEqual(tokenAt('1.5e-2f').category, 'number');
assert.strictEqual(tokenAt('POSITION').category, 'semantic');
assert.strictEqual(tokenAt('SV_Target').category, 'semantic');
assert.strictEqual(tokenAt('#include').category, 'directive');
assert.strictEqual(tokenAt('Common.hlsl').category, 'string');
assert.strictEqual(tokenAt('// Illuminate', 4).category, 'comment');
assert.strictEqual(tokenAt('float4 fake').category, 'comment');
assert.strictEqual(tokenAt('Sample/Illuminate').category, 'string');
for (let i = 1; i < tokens.length; i++) { assert.ok(tokens[i].start >= tokens[i - 1].end, 'No overlapping tokens'); }

const crlf = '// 中文 😀\r\nfloat4 Shade() { return 1; }';
const crlfTokens = classifyShader(crlf, parseShaderDocument(crlf));
assert.strictEqual(crlfTokens.find((token) => token.category === 'function')?.start, crlf.indexOf('Shade'));

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
for (const category of Object.keys(colorCategories) as (keyof typeof colorCategories)[]) {
  for (const light of [false, true]) {
    const id = colorTokenType(category, light);
    assert.ok(manifest.contributes.semanticTokenTypes.some((definition: { id: string }) => definition.id === id));
    assert.strictEqual(manifest.contributes.configurationDefaults['editor.semanticTokenColorCustomizations'].rules[id].foreground, colorCategories[category][light ? 'light' : 'dark']);
  }
}
console.log('Shader semantic classification and dark/light palette tests passed.');
