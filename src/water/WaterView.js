import * as THREE from 'three'
import { WaterSim } from './WaterSim.js'
import { GlyphField } from './GlyphField.js'
import { createBambooShadow } from './bamboo.js'
import { damp } from '../core/math.js'
import { surfaceGLSL, surfaceUniforms } from './surface.js'

// 坛中的水面：水底（背景）→ 活字（按深浅排序，各自折射）。
// 水面高光不单独成层，由背景和活字各自在着色器里算（见 surface.js）。
// 整个场景以 CSS 像素为单位，原点在画面中心，y 向上。

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// 活字里的作品画面随鼠标移动的方式。
// 鼠标给出“想去的位置”（与鼠标同幅，随后缓缓回正）；画面不直接跳过去，而是：
//   1. 目标先限速：每秒最多移动 speed 像素
//   2. 再经过三阶临界阻尼滤波：急动度 j = ω³(目标−位置) − 3ω²·速度 − 3ω·加速度
// 线性滤波器本身不会过冲、不会失稳；输入的变化速度有上限，输出的急动度也就有界，
// 匀速时约为 0.23·speed·ω²，快速一划约每秒立方一万像素——起步、停下都是缓缓的。
// 以 300 像素字身为基准，随字的大小等比缩放。
const FILL = { omega: 8, speed: 500, decay: 0.9 }

// 清水的水底：晃动的光纹（焦散）+ 两层交错的竹影。
// 都是柔和的低频图案，按三分之一分辨率画进一张小纹理：R = 光纹，G = 竹影
const floorFrag = /* glsl */ `
  uniform sampler2D uBamboo;
  uniform float uTime;
  uniform vec2 uViewport;
  varying vec2 vUv;

  // Dave Hoskins 的可平铺焦散
  float caustic(vec2 uv, float time) {
    vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
    vec2 i = p;
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < 4; n++) {
      float t = time * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return pow(abs(c), 8.0);
  }

  void main() {
    float aspect = uViewport.x / uViewport.y;
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    // 光纹放大、放慢：积水空明，要静，不要泳池那样碎
    float caus = caustic(p * 0.62 + vec2(0.3, 0.7), uTime * 0.24) * 0.75
               + caustic(p * 1.25 - vec2(0.8, 0.2), uTime * 0.18 + 7.0) * 0.3;

    // 竹影：近的一层清楚些，远的一层转个角度、放大、更虚，两层交横
    vec2 b = p / max(aspect, 1.0);
    vec2 sway = vec2(sin(uTime * 0.31 + b.y * 3.0), cos(uTime * 0.23 + b.x * 2.4)) * 0.007;
    float nearShadow = texture(uBamboo, b * 0.98 + 0.5 + sway, 0.8).r;
    float a = 1.9;
    mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
    float farShadow = texture(uBamboo, rot * b * 1.3 + vec2(0.63, 0.43) + sway * 0.6, 2.4).r;
    float shadow = 1.0 - (1.0 - nearShadow * 0.8) * (1.0 - farShadow * 0.45);
    gl_FragColor = vec4(caus, shadow, 0.0, 1.0);
  }
`

// 水底（背景）。清水：青蓝的透亮水色，叠上光纹、竹影、涟漪聚光；夜水：近乎全黑的深水
const backgroundFrag = /* glsl */ `
  uniform vec2 uViewport;
  uniform float uRefract;
  uniform float uClear;
  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uLight;
  uniform vec3 uShadow;
  uniform sampler2D uFloor;
  varying vec2 vUv;
  ${surfaceGLSL}
  void main() {
    vec3 w = waterAt(vUv);
    vec3 col;
    if (uClear > 0.5) {
      // 水底隔着一层水，被涟漪折射得晃动
      vec2 uv = vUv + w.xy * uRefract * 1.2 / uViewport;
      vec2 fl = texture(uFloor, uv).rg;
      vec2 p = (vUv - 0.5) * uViewport / min(uViewport.x, uViewport.y);
      float r = length(p * vec2(0.8, 1.0));
      col = mix(uShallow, uMid, smoothstep(0.05, 0.95, r));
      col = mix(col, uDeep, smoothstep(0.45, 1.45, r));
      // 左上方来的天光，在水面上铺开一层很淡的亮
      col += uLight * 0.045 * smoothstep(1.5, 0.0, length(p - vec2(-0.55, 0.42)));
      col = mix(col, uShadow, fl.g * 0.32);
      col += uLight * fl.r * 0.26 * (1.0 - fl.g * 0.8) * (1.0 - smoothstep(0.45, 1.3, r));
      col += uLight * clamp(-w.z * 2.5, 0.0, 0.22); // 涟漪把光聚在水底
    } else {
      vec2 uv = vUv + w.xy * uRefract * 1.8 / uViewport;
      vec2 p = (uv - 0.5) * uViewport / min(uViewport.x, uViewport.y);
      float r = length(p * vec2(0.85, 1.0));
      col = uDeep + vec3(0.012, 0.016, 0.018) * smoothstep(1.0, 0.0, r);
      col *= mix(1.0, 0.45, smoothstep(0.5, 1.2, r));
    }
    gl_FragColor = vec4(filmGrain(surfaceLight(col, w.xy)), 1.0);
  }
`

