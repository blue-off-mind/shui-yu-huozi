// 生成式占位画面：在没有真实图片 / 视频时，代替作品出现在活字里。
// 每段程序实现 vec3 work(vec2 uv, float t, float aspect)，uv ∈ [0,1]²。

const common = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
    return s;
  }
`

export const programs = {
  // 潮汐：墨与水的交缠
  ink: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.2;
      vec2 q = vec2(fbm(p + vec2(0.0, t * 0.05)), fbm(p + vec2(5.2, 1.3) - t * 0.04));
      vec2 r = vec2(fbm(p + 3.2 * q + vec2(1.7, 9.2) + t * 0.07), fbm(p + 3.2 * q + vec2(8.3, 2.8) - t * 0.06));
      float f = fbm(p + 3.0 * r);
      vec3 deep = vec3(0.02, 0.07, 0.10);
      vec3 tide = vec3(0.09, 0.33, 0.42);
      vec3 foam = vec3(0.86, 0.92, 0.90);
      vec3 col = mix(deep, tide, smoothstep(0.25, 0.75, f));
      col = mix(col, foam, smoothstep(0.55, 0.95, f * length(r) * 1.3));
      return col * (0.8 + 0.35 * q.x);
    }
  `,

  // 一束光分开又合上
  light: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float open = 0.5 - 0.5 * cos(t * 0.32);
      float sep = 0.3 * open;
      float w = mix(0.11, 0.06, open);
      float fall = smoothstep(-0.65, 0.55, p.y);
      float b = exp(-pow((p.x - sep) / w, 2.0)) + exp(-pow((p.x + sep) / w, 2.0));
      b *= mix(0.45, 1.0, fall) * mix(1.0, 0.7, open);
      vec2 g = p * vec2(26.0, 26.0) + vec2(0.0, t * 0.6);
      vec2 id = floor(g);
      vec2 h = hash22(id);
      float dust = smoothstep(0.08, 0.0, length(fract(g) - 0.5 - (h - 0.5) * 0.6)) * step(0.82, h.x);
      dust *= 0.5 + 0.5 * sin(t * 1.7 + h.y * 30.0);
      float pool = exp(-pow(p.y + 0.42, 2.0) * 40.0) * exp(-p.x * p.x * 3.0);
      vec3 warm = vec3(1.0, 0.78, 0.46);
      vec3 col = vec3(0.025, 0.02, 0.018) + warm * (b * 0.85 + pool * 0.35) + warm * dust * b * 1.2;
      return col + vec3(0.02, 0.012, 0.0) * fbm(p * 3.0 + t * 0.1);
    }
  `,

  // 把温度画成颜色
  dream: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 1.7;
      float n1 = fbm(p * 1.1 + vec2(t * 0.05, -t * 0.04));
      float n2 = fbm(p * 1.6 - vec2(t * 0.03, t * 0.05) + n1 * 2.2);
      vec3 a = vec3(0.62, 0.52, 0.66), b = vec3(0.32, 0.28, 0.30), d = vec3(0.05, 0.22, 0.42);
      vec3 col = a + b * cos(6.28318 * (n2 * 1.3 + t * 0.025 + d));
      col *= 0.45 + 0.7 * smoothstep(0.2, 0.85, n2);
      return col;
    }
  `,

  // 风走过的路：流动的等值线
  wind: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
      float f = fbm(p * 0.9 + vec2(t * 0.05, 0.0)) + 0.35 * fbm(p * 2.2 - vec2(0.0, t * 0.04));
      float k = f * 16.0 + t * 0.12;
      float d = abs(fract(k) - 0.5);
      float w = fwidth(k);
      float line = 1.0 - smoothstep(0.0, w * 1.6, d - 0.02);
      vec3 bg = mix(vec3(0.03, 0.06, 0.05), vec3(0.06, 0.1, 0.08), uv.y);
      vec3 ink = vec3(0.62, 0.84, 0.70);
      return bg + ink * line * (0.25 + 0.75 * smoothstep(0.35, 0.8, f));
    }
  `,

  // 深夜书店的灯
  lantern: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      vec3 col = mix(vec3(0.015, 0.02, 0.04), vec3(0.04, 0.035, 0.06), uv.y);
      for (int layer = 0; layer < 3; layer++) {
        float fl = float(layer);
        float scale = 3.5 + fl * 2.5;
        vec2 g = p * scale + vec2(fl * 7.3, -t * (0.04 + 0.02 * fl));
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j));
          vec2 h = hash22(id + o + fl * 13.1);
          if (h.x < 0.45) continue;
          vec2 c = o + (h - 0.5) * 0.7;
          float r = 0.16 + 0.22 * hash12(id + o + 3.1);
          float dd = length(f - c);
          float tw = 0.55 + 0.45 * sin(t * (0.6 + h.y * 1.4) + h.x * 40.0);
          float disc = smoothstep(r, r * 0.82, dd) + 0.25 * smoothstep(r * 1.6, r, dd);
          vec3 tint = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.82, 0.55), h.y);
          col += tint * disc * tw * (0.42 - fl * 0.1);
        }
      }
      return col;
    }
  `,

  // 层层开合的花
  bloom: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float a = atan(p.y, p.x);
      float r = length(p);
      vec3 col = mix(vec3(0.07, 0.09, 0.08), vec3(0.13, 0.15, 0.12), uv.y);
      col += vec3(0.05, 0.03, 0.03) * exp(-r * 4.0);
      for (int k = 3; k >= 0; k--) {
        float fk = float(k);
        float petals = 5.0 + mod(fk, 2.0);
        float rot = t * (0.06 + fk * 0.025) * (mod(fk, 2.0) * 2.0 - 1.0) + fk;
        float open = 0.5 + 0.5 * sin(t * 0.35 + fk * 0.9);
        float R = (0.09 + 0.065 * fk) * (0.85 + 0.25 * open) * (0.62 + 0.38 * abs(cos(petals * 0.5 * (a + rot))));
        float m = smoothstep(R, R - 0.006 - 0.012 * fk, r);
        vec3 c = mix(vec3(0.95, 0.88, 0.88), vec3(0.86, 0.32, 0.42), fk / 3.0);
        col = mix(col, c * (0.65 + 0.45 * (1.0 - r / max(R, 1e-3))), m * (0.85 - fk * 0.12));
      }
      return col;
    }
  `,

  // 一年的月相
  moon: /* glsl */ `
    vec3 work(vec2 uv, float t, float aspect) {
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float R = 0.27;
      vec2 q = p / R;
      float d = length(q);
      vec3 n = vec3(q, sqrt(max(0.0, 1.0 - d * d)));
      float ph = t * 0.22;
      float lit = smoothstep(-0.04, 0.06, dot(n, vec3(sin(ph), 0.0, -cos(ph))));
      float maria = fbm(q * 2.6 + 4.0);
      vec3 surface = mix(vec3(0.5, 0.55, 0.62), vec3(0.94, 0.95, 0.97), smoothstep(0.35, 0.7, maria));
      vec3 moon = surface * lit + vec3(0.03, 0.04, 0.06) * (1.0 - lit);
      float disc = smoothstep(1.0, 0.985, d);
      vec3 sky = mix(vec3(0.008, 0.015, 0.04), vec3(0.035, 0.06, 0.11), uv.y);
      sky += vec3(0.12, 0.15, 0.2) * exp(-max(d - 1.0, 0.0) * 5.0) * 0.35 * (0.3 + 0.7 * (0.5 - 0.5 * cos(ph)));
      vec3 col = mix(sky, moon, disc);
      float cloud = smoothstep(0.5, 0.85, fbm(p * vec2(2.5, 6.0) + vec2(t * 0.03, 0.0)));
      return mix(col, vec3(0.5, 0.55, 0.62) * 0.5, cloud * 0.45);
    }
  `,
}

export function generativeFragment(id) {
  const body = programs[id] || programs.ink
  return /* glsl */ `
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;
    ${common}
    ${body}
    void main() {
      gl_FragColor = vec4(work(vUv, uTime, uResolution.x / uResolution.y), 1.0);
    }
  `
}
