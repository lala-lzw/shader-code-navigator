const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {Registry, parseRawGrammar} = require('vscode-textmate');
const {loadWASM, OnigScanner, OnigString} = require('vscode-oniguruma');

(async () => {
  await loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
  const registry = new Registry({
    onigLib: Promise.resolve({createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text)}),
    loadGrammar: async scope => {
      const file = path.join(__dirname, '../syntaxes/', scope === 'source.hlsl' ? 'hlsl.tmLanguage.json' : 'shaderlab.tmLanguage.json');
      return parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
    }
  });
  for (const language of ['source.shaderlab', 'source.hlsl']) {
    const grammar = await registry.loadGrammar(language);
    const check = (line, needle, scope) => {
      const result = grammar.tokenizeLine(line);
      const offset = line.indexOf(needle);
      assert.ok(offset >= 0);
      const token = result.tokens.find(item => item.startIndex <= offset && item.endIndex > offset);
      assert.ok(token.scopes.some(value => value.startsWith(scope)), language + ': ' + needle + ' has wrong scopes: ' + token.scopes.join(', '));
      return token;
    };
    check('if (weight > 0) Shade(input);', 'if', 'keyword.control');
    check('if (weight > 0) Shade(input);', 'Shade', 'entity.name.function');
    check('float4x4 Transform;', 'float4x4', 'storage.type');
    check('float4x4 Transform;', 'Transform', 'variable.other');
    check('Texture2D<float4> tex;', 'Texture2D', 'support.type');
    check('return normalize(input.normal);', 'normalize', 'entity.name.function');
    check('#define SCALE(value) ((value) * 2)', 'SCALE', 'entity.name.function.preprocessor');
    check('#include <Common.hlsl>', 'Common', 'string.quoted.other.include');
    check('float3 normal : NORMAL;', 'NORMAL', 'entity.name.label');
    check('// if (foo) Shade()', 'Shade', 'comment.line');
    check('Shader "Shade()"', 'Shade()', 'string.quoted');
    check('float n = 1.2e-3f;', '1.2e-3f', 'constant.numeric');
    let state = grammar.tokenizeLine('/* Shade()').ruleStack;
    const comment = grammar.tokenizeLine('float4 value; */', state);
    assert.ok(comment.tokens[0].scopes.some(scope => scope.startsWith('comment.block')));
  }
  registry.dispose();
  console.log('ShaderLab/HLSL TextMate grammar tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
