// 按页面实际用到的字裁剪字体，输出到 src/fonts/（由 Vite 打包并加 hash）。
// 中文字体动辄十几 MB，裁剪后只剩几十 KB，也不依赖 Google Fonts，国内可直接访问。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import subsetFont from 'subset-font'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => path.join(root, p)
const load = (p) => import(pathToFileURL(src(p)).href + `?t=${Date.now()}`)

const { site, works } = await load('src/content/works.js')
const { ui } = await load('src/content/ui.js')

// 递归收集对象里的所有字符串
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
const NUMERALS = '〇一二三四五六七八九十'
const PUNCT = '，。、：；！？「」『』《》（）—…·'

const html = (await readFile(src('index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '')
const htmlText = html.replace(/<[^>]+>/g, ' ')

const sets = {
  // 活字：只需要作品的单字
  display: works.map((w) => w.char).join(''),
  // 毛笔短句 + 酒坛上的斗方
  brush: strings(works.map((w) => (w.lines ?? []).map((l) => l.brush))).join('') + site.jarLabel + PUNCT,
  // 界面小字
  serif: strings({ site, works, ui }).join('') + htmlText + NUMERALS + PUNCT + ASCII,
}

const fonts = [
  { name: 'display', file: 'fonts-src/ShipporiMinchoB1-ExtraBold.ttf', text: sets.display },
  { name: 'brush', file: 'fonts-src/ZhiMangXing-Regular.ttf', text: sets.brush },
  {
    name: 'serif',
    file: 'fonts-src/NotoSerifSC-VF.ttf',
    text: sets.serif,
    variationAxes: { wght: { min: 200, max: 900 } },
  },
]

const unique = (s) => [...new Set(Array.from(s))].filter((c) => c.trim() || c === ' ').join('')

await mkdir(src('src/fonts'), { recursive: true })

for (const font of fonts) {
  const text = unique(font.text)
  const buffer = await readFile(src(font.file))
  const out = await subsetFont(buffer, text, {
    targetFormat: 'woff2',
    ...(font.variationAxes ? { variationAxes: font.variationAxes } : {}),
  })
  await writeFile(src(`src/fonts/${font.name}.woff2`), out)
  console.log(`[fonts] ${font.name.padEnd(8)} ${String(Array.from(text).length).padStart(4)} 字  ${(out.length / 1024).toFixed(1)} KB`)
}

// 检查活字是否都在明朝体里（Shippori 收录的是日文字形，部分简体专用字没有）
try {
  const hb = await import('harfbuzzjs')
  const face = new hb.Face(new hb.Blob(await readFile(src(fonts[0].file))))
  const cps = new Set(face.collectUnicodes())
  const missing = Array.from(sets.display).filter((c) => !cps.has(c.codePointAt(0)))
  if (missing.length) {
    console.warn(`[fonts] 明朝体缺字：${missing.join('')} —— 将回退到思源宋体，建议改用繁体 / 日文字形`)
  }
} catch {
  // 只是提示性检查，失败不影响构建
}