export class WaterView {
  constructor(renderer, { works, medias, sdfs, tweens, theme }) {
    this.renderer = renderer
    this.medias = medias
    this.theme = theme
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)
    this.sim = new WaterSim(renderer)
    this.time = 0
    // 填充画面的运动状态：target 鼠标给出的目标，limited 限速后的目标，p / v / a 位置、速度、加速度
    this.fill = {
      target: new THREE.Vector2(),
      limited: new THREE.Vector2(),
      p: new THREE.Vector2(),
      v: new THREE.Vector2(),
      a: new THREE.Vector2(),
    }
    // 最近鼠标走过的路程（像素，指数衰减）：agitation 记最近半秒多，fatigue 记最近几秒
    this.agitation = 0
    this.fatigue = 0
    this.nextDrop = 2
    this.reduced = false

    this.colors = theme
    surfaceUniforms.uGrainAmount.value = theme.grain

    // 清水才有水底：光纹与竹影画进一张小纹理
    if (theme.clear) {
      this.floorTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false })
      this.floorTarget.texture.colorSpace = THREE.NoColorSpace
      this.floorMat = new THREE.ShaderMaterial({
        vertexShader: quadVert,
        fragmentShader: floorFrag,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uBamboo: { value: createBambooShadow() },
          uTime: { value: 0 },
          uViewport: { value: new THREE.Vector2(1, 1) },
        },
      })
      this.floorScene = new THREE.Scene()
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.floorMat)
      quad.frustumCulled = false
      this.floorScene.add(quad)
    }

    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: backgroundFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...surfaceUniforms,
        uViewport: { value: new THREE.Vector2(1, 1) },
        uRefract: { value: 140 },
        uClear: { value: theme.clear },
        uShallow: { value: theme.shallow },
        uMid: { value: theme.mid },
        uDeep: { value: theme.deep },
        uLight: { value: theme.light },
        uShadow: { value: theme.shadow },
        uFloor: { value: this.floorTarget?.texture ?? null },
      },
    })
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat)
    bg.frustumCulled = false
    bg.renderOrder = 0
    this.scene.add(bg)

    this.field = new GlyphField({ works, medias, sdfs, colors: this.colors, tweens })
    this.scene.add(this.field.group)

  }

  set reducedMotion(v) {
    this.reduced = v
    this.field.reduced = v
  }

  resize(w, h) {
    this.w = w
    this.h = h
    this.camera.left = -w / 2
    this.camera.right = w / 2
    this.camera.top = h / 2
    this.camera.bottom = -h / 2
    this.camera.updateProjectionMatrix()
    this.sim.resize(w, h)
    this.field.layout(w, h)
    this.bgMat.uniforms.uViewport.value.set(w, h)
    if (this.floorTarget) {
      this.floorTarget.setSize(Math.max(64, Math.round(w / 3)), Math.max(64, Math.round(h / 3)))
      this.floorMat.uniforms.uViewport.value.set(w, h)
    }
  }

  // 屏幕坐标（左上原点）→ 水面坐标
  toWater(clientX, clientY) {
    return { x: clientX - this.w / 2, y: this.h / 2 - clientY }
  }

  // 在水面上划一道
  stir(x0, y0, x1, y1, scale = 1, radius = 18) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 0.5) return
    const strength = Math.min(1, len / (radius * 1.5)) * 0.42 * scale
    this.sim.stroke(x0, y0, x1, y1, radius, strength)
  }

  drop(x, y, strength = 1.2, radius = 22) {
    this.sim.drop(x, y, radius, strength)
  }

  pick(clientX, clientY) {
    const p = this.toWater(clientX, clientY)
    return this.field.pick(p.x, p.y)
  }

  // 活字中心在屏幕上的位置（用于标题、无障碍按钮）
  glyphScreenRect(index) {
    const g = this.field.glyphs[index]
    return {
      x: g.center.x + this.w / 2,
      y: this.h / 2 - g.center.y,
      size: g.em,
    }
  }

  /**
   * @param {number} dt
   * @param {object} input  { seg, pointer, interactive }
   */
  update(dt, input = {}) {
    this.time += dt
    const { seg, pointer, interactive } = input

    let pointerState = { x: 0, y: 0, vx: 0, vy: 0 }
    let pointerActive = false
    // 鼠标动得越猛，每一下激起的水波越轻：扰动的总量有上限，快速抖动也不会把水面搅乱。
    // 作品展开时观众在看视频，水波再减半。
    const focus = this.field.focused >= 0 ? this.field.glyphs[this.field.focused].focus : 0
    this.agitation *= Math.exp(-dt / 0.6)
    this.fatigue *= Math.exp(-dt / 3)
    // 平方型的衰减：正常速度几乎不打折扣，越过正常范围才迅速变轻
    const calm = 1 / (1 + (this.agitation / 1400) ** 2 + (this.fatigue / 9000) ** 2)
    if (seg && interactive) {
      const a = this.toWater(seg.x0, seg.y0)
      const b = this.toWater(seg.x1, seg.y1)
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      // 一帧里跨度过大的视为跳变（比如切回窗口），不画
      if (seg.moved && len < 320) {
        this.agitation += len
        this.fatigue += len
        this.stir(a.x, a.y, b.x, b.y, calm * (1 - 0.5 * focus))
      }
      // 填充的目标与鼠标同幅移动
      this.fill.target.x += seg.dx
      this.fill.target.y -= seg.dy
      pointerState = { x: b.x, y: b.y, vx: pointer.vx * calm, vy: -pointer.vy * calm }
      pointerActive = seg.moved
    }
    this.updateFill(dt)

    // 偶尔落下一滴，让水面一直是活的
    if (!this.reduced) {
      this.nextDrop -= dt
      if (this.nextDrop <= 0) {
        this.nextDrop = 3 + Math.random() * 5
        const x = (Math.random() - 0.5) * this.w * 0.9
        const y = (Math.random() - 0.5) * this.h * 0.9
        this.drop(x, y, 0.35 + Math.random() * 0.3, 10 + Math.random() * 8)
      }
    }

    this.sim.update(dt)
    this.medias.forEach((m, i) => m.update(dt, i))

    const su = surfaceUniforms
    su.uWater.value = this.sim.texture
    su.uWaterTexel.value.copy(this.sim.texel)
    su.uGrainSeed.value = Math.floor(this.time * 24) % 61 // 颗粒每秒换 24 次，像胶片
    // 点开作品时，水面高光收敛，免得干扰看视频
    su.uGlint.value = damp(su.uGlint.value, 1 - focus * 0.7, 4, dt)

    this.field.update(dt, this.time, {
      pointer: pointerState,
      pointerActive,
      fillOffset: this.fill.p,
    })
  }

  updateFill(dt) {
    const f = this.fill
    f.target.multiplyScalar(Math.exp(-dt / FILL.decay)) // 目标缓缓回正
    const scale = this.field.em / 300
    const w = FILL.omega
    const n = Math.max(1, Math.ceil(dt * 240)) // 细分步长，帧率高低都一样平滑
    const h = dt / n
    const step = FILL.speed * scale * h
    for (let i = 0; i < n; i++) {
      const dx = f.target.x - f.limited.x
      const dy = f.target.y - f.limited.y
      const d = Math.hypot(dx, dy)
      const k = d > step ? step / d : 1
      f.limited.x += dx * k
      f.limited.y += dy * k
      for (const ax of ['x', 'y']) {
        const jerk = w * w * w * (f.limited[ax] - f.p[ax]) - 3 * w * w * f.v[ax] - 3 * w * f.a[ax]
        f.a[ax] += jerk * h
        f.v[ax] += f.a[ax] * h
        f.p[ax] += f.v[ax] * h
      }
    }
  }

  render(target = null) {
    const r = this.renderer
    const prev = r.getRenderTarget()
    if (this.floorTarget) {
      this.floorMat.uniforms.uTime.value = this.time
      r.setRenderTarget(this.floorTarget)
      r.render(this.floorScene, this.camera)
    }
    r.setRenderTarget(target)
    r.render(this.scene, this.camera)
    r.setRenderTarget(prev)
  }
}
