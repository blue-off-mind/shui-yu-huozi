import './styles.css'
import * as THREE from 'three'
import { site, works } from './content/works.js'
import { ui as copy } from './content/ui.js'
import { Pointer } from './core/pointer.js'
import { Tweens, ease, damp, prefersReducedMotion } from './core/math.js'
import { createGlyphSDF } from './water/glyphSDF.js'
import { WorkMedia } from './media/media.js'
import { WaterView } from './water/WaterView.js'
import { JarScene } from './jar/JarScene.js'
import { Interface } from './ui/Interface.js'
import { Tour } from './ui/Tour.js'
import { Quality } from './core/quality.js'
import { resolveTheme } from './water/themes.js'

// 场景流转：loading → intro → jar → diving → water ⇄ focus / closing；water → surfacing → jar
const WATER_SCENES = new Set(['water', 'focus', 'closing'])
const FONT_MINCHO = '"Huozi Mincho", "Huozi Serif", serif'
const FONT_BRUSH = '"Huozi Brush", "Huozi Serif", serif'

const canvas = document.getElementById('stage')
const reduced = prefersReducedMotion()
const theme = resolveTheme(site.water)
document.body.classList.add(`water-${theme.name}`)
const tweens = new Tweens()
const pointer = new Pointer()
const state = { scene: 'loading', load: 0, focused: -1, elapsed: 0, jarHover: false }

let renderer
let jar
let water
let waterRT
let medias = []
let viewW = window.innerWidth
let viewH = window.innerHeight
let dpr = 1
let quality

const ui = new Interface({
  copy,
  site,
  works,
  onOpenWork: openWork,
  onDive: dive,
  onBack: surface,
  onClose: closeWork,
  onToggleSound: toggleSound,
  onClue: (i) => tour.go(i),
})

// 截图导览：每走到一条线索，文字换成这一条，镜头移到截图上对应的位置
const tour = new Tour({
  onStep(index, line) {
    ui.showClue(index)
    if (water && state.focused >= 0) water.field.setView(state.focused, line?.view)
  },
})

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const until = (test) =>
  new Promise((resolve) => {
    const check = () => (test() ? resolve() : requestAnimationFrame(check))
    check()
  })

function setScene(name) {
  state.scene = name
  ui.setScene(name)
}

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

if (hasWebGL2()) start()
else ui.showFallback(works)

async function start() {
  // 多重采样只在普通屏上开：Retina 屏像素够细，字形和白线又都在着色器里自己抗锯齿，
  // 省掉每帧对整块画布的多重采样解析
  const msaa = (window.devicePixelRatio || 1) < 1.75
  renderer = new THREE.WebGLRenderer({ canvas, antialias: msaa, powerPreference: 'high-performance' })
  quality = new Quality(renderer.getContext())
  renderer.setClearColor(0x000000, 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1

  jar = new JarScene(renderer)
  resize()
  window.addEventListener('resize', resize)
  canvas.addEventListener('click', onClick)
  window.addEventListener('keydown', onKey)
  requestAnimationFrame(loop)

  await load()
  // 白线画满之后，酒坛才从黑暗里浮出来
  await until(() => jar.lineProgress > 0.985)
  setScene('intro')
  await tweens.run(reduced ? 0.8 : 3, (t) => (jar.intro = t), { ease: ease.inOutSine })
  ui.placeJarButton(jar.screenBounds())
  setScene('jar')
  quality.enabled = true // 开场动画结束后才开始评估，避开加载期的卡顿
}

async function load() {
  const progress = (p) => (state.load = Math.max(state.load, p))
  const brushText = site.jarLabel + works.flatMap((w) => (w.lines ?? []).map((l) => l.brush)).join('')
  await Promise.all([
    document.fonts.load(`800 64px ${FONT_MINCHO}`, works.map((w) => w.char).join('')),
    document.fonts.load(`64px ${FONT_BRUSH}`, brushText),
    document.fonts.load('400 16px "Huozi Serif"', site.title),
    document.fonts.load('600 16px "Huozi Serif"', site.title),
  ]).catch(() => {})
  progress(0.2)
  await nextFrame()

  const sdfs = []
  for (let i = 0; i < works.length; i++) {
    sdfs.push(createGlyphSDF(works[i].char, { fontFamily: FONT_MINCHO, weight: 800 }))
    progress(0.2 + (0.5 * (i + 1)) / works.length)
    await nextFrame()
  }

  medias = works.map((w) => new WorkMedia(w, renderer))
  water = new WaterView(renderer, { works, medias, sdfs, tweens, theme })
  water.reducedMotion = reduced
  makeWaterTarget()
  water.resize(viewW, viewH)
  progress(0.78)
  await nextFrame()

  await jar.build({ labelChar: site.jarLabel, labelFont: FONT_BRUSH, waterTexture: waterRT.texture, theme })
  jar.resize(viewW, viewH, dpr)
  progress(0.9)
  await nextFrame()

  // 预先编译着色器、渲染一帧，避免第一次交互时卡顿
  water.update(1 / 60, {})
  water.render(waterRT)
  renderer.compile(jar.scene, jar.camera)
  renderer.compile(water.scene, water.camera)
  progress(1)
}

// 坛中水面的三档分辨率：酒坛在远处时液面只有几十个像素，没必要按全屏去画。
// 小的两档带 mipmap，缩小显示时不闪烁；推到近处才换成与屏幕等大的那张，保证交接无缝。
const waterTargets = []
const WATER_LEVELS = [
  { scale: 0.25, until: 0.22 },
  { scale: 0.5, until: 0.46 },
  { scale: 1, until: Infinity },
]

function makeWaterTarget() {
  const w = Math.max(1, Math.round(viewW * dpr))
  const h = Math.max(1, Math.round(viewH * dpr))
  WATER_LEVELS.forEach((level, i) => {
    const lw = Math.max(1, Math.round(w * level.scale))
    const lh = Math.max(1, Math.round(h * level.scale))
    if (!waterTargets[i]) {
      const mip = level.scale < 1
      waterTargets[i] = new THREE.WebGLRenderTarget(lw, lh, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: mip,
        minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      })
      waterTargets[i].texture.colorSpace = THREE.NoColorSpace
    } else {
      waterTargets[i].setSize(lw, lh)
    }
  })
  waterRT = waterTargets[waterTargets.length - 1]
}

