/** Portable HLSL intrinsics. Generic types describe overload families, not compiler type checking. */
export const intrinsics: Record<string, string[]> = {
  abs: ['T abs(T value)'], acos: ['T acos(T value)'], asin: ['T asin(T value)'], atan: ['T atan(T value)'],
  atan2: ['T atan2(T y, T x)'], all: ['bool all(T value)'], any: ['bool any(T value)'],
  ceil: ['T ceil(T value)'], clamp: ['T clamp(T value, T minimum, T maximum)'], clip: ['void clip(T value)'],
  cos: ['T cos(T value)'], sin: ['T sin(T value)'], tan: ['T tan(T value)'],
  cross: ['float3 cross(float3 a, float3 b)'], dot: ['float dot(T a, T b)'],
  ddx: ['T ddx(T value)'], ddy: ['T ddy(T value)'], fwidth: ['T fwidth(T value)'],
  determinant: ['float determinant(matrix value)'], distance: ['float distance(T a, T b)'],
  exp: ['T exp(T value)'], exp2: ['T exp2(T value)'], floor: ['T floor(T value)'], frac: ['T frac(T value)'],
  lerp: ['T lerp(T a, T b, T t)'], length: ['float length(T value)'],
  log: ['T log(T value)'], log2: ['T log2(T value)'], max: ['T max(T a, T b)'], min: ['T min(T a, T b)'],
  mul: ['T mul(T a, T b)'], normalize: ['T normalize(T value)'], pow: ['T pow(T value, T exponent)'],
  rcp: ['T rcp(T value)'], reflect: ['T reflect(T incident, T normal)'], refract: ['T refract(T incident, T normal, float eta)'],
  round: ['T round(T value)'], rsqrt: ['T rsqrt(T value)'], saturate: ['T saturate(T value)'], sign: ['T sign(T value)'],
  smoothstep: ['T smoothstep(T minimum, T maximum, T value)'], sqrt: ['T sqrt(T value)'], step: ['T step(T edge, T value)'],
  transpose: ['matrix transpose(matrix value)'], sincos: ['void sincos(T value, out T sine, out T cosine)'],
  tex2D: ['float4 tex2D(sampler2D texture, float2 uv)'], tex2Dlod: ['float4 tex2Dlod(sampler2D texture, float4 uvLod)'],
  tex2Dproj: ['float4 tex2Dproj(sampler2D texture, float4 uv)'], tex3D: ['float4 tex3D(sampler3D texture, float3 uv)'],
  asfloat: ['float asfloat(uint value)'], asuint: ['uint asuint(float value)'], asint: ['int asint(float value)'],
  fmod: ['T fmod(T a, T b)'], trunc: ['T trunc(T value)'], isfinite: ['bool isfinite(T value)'], isnan: ['bool isnan(T value)'],
  InterlockedAdd: ['void InterlockedAdd(inout uint destination, uint value, out uint original)'],
  GroupMemoryBarrierWithGroupSync: ['void GroupMemoryBarrierWithGroupSync()']
};

export const keywords = ['void', 'struct', 'cbuffer', 'return', 'if', 'else', 'for', 'while', 'switch', 'static', 'const', 'uniform', 'in', 'out', 'inout', 'groupshared',
  'CBUFFER_START', 'CBUFFER_END', 'HLSLPROGRAM', 'HLSLINCLUDE', 'ENDHLSL', 'CGPROGRAM', 'CGINCLUDE', 'ENDCG', 'Pass', 'SubShader', 'Properties', 'Fallback', 'Shader', 'Tags', 'Blend', 'BlendOp', 'Cull', 'ZTest', 'ZWrite', 'Stencil',
  'SamplerState', 'SamplerComparisonState', 'sampler2D', 'samplerCUBE', 'Texture2D', 'Texture3D', 'TextureCube', 'Texture2DArray', 'StructuredBuffer', 'ByteAddressBuffer', 'RWTexture2D', 'RWStructuredBuffer',
  ...['bool', 'double', 'float', 'half', 'fixed', 'int', 'uint', 'min16float'].flatMap((type) => [type, ...[2, 3, 4].flatMap((size) => [type + size, ...[2, 3, 4].map((columns) => type + size + 'x' + columns)])])];
