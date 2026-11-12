const fs = require('fs');
const path = require('path');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  // The VS Code terminal/CLI can inherit Electron's Node-only launch mode.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-navigator-'));
  const workspace = path.join(base, 'workspace');
  const shared = path.join(base, 'shared');
  const testLanguage = process.env.SHADER_TEST_LANGUAGE || 'shaderlab';
  const extensions = path.join(base, 'extensions');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'shaderNavigator.includePaths': ['../shared'], 'files.autoSave': 'off', 'files.associations': { '*.shader': testLanguage, '*.hlsl': testLanguage === 'UnityShader' ? testLanguage : 'hlsl' } }));
  if (testLanguage === 'UnityShader') {
    const stub = path.join(extensions, 'test.unity-language-1.0.0');
    fs.mkdirSync(stub, {recursive:true});
    fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({name:'unity-language',publisher:'test',version:'1.0.0',engines:{vscode:'^1.85.0'},contributes:{languages:[{id:'UnityShader',extensions:['.shader','.hlsl','.cginc','.compute']}]}}));
  }
  fs.writeFileSync(path.join(workspace, 'Common.hlsl'), '#include "Cycle.hlsl"\n#define SCALE 2\nstruct Input { float3 normal : NORMAL; float2 uv; };\ncbuffer Globals { float4 _Tint; };\nfloat4 Evaluate(Input value, float strength) { return float4(value.normal * strength, 1); }\nfloat4 Evaluate(float3 value) { return float4(value, 1); }\n');
  fs.writeFileSync(path.join(workspace, 'Cycle.hlsl'), '#include "Common.hlsl"\n');
  fs.writeFileSync(path.join(shared, 'External.hlsli'), 'float ExternalFactor(float input) { return input * 2; }\n');
  fs.writeFileSync(path.join(workspace, 'Unrelated.hlsl'), 'float4 Evaluate(float unused) { return unused; }\nfloat UnrelatedHelper() { return 0; }');
  fs.writeFileSync(path.join(workspace, 'Main.shader'), 'Shader "Sample/Portable" {\nSubShader { Pass { HLSLPROGRAM\n#include "/Common.hlsl"\n#include_with_pragmas "External.hlsli"\nCBUFFER_START(UnityPerMaterial)\nfloat4 _Color;\nCBUFFER_END\nfloat4 Fragment(Input input) : SV_Target {\n    float strength = SCALE;\n    float4 color = Evaluate(input, strength);\n    color += _Tint + _Color;\n    float3 normal = input.normal;\n    float nested = ExternalFactor(max(1, 2));\n    // Evaluate(input, strength)\n    return color;\n}\nENDHLSL\n} } }\n');
  const options = {
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, '../out/test/integration.js'),
    vscodeExecutablePath: process.env.SHADER_TEST_CODE_EXE,
    launchArgs: [workspace, '--user-data-dir=' + path.join(base, 'profile'), '--extensions-dir=' + extensions, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox'],
    extensionTestsEnv: { SHADER_TEST_WORKSPACE: workspace, SHADER_TEST_LANGUAGE: testLanguage }
  };
  console.log('Isolated VS Code test workspace: ' + workspace);
  await runTests(options);
})().catch((error) => { console.error(error); process.exitCode = 1; });
