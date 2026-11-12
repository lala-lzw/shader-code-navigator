import * as assert from 'assert';
import { findIdentifierOccurrences, identifierAt, parseShaderDocument } from '../parser';

const source = `// #include "ignored.hlsl"
#include "Common/Lighting.hlsl"
#include <Packages/com.example/Runtime.hlsl>

Shader "Example/Test" {
    Properties { _Color ("Color", Color) = (1, 1, 1, 1) }
    HLSLPROGRAM
    #define USE_FOG 1
    struct Attributes { float3 position : POSITION; };
    CBUFFER_START(UnityPerMaterial)
        float4 _Color;
    CBUFFER_END
    float4 Evaluate(float3 position) : SV_Target {
        return float4(position, 1);
    }
    ENDHLSL
}
`;

const parsed = parseShaderDocument(source);
assert.deepStrictEqual(parsed.includes.map((include) => include.path), [
  'Common/Lighting.hlsl',
  'Packages/com.example/Runtime.hlsl'
]);
assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Example/Test' && symbol.kind === 'shader'));
assert.ok(parsed.symbols.some((symbol) => symbol.name === 'USE_FOG' && symbol.kind === 'macro'));
assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Attributes' && symbol.kind === 'struct'));
assert.ok(parsed.symbols.some((symbol) => symbol.name === '_Color' && symbol.kind === 'property'));
assert.ok(parsed.symbols.some((symbol) => symbol.name === 'Evaluate' && symbol.kind === 'function'));
assert.ok(identifierAt('float4 Evaluate(float3 value)', 10));
assert.strictEqual(identifierAt('float4 Evaluate(float3 value)', 0)?.start, 0);
assert.strictEqual(findIdentifierOccurrences('// Evaluate\nEvaluate(value);\n"Evaluate"', 'Evaluate').length, 1);
console.log('Shader parser tests passed.');
