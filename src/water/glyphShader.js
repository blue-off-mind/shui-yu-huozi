import { surfaceGLSL } from './surface.js'

// 活字着色器。顶点在着色器里完成变换：位置、旋转、随水波起伏。
// 片元：距离场字形 + 作品填充 + 水面折射 / 焦散 + 点开时的墨晕扩散 + 水面高光。
// 只在需要时才做的计算（墨晕噪声、视频采样）都放在按 uniform 分支里，平时直接跳过。

export const glyphVert = /* glsl */ `
  uniform vec2 uCenter;      // 活字中心（水面坐标，CSS 像素，原点在画面中心，y 向上）
  uniform float uRotation;
  uniform vec2 uQuad;        // 面片半宽、半高（像素）
  uniform vec2 uViewport;
  uniform sampler2D uWater;
  uniform vec2 uWaterTexel;
  uniform float uBob;        // 随水波漂移的幅度

  varying vec2 vLocal;       // 活字自身坐标系里的像素位置（未旋转）
  varying vec2 vScreenUv;

  void main() {
    vec2 cuv = uCenter / uViewport + 0.5;
    float hL = texture(uWater, cuv - vec2(uWaterTexel.x, 0.0)).r;
    float hR = texture(uWater, cuv + vec2(uWaterTexel.x, 0.0)).r;
    float hD = texture(uWater, cuv - vec2(0.0, uWaterTexel.y)).r;
    float hU = texture(uWater, cuv + vec2(0.0, uWaterTexel.y)).r;
    vec2 grad = vec2(hR - hL, hU - hD);
    vec2 bob = -grad * uBob;

    vec2 local = position.xy * 2.0 * uQuad;
    float c = cos(uRotation), s = sin(uRotation);
    vec2 world = uCenter + bob + mat2(c, s, -s, c) * local;

    vLocal = local;
    vScreenUv = world / uViewport + 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 0.0, 1.0);
  }
`

