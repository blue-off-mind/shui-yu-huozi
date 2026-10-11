import * as THREE from 'three'

// 把单个汉字画到 canvas 上，再用欧氏距离变换（Felzenszwalb）生成有向距离场。
// R 通道：字形边缘附近的精细距离（用于抗锯齿、景深虚化、浮雕高光）
// G 通道：字形外部的远距离（用于点开时“墨晕”向外扩散）

const INF = 1e20

function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  f[0] = grid[offset]
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]
    const q2 = q * q
    do {
      const r = v[k]
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2
    } while (s <= z[k] && --k > -1)
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++
    const r = v[k]
    const qr = q - r
    grid[offset + q * stride] = f[r] + qr * qr
  }
}

function edt(grid, size) {
  const f = new Float64Array(size)
  const v = new Uint16Array(size)
  const z = new Float64Array(size + 1)
  for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z)
  for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z)
}

/**
 * @param {string} char 单字
 * @param {object} o
 * @param {string} o.fontFamily CSS font-family
 * @param {number} o.weight 字重
 * @param {number} o.size 纹理边长（像素）
 * @param {number} o.pad 字身框外留白（占字身比例）
 */
export function createGlyphSDF(char, { fontFamily, weight = 800, size = 768, pad = 0.18, fineSpread = 24 } = {}) {
  const S = size
  const em = Math.round(S / (1 + 2 * pad))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  ctx.fillStyle = '#fff'
  ctx.font = `${weight} ${em}px ${fontFamily}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // 以字的实际墨迹外框居中，而不是字身框 —— 每个字在水里都“站正”
  const m = ctx.measureText(char)
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
  const x = S / 2 - inkW / 2 + m.actualBoundingBoxLeft
  const y = S / 2 - inkH / 2 + m.actualBoundingBoxAscent
  ctx.fillText(char, x, y)

  const img = ctx.getImageData(0, 0, S, S).data
  const n = S * S
  const outer = new Float64Array(n)
  const inner = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = img[i * 4] / 255
    if (a >= 1) {
      outer[i] = 0
      inner[i] = INF
    } else if (a <= 0) {
      outer[i] = INF
      inner[i] = 0
    } else {
      const d = 0.5 - a
      outer[i] = d > 0 ? d * d : 0
      inner[i] = d < 0 ? d * d : 0
    }
  }
  edt(outer, S)
  edt(inner, S)

  // 上下翻转写入：DataTexture 第 0 行在底部
  const data = new Uint8Array(n * 2)
  const outside = new Float32Array(n) // CPU 端保留一份，用于鼠标命中测试
  for (let row = 0; row < S; row++) {
    for (let col = 0; col < S; col++) {
      const i = row * S + col
      const dOut = Math.sqrt(outer[i])
      const dIn = Math.sqrt(inner[i])
      const sd = dIn - dOut // 内正外负
      const j = (S - 1 - row) * S + col
      data[j * 2] = Math.round(Math.min(1, Math.max(0, 0.5 + sd / (2 * fineSpread))) * 255)
      data[j * 2 + 1] = Math.round(Math.min(1, dOut / S) * 255)
      outside[j] = Math.max(0, dOut - 0.5)
    }
  }

  const texture = new THREE.DataTexture(data, S, S, THREE.RGFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true

  return {
    texture,
    size: S,
    pad,
    fineSpread,
    // 墨迹外框的半宽、半高（以字身为单位）：活字面片只需盖住这么大，不必铺满整个距离场
    inkHalf: [inkW / em / 2, inkH / em / 2],
    // 纹理坐标 (u,v ∈ 0..1，v 向上) 处到字形的距离，单位：纹理像素
    distanceAt(u, v) {
      if (u < 0 || u > 1 || v < 0 || v > 1) return INF
      const col = Math.min(S - 1, Math.max(0, Math.round(u * (S - 1))))
      const row = Math.min(S - 1, Math.max(0, Math.round(v * (S - 1))))
      return outside[row * S + col]
    },
  }
}
