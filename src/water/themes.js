import * as THREE from 'three'

// 两种水：清水（默认）与夜水。在 src/content/works.js 的 site.water 里切换，
// 也可以在网址后面加 ?water=night / ?water=clear 临时对比。

// 水面场景在显示空间里合成，颜色按十六进制原样使用，不做 sRGB → 线性的转换
const raw = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace)

export const themes = {
  // 积水空明：偏蓝的青，中间最透亮，近坛壁渐深；水底有光纹与竹影，活字像沉在水里的实物
  clear: {
    clear: 1,
    shallow: raw(0xa3d9ee),
    mid: raw(0x5cadd1),
    deep: raw(0x226a90),
    light: raw(0xf0fcff), // 水底光纹
    shadow: raw(0x0e3950), // 竹影、字影
    tint: raw(0x7bbfd8), // 深处的活字被水色笼住
    edge: raw(0x1c5876), // 酒坛液面边缘的暗处
    ink: raw(0xebe5d6),
    pool: raw(0x2b7598),
    mouthLight: 0x7cd2ff, // 坛口透出的青光
    grain: 0.05,
  },
  // 夜水：近乎全黑的深水，活字是发着微光的象牙色
  night: {
    clear: 0,
    shallow: new THREE.Color(0x030506),
    mid: new THREE.Color(0x030506),
    deep: new THREE.Color(0x030506),
    light: new THREE.Color(0xffffff),
    shadow: new THREE.Color(0x000000),
    tint: new THREE.Color(0x030506),
    edge: new THREE.Color(0x030506).multiplyScalar(0.5),
    ink: new THREE.Color(0xebe5d6),
    pool: new THREE.Color(0x030506),
    mouthLight: null,
    grain: 0.16,
  },
}

export function resolveTheme(preferred) {
  const fromUrl = new URLSearchParams(location.search).get('water')
  const name = themes[fromUrl] ? fromUrl : themes[preferred] ? preferred : 'clear'
  return { name, ...themes[name] }
}
