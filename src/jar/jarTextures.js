import * as THREE from 'three'

// 酒坛的程序化贴图：酱黑釉、下半截露胎、口沿一圈素胎（芒口）、拉坯留下的轮旋纹。
// 贴图的 v 方向沿着轮廓线（底心 → 外壁 → 口沿 → 内壁），用 profile 查到每一行对应的高度。

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

// u 方向可循环的数值噪声
function pnoise(x, y, period) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const wrap = (v) => ((v % period) + period) % period
  const a = hash(wrap(xi), yi)
  const b = hash(wrap(xi + 1), yi)
  const c = hash(wrap(xi), yi + 1)
  const d = hash(wrap(xi + 1), yi + 1)
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

function fbm(x, y, period) {
  let s = 0
  let a = 0.5
  let p = period
  for (let i = 0; i < 4; i++) {
    s += a * pnoise(x, y, p)
    x *= 2
    y *= 2
    p *= 2
    a *= 0.5
  }
  return s
}

/**
 * @param {THREE.Vector2[]} profile  (r, y) 轮廓点，等弧长分布
 * @param {number} rimIndex 口沿最高点在 profile 中的下标
 */
// 逐行生成约需一百毫秒，分成若干帧完成，免得开场白线画到一半卡住
export async function createJarTextures(profile, rimIndex, { width = 512, height = 1024 } = {}) {
  const color = document.createElement('canvas')
  const surface = document.createElement('canvas')
  const coat = document.createElement('canvas')
  for (const c of [color, surface, coat]) {
    c.width = width
    c.height = height
  }
  const cctx = color.getContext('2d')
  const sctx = surface.getContext('2d')
  const kctx = coat.getContext('2d')
  const cimg = cctx.createImageData(width, height)
  const simg = sctx.createImageData(width, height)
  const kimg = kctx.createImageData(width, height)

  // 釉线：大致在 0.2 高度，带几道向下的流釉
  const drips = []
  for (let i = 0; i < 9; i++) {
    drips.push({ u: hash(i, 3.1), w: 0.012 + hash(i, 7.7) * 0.03, len: 0.03 + hash(i, 9.3) * 0.09 })
  }
  const glazeLine = (u) => {
    let y = 0.215 + (fbm(u * 8, 0.5, 8) - 0.5) * 0.03
    for (const d of drips) {
      let du = Math.abs(u - d.u)
      du = Math.min(du, 1 - du)
      const t = Math.max(0, 1 - du / d.w)
      y -= d.len * t * t * (3 - 2 * t)
    }
    return y
  }

  const lineAt = new Float32Array(width)
  for (let col = 0; col < width; col++) lineAt[col] = glazeLine(col / width)

  const n = profile.length - 1
  for (let row = 0; row < height; row++) {
    if (row && row % 96 === 0) await new Promise((resolve) => requestAnimationFrame(resolve))
    const v = 1 - row / (height - 1)
    const idx = Math.min(n, Math.max(0, Math.round(v * n)))
    const p = profile[idx]
    const y = p.y
    const inner = idx > rimIndex + 2
    const lipTop = Math.abs(idx - rimIndex) <= 2
    const prev = profile[Math.max(0, idx - 1)]
    const next = profile[Math.min(n, idx + 1)]
    const slope = Math.abs(next.y - prev.y) / Math.max(1e-5, Math.hypot(next.x - prev.x, next.y - prev.y))
    // 肩部平缓处釉层薄，透出一点酱色
    const thin = inner ? 0 : Math.max(0, 1 - slope * 1.6) * (y > 0.6 ? 1 : 0)

    for (let col = 0; col < width; col++) {
      const u = col / width
      const i4 = (row * width + col) * 4
      const grain = hash(col * 0.37 + row * 0.11, row * 0.71) - 0.5
      const mott = fbm(u * 24, y * 40, 24)
      const streak = pnoise(u * 60, y * 3, 60)
      let glazed = !inner && !lipTop && y > lineAt[col]
      if (idx === 0 || y < 0.004) glazed = false

      let r, g, b, rough, cc
      if (inner) {
        // 内壁：哑光的深色素胎。坛子里本该是暗的，不反光，潜入时像一条幽深的通道
        const k = 0.8 + mott * 0.3 + grain * 0.2
        r = 34 * k
        g = 24 * k
        b = 18 * k
        rough = 0.92
        cc = 0
      } else if (glazed) {
        const k = 0.85 + mott * 0.3 + (streak - 0.5) * 0.18
        r = (26 + thin * 46) * k
        g = (17 + thin * 22) * k
        b = (11 + thin * 9) * k
        rough = 0.2 + mott * 0.12
        cc = 1
      } else {
        const k = 0.88 + mott * 0.25 + grain * 0.18
        r = 108 * k
        g = 72 * k
        b = 50 * k
        if (lipTop) {
          r *= 1.08
          g *= 1.06
        }
        rough = 0.86
        cc = 0
      }
      cimg.data[i4] = r
      cimg.data[i4 + 1] = g
      cimg.data[i4 + 2] = b
      cimg.data[i4 + 3] = 255

      // 轮旋纹：素胎上明显，釉下若隐若现
      const rings = Math.sin(y * Math.PI * 2 * 70 + pnoise(u * 6, y * 10, 6) * 3) * 0.5 + 0.5
      const bump = 0.5 + (rings - 0.5) * (glazed ? 0.12 : 0.5) + grain * (glazed ? 0.04 : 0.35)
      simg.data[i4] = bump * 255
      simg.data[i4 + 1] = rough * 255
      simg.data[i4 + 2] = 0
      simg.data[i4 + 3] = 255

      kimg.data[i4] = cc * 255
      kimg.data[i4 + 1] = cc * 255
      kimg.data[i4 + 2] = cc * 255
      kimg.data[i4 + 3] = 255
    }
  }
  cctx.putImageData(cimg, 0, 0)
  sctx.putImageData(simg, 0, 0)
  kctx.putImageData(kimg, 0, 0)

  const make = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.anisotropy = 4
    return t
  }
  return { map: make(color, true), surface: make(surface, false), clearcoat: make(coat, false) }
}

