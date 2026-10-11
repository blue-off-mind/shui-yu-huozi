import * as THREE from 'three'
import { glyphVert, glyphFrag } from './glyphShader.js'
import { surfaceUniforms } from './surface.js'
import { clamp, damp, lerp, mulberry32, noise1, ease } from '../core/math.js'

const DEPTH_LEVELS = [0, 0.34, 0.67, 1] // 几层不同的深度：大小差 10%，透明度差 30%
// 作品色调：按十六进制原样使用（水面场景在显示空间里合成）
const toneOf = (hex) => new THREE.Color().setHex(parseInt(hex.slice(1), 16), THREE.LinearSRGBColorSpace)
const OVERVIEW = [0.5, 0.5, 1] // 点开时先看截图全貌

// 清水里活字投在水底的影子（以 300 像素字身为基准）
const SHADOW = { dist: 16, blur: 10, alpha: 0.32 }
const SHADOW_REACH = SHADOW.dist * 1.45 + SHADOW.blur * 1.4 * 1.6 + 2
const SIZE_RANGE = 0.1
const OPACITY_RANGE = 0.3

export class GlyphField {
  constructor({ works, medias, sdfs, colors, tweens }) {
    this.tweens = tweens
    this.clear = colors.clear > 0
    this.group = new THREE.Group()
    this.hovered = -1
    this.focused = -1
    this.focusing = false
    this.frame = { cx: 0, cy: 0, hw: 320, hh: 180 }
    this.reduced = false

    const geometry = new THREE.PlaneGeometry(1, 1)
    this.glyphs = works.map((work, i) => {
      const sdf = sdfs[i]
      const media = medias[i]
      const material = new THREE.ShaderMaterial({
        vertexShader: glyphVert,
        fragmentShader: glyphFrag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          ...surfaceUniforms,
          uCenter: { value: new THREE.Vector2() },
          uRotation: { value: 0 },
          uQuad: { value: new THREE.Vector2(100, 100) },
          uViewport: { value: new THREE.Vector2(1, 1) },
          uBob: { value: 70 },
          uSdf: { value: sdf.texture },
          uSdfTexSize: { value: sdf.size },
          uSdfPad: { value: sdf.pad },
          uFineSpread: { value: sdf.fineSpread },
          uEm: { value: 100 },
          uDepth: { value: 0 },
          uOpacity: { value: 1 },
          uHover: { value: 0 },
          uDim: { value: 0 },
          uCover: { value: media.coverTexture },
          uCoverAspect: { value: media.coverAspect },
          uStage: { value: media.stageTexture },
          uStageAspect: { value: media.stageAspect },
          uStageMix: { value: 0 },
          uFillOffset: { value: new THREE.Vector2() },
          uFocus: { value: 0 },
          uReveal: { value: 0 },
          uFrame: { value: new THREE.Vector2(320, 180) },
          uRefract: { value: 140 },
          uTime: { value: 0 },
          uInk: { value: colors.ink },
          uPool: { value: colors.pool },
          uClear: { value: colors.clear },
          uTint: { value: colors.tint },
          uShadowColor: { value: colors.shadow },
          uShadowDir: { value: new THREE.Vector2(0.6, -0.8) },
          uShadowDist: { value: SHADOW.dist },
          uShadowBlur: { value: SHADOW.blur },
          uShadowAlpha: { value: SHADOW.alpha },
          uDuotone: { value: work.tone ? 1 : 0 },
          uToneDark: { value: work.tone ? toneOf(work.tone).multiplyScalar(0.17) : new THREE.Color() },
          uToneLight: { value: work.tone ? toneOf(work.tone) : new THREE.Color() },
          uStageView: { value: new THREE.Vector3(0.5, 0.5, 1) },
          uLevels: { value: new THREE.Vector2(0, 1) },
        },
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      this.group.add(mesh)
      return {
        index: i,
        work,
        media,
        sdf,
        mesh,
        u: material.uniforms,
        home: new THREE.Vector2(),
        pos: new THREE.Vector2(),
        vel: new THREE.Vector2(),
        baseDepth: 0,
        rot0: 0,
        seed: i * 13.37 + 1,
        hover: 0,
        focus: 0,
        reveal: 0,
        dim: 0,
        stageMix: 0,
        em: 100,
        center: new THREE.Vector2(),
        rotation: 0,
        depth: 0,
        // 截图上的镜头：当前值、速度、目标（中心 x、y 以左上角为原点，放大倍数）
        view: OVERVIEW.slice(),
        viewVel: [0, 0, 0],
        viewTarget: OVERVIEW.slice(),
      }
    })
    this.byDepth = this.glyphs.slice() // 由深到浅，每帧原地重排
  }

  // —— 布局：错落的交错网格。先按画面比例选行列，再逐行错开、随机偏移，
  //    看起来是随意漂着的，但彼此不会压在一起 ——
  layout(w, h) {
    this.viewW = w
    this.viewH = h
    const n = this.glyphs.length
    const portrait = h > w * 1.1
    // 给右上角按钮、底部提示留出位置
    const side = portrait ? 14 : Math.max(40, w * 0.035)
    const box = {
      x0: -w / 2 + side,
      x1: w / 2 - side,
      y0: -h / 2 + (portrait ? 92 : 52),
      y1: h / 2 - (portrait ? 70 : 30),
    }
    const bw = box.x1 - box.x0
    const bh = box.y1 - box.y0

    let best = { rows: 1, cols: n, cell: 0 }
    for (let rows = 1; rows <= n; rows++) {
      const cols = Math.ceil(n / rows)
      const cell = Math.min(bw / cols, bh / rows)
      if (cell > best.cell) best = { rows, cols, cell }
    }
    const { rows, cols } = best
    const cw = bw / cols
    const ch = bh / rows
    this.em = Math.min(cw, ch) * 0.84

    const rand = mulberry32(20251011)
    const pts = []
    let k = 0
    for (let r = 0; r < rows; r++) {
      const count = Math.min(cols, n - k)
      // 不满的一行居中；奇偶行左右错开四分之一格
      const offset = (cols - count) * cw * 0.5 + (r % 2 ? 0.12 : -0.12) * cw * (rows > 1 ? 1 : 0)
      for (let c = 0; c < count; c++, k++) {
        const jx = (rand() - 0.5) * Math.max(0, cw - this.em) + (rand() - 0.5) * this.em * 0.1
        // 上下错落要一高一低地交替，不然几个字可能全挤到同一边
        const sway = Math.min((ch - this.em) * 0.5, this.em * 0.32)
        const jy = ((c + r) % 2 ? 1 : -1) * (0.45 + rand() * 0.55) * Math.max(0, sway)
        const x = box.x0 + offset + cw * (c + 0.5) + jx
        const y = box.y1 - ch * (r + 0.5) + jy
        const half = this.em * (portrait ? 0.52 : 0.46) // 竖屏两侧窄，宽字（如「嵌」）的墨迹要留足余量
        pts.push(new THREE.Vector2(clamp(x, box.x0 + half, box.x1 - half), clamp(y, box.y0 + half, box.y1 - half)))
      }
    }

    // 作品少时，深浅收在较窄的范围里：每一件都看得清，又仍有前后层次
    const levels = n <= 3 ? [0, 0.32, 0.62] : DEPTH_LEVELS
    const order = this.glyphs.map((_, i) => i).sort(() => rand() - 0.5)
    order.forEach((gi, j) => {
      const g = this.glyphs[gi]
      g.baseDepth = clamp(levels[j % levels.length] + (rand() - 0.5) * 0.06)
      g.rot0 = (rand() - 0.5) * 0.14
    })
    this.glyphs.forEach((g, i) => {
      const first = g.home.lengthSq() === 0 && g.pos.lengthSq() === 0
      g.home.copy(pts[i])
      if (first) g.pos.copy(pts[i])
      g.u.uViewport.value.set(w, h)
    })
  }

  // 点开后画框的位置（水面坐标）。画框形状跟着画面走：竖图像立轴，宽图像手卷，方图像斗方。
  // side：画框偏左，文字在右侧；below：画框在上，文字在下（宽图与竖屏手机）
  computeFrame(aspect) {
    const w = this.viewW
    const h = this.viewH
    const portrait = h > w * 1.1
    const mode = portrait || aspect > 1.35 ? 'below' : 'side'
    let maxW
    let maxH
    if (portrait) {
      maxW = w * 0.86
      maxH = h * 0.4
    } else if (mode === 'below') {
      maxW = w * 0.72
      maxH = h * 0.5
    } else {
      maxW = w * 0.46
      maxH = h * 0.74
    }
    let fw = maxW
    let fh = fw / aspect
    if (fh > maxH) {
      fh = maxH
      fw = fh * aspect
    }
    const top = portrait ? 126 : h * 0.1 // 竖屏时画框上方要放两行题签
    const cx = mode === 'side' ? -w * 0.14 : 0
    const cy = mode === 'side' ? 0 : h / 2 - top - fh / 2
    return { cx, cy, hw: fw / 2, hh: fh / 2, portrait, mode }
  }

  // 设置截图上的镜头目标：[x, y, 放大倍数]，x、y 以左上角为原点
  setView(index, view = OVERVIEW) {
    const g = this.glyphs[index]
    if (g) g.viewTarget = view.slice()
  }

  updateView(g, dt, time) {
    // 二阶临界阻尼：镜头起停都柔和
    const w = 3.6
    const n = Math.max(1, Math.ceil(dt * 120))
    const h = dt / n
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 3; i++) {
        g.viewVel[i] += (w * w * (g.viewTarget[i] - g.view[i]) - 2 * w * g.viewVel[i]) * h
        g.view[i] += g.viewVel[i] * h
      }
    }
    // 停住时也有一点缓慢的漂移，画面不至于死板；再把取景框收在截图之内
    const z = Math.max(1, g.view[2])
    const drift = z > 1.05 ? 0.012 / z : 0
    const half = 0.5 / z
    const x = clamp(g.view[0] + Math.sin(time * 0.13 + g.seed) * drift, half, 1 - half)
    const y = clamp(g.view[1] + Math.cos(time * 0.11 + g.seed) * drift, half, 1 - half)
    g.u.uStageView.value.set(x, 1 - y, z)
  }

  // 命中测试：从浅到深，第一个碰到的字
  pick(x, y) {
    for (let k = this.byDepth.length - 1; k >= 0; k--) {
      const g = this.byDepth[k]
      const dx = x - g.center.x
      const dy = y - g.center.y
      const c = Math.cos(-g.rotation)
      const s = Math.sin(-g.rotation)
      const lx = c * dx - s * dy
      const ly = s * dx + c * dy
      const domain = g.em * (1 + 2 * g.sdf.pad)
      const u = lx / domain + 0.5
      const v = ly / domain + 0.5
      const d = g.sdf.distanceAt(u, v) * (domain / g.sdf.size)
      if (d < Math.max(10, g.em * 0.07)) return g.index
    }
    return -1
  }

  setHovered(index) {
    this.hovered = index
  }

  async open(index) {
    const g = this.glyphs[index]
    if (!g || this.focusing) return
    this.focusing = true
    this.focused = index
    this.hovered = -1
    const fast = this.reduced
    this.frame = this.computeFrame(g.media.stageAspect || 16 / 9)
    g.u.uFrame.value.set(this.frame.hw, this.frame.hh)
    g.u.uStage.value = g.media.stageTexture
    g.u.uStageAspect.value = g.media.stageAspect
    g.u.uCoverAspect.value = g.media.coverAspect

    for (const other of this.glyphs) {
      if (other === g) continue
      this.tweens.run(fast ? 0.4 : 1.2, (t) => (other.dim = t), { ease: ease.inOutSine })
    }
    const playing = g.media.play()
    // 先浮上水面、放大到画面中央；字站稳后，笔画才像墨一样慢慢洇开
    await Promise.all([
      this.tweens.run(fast ? 0.5 : 1.3, (t) => (g.focus = t), { ease: ease.inOutCubic }),
      this.tweens.run(fast ? 0.6 : 2.4, (t) => (g.reveal = t), { ease: ease.inOutCubic, delay: fast ? 0.2 : 0.95 }),
      playing.then(() => this.tweens.run(0.8, (t) => (g.stageMix = Math.max(g.stageMix, t)), { delay: 0.9 })),
    ])
    this.focusing = false
  }

  async close() {
    const g = this.glyphs[this.focused]
    if (!g || this.focusing) return
    this.focusing = true
    const fast = this.reduced
    for (const other of this.glyphs) {
      if (other === g) continue
      this.tweens.run(fast ? 0.4 : 1.3, (t) => (other.dim = 1 - t), { ease: ease.inOutSine, delay: fast ? 0 : 0.5 })
    }
    await Promise.all([
      this.tweens.run(fast ? 0.5 : 1.25, (t) => (g.reveal = 1 - t), { ease: ease.inOutSine }),
      this.tweens.run(fast ? 0.5 : 1.0, (t) => (g.stageMix = 1 - t), { ease: ease.inOutSine, delay: fast ? 0 : 0.5 }),
      this.tweens.run(fast ? 0.5 : 1.15, (t) => (g.focus = 1 - t), { ease: ease.inOutCubic, delay: fast ? 0.1 : 0.7 }),
    ])
    g.media.pause()
    g.view = OVERVIEW.slice()
    g.viewVel = [0, 0, 0]
    g.viewTarget = OVERVIEW.slice()
    this.focused = -1
    this.focusing = false
  }

  update(dt, time, { pointer, fillOffset, pointerActive }) {
    const em = this.em
    for (const g of this.glyphs) {
      // 漂移目标：自己的位置附近缓慢游走
      const drift = this.reduced ? 0 : 1
      const tx = g.home.x + noise1(time * 0.07, g.seed) * em * 0.06 * drift
      const ty = g.home.y + noise1(time * 0.06, g.seed + 7) * em * 0.06 * drift
      g.vel.x += (tx - g.pos.x) * 5 * dt
      g.vel.y += (ty - g.pos.y) * 5 * dt
      // 鼠标划过时，带起的水流把字轻轻推开
      if (pointerActive) {
        const dx = g.pos.x - pointer.x
        const dy = g.pos.y - pointer.y
        const fall = Math.exp(-(dx * dx + dy * dy) / (em * em * 0.8))
        g.vel.x += pointer.vx * fall * 0.045 * drift
        g.vel.y += pointer.vy * fall * 0.045 * drift
      }
      const fr = Math.exp(-dt * 3.2)
      g.vel.multiplyScalar(fr)
      // 再猛的水流也只能把字推开一小段
      const vmax = em * 1.2
      if (g.vel.lengthSq() > vmax * vmax) g.vel.setLength(vmax)
      g.pos.addScaledVector(g.vel, dt)

      g.hover = damp(g.hover, this.hovered === g.index ? 1 : 0, 7, dt)
      g.media.slow = g.dim > 0.5

      const breathe = noise1(time * 0.09, g.seed + 11) * 0.05 * drift
      const idleDepth = clamp(g.baseDepth + breathe - g.hover * 0.3)
      const idleEm = em * (1 - SIZE_RANGE * idleDepth) * (1 - 0.06 * g.dim)
      const idleRot = g.rot0 + noise1(time * 0.05, g.seed + 3) * 0.025 * drift + g.vel.x * 0.00006

      const f = g.focus
      const fe = this.frame
      const focusEm = Math.min(fe.hw, fe.hh) * 2 * 0.9 // 字放大到正好放进画框
      g.center.set(lerp(g.pos.x, fe.cx, f), lerp(g.pos.y, fe.cy, f))
      g.em = lerp(idleEm, focusEm, f)
      g.rotation = lerp(idleRot, 0, f)
      g.depth = lerp(idleDepth, 0, f) + g.dim * 0.35

      // 面片只盖住墨迹外框，外加折射、虚化（清水里还有影子）留出的余量；
      // 比铺满整个距离场少画一半以上的像素
      const reach = this.clear ? (SHADOW_REACH * g.em) / 300 : 0
      const margin = 34 + reach
      const qx = Math.max(g.em * g.sdf.inkHalf[0] + margin, f > 0 ? fe.hw * 1.04 + reach : 0)
      const qy = Math.max(g.em * g.sdf.inkHalf[1] + margin, f > 0 ? fe.hh * 1.04 + reach : 0)

      // 填充位移：与鼠标移动同幅，越界时柔和收住
      const maxOff = g.em * 0.17
      const ox = maxOff * Math.tanh(fillOffset.x / maxOff)
      const oy = maxOff * Math.tanh(fillOffset.y / maxOff)

      const u = g.u
      u.uCenter.value.copy(g.center)
      u.uRotation.value = g.rotation
      u.uBob.value = 70 * (1 - f) // 点开后画框稳稳停住，不再随水波漂
      u.uQuad.value.set(qx, qy)
      u.uEm.value = g.em
      u.uDepth.value = clamp(g.depth, 0, 1.4)
      u.uOpacity.value = 1 - OPACITY_RANGE * clamp(idleDepth)
      u.uHover.value = g.hover
      u.uDim.value = g.dim
      u.uFocus.value = f
      u.uReveal.value = g.reveal
      u.uStageMix.value = g.stageMix
      u.uFillOffset.value.set(ox, oy)
      u.uTime.value = time
      if (f > 0) this.updateView(g, dt, time)
      u.uLevels.value.set(g.media.levels[0], g.media.levels[1])
      u.uCover.value = g.media.coverTexture
      u.uCoverAspect.value = g.media.coverAspect
      if (f > 0) {
        u.uStage.value = g.media.stageTexture
        u.uStageAspect.value = g.media.stageAspect
      }
    }
    // 深的先画，浅的后画；点开的那个永远在最上面
    this.byDepth.sort((a, b) => b.depth - a.depth)
    this.byDepth.forEach((g, k) => (g.mesh.renderOrder = 10 + k + (g.focus > 0 ? 100 : 0)))
  }
}
