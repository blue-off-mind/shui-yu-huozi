import * as THREE from 'three'
import { mulberry32 } from '../core/math.js'

// 藻荇交横，盖竹柏影也。
// 用 canvas 画一张竹影：两根斜穿画面的竹竿、竹节上分出的细枝、枝头成簇的竹叶，
// 再从底边飘上来几缕水藻。画面中央留空，让活字看得清楚。
// 白色 = 影子浓，透明 = 无影。画完缩小一半，靠缩放和 mipmap 让边缘变柔。

function leaf(ctx, x, y, angle, len, width) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  // 叶基窄、三分之一处最宽、叶尖收成一点
  ctx.quadraticCurveTo(len * 0.32, -width, len, 0)
  ctx.quadraticCurveTo(len * 0.36, width * 0.85, 0, 0)
  ctx.fill()
  ctx.restore()
}

function stalk(ctx, x0, y0, x1, y1, width, rand) {
  const n = 5 + Math.floor(rand() * 3)
  const nodes = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    nodes.push([x0 + (x1 - x0) * t + (rand() - 0.5) * 6, y0 + (y1 - y0) * t])
  }
  ctx.lineWidth = width
  ctx.lineCap = 'butt'
  for (let i = 0; i < n; i++) {
    const [ax, ay] = nodes[i]
    const [bx, by] = nodes[i + 1]
    // 竹节处留一道细缝
    const gap = 0.035
    ctx.beginPath()
    ctx.moveTo(ax + (bx - ax) * gap, ay + (by - ay) * gap)
    ctx.lineTo(bx - (bx - ax) * gap, by - (by - ay) * gap)
    ctx.stroke()
  }
  return nodes
}

function cluster(ctx, x, y, dir, size, rand) {
  const count = 3 + Math.floor(rand() * 3)
  const spread = 0.9 + rand() * 0.5
  for (let i = 0; i < count; i++) {
    const a = dir + (i / (count - 1) - 0.5) * spread + (rand() - 0.5) * 0.18
    const len = size * (0.75 + rand() * 0.5)
    leaf(ctx, x, y, a, len, len * (0.1 + rand() * 0.03))
  }
}

function branch(ctx, x, y, angle, len, rand, size) {
  const ex = x + Math.cos(angle) * len
  const ey = y + Math.sin(angle) * len
  ctx.lineWidth = 2.5 + rand() * 2
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.quadraticCurveTo((x + ex) / 2 + (rand() - 0.5) * 30, (y + ey) / 2 + (rand() - 0.5) * 30, ex, ey)
  ctx.stroke()
  cluster(ctx, ex, ey, angle + (rand() - 0.5) * 0.6, size, rand)
  // 枝条中途再生一簇
  if (rand() > 0.4) {
    const t = 0.45 + rand() * 0.25
    cluster(ctx, x + (ex - x) * t, y + (ey - y) * t, angle + (rand() > 0.5 ? 0.9 : -0.9), size * 0.8, rand)
  }
}

function weed(ctx, x, y, height, rand) {
  ctx.lineWidth = 2 + rand() * 2.5
  ctx.beginPath()
  ctx.moveTo(x, y)
  const steps = 24
  const phase = rand() * 6.28
  const amp = 14 + rand() * 22
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    ctx.lineTo(x + Math.sin(t * 5.5 + phase) * amp * t, y - height * t)
  }
  ctx.stroke()
}

export function createBambooShadow(size = 1024) {
  const rand = mulberry32(512)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  const S = size

  // 左边一根竹竿，从左上斜到下方；右边一根，从右上斜下
  const left = stalk(ctx, -S * 0.06, S * 0.1, S * 0.36, S * 1.06, S * 0.018, rand)
  const right = stalk(ctx, S * 1.06, -S * 0.04, S * 0.74, S * 1.04, S * 0.015, rand)

  const leafSize = S * 0.12
  // 竹节上分枝，枝头竹叶朝画面外侧和上方伸展，中央尽量留空
  left.slice(1, -1).forEach(([x, y], i) => {
    if (rand() > 0.72) return
    const outward = i % 2 ? Math.PI * 1.05 : -Math.PI * 0.35
    branch(ctx, x, y, outward + (rand() - 0.5) * 0.4, S * (0.08 + rand() * 0.08), rand, leafSize)
  })
  right.slice(1, -1).forEach(([x, y], i) => {
    if (rand() > 0.72) return
    const outward = i % 2 ? -Math.PI * 0.05 : -Math.PI * 0.62
    branch(ctx, x, y, outward + (rand() - 0.5) * 0.4, S * (0.08 + rand() * 0.08), rand, leafSize)
  })
  // 上方垂下来的几簇叶子
  for (let i = 0; i < 4; i++) {
    const x = S * (0.15 + i * 0.22 + (rand() - 0.5) * 0.08)
    cluster(ctx, x, -S * 0.02, Math.PI * (0.42 + (rand() - 0.5) * 0.3), leafSize * 1.1, rand)
  }
  // 底边几缕水藻
  for (let i = 0; i < 5; i++) {
    weed(ctx, S * (0.12 + rand() * 0.76), S * 1.02, S * (0.18 + rand() * 0.2), rand)
  }

  // 缩小一半：边缘自然变柔，也省显存
  const half = document.createElement('canvas')
  half.width = half.height = size / 2
  const hctx = half.getContext('2d')
  hctx.imageSmoothingQuality = 'high'
  hctx.drawImage(c, 0, 0, size / 2, size / 2)

  const tex = new THREE.CanvasTexture(half)
  tex.colorSpace = THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  return tex
}
