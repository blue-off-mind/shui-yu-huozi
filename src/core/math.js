export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const invLerp = (a, b, v) => clamp((v - a) / (b - a))
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v)
  return t * t * (3 - 2 * t)
}
// 与帧率无关的指数趋近
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt))

export const ease = {
  linear: (t) => t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inCubic: (t) => t * t * t,
}

// 一段时间内的插值，返回 Promise；由主循环驱动
export class Tweens {
  constructor() {
    this.list = []
  }

  run(duration, onUpdate, { ease: easeFn = ease.inOutCubic, delay = 0 } = {}) {
    let cancel
    const promise = new Promise((resolve) => {
      const tween = { t: -delay, duration: Math.max(duration, 1e-4), onUpdate, easeFn, resolve, done: false }
      cancel = () => {
        tween.done = true
        resolve(false)
      }
      this.list.push(tween)
    })
    promise.cancel = cancel
    return promise
  }

  update(dt) {
    for (const tw of this.list) {
      if (tw.done) continue
      tw.t += dt
      if (tw.t < 0) continue
      const p = Math.min(tw.t / tw.duration, 1)
      tw.onUpdate(tw.easeFn(p), p)
      if (p >= 1) {
        tw.done = true
        tw.resolve(true)
      }
    }
    this.list = this.list.filter((tw) => !tw.done)
  }
}

// 确定性的伪随机数，保证每次打开时活字的布局一致
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 平滑的一维噪声，用于活字的漂移
export function noise1(x, seed = 0) {
  const i = Math.floor(x)
  const f = x - i
  const h = (n) => {
    const s = Math.sin((n + seed * 57.17) * 127.1) * 43758.5453
    return s - Math.floor(s)
  }
  const u = f * f * (3 - 2 * f)
  return lerp(h(i), h(i + 1), u) * 2 - 1
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// 2025 → 二〇二五
export const toHanNumerals = (n) => String(n).replace(/\d/g, (d) => '〇一二三四五六七八九'[d])
