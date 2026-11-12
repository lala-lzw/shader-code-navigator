# Shader Code Navigator

独立的 VS Code ShaderLab / HLSL 语言辅助扩展。可用于任意文件夹，无 Unity 项目程序集或业务代码依赖。

Standalone ShaderLab / HLSL navigation and completion for Visual Studio Code. Compatible with the Unity extension's `UnityShader` language mode.

## 安装与使用

从 [GitHub Releases](https://github.com/lala-lzw/shader-code-navigator/releases/latest) 下载 `.vsix` 安装包。在 VS Code 扩展面板的 `…` 菜单选择 **从 VSIX 安装**，选择下载的文件。安装后打开 Shader 文件；已打开的窗口若未生效，执行 **Developer: Reload Window**。

已安装 Unity 官方扩展时，文件保持 `UnityShader` 语言模式即可，无需禁用其它扩展或改动项目配置。

- 输入部分函数名、变量名或类型名会出现候选；`Ctrl+Space` 手动触发，`Tab` / `Enter` 选择。
- `Ctrl+单击` / `F12` 跳转 include、函数、宏、结构体、字段、参数、局部变量和材质属性定义。
- 输入 `(`、`,` 显示参数提示；`Ctrl+Shift+Space` 手动触发。支持常用 HLSL 内建函数及工作区函数签名。
- `input.` 提示结构体成员，向量的 `.` 提示 `xyzw` / `rgba` 分量组合。
- 鼠标悬停显示声明；`Shift+F12` 查找引用，`F2` 重命名可明确解析的符号（请在 VS Code 中预览修改）。
- `Ctrl+Shift+O` 查看当前文件符号，`Ctrl+T` 搜索工作区符号。
- 命令 **Shader Navigator: Rebuild Index** 重新扫描。

支持 `.shader`、`.shaderlab`、`.hlsl`、`.hlsli`、`.cginc`、`.compute`、`.inc`，包括语法高亮、括号配对、注释与折叠。文件编辑后实时更新，包括尚未保存的内容。

## include 路径

依次搜索：当前文件目录、打开的工作区根目录、配置的 include 目录，最后尝试工作区中唯一匹配的路径或文件名。支持递归 include、循环 include 和 `#include_with_pragmas`。补全和符号跳转按当前文件的 include 依赖链及局部作用域查找，避免其它 Shader 的同名函数混进候选。

在用户设置或任意工作区设置中配置；路径可以是绝对路径、相对工作区路径，或使用 `${workspaceFolder}`。工作区外的目录也会建立符号索引。

```json
{
  "shaderNavigator.includePaths": [
    "Shaders/Includes",
    "../SharedShaders"
  ]
}
```

Unity 内建 `CGIncludes`、额外 SDK 和工作区外的 Shader 库可通过该设置接入。不会写入固定 Unity 安装路径。外部目录文件在扩展中编辑时会更新，若由其它程序修改，请执行 Rebuild Index。

默认排除 `node_modules`、`Library`、`Temp`、`obj`、`bin`，可用 `shaderNavigator.exclude` 调整。扫描上限为 20000 个文件；状态栏数字后的 `+` 表示达到上限，可调整 `shaderNavigator.maxFiles`。

## 当前边界

这是基于源码索引的语言辅助工具，未连接 Shader 编译器。它不执行条件宏分支求值、宏展开或完整 HLSL 类型检查，不报告编译错误。函数重载会列出可见实现；复杂模板、宏生成声明、方法返回值推导、数组访问后的成员链，以及完整 C/C++ 作用域语义不在当前支持范围。引用和重命名依赖同一套索引规则，复杂宏和重载场景请人工确认。

## 开发与验证

Node.js 18 或以上版本：

1. `npm ci`
2. `npm test`：TypeScript 编译和解析测试。
3. `npm run test:integration`：在独立临时工作区启动真实 VS Code 扩展宿主测试。可通过环境变量 `SHADER_TEST_CODE_EXE` 指定已有的 `Code.exe`，未指定时测试工具会下载 VS Code。
4. `npm run vsix`：生成可安装包。

直接打开本目录并按 `F5` 可运行开发扩展。入口为 `src/extension.ts`，源码解析为 `src/parser.ts`，include 和作用域索引为 `src/workspaceIndex.ts`。

集成测试覆盖原生 ShaderLab 和 Unity 扩展的 `UnityShader` 模式，包括自动激活、include 和精确符号跳转、重载候选、局部变量/参数/结构体字段、cbuffer、补全、外部 include 库、内建函数签名、悬停、引用、重命名、文档符号、向量分量及未保存文本更新。

## 0.1.1 修复

兼容 Unity 官方扩展的 `UnityShader` 语言 ID 和其它扩展的文件关联；后台扫描前先注册语言服务；支持带前导 `/` 的虚拟根 include 路径。

执行 **Shader Navigator: Diagnose Active File**，可在 Output > Shader Code Navigator 查看激活状态、实际语言模式和 include 解析结果。

## 许可证

[MIT](LICENSE)。
