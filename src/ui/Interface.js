import { toHanNumerals } from '../core/math.js'

// 页面上的 DOM 部分：提示、无障碍按钮、悬停说明、作品页的题签与线索

const $ = (sel) => document.querySelector(sel)
const HAN = '一二三四五六七八九十'

export class Interface {
  constructor({ copy, site, works, onOpenWork, onDive, onBack, onClose, onToggleSound, onClue }) {
    this.copy = copy
    this.works = works
    this.work = null
    this.clue = null
    this.clueIndex = -2
    this.hintTimer = null

    document.title = site.author ? `${site.title} · ${site.author}` : site.title
    this.jarButton = $('.jar-button')
    this.jarButton.setAttribute('aria-label', copy.openLabel)
    this.jarButton.addEventListener('click', onDive)
    $('.jar-hint').textContent = copy.openHint

    this.backButton = $('.back-button')
    this.backButton.textContent = copy.backToJar
    this.backButton.addEventListener('click', onBack)
    this.waterHint = $('.water-hint')

    this.closeButton = $('.close-button')
    this.closeButton.textContent = copy.close
    this.closeButton.addEventListener('click', onClose)
    this.soundButton = $('.sound-button')
    this.soundButton.addEventListener('click', onToggleSound)
    this.projectLink = $('.project-link')
    this.projectLink.textContent = copy.viewProject

    this.focusLayer = $('.focus-layer')
    this.focusTitle = $('.focus-title')
    this.focusInfo = $('.focus-info')
    this.clues = $('.clues')
    this.focusStack = $('.focus-stack')
    this.focusSummary = $('.focus-summary')
    this.clueNav = $('.clue-nav')
    this.clueNav.setAttribute('aria-label', copy.cluesLabel)
    this.onClue = onClue

    this.hoverCaption = $('.hover-caption')
    this.hoverTitle = $('.hover-title')
    this.hoverInfo = $('.hover-info')
    this.hoverStack = $('.hover-stack')
    this.hoverIndex = -1

    const nav = $('.works-nav')
    nav.setAttribute('aria-label', copy.worksLabel)
    this.workButtons = works.map((w, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-label', `${w.title}，${w.year}，${w.role}`)
      b.addEventListener('click', () => onOpenWork(i))
      nav.appendChild(b)
      return b
    })
  }

  setScene(name) {
    document.body.dataset.scene = name
    if (name !== 'water') this.setHover(-1)
  }

  setPointerCursor(on) {
    document.body.classList.toggle('is-pointer', on)
  }

  setPortrait(on) {
    document.body.classList.toggle('is-portrait', on)
  }

  showWaterHint(isTouch) {
    this.waterHint.textContent = isTouch ? this.copy.waterHintTouch : this.copy.waterHint
    this.waterHint.classList.remove('is-gone')
    clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(() => this.hideWaterHint(), 12000)
  }

  hideWaterHint() {
    this.waterHint.classList.add('is-gone')
  }

  placeJarButton(b) {
    const s = this.jarButton.style
    s.width = `${b.width}px`
    s.height = `${b.height}px`
    s.transform = `translate(${b.x}px, ${b.y}px)`
  }

  placeWorkButtons(rects) {
    rects.forEach((r, i) => {
      const s = this.workButtons[i].style
      const size = r.size * 0.9
      s.width = s.height = `${size}px`
      s.transform = `translate(${r.x - size / 2}px, ${r.y - size / 2}px)`
    })
  }

  setHover(index, rect) {
    if (index !== this.hoverIndex) {
      this.hoverIndex = index
      if (index >= 0) {
        const w = this.works[index]
        this.hoverTitle.textContent = w.title
        this.hoverInfo.textContent = `${toHanNumerals(w.year)}　${w.role}`
        this.hoverStack.textContent = (w.stack ?? []).join(' · ')
      }
      this.hoverCaption.classList.toggle('is-visible', index >= 0)
    }
    if (index >= 0 && rect) {
      // 竖排说明从字的右上角往下排；太靠下时整体上移，不让它跑出屏幕
      const height = this.hoverCaption.offsetHeight
      const x = Math.min(rect.x + rect.size * 0.56, window.innerWidth - 90)
      const y = Math.max(16, Math.min(rect.y - rect.size * 0.46, window.innerHeight - height - 24))
      this.hoverCaption.style.transform = `translate(${x}px, ${y}px)`
    }
  }

