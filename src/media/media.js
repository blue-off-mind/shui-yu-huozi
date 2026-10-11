import * as THREE from 'three'
import { generativeFragment } from './generative.js'

// 每件作品的画面来源：
//   cover —— 平时填充在活字里的画面
//   stage —— 点开后播放的“演示视频”
// 有真实图片 / 视频就用真实素材；都没有时，用生成式占位画面。

// 封面只是半透明地填在字里，用不着高分辨率；点开后的“视频”按 30 帧刷新，和真实视频一样
const IDLE_SIZE = [512, 288]
const STAGE_SIZE = [1280, 720]

const vert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// 保持 sRGB 原值：2D 合成全部在显示空间里进行，渲染到纹理再贴回酒坛时颜色不变
function rawColor(texture) {
  texture.colorSpace = THREE.NoColorSpace
  return texture
}

class GenerativeSource {
  constructor(renderer, programId) {
    this.renderer = renderer
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: generativeFragment(programId),
      uniforms: { uTime: { value: 0 }, uResolution: { value: new THREE.Vector2(...IDLE_SIZE) } },
      depthTest: false,
      depthWrite: false,
    })
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
    this.idle = this.makeTarget(...IDLE_SIZE)
    this.stage = null
    // 把高清的“视频”缩到封面上：比再跑一遍生成程序便宜得多
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSource;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture(uSource, vUv).rgb, 1.0); }
      `,
      uniforms: { uSource: { value: null } },
      depthTest: false,
      depthWrite: false,
    })
  }

  copy(source, target) {
    const quad = this.scene.children[0]
    this.copyMat.uniforms.uSource.value = source
    quad.material = this.copyMat
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(prev)
    quad.material = this.material
  }

  makeTarget(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false })
    rawColor(rt.texture)
    return rt
  }

  render(target, time) {
    this.material.uniforms.uTime.value = time
    this.material.uniforms.uResolution.value.set(target.width, target.height)
    const prev = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(prev)
  }
}

// 截图的灰阶范围：取亮度的 0.5% 与 99.8% 分位，双色调前先把它拉开到 0～1。
// 上限要取得很靠边：浅色按钮上的浅色文字、浅底上的激光光斑都在最亮的那一小段里
function measureLevels(image) {
  const w = 160
  const h = Math.max(1, Math.round((w * image.height) / image.width))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    hist[Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)]++
  }
  const total = w * h
  const at = (q) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= total * q) return v / 255
    }
    return 1
  }
  return [at(0.005), at(0.998)]
}

export class WorkMedia {
  constructor(work, renderer) {
    this.work = work
    this.renderer = renderer
    this.clock = Math.random() * 40 // 作品自己的时间轴：平时慢，点开后正常速度
    this.rate = 0.3
    this.focused = false
    this.focusTime = 0
    this.coverAspect = 16 / 9
    this.stageAspect = 16 / 9
    this.stageReady = false
    this.frame = 0
    this.slow = false // 别的作品点开时，这件沉在水底，刷新得更慢

    this.generative = null
    this.image = null
    this.video = null

    this.levels = [0, 1]
    if (work.cover) {
      this.image = rawColor(new THREE.TextureLoader().load(work.cover, (t) => {
        this.coverAspect = t.image.width / t.image.height
        if (!this.video) this.stageAspect = this.coverAspect
        this.levels = measureLevels(t.image)
      }))
      this.image.minFilter = THREE.LinearMipmapLinearFilter
      this.image.anisotropy = 4
    }
    if (work.video) this.createVideo(work.video)
    if (!work.cover && !work.video) {
      this.generative = new GenerativeSource(renderer, work.placeholder)
    }
  }

  createVideo(src) {
    const v = document.createElement('video')
    v.src = src
    v.crossOrigin = 'anonymous'
    v.loop = true
    v.muted = true
    v.playsInline = true
    v.setAttribute('playsinline', '')
    v.preload = this.work.cover ? 'metadata' : 'auto'
    v.addEventListener('loadedmetadata', () => {
      this.stageAspect = v.videoWidth / v.videoHeight || 16 / 9
      if (!this.work.cover) {
        this.coverAspect = this.stageAspect
        // 没有封面图时，用视频里的一帧当封面
        v.currentTime = Math.min(0.5, (v.duration || 1) / 3)
      }
    })
    this.video = v
    this.videoTexture = rawColor(new THREE.VideoTexture(v))
  }

  // 视频是否带音轨（没有音轨就不显示声音按钮）
  get hasAudio() {
    const v = this.video
    if (!v) return false
    if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio
    if (v.audioTracks) return v.audioTracks.length > 0
    if (typeof v.webkitAudioDecodedByteCount === 'number') return v.webkitAudioDecodedByteCount > 0
    return true
  }

  get coverTexture() {
    if (this.image) return this.image
    if (this.video && !this.work.cover) return this.videoTexture
    return this.generative.idle.texture
  }

  get stageTexture() {
    if (this.video) return this.videoTexture
    if (this.generative) return this.generative.stage?.texture ?? this.generative.idle.texture
    return this.image
  }

  // 点开后已播放的时长（用于字幕）
  get currentTime() {
    if (this.video) return this.video.currentTime
    return this.focusTime
  }

  get duration() {
    if (this.video && Number.isFinite(this.video.duration)) return this.video.duration
    return Infinity
  }

  async play({ sound = true } = {}) {
    this.focused = true
    this.focusTime = 0
    if (this.generative && !this.generative.stage) {
      this.generative.stage = this.generative.makeTarget(...STAGE_SIZE)
    }
    if (this.video) {
      this.video.currentTime = 0
      this.video.muted = !sound
      try {
        await this.video.play()
      } catch {
        // 有声自动播放被拦截时，改为静音播放
        this.video.muted = true
        await this.video.play().catch(() => {})
      }
      this.stageReady = true
    } else {
      this.stageReady = true
    }
  }

  pause() {
    this.focused = false
    this.stageReady = false
    if (this.video) this.video.pause()
  }

  setMuted(muted) {
    if (this.video) this.video.muted = muted
  }

  get muted() {
    return this.video ? this.video.muted : true
  }

  // index 用来错开各件作品的刷新帧，避免同一帧里一起渲染
  update(dt, index = 0) {
    this.rate += ((this.focused ? 1 : 0.3) - this.rate) * (1 - Math.exp(-dt * 3))
    this.clock += dt * this.rate
    if (this.focused) this.focusTime += dt
    if (!this.generative) return
    this.frame++
    const gen = this.generative
    const tick = this.frame + index
    if (this.focused && gen.stage) {
      // 点开的那件：高清画面每两帧刷新一次（30 帧），顺手缩一份给封面
      if (tick % 2 === 0) {
        gen.render(gen.stage, this.clock)
        if (tick % 4 === 0) gen.copy(gen.stage.texture, gen.idle)
      }
    } else if (tick % (this.slow ? 8 : 4) === 0) {
      // 平时：封面慢慢流动，每四帧刷新一次就足够顺滑
      gen.render(gen.idle, this.clock)
    }
  }
}
