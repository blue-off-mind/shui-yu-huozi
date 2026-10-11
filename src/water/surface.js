import * as THREE from 'three'

// 水面光照：背景和每个活字都在自己的着色器里算同一份水面高光，
// 不再单独画一遍全屏的水面层。
//
// 为什么等价：水面层原本是 结果 = 底色 × mul + add。
// 活字用 alpha 混合画在背景上：(字×mul+add)·a + (底×mul+add)·(1−a) = (字·a + 底·(1−a))×mul + add，
// 和“先叠活字、再盖一层水面”完全一样，却省掉一整遍全屏绘制。

// 所有材质共用同一组 uniform 对象：每帧改一次，处处生效
export const surfaceUniforms = {
  uWater: { value: null },
  uWaterTexel: { value: new THREE.Vector2(1, 1) },
  uSlope: { value: 1.6 },
  uGlint: { value: 1 },
  uGrainSeed: { value: 0 },
  uGrainAmount: { value: 0.16 },
}

export const surfaceGLSL = /* glsl */ `
  uniform sampler2D uWater;
  uniform vec2 uWaterTexel;
  uniform float uSlope;
  uniform float uGlint;
  uniform float uGrainSeed;
  uniform float uGrainAmount;

  // 高度场的梯度 (xy) 与拉普拉斯 (z)
  vec3 waterAt(vec2 uv) {
    float h  = texture(uWater, uv).r;
    float hL = texture(uWater, uv - vec2(uWaterTexel.x, 0.0)).r;
    float hR = texture(uWater, uv + vec2(uWaterTexel.x, 0.0)).r;
    float hD = texture(uWater, uv - vec2(0.0, uWaterTexel.y)).r;
    float hU = texture(uWater, uv + vec2(0.0, uWaterTexel.y)).r;
    return vec3((hR - hL) * 0.5, (hU - hD) * 0.5, hL + hR + hD + hU - 4.0 * h);
  }

  // 波纹的明暗 + 反射天光里那条白线（与开场的白线是同一束光）
  vec3 surfaceLight(vec3 col, vec2 grad) {
    vec2 g = grad * uSlope;
    // 坡度设上限：浪再大，明暗也不会走到全黑或全白
    float gl = length(g);
    if (gl > 0.5) g *= 0.5 / gl;
    vec3 n = normalize(vec3(-g, 1.0));
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
    vec2 sun = vec2(-0.16, 0.22);
    vec2 m = r.xy - sun;
    // 减去平静水面时的基准，水面不动时保持原样
    float sky = max(exp(-dot(m, m) / 0.045) - exp(-dot(sun, sun) / 0.045), 0.0);
    float line = exp(-pow((r.y - 0.15) / 0.03, 2.0)) * smoothstep(0.9, 0.1, abs(r.x + 0.05));
    vec3 L = normalize(vec3(-0.4, 0.55, 1.0));
    float shade = dot(n, L) - L.z;
    vec3 add = vec3(0.93, 0.94, 0.96) * line * 0.26 * uGlint
             + vec3(0.62, 0.68, 0.74) * sky * 0.11 * uGlint
             + vec3(0.62, 0.68, 0.74) * max(shade, 0.0) * 1.4;
    float mul = clamp(1.0 + min(shade, 0.0) * 3.0, 0.45, 1.0);
    return col * mul + add;
  }

  // 胶片颗粒：按亮度成比例，纯黑保持纯黑
  vec3 filmGrain(vec3 col) {
    vec3 p3 = fract(vec3(gl_FragCoord.xy + uGrainSeed * vec2(37.0, 17.0), uGrainSeed) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    float n = fract((p3.x + p3.y) * p3.z) - 0.5;
    return col + col * n * uGrainAmount;
  }
`