function waterTargetFor(fraction) {
  const i = WATER_LEVELS.findIndex((level) => fraction < level.until)
  return waterTargets[i]
}

function resize() {
  viewW = window.innerWidth
  viewH = window.innerHeight
  dpr = quality.dpr()
  renderer.setPixelRatio(dpr)
  renderer.setSize(viewW, viewH)
  ui.setPortrait(viewH > viewW * 1.1)
  if (water) {
    makeWaterTarget()
    water.resize(viewW, viewH)
  }
  jar.resize(viewW, viewH, dpr)
  if (state.scene === 'jar') ui.placeJarButton(jar.screenBounds())
  if (state.scene === 'focus' && state.focused >= 0) {
    const f = water.field
    f.frame = f.computeFrame(medias[state.focused].stageAspect || 16 / 9)
    f.glyphs[state.focused].u.uFrame.value.set(f.frame.hw, f.frame.hh)
    ui.placeFrame(frameToScreen(f.frame))
  }
}

function frameToScreen(f) {
  return {
    x: viewW / 2 + f.cx - f.hw,
    y: viewH / 2 - f.cy - f.hh,
    width: f.hw * 2,
    height: f.hh * 2,
    mode: f.mode,
    portrait: f.portrait,
  }
}

// —— 交互 ——

function onClick(e) {
  if (state.scene === 'jar') {
    if (jar.hitJar(e.clientX, e.clientY)) dive()
  } else if (state.scene === 'water') {
    const idx = water.pick(e.clientX, e.clientY)
    if (idx >= 0) openWork(idx)
    else {
      const p = water.toWater(e.clientX, e.clientY)
      water.drop(p.x, p.y, 0.9, 20)
    }
  } else if (state.scene === 'focus') {
    const f = frameToScreen(water.field.frame)
    const inside = e.clientX > f.x && e.clientX < f.x + f.width && e.clientY > f.y && e.clientY < f.y + f.height
    if (!inside) closeWork()
  }
}

function onKey(e) {
  if (state.scene !== 'focus') return
  if (e.key === 'Escape') closeWork()
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') tour.next()
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') tour.prev()
}

async function dive() {
  if (state.scene !== 'jar') return
  setScene('diving')
  ui.setPointerCursor(false)
  const duration = reduced ? 1.8 : 4.8
  // 摄像机到坛口正上方时，水面上落下一滴
  tweens.run(0, () => water.drop(0, 0, 1.4, 34), { delay: duration * 0.55 })
  await tweens.run(duration, (t) => (jar.dive = t), { ease: ease.linear })
  setScene('water')
  ui.showWaterHint(pointer.isTouch)
}

async function surface() {
  if (state.scene !== 'water') return
  setScene('surfacing')
  water.field.setHovered(-1)
  ui.setPointerCursor(false)
  await tweens.run(reduced ? 1.5 : 3.8, (t) => (jar.dive = 1 - t), { ease: ease.linear })
  ui.placeJarButton(jar.screenBounds())
  setScene('jar')
}

async function openWork(i) {
  if (state.scene !== 'water' || water.field.focusing) return
  state.focused = i
  setScene('focus')
  ui.setPointerCursor(false)
  const g = water.field.glyphs[i]
  water.drop(g.center.x, g.center.y, 0.7, 40)
  const frame = water.field.computeFrame(medias[i].stageAspect || 16 / 9)
  ui.openWork(works[i], medias[i], frameToScreen(frame))
  ui.showClue(-1)
  tour.start(works[i])
  await water.field.open(i)
}