export const glyphFrag = /* glsl */ `
  uniform sampler2D uSdf;
  uniform float uSdfTexSize;
  uniform float uSdfPad;
  uniform float uFineSpread;

  uniform float uEm;          // 当前字身大小（像素）
  uniform float uDepth;       // 0 = 贴近水面，1 = 最深
  uniform float uOpacity;
  uniform float uHover;
  uniform float uDim;         // 其他活字被点开时下沉变暗

  uniform sampler2D uCover;
  uniform float uCoverAspect;
  uniform sampler2D uStage;
  uniform float uStageAspect;
  uniform float uStageMix;    // 封面 → 演示视频
  uniform vec2 uFillOffset;   // 随鼠标移动的填充位移（像素）

  uniform float uFocus;       // 0..1 移动到画面中央并放大
  uniform float uReveal;      // 0..1 墨晕扩散，露出完整视频
  uniform vec2 uFrame;        // 视频画框的半宽、半高（像素）

  uniform float uRefract;
  uniform float uTime;
  uniform vec3 uInk;
  uniform vec3 uPool;

  uniform float uRotation;
  uniform float uDuotone;     // 1 = 灰度截图按作品色调做双色调
  uniform vec2 uLevels;       // 截图的灰阶范围（自动测得），先拉开再上色
  uniform vec3 uToneDark;
  uniform vec3 uToneLight;
  uniform vec3 uStageView;    // 点开后在截图上的取景：中心 (u, v) 与放大倍数
  uniform float uClear;       // 1 = 清水，0 = 夜水
  uniform vec3 uTint;         // 清水里深处活字被笼上的水色
  uniform vec3 uShadowColor;
  uniform vec2 uShadowDir;    // 屏幕空间里影子偏移的方向（光从左上来）
  uniform float uShadowDist;  // 以 300 像素字身为基准
  uniform float uShadowBlur;
  uniform float uShadowAlpha;

  varying vec2 vLocal;
  varying vec2 vScreenUv;

  ${surfaceGLSL}

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }

  // 双色调：暗部取作品色调的深色，亮部取作品色调。点开后渐渐褪向纸墨，界面看得更清楚
  vec3 duotone(vec3 c, float paper) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    l = clamp((l - uLevels.x) / max(uLevels.y - uLevels.x, 0.05), 0.0, 1.0);
    vec3 dark = mix(uToneDark, vec3(0.12, 0.13, 0.14), paper * 0.6);
    vec3 light = mix(uToneLight, vec3(0.95, 0.945, 0.92), paper * 0.82);
    return mix(dark, light, l);
  }

  // 把“以字身为单位的正方形”贴到长宽比为 aspect 的画面上，居中裁切
  vec2 coverUv(vec2 sq, float aspect) {
    vec2 uv = sq;
    if (aspect > 1.0) uv.x = (uv.x - 0.5) / aspect + 0.5;
    else uv.y = (uv.y - 0.5) * aspect + 0.5;
    return uv;
  }

  void main() {
    // —— 水面：折射与焦散 ——
    vec3 w = waterAt(vScreenUv);
    vec2 grad = w.xy;
    float lap = w.z;
    // 越深，光穿过的水越多，折射越明显；浮到水面（点开）时几乎不折射
    float depthRefr = (0.35 + uDepth) * (1.0 - 0.95 * uFocus);
    vec2 p = vLocal + grad * uRefract * depthRefr;

    // —— 字形 ——
    float domain = uEm * (1.0 + 2.0 * uSdfPad);       // 距离场纹理覆盖的像素范围
    vec2 guv = p / domain + 0.5;
    vec2 sd = texture(uSdf, clamp(guv, 0.0, 1.0)).rg;
    float pxPerTexel = domain / uSdfTexSize;
    float dist = (sd.r - 0.5) * 2.0 * uFineSpread * pxPerTexel;   // 内正外负（像素）
    vec2 outside = max(abs(guv - 0.5) - 0.5, 0.0) * domain;
    dist -= length(outside);
    float soft = 0.7 + uDepth * 2.6 * (1.0 - uFocus) + uDim * 2.0;  // 越深越虚
    float glyph = smoothstep(-soft, soft, dist);

    // 浮雕所需的导数要在分支之外取
    vec2 sdGrad = vec2(dFdx(dist), dFdy(dist));

    // —— 墨晕：从笔画向外渗开，直到铺满画框（只在展开 / 收起的过程中计算）——
    float bleed = 0.0;
    float fringe = 0.0;
    float frame = 1.0;
    if (uReveal > 0.0) {
      vec2 fq = abs(p) - uFrame;
      float frameDist = length(max(fq, 0.0)) + min(max(fq.x, fq.y), 0.0);
      frame = mix(1.0, 1.0 - smoothstep(-1.0, 1.0, frameDist), smoothstep(0.0, 0.25, uReveal));
      if (uReveal < 1.0) {
        float far = sd.g * uSdfTexSize * pxPerTexel + length(outside);
        float rmax = length(uFrame) * 0.85;
        float wob = fbm(p * 0.012 + vec2(uTime * 0.05, -uTime * 0.04)) - 0.5;
        float wob2 = fbm(p * 0.045 - uTime * 0.08) - 0.5;
        float front = uReveal * rmax;
        float edge = far + (wob * 0.32 + wob2 * 0.08) * rmax * sin(3.14159 * uReveal);
        float feather = 6.0 + 26.0 * uReveal * (1.0 - uReveal);
        bleed = 1.0 - smoothstep(front - feather, front + feather, edge);
        bleed = max(bleed, smoothstep(0.9, 1.0, uReveal));
        fringe = smoothstep(feather * 1.5, 0.0, abs(edge - front)) * uReveal * (1.0 - uReveal) * 4.0;
      } else {
        bleed = 1.0;
      }
    }
    float body = max(glyph, bleed * frame);

    // —— 填充 ——
    // 平时：作品以字身为单位居中铺满，并随鼠标移动；点开后：对齐到视频画框
    vec2 stageSq = p / (uFrame * 2.0) + 0.5;
    vec2 viewSq = uStageView.xy + (stageSq - 0.5) / uStageView.z; // 镜头取景
    vec3 fill = vec3(0.0);
    if (uStageMix < 1.0) {
      vec2 idleSq = (p - uFillOffset * (1.0 - uFocus)) / (uEm * 1.36) + 0.5;
      vec2 cuv = coverUv(idleSq, uCoverAspect);
      if (uFocus > 0.0) {
        vec2 coverStageUv = (uCoverAspect > uStageAspect)
          ? vec2((viewSq.x - 0.5) * uStageAspect / uCoverAspect + 0.5, viewSq.y)
          : vec2(viewSq.x, (viewSq.y - 0.5) * uCoverAspect / uStageAspect + 0.5);
        cuv = mix(cuv, coverStageUv, uFocus);
      }
      fill = texture(uCover, cuv).rgb;
    }
    if (uStageMix > 0.0) {
      // 视频比例与画框不一致时（比如元数据还没加载完就点开了），裁切填满而不是拉伸
      float frameAspect = uFrame.x / uFrame.y;
      vec2 stageUv = (uStageAspect > frameAspect)
        ? vec2((viewSq.x - 0.5) * frameAspect / uStageAspect + 0.5, viewSq.y)
        : vec2(viewSq.x, (viewSq.y - 0.5) * uStageAspect / frameAspect + 0.5);
      fill = mix(fill, texture(uStage, stageUv).rgb, uStageMix);
    }
    if (uDuotone > 0.5) fill = duotone(fill, uReveal);

    // —— 着色 ——
    vec3 face;
    float gl = length(sdGrad);
    vec2 nrm = gl > 1e-4 ? -sdGrad / gl : vec2(0.0);
    if (uClear > 0.5) {
      // 清水：活字是沉在水里的实物，作品就是它的颜色
      face = fill * (1.04 + 0.1 * uHover);
      face *= 1.0 - lap * 4.0 * (1.0 - uFocus);   // 水波汇聚的光落在字上
      // 一圈暗边，把字从透亮的水里托出来
      face *= 1.0 - 0.22 * smoothstep(3.0, 0.0, dist) * glyph * (1.0 - uReveal);
    } else {
      // 夜水：活字本身是半透明的象牙色，作品画面半透明地填在里面
      // 象牙色压暗后只作为“底”，保证暗色画面里字形依然可读，又不至于发灰
      float fillAmt = mix(0.74 + 0.14 * uHover, 1.0, uReveal);
      face = mix(uInk * 0.55, fill * 1.18, fillAmt);
      face *= 1.0 - lap * 6.0 * (1.0 - uFocus);   // 焦散：水波汇聚处更亮
      // 浮雕：左上受光，像铅字被光扫过的边
      float rim = smoothstep(3.5, 0.0, dist) * glyph;
      face += uInk * rim * max(0.0, dot(nrm, normalize(vec2(-0.6, 0.8)))) * 0.28 * (1.0 - uReveal);
    }

    // 笔画逐渐化开成视频
    vec3 col = mix(face, fill, bleed * frame * smoothstep(0.0, 0.6, uReveal));
    // 墨晕前沿的一圈深色水痕
    col *= 1.0 - 0.45 * clamp(fringe, 0.0, 1.0) * (1.0 - glyph);

    // 越深越被水色笼住
    if (uClear > 0.5) col = mix(col, uTint, 0.1 + 0.42 * clamp(uDepth, 0.0, 1.0) * (1.0 - uFocus) + uDim * 0.5);
    else col = mix(col, uPool, uDepth * 0.28 * (1.0 - uFocus) + uDim * 0.35);

    float alpha = body * mix(uOpacity * 0.9, 1.0, uFocus) * (1.0 - uDim * mix(0.84, 0.8, uClear));

    // —— 清水里，字在水底投下影子：浮得越高，影子离得越远、越虚 ——
    float shadowA = 0.0;
    if (uClear > 0.5) {
      float lift = 1.0 - clamp(uDepth, 0.0, 1.0);
      float scale = uEm / 300.0;
      float cr = cos(uRotation), sr = sin(uRotation);
      vec2 dirLocal = vec2(cr * uShadowDir.x + sr * uShadowDir.y, -sr * uShadowDir.x + cr * uShadowDir.y);
      vec2 ps = p - dirLocal * uShadowDist * (0.45 + lift) * scale;
      vec2 guvS = ps / domain + 0.5;
      vec2 sdS = texture(uSdf, clamp(guvS, 0.0, 1.0)).rg;
      vec2 outS = max(abs(guvS - 0.5) - 0.5, 0.0) * domain;
      // 精细距离只覆盖边缘附近，再往外改用远距离通道，影子才能虚得开
      float dS = sdS.r > 0.02
        ? (sdS.r - 0.5) * 2.0 * uFineSpread * pxPerTexel - length(outS)
        : -(sdS.g * uSdfTexSize * pxPerTexel + length(outS));
      float blur = uShadowBlur * (0.4 + lift) * scale + 1.5;
      shadowA = smoothstep(-blur, blur * 0.6, dS);
      if (uReveal > 0.0) {
        vec2 fq2 = abs(ps) - uFrame;
        float fd = length(max(fq2, 0.0)) + min(max(fq2.x, fq2.y), 0.0);
        shadowA = max(shadowA, (1.0 - smoothstep(-blur, blur, fd)) * smoothstep(0.0, 0.5, uReveal));
      }
      shadowA *= uShadowAlpha * (1.0 - uDim * 0.75) * mix(uOpacity, 1.0, uFocus);
    }

    // 字盖在自己的影子上。作品浮出水面后，水面的光影只在它上面留下很轻的一层
    float A = 1.0 - (1.0 - alpha) * (1.0 - shadowA);
    vec3 colLit = mix(surfaceLight(col, grad), col, 0.85 * uFocus);
    vec3 C = colLit * alpha;
    if (shadowA > 0.0) C += surfaceLight(uShadowColor, grad) * shadowA * (1.0 - alpha);
    gl_FragColor = vec4(filmGrain(C / max(A, 1e-4)), A);
  }
`
