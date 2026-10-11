// 截图导览：点开作品后，先看全貌，再逐条走过线索，镜头随之移到截图上对应的位置。
// 每条停留的时间按注释长短来定，够读完；讲完一轮回到全貌，稍停后再从头开始。
// index = -1 表示全貌。

const INTRO = 3.4 // 等墨晕铺开
const OUTRO = 5

export class Tour {
  constructor({ onStep }) {
    this.onStep = onStep
    this.work = null
    this.index = -1
    this.t = 0
    this.wait = 0
  }

  start(work) {
    this.work = work
    this.index = -1
    this.t = 0
    this.wait = INTRO
  }

  stop() {
    this.work = null
    this.index = -1
  }

  get count() {
    return this.work?.lines?.length ?? 0
  }

  duration(line) {
    const chars = Array.from(line.note ?? '').length + Array.from(line.brush ?? '').length * 2
    return Math.min(14, Math.max(8, 3.5 + chars * 0.11))
  }

  go(index) {
    if (!this.work || !this.count) return
    const n = this.count
    // 讲完最后一条回到全貌；从全貌往回翻则落到最后一条
    if (index >= n) index = -1
    if (index < -1) index = n - 1
    this.index = index
    this.t = 0
    this.wait = index < 0 ? OUTRO : this.duration(this.work.lines[index])
    this.onStep(index, index < 0 ? null : this.work.lines[index])
  }

  next() {
    this.go(this.index + 1)
  }

  prev() {
    this.go(this.index < 0 ? this.count - 1 : this.index - 1)
  }

  update(dt) {
    if (!this.work || !this.count) return
    this.t += dt
    if (this.t >= this.wait) this.next()
  }
}
