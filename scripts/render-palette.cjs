const fs = require('fs');
const path = require('path');
const {classifyShader, colorCategories} = require('../out/highlighting');
const {parseShaderDocument} = require('../out/parser');

const source = `#include "Lighting.hlsl"
#define FOG_DENSITY 0.02

struct SurfaceInput
{
    float3 normalWS : NORMAL;
    float3 viewWS;
};

float3 EvaluateLighting(SurfaceInput input, float intensity)
{
    // Functions stay green; control flow stays purple.
    const float exposure = 1.25;
    float3 normal = normalize(input.normalWS);
    if (intensity > 0.0)
        return saturate(normal * intensity * exposure);
    return float3(FOG_DENSITY, 0.0, 0.0);
}`;
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tokens = classifyShader(source, parseShaderDocument(source));
const width = 960, lineHeight = 25, top = 96;
let offset = 0;
const rows = source.split('\n').map((line, i) => {
  const spans = [];
  let cursor = offset;
  for (const token of tokens.filter(token => token.start < offset + line.length && token.end > offset)) {
    const start = Math.max(token.start, offset), end = Math.min(token.end, offset + line.length);
    if (start > cursor) { spans.push(escape(source.slice(cursor, start))); }
    spans.push('<tspan fill="' + colorCategories[token.category].dark + '">' + escape(source.slice(start, end)) + '</tspan>');
    cursor = end;
  }
  spans.push(escape(source.slice(cursor, offset + line.length)));
  offset += line.length + 1;
  return '<text x="36" y="'+(top+i*lineHeight)+'" text-anchor="end" fill="#858585">'+(i+1)+'</text><text x="58" y="'+(top+i*lineHeight)+'" fill="#D4D4D4" xml:space="preserve">'+spans.join('')+'</text>';
});
const height = top + rows.length * lineHeight + 20;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Shader C# inspired palette: green functions, teal types, blue variables, purple control flow">\n' +
  '<rect width="100%" height="100%" rx="10" fill="#1E1E1E"/><path d="M10 0h940a10 10 0 0 1 10 10v35H0V10A10 10 0 0 1 10 0" fill="#252526"/>' +
  '<g font-family="Consolas, Menlo, monospace" font-size="15"><text x="24" y="28" fill="#D4D4D4">Lighting.hlsl - Shader Code Navigator</text>' +
  '<text x="24" y="66" fill="#8FCD8F">FUNCTION</text><text x="145" y="66" fill="#4EC9B0">TYPE</text><text x="226" y="66" fill="#9CDCFE">VARIABLE</text><text x="345" y="66" fill="#C586C0">CONTROL FLOW</text><text x="510" y="66" fill="#C8A2C8">MACRO</text><text x="620" y="66" fill="#CE9178">STRING</text>' + rows.join('\n')+'</g></svg>\n';
fs.mkdirSync(path.resolve(__dirname, '../docs'), {recursive:true});
fs.writeFileSync(path.resolve(__dirname, '../docs/highlighting.svg'), svg);
console.log('Generated docs/highlighting.svg from the semantic palette.');
