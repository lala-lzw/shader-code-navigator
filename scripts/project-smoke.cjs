const fs = require('fs');
const path = require('path');
const os = require('os');
const {runTests} = require('@vscode/test-electron');
(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-project-smoke-'));
  const extensions = path.join(base, 'extensions');
  const stub = path.join(extensions,'test.unity-language-1.0.0');
  fs.mkdirSync(stub,{recursive:true});
  fs.writeFileSync(path.join(stub,'package.json'),JSON.stringify({name:'unity-language',publisher:'test',version:'1.0.0',engines:{vscode:'^1.85.0'},contributes:{languages:[{id:'UnityShader',extensions:['.hlsl','.shader','.cginc','.compute']}]}}));
  await runTests({
    vscodeExecutablePath:process.env.SHADER_TEST_CODE_EXE,
    extensionDevelopmentPath:path.resolve(__dirname,'..'),
    extensionTestsPath:path.resolve(__dirname,'../out/test/projectSmoke.js'),
    extensionTestsEnv:{SHADER_TEST_REAL_FILE:process.env.SHADER_TEST_REAL_FILE},
    launchArgs:[process.env.SHADER_TEST_PROJECT_ROOT,'--user-data-dir='+path.join(base,'profile'),'--extensions-dir='+extensions,'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--no-sandbox']
  });
})().catch(error=>{console.error(error);process.exitCode=1;});
