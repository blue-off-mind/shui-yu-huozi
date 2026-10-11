import * as THREE from 'three'

// GPU 上的二维波动方程（高度场）。R：高度，G：速度。
// 坐标约定：输入一律是“水面坐标”——CSS 像素，原点在画面中心，y 向上。

const MAX_STROKES = 8
const CELL = 3 // 每个模拟格子约 3 CSS 像素
const STEP = 1 / 120

const fullscreenVert = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const updateFrag = /* glsl */ `
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform float uDamping;
  void main() {
    vec2 uv = gl_FragCoord.xy * uTexel;
    vec4 s = texture(uState, uv);
    vec4 l = texture(uState, uv - vec2(uTexel.x, 0.0));
    vec4 r = texture(uState, uv + vec2(uTexel.x, 0.0));
    vec4 d = texture(uState, uv - vec2(0.0, uTexel.y));
    vec4 u = texture(uState, uv + vec2(0.0, uTexel.y));
    float avg = (l.r + r.r + d.r + u.r) * 0.25;
    float avgV = (l.g + r.g + d.g + u.g) * 0.25;
    s.g += (avg - s.r) * 2.0;
    // 粘滞：速度向周围平均值靠一点。格点级的锯齿（最容易失控的高频成分）很快被抹平，
    // 正常涟漪的波长远大于格点，几乎不受影响
    s.g = mix(s.g, avgV, 0.05);
    s.g *= uDamping;
    // 浪一旦偏大就额外耗散：持续搅动时波峰会同相叠加（共振），靠这里把它压住
    float amp = abs(s.r) + abs(s.g) * 3.0;
    s.g *= 1.0 - 0.18 * smoothstep(0.5, 1.3, amp);
    s.r += s.g;
    s.r *= 0.9992;
    // 只防溢出的宽松上下限。不能把速度卡得太紧：那样高频振荡会在上下限之间来回翻，
    // 比例阻尼失效，反而停不下来
    s.r = clamp(s.r, -4.0, 4.0);
    s.g = clamp(s.g, -4.0, 4.0);
    if (isnan(s.r) || isnan(s.g)) s = vec4(0.0);
    gl_FragColor = s;
  }
`

const strokeFrag = /* glsl */ `
  #define MAX_STROKES ${MAX_STROKES}
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform vec4 uSeg[MAX_STROKES];    // 线段端点（模拟格坐标）
  uniform vec2 uParam[MAX_STROKES];  // 半径（格）、强度
  uniform int uCount;
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }
  void main() {
    vec2 uv = gl_FragCoord.xy * uTexel;
    vec4 s = texture(uState, uv);
    for (int i = 0; i < MAX_STROKES; i++) {
      if (i >= uCount) break;
      float d = segDist(gl_FragCoord.xy, uSeg[i].xy, uSeg[i].zw);
      float f = max(0.0, 1.0 - d / uParam[i].x);
      f = 0.5 - 0.5 * cos(f * 3.14159265);
      // 把水面“按下”到某个深度，而不是一味累加：相邻两帧的笔画在接缝处不会叠出一串珠子。
      // 按住的地方速度同时归零——手指压着的水面是静止的。只钳住高度、不管速度的话，
      // 来回抖动时速度会一步步累加，松手那一刻能量全部释放，最终数值发散。
      float on = step(0.001, f);
      s.r = mix(s.r, min(s.r, -f * uParam[i].y), on);
      s.g *= 1.0 - f * on;
    }
    gl_FragColor = s;
  }
`

export class WaterSim {
  constructor(renderer) {
    this.renderer = renderer
    this.enabled =
      renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float')
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.updateMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: updateFrag,
      uniforms: { uState: { value: null }, uTexel: { value: new THREE.Vector2() }, uDamping: { value: 0.995 } },
      depthTest: false,
      depthWrite: false,
    })
    this.strokeMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: strokeFrag,
      uniforms: {
        uState: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSeg: { value: Array.from({ length: MAX_STROKES }, () => new THREE.Vector4()) },
        uParam: { value: Array.from({ length: MAX_STROKES }, () => new THREE.Vector2()) },
        uCount: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })

    this.queue = []
    this.acc = 0
    this.width = 1
    this.height = 1
    this.viewW = 1
    this.viewH = 1
    this.targets = []
    this.index = 0
    // 不支持浮点渲染目标时，用一张平的高度场代替（水面静止，其余效果照常）
    this.flat = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    this.flat.needsUpdate = true
  }

  resize(viewW, viewH) {
    this.viewW = viewW
    this.viewH = viewH
    if (!this.enabled) return
    const scale = Math.min(1 / CELL, 1024 / viewW, 1024 / viewH)
    const w = Math.max(32, Math.round(viewW * scale))
    const h = Math.max(32, Math.round(viewH * scale))
    if (w === this.width && h === this.height && this.targets.length) return
    this.width = w
    this.height = h
    this.targets.forEach((t) => t.dispose())
    this.targets = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    )
    // 新目标需要清零
    const prev = this.renderer.getRenderTarget()
    const clear = new THREE.Color()
    const alpha = this.renderer.getClearAlpha()
    this.renderer.getClearColor(clear)
    this.renderer.setClearColor(0x000000, 0)
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t)
      this.renderer.clear(true, false, false)
    }
    this.renderer.setClearColor(clear, alpha)
    this.renderer.setRenderTarget(prev)
    this.updateMat.uniforms.uTexel.value.set(1 / w, 1 / h)
    this.strokeMat.uniforms.uTexel.value.set(1 / w, 1 / h)
  }

  get texture() {
    return this.enabled && this.targets.length ? this.targets[this.index].texture : this.flat
  }

  get texel() {
    return new THREE.Vector2(1 / this.width, 1 / this.height)
  }

  // 水面坐标 → 模拟格坐标
  toCell(x, y) {
    return [(x / this.viewW + 0.5) * this.width, (y / this.viewH + 0.5) * this.height]
  }

  // 一段划痕：半径、强度以 CSS 像素 / 任意单位给出
  stroke(x0, y0, x1, y1, radius = 14, strength = 0.6) {
    if (!this.enabled || ![x0, y0, x1, y1, radius, strength].every(Number.isFinite)) return
    const [ax, ay] = this.toCell(x0, y0)
    const [bx, by] = this.toCell(x1, y1)
    const r = (radius * this.width) / this.viewW
    this.queue.push([ax, ay, bx, by, Math.max(1.5, r), strength])
  }

  drop(x, y, radius = 18, strength = 1) {
    this.stroke(x, y, x, y, radius, strength)
  }

  pass(material) {
    const read = this.targets[this.index]
    const write = this.targets[1 - this.index]
    material.uniforms.uState.value = read.texture
    this.quad.material = material
    this.renderer.setRenderTarget(write)
    this.renderer.render(this.scene, this.camera)
    this.index = 1 - this.index
  }

  update(dt) {
    if (!this.enabled || !this.targets.length) return
    const prev = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false

    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_STROKES)
      const u = this.strokeMat.uniforms
      batch.forEach((s, i) => {
        u.uSeg.value[i].set(s[0], s[1], s[2], s[3])
        u.uParam.value[i].set(s[4], s[5])
      })
      u.uCount.value = batch.length
      this.pass(this.strokeMat)
    }

    this.acc = Math.min(this.acc + dt, STEP * 4)
    while (this.acc >= STEP) {
      this.pass(this.updateMat)
      this.acc -= STEP
    }

    this.renderer.autoClear = prevAutoClear
    this.renderer.setRenderTarget(prev)
  }
}
