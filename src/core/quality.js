// 渲染分辨率的自动调节：GPU 跟不上时，每次把像素比降 0.25，最低 1 倍。
//
// 判断依据优先用 GPU 计时（EXT_disjoint_timer_query_webgl2，Chrome / Edge 支持）：
// 量的是每帧真实的 GPU 耗时，不会被浏览器的限帧误导——比如 Safari 低电量模式会把
// 帧率锁在 30，但那时 GPU 其实很闲，不该降低清晰度。
// 没有 GPU 计时的浏览器，只在帧率持续低于 24 帧时才降。

const WINDOW = 1.5 // 每 1.5 秒评估一次
const GPU_BUDGET = 11 // 毫秒：给浏览器合成留出余量，仍能稳住 60 帧
const MIN_FPS = 24

export class Quality {
  constructor(gl) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.pending = []
    this.active = null
    this.gpu = []
    this.time = 0
    this.frames = 0
    this.drop = 0
    this.enabled = false
  }

  maxDpr() {
    return Math.min(window.devicePixelRatio || 1, 2)
  }

  dpr() {
    return Math.max(1, this.maxDpr() - this.drop)
  }

  begin() {
    if (!this.enabled || !this.ext || this.active) return
    this.active = this.gl.createQuery()
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active)
  }

  end() {
    if (!this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
  }

  // 取回前几帧已经完成的计时结果
  poll() {
    const { gl, ext } = this
    if (!ext || !this.pending.length) return
    let disjoint = false
    while (this.pending.length) {
      const q = this.pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      if (!disjoint) disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT)
      if (!disjoint) this.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
      gl.deleteQuery(q)
      this.pending.shift()
    }
  }

  // 每帧调用；需要降低分辨率时返回 true
  update(dt) {
    if (!this.enabled || dt > 0.1) return false // 切到后台、偶发卡顿不算
    this.poll()
    this.time += dt
    this.frames++
    if (this.time < WINDOW) return false
    const fps = this.frames / this.time
    const gpu = this.gpu.length ? this.gpu.reduce((a, b) => a + b, 0) / this.gpu.length : null
    this.time = 0
    this.frames = 0
    this.gpu.length = 0
    const slow = gpu !== null ? gpu > GPU_BUDGET : fps < MIN_FPS
    if (slow && this.dpr() > 1) {
      this.drop += 0.25
      return true
    }
    return false
  }
}