// 斗方：红纸菱形，墨书一字
export function createLabelTexture(char, fontFamily) {
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, S, S)

  ctx.save()
  ctx.translate(S / 2, S / 2)
  ctx.rotate(Math.PI / 4)
  const half = S * 0.335
  // 略不规整的纸边
  ctx.beginPath()
  const steps = 64
  for (let i = 0; i <= steps * 4; i++) {
    const side = Math.floor(i / steps) % 4
    const t = (i % steps) / steps
    const j = (hash(i, 1.3) - 0.5) * 3
    let x, y
    if (side === 0) [x, y] = [-half + t * 2 * half, -half + j]
    else if (side === 1) [x, y] = [half + j, -half + t * 2 * half]
    else if (side === 2) [x, y] = [half - t * 2 * half, half + j]
    else [x, y] = [-half + j, half - t * 2 * half]
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  const grad = ctx.createRadialGradient(0, 0, half * 0.1, 0, 0, half * 1.5)
  grad.addColorStop(0, '#8f2a1c')
  grad.addColorStop(1, '#5c1a12')
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()

  // 纸纤维与褪色
  const img = ctx.getImageData(0, 0, S, S)
  for (let i = 0; i < S * S; i++) {
    const a = img.data[i * 4 + 3]
    if (!a) continue
    const x = i % S
    const y = (i / S) | 0
    const f = 0.9 + (hash(x * 0.9, y * 0.3) - 0.5) * 0.16 + (fbm(x / 40, y / 40, 1e6) - 0.5) * 0.25
    img.data[i * 4] *= f
    img.data[i * 4 + 1] *= f
    img.data[i * 4 + 2] *= f
  }
  ctx.putImageData(img, 0, 0)

  ctx.globalCompositeOperation = 'source-atop'
  ctx.fillStyle = 'rgba(16, 9, 7, 0.93)'
  ctx.font = `${Math.round(S * 0.4)}px ${fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(char, S / 2, S / 2 + S * 0.01)
  ctx.globalCompositeOperation = 'source-over'

  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
