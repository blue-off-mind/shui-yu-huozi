// 指针状态：位置（CSS 像素，左上角为原点）、本帧位移、平滑速度
export class Pointer {
  constructor() {
    this.x = window.innerWidth / 2
    this.y = window.innerHeight / 2
    this.prevX = this.x
    this.prevY = this.y
    this.dx = 0
    this.dy = 0
    this.vx = 0
    this.vy = 0
    this.inside = false
    this.moved = false
    this.type = 'mouse'
    this.hasMoved = false

    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: true })
    window.addEventListener('pointerdown', (e) => this.onMove(e, true), { passive: true })
    document.documentElement.addEventListener('pointerleave', () => (this.inside = false))
    window.addEventListener('blur', () => (this.inside = false))
  }

  onMove(e, isDown = false) {
    this.type = e.pointerType || 'mouse'
    // 第一次移动、离开窗口后再回来、触屏按下：都把上一点设为当前点，
    // 避免从旧位置（或屏幕中心）拉出一条长长的涟漪
    if (!this.inside || (isDown && this.type !== 'mouse')) {
      this.prevX = e.clientX
      this.prevY = e.clientY
      this.x = e.clientX
      this.y = e.clientY
      this.inside = true
      return
    }
    this.dx += e.clientX - this.x
    this.dy += e.clientY - this.y
    this.x = e.clientX
    this.y = e.clientY
    this.inside = true
    this.moved = true
    this.hasMoved = true
  }

  // 每帧调用一次：返回本帧的移动线段，并更新速度
  frame(dt) {
    const seg = { x0: this.prevX, y0: this.prevY, x1: this.x, y1: this.y, dx: this.dx, dy: this.dy, moved: this.moved }
    const k = 1 - Math.exp(-dt * 14)
    const ivx = dt > 0 ? this.dx / dt : 0
    const ivy = dt > 0 ? this.dy / dt : 0
    this.vx += (ivx - this.vx) * k
    this.vy += (ivy - this.vy) * k
    this.prevX = this.x
    this.prevY = this.y
    this.dx = 0
    this.dy = 0
    this.moved = false
    return seg
  }

  get isTouch() {
    return this.type === 'touch' || this.type === 'pen'
  }
}