async function closeWork() {
  if (state.scene !== 'focus' || water.field.focusing) return
  setScene('closing')
  tour.stop()
  water.field.setView(state.focused)
  ui.closeWork()
  await water.field.close()
  state.focused = -1
  setScene('water')
}

function toggleSound() {
  const m = medias[state.focused]
  if (!m) return
  m.setMuted(!m.muted)
  ui.updateSoundLabel(m)
}

// —— 主循环 ——

let last = performance.now()
let lastPointerX = -1
let lastPointerY = -1

function loop(now) {
  requestAnimationFrame(loop)
  const raw = Math.max(0, (now - last) / 1000)
  const dt = Math.min(0.05, raw)
  last = now
  if (quality.update(raw)) resize()
  quality.begin()
  frame(dt)
  quality.end()
}

function frame(dt) {
  state.elapsed += dt
  tweens.update(dt)
  const seg = pointer.frame(dt)

  // 白线至少用 1.6 秒画满：加载再快，开场也有一个从容的起笔
  const lineTarget = Math.min(state.load, state.elapsed / 1.6)
  jar.lineProgress = damp(jar.lineProgress, lineTarget, reduced ? 12 : 3.2, dt)

  if (!water) {
    jar.update(dt)
    jar.render()
    return
  }

  if (WATER_SCENES.has(state.scene)) {
    water.update(dt, { seg, pointer, interactive: true })
    water.render(null)
    updateWaterUI(dt)
    return
  }

  // 酒坛场景：水面画进纹理，贴到坛中液面上
  if (state.scene === 'jar') {
    const moved = pointer.x !== lastPointerX || pointer.y !== lastPointerY
    if (moved) {
      state.jarHover = pointer.inside && jar.hitJar(pointer.x, pointer.y)
      ui.setPointerCursor(state.jarHover)
      lastPointerX = pointer.x
      lastPointerY = pointer.y
    }
  } else {
    state.jarHover = false
  }
  jar.hover = damp(jar.hover, state.jarHover ? 1 : 0, 5, dt)
  water.update(dt, {})
  jar.update(dt)
  const target = waterTargetFor(jar.liquidScreenFraction())
  water.render(target)
  jar.setWaterTexture(target.texture)
  jar.render()
}

let uiFrame = 0
function updateWaterUI(dt) {
  const rects = works.map((_, i) => water.glyphScreenRect(i))
  // 这些按钮只在键盘聚焦时可见，不必每帧挪动它们
  if (uiFrame++ % 12 === 0 || ui.workButtons.includes(document.activeElement)) ui.placeWorkButtons(rects)
  if (state.scene === 'water' && !pointer.isTouch) {
    const picked = pointer.inside ? water.pick(pointer.x, pointer.y) : -1
    // 键盘焦点落在某件作品上时，也让它浮起来、显示标题
    const idx = picked >= 0 ? picked : ui.workButtons.indexOf(document.activeElement)
    water.field.setHovered(idx)
    ui.setHover(idx, idx >= 0 ? rects[idx] : null)
    ui.setPointerCursor(picked >= 0)
  } else if (state.scene !== 'water') {
    water.field.setHovered(-1)
  }
  if (state.scene === 'focus' && state.focused >= 0) {
    tour.update(dt)
    ui.updateSoundLabel(medias[state.focused])
  }
}

// 开发环境的调试入口（构建后不会存在）
if (import.meta.env.DEV) {
  window.__hz = {
    state,
    get jar() {
      return jar
    },
    get water() {
      return water
    },
    get quality() {
      return quality
    },
    resize,
    dive,
    surface,
    openWork,
    closeWork,
    // 基准测试：连续渲染 n 帧，每帧等 GPU 做完，返回每帧平均耗时（毫秒）
    bench(mode = 'water', n = 40) {
      const gl = renderer.getContext()
      const step = () => {
        if (mode === 'none') return
        if (mode === 'water') {
          water.update(1 / 60, {})
          water.render(null)
        } else {
          water.update(1 / 60, {})
          jar.update(1 / 60)
          const target = waterTargetFor(jar.liquidScreenFraction())
          water.render(target)
          jar.setWaterTexture(target.texture)
          jar.render()
        }
      }
      // 读回一个像素会强制等 GPU 把之前的命令全部做完（gl.finish 在 Chrome 里不等）
      const px = new Uint8Array(4)
      const sync = () => {
        renderer.setRenderTarget(null)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      }
      for (let i = 0; i < 6; i++) step()
      sync()
      // 测三轮取最快的一轮，排除后台抖动
      let best = Infinity
      for (let round = 0; round < 3; round++) {
        const t0 = performance.now()
        for (let i = 0; i < n; i++) {
          step()
          sync()
        }
        best = Math.min(best, (performance.now() - t0) / n)
      }
      return +best.toFixed(2)
    },
  }
}