  // frame：画框在屏幕上的矩形（CSS 像素）与排版方式
  openWork(work, media, frame) {
    this.work = work
    this.focusTitle.textContent = `《${work.title}》`
    this.focusInfo.textContent = `${toHanNumerals(work.year)}　${work.role}`
    this.focusStack.textContent = (work.stack ?? []).join(' · ')
    this.focusSummary.textContent = work.summary ?? ''

    this.clues.replaceChildren()
    this.clue = null
    this.clueIndex = -2
    this.clueNav.replaceChildren(
      ...(work.lines ?? []).map((line, i) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = HAN[i] ?? String(i + 1)
        b.setAttribute('aria-label', `第${HAN[i] ?? i + 1}条：${line.brush}`)
        b.addEventListener('click', () => this.onClue(i))
        return b
      }),
    )
    this.placeFrame(frame)

    this.updateSoundLabel(media)
    if (work.link) {
      this.projectLink.hidden = false
      this.projectLink.href = work.link
    } else {
      this.projectLink.hidden = true
    }
    this.hideWaterHint()
  }

  // 题签、线索、按钮都以画框为参照摆放
  placeFrame(frame) {
    this.setPortrait(frame.portrait)
    document.body.classList.toggle('focus-side', frame.mode === 'side')
    document.body.classList.toggle('focus-below', frame.mode !== 'side')
    const st = this.focusLayer.style
    st.setProperty('--fx', `${frame.x}px`)
    st.setProperty('--fy', `${frame.y}px`)
    st.setProperty('--fw', `${frame.width}px`)
    st.setProperty('--fh', `${frame.height}px`)
    // 毛笔字号：竖排时最长的一句恰好放进画框的高度，横排时放进画框的宽度
    const longest = Math.max(1, ...(this.work?.lines ?? []).map((l) => Array.from(l.brush).length))
    const size =
      frame.mode === 'side'
        ? Math.min(38, Math.max(22, (frame.height * 0.62) / longest / 1.12))
        : Math.min(frame.portrait ? 24 : 32, Math.max(19, (frame.width * 0.6) / longest / 1.08))
    st.setProperty('--brush-size', `${size.toFixed(1)}px`)
  }

  // 切换到第 index 条线索（-1 表示全貌，只留简介）
  showClue(index) {
    if (index === this.clueIndex) return
    this.clueIndex = index
    ;[...this.clueNav.children].forEach((b, i) => b.setAttribute('aria-current', i === index ? 'true' : 'false'))
    if (this.clue) {
      const old = this.clue
      old.classList.remove('is-in')
      old.classList.add('is-out')
      setTimeout(() => old.remove(), 900)
      this.clue = null
    }
    this.focusLayer.classList.toggle('is-overview', index < 0)
    const line = this.work?.lines?.[index]
    if (!line) return
    const el = document.createElement('div')
    el.className = 'clue'
    const brush = document.createElement('p')
    brush.className = 'clue-brush'
    brush.textContent = line.brush
    const note = document.createElement('p')
    note.className = 'clue-note'
    note.textContent = line.note
    el.append(brush, note)
    this.clues.appendChild(el)
    // 下一帧再加 class，让过渡生效
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')))
    this.clue = el
  }

  // 按钮写的是点下去会发生什么
  updateSoundLabel(media) {
    const label = media.muted ? this.copy.unmute : this.copy.mute
    if (this.soundButton.textContent !== label) this.soundButton.textContent = label
    this.soundButton.hidden = !media.hasAudio
  }

  closeWork() {
    this.showClue(-1)
    this.work = null
  }

  showFallback(works) {
    const box = $('.fallback')
    box.hidden = false
    $('.fallback-message').textContent = this.copy.webglError
    const list = $('.fallback-list')
    for (const w of works) {
      const li = document.createElement('li')
      li.textContent = `${w.char}　《${w.title}》`
      const span = document.createElement('span')
      span.textContent = `${toHanNumerals(w.year)}　${w.role}`
      li.appendChild(span)
      if (w.summary) {
        const p = document.createElement('p')
        p.textContent = w.summary
        li.appendChild(p)
      }
      list.appendChild(li)
    }
    document.body.dataset.scene = 'fallback'
  }
}
