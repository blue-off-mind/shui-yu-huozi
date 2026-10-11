import * as THREE from 'three'
import { createJarTextures, createLabelTexture } from './jarTextures.js'
import { clamp, lerp, ease, smoothstep } from '../core/math.js'

// 开场：全黑，摄像机从斜上方 45° 看画面正中的酒坛，一条白线横过画面中点，藏在坛后。
// 点击后：摄像机沿圆周升到坛口正上方，再前推，坛里的水面铺满画面，交给水面场景。

const FOV = 30
const TARGET = new THREE.Vector3(0, 0.5, 0)
const START = Math.PI / 4
const JAR_SCREEN_HEIGHT = 0.3
// 水位在坛腹最宽处稍下：45° 斜看时视线被坛颈挡住，首页看不到坛里；点开后从正上方才望得见
const LIQUID_Y = 0.45
const X_AXIS = new THREE.Vector3(1, 0, 0)

// 酒坛轮廓 (半径, 高度)：底心 → 外壁 → 卷唇 → 坛颈内壁 → 坛肩、坛腹内壁（一直到水面以下）
const PROFILE = [
  [0.0, 0.0],
  [0.1, 0.0],
  [0.178, 0.0],
  [0.19, 0.006],
  [0.198, 0.022],
  [0.218, 0.068],
  [0.25, 0.14],
  [0.286, 0.23],
  [0.317, 0.33],
  [0.338, 0.43],
  [0.35, 0.515],
  [0.352, 0.578],
  [0.343, 0.645],
  [0.32, 0.71],
  [0.282, 0.77],
  [0.235, 0.82],
  [0.19, 0.856],
  [0.16, 0.878],
  [0.147, 0.895],
  [0.142, 0.918],
  [0.144, 0.943],
  [0.151, 0.961],
  [0.159, 0.975],
  [0.1625, 0.988],
  [0.159, 0.998],
  [0.149, 1.003],
  [0.138, 1.0],
  [0.13, 0.99],
  [0.126, 0.97],
  [0.124, 0.94],
  [0.123, 0.9],
  [0.128, 0.878],
  [0.152, 0.858],
  [0.2, 0.826],
  [0.252, 0.78],
  [0.294, 0.72],
  [0.319, 0.655],
  [0.33, 0.585],
  [0.33, 0.515],
  [0.318, 0.43],
  [0.3, 0.37],
]

// 白线只画在它所在的一条窄带上，而不是铺满整个屏幕
const lineVert = /* glsl */ `
  uniform float uY;
  uniform float uBand;
  void main() { gl_Position = vec4(position.x, uY + position.y * uBand, 0.0, 1.0); }
`

const lineFrag = /* glsl */ `
  uniform float uY;
  uniform float uProgress;
  uniform float uOpacity;
  uniform vec2 uResolution;
  uniform float uDpr;
  void main() {
    float yPx = (uY * 0.5 + 0.5) * uResolution.y;
    float d = abs(gl_FragCoord.y - yPx) / uDpr;
    float core = 1.0 - smoothstep(0.3, 0.9, d);
    float glow = exp(-d * d / 14.0) * 0.1;
    float x = abs(gl_FragCoord.x / uResolution.x - 0.5) * 2.0;
    float reach = 1.0 - smoothstep(uProgress - 0.04, uProgress, x);
    reach *= step(0.0005, uProgress);
    gl_FragColor = vec4(vec3(0.96, 0.955, 0.94) * (core + glow) * reach * uOpacity, 1.0);
  }
`

const liquidVert = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vWorld;
  void main() {
    vLocal = position.xy;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

// 坛中液面：直接贴上水面场景的画面。映射关系保证摄像机停在终点时，
// 液面上的画面与屏幕逐像素重合，于是可以无缝切换到水面场景。
const liquidFrag = /* glsl */ `
  uniform sampler2D uWaterTex;
  uniform vec2 uMapSize;
  uniform float uRadius;
  uniform float uEffects;
  uniform float uEdgeFade;
  uniform float uIntro;
  uniform vec3 uEdge;
  varying vec2 vLocal;
  varying vec3 vWorld;
  void main() {
    vec2 uv = 0.5 + vLocal / uMapSize;
    vec3 col = texture(uWaterTex, clamp(uv, 0.0, 1.0)).rgb;
    // 贴图矩形的边缘柔和地融进暗处；再叠一层圆形的明暗：靠坛壁渐暗，远看是一汪圆形的亮水。
    // 推到终点时这两层过渡都归零，与水面场景逐像素一致
    float ex = min(uv.x, 1.0 - uv.x) * uMapSize.x / uMapSize.y;
    float ey = min(uv.y, 1.0 - uv.y);
    float edge = smoothstep(0.0, 0.2, min(ex, ey));
    edge *= smoothstep(1.0, 0.45, length(vLocal) / uRadius);
    col = mix(uEdge, col, mix(1.0, edge, uEdgeFade));
    float r = length(vLocal) / uRadius;
    float wall = mix(1.0, 0.25 + 0.75 * smoothstep(1.0, 0.55, r), uEffects);
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0) * 0.5 * uEffects;
    col = col * wall + vec3(0.75, 0.78, 0.82) * fres * 0.25;
    gl_FragColor = vec4(col * uIntro, 1.0);
  }
`

export class JarScene {
  constructor(renderer) {
    this.renderer = renderer
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 200)
    this.dive = 0
    this.intro = 0
    this.lineProgress = 0
    this.lineOpacity = 1
    this.hover = 0
    this.radius = 4
    this.endRadius = 1
    this.raycaster = new THREE.Raycaster()
    this.ndc = new THREE.Vector2()
    this.time = 0
    this.built = false
    this._tmpA = new THREE.Vector3()
    this._tmpB = new THREE.Vector3()

    // —— 白线：加载时它就是进度条，从中点向两侧画开 ——
    // 不设 transparent：透明队列总在不透明物体之后绘制，白线就会盖到酒坛前面。
    // 放进不透明队列最先画、不写深度，用加色混合叠在黑底上，坛身随后把它挡住。
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: lineVert,
      fragmentShader: lineFrag,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uY: { value: 0 },
        uBand: { value: 0.03 },
        uProgress: { value: 0 },
        uOpacity: { value: 1 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
      },
    })
    const line = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lineMat)
    line.frustumCulled = false
    line.renderOrder = -1
    this.scene.add(line)
    this.placeCamera(START, this.radius)
  }

  async build({ labelChar, labelFont, waterTexture, theme }) {
    this.theme = theme
    const curve = new THREE.SplineCurve(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)))
    const pts = curve.getSpacedPoints(360)
    let rimIndex = 0
    pts.forEach((p, i) => {
      if (p.y > pts[rimIndex].y) rimIndex = i
    })
    this.profile = pts

    // —— 坛身 ——
    const tex = await createJarTextures(pts, rimIndex)
    const body = new THREE.Mesh(
      new THREE.LatheGeometry(pts, 180),
      new THREE.MeshPhysicalMaterial({
        map: tex.map,
        roughnessMap: tex.surface,
        roughness: 1,
        bumpMap: tex.surface,
        bumpScale: 0.35,
        clearcoat: 1,
        clearcoatMap: tex.clearcoat,
        clearcoatRoughness: 0.06,
        metalness: 0,
        ior: 1.5,
      }),
    )
    this.body = body
    this.scene.add(body)

    // —— 斗方 ——
    const labelPts = pts.filter((p, i) => i < rimIndex && p.y > 0.395 && p.y < 0.675).map((p) => new THREE.Vector2(p.x + 0.0028, p.y))
    let arc = 0
    for (let i = 1; i < labelPts.length; i++) arc += labelPts[i].distanceTo(labelPts[i - 1])
    const meanR = labelPts.reduce((s, p) => s + p.x, 0) / labelPts.length
    const span = arc / meanR
    const center = -0.22
    const label = new THREE.Mesh(
      new THREE.LatheGeometry(labelPts, 48, center - span / 2, span),
      new THREE.MeshStandardMaterial({
        map: createLabelTexture(labelChar, labelFont),
        alphaTest: 0.5,
        alphaToCoverage: true,
        roughness: 0.8,
        metalness: 0,
      }),
    )
    this.label = label
    this.scene.add(label)

    // —— 颈部麻绳：两股拧在一起 ——
    const neckY = 0.912
    let neckR = 0.144
    for (let i = 0; i < rimIndex; i++) {
      if (pts[i].y > neckY) {
        neckR = pts[i].x
        break
      }
    }
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1d, roughness: 0.95, metalness: 0 })
    for (const phase of [0, Math.PI]) {
      const a = 0.0042
      const path = new THREE.Curve()
      path.getPoint = (t, target = new THREE.Vector3()) => {
        const th = t * Math.PI * 2
        const tw = th * 46 + phase
        const rr = neckR + a + 0.0006 + a * Math.cos(tw)
        return target.set(Math.sin(th) * rr, neckY + a * Math.sin(tw), Math.cos(th) * rr)
      }
      const rope = new THREE.Mesh(new THREE.TubeGeometry(path, 900, a * 0.95, 6, true), ropeMat)
      this.scene.add(rope)
    }

    // —— 液面 ——
    let liquidR = 0.125
    for (let i = rimIndex; i < pts.length; i++) {
      if (pts[i].y <= LIQUID_Y) {
        liquidR = pts[i].x
        break
      }
    }
    this.liquidR = liquidR
    // 水面以上的内壁（含坛颈与卷唇内侧），用来求摄像机终点
    this.innerWall = pts.filter((p, i) => i > rimIndex && p.y >= LIQUID_Y)
    this.liquidMat = new THREE.ShaderMaterial({
      vertexShader: liquidVert,
      fragmentShader: liquidFrag,
      uniforms: {
        uWaterTex: { value: waterTexture },
        uMapSize: { value: new THREE.Vector2(0.2, 0.1) },
        uRadius: { value: liquidR },
        uEffects: { value: 1 },
        uEdgeFade: { value: 1 },
        uIntro: { value: 0 },
        uEdge: { value: theme.edge },
      },
    })
    const liquid = new THREE.Mesh(new THREE.CircleGeometry(liquidR + 0.004, 128), this.liquidMat)
    liquid.rotation.x = -Math.PI / 2
    liquid.position.y = LIQUID_Y
    this.liquid = liquid
    this.scene.add(liquid)

    // —— 光 ——
    this.scene.environment = this.buildEnvironment()
    this.scene.environmentIntensity = 0
    this.key = new THREE.DirectionalLight(0xffe6cc, 0)
    this.key.position.set(-2.2, 3.2, 2.4)
    this.rim = new THREE.DirectionalLight(0xdfe7ff, 0)
    this.rim.position.set(1.6, 2.4, -3)
    this.fill = new THREE.DirectionalLight(0xffffff, 0)
    this.fill.position.set(2.5, 0.6, 2)
    this.scene.add(this.key, this.rim, this.fill)
    // 清水：水面上方一盏青光，照亮坛肩内壁。首页从斜上方看不到，潜入坛颈时才渐渐亮起来
    if (theme.mouthLight) {
      this.mouthLight = new THREE.PointLight(theme.mouthLight, 0, 0.6, 2)
      this.mouthLight.position.set(0, LIQUID_Y + 0.12, 0)
      this.scene.add(this.mouthLight)
    }

    // 射线检测用的低模（高模每帧逐三角形检测太慢）
    const proxy = new THREE.Mesh(
      new THREE.LatheGeometry(pts.filter((_, i) => i % 8 === 0 || i === rimIndex), 24),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    )
    this.scene.add(proxy)
    this.pickables = [proxy]
    this.built = true
    if (this.w) this.resize(this.w, this.h, this.dpr)
  }

  // 环境光：一圈细亮的“地平线”（与白线同一束光，在釉面上反射成一道横亮线）、顶上一块柔光、背后一道轮廓光
  buildEnvironment() {
    const env = new THREE.Scene()
    env.background = new THREE.Color(0x000000)
    const emissive = (v) => new THREE.MeshBasicMaterial({ color: new THREE.Color(v, v, v), side: THREE.DoubleSide })
    // 坛后的一段“地平线”：与白线同方向，在釉面边缘留下细细一道横光
    const arc = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 0.6, 64, 1, true, Math.PI - 0.9, 1.8),
      emissive(4),
    )
    arc.position.y = 30 * Math.tan((6 * Math.PI) / 180)
    env.add(arc)
    // 左前方竖向柔光条：坛身左侧一道长高光
    const left = new THREE.Mesh(new THREE.PlaneGeometry(5, 26), emissive(2.6))
    left.position.set(-24, 6, 14)
    left.lookAt(0, 4, 0)
    env.add(left)
    // 右后方弱一些的柔光条：右侧轮廓
    const right = new THREE.Mesh(new THREE.PlaneGeometry(4, 22), emissive(1.3))
    right.position.set(24, 4, -10)
    right.lookAt(0, 4, 0)
    env.add(right)
    // 极弱的地面反光：让坛身下半截的轮廓不至于完全沉进黑里
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48), emissive(0.12))
    floor.position.y = -12
    floor.rotation.x = -Math.PI / 2
    env.add(floor)
    // 顶光：肩部与口沿
    const top = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), emissive(0.35))
    top.position.y = 28
    top.rotation.x = Math.PI / 2
    env.add(top)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const rt = pmrem.fromScene(env, 0.012)
    pmrem.dispose()
    return rt.texture
  }

  resize(w, h, dpr) {
    this.w = w
    this.h = h
    this.dpr = dpr
    const aspect = w / h
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.lineMat.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.lineMat.uniforms.uDpr.value = dpr
    this.lineMat.uniforms.uBand.value = 32 / h // 上下各 16 个 CSS 像素，够放下线和它的光晕
    if (!this.built) return

    // 终点：视锥要整个穿过坛颈、落在液面上时恰好与屏幕等大，四角都不能碰到内壁。
    // 沿内壁逐高度检查：高度 y 处视锥的半对角线 (yCam − y)·tan(fov/2)·√(1+宽高比²) 必须小于该处内壁半径
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    const spread = tanHalf * Math.sqrt(1 + aspect * aspect)
    let yCam = 1.5
    for (const p of this.innerWall) yCam = Math.min(yCam, p.y + (0.97 * p.x) / spread)
    const D = yCam - LIQUID_Y
    const H = 2 * D * tanHalf
    this.liquidMat.uniforms.uMapSize.value.set(H * aspect, H)
    this.endRadius = yCam - TARGET.y
    this.fitRadius(aspect)
    this.updateCamera()
  }

  // 让酒坛在 45° 视角下约占画面高度的 30%
  fitRadius(aspect) {
    const samples = []
    const outer = this.profile.filter((_, i) => i % 6 === 0)
    for (const p of outer) {
      for (let k = 0; k <= 16; k++) {
        const th = (k / 16) * Math.PI * 2
        samples.push(new THREE.Vector3(Math.sin(th) * p.x, p.y, Math.cos(th) * p.x))
      }
    }
    let R = 4
    const v = new THREE.Vector3()
    for (let it = 0; it < 8; it++) {
      this.placeCamera(START, R)
      this.camera.updateMatrixWorld()
      let minY = Infinity
      let maxY = -Infinity
      let maxX = 0
      for (const s of samples) {
        v.copy(s).project(this.camera)
        minY = Math.min(minY, v.y)
        maxY = Math.max(maxY, v.y)
        maxX = Math.max(maxX, Math.abs(v.x))
      }
      const fracH = (maxY - minY) / 2
      const fracW = maxX
      const k = Math.max(fracH / JAR_SCREEN_HEIGHT, fracW / (aspect < 1 ? 0.62 : 0.9))
      R *= k
    }
    this.radius = R
  }

  placeCamera(phi, r) {
    this.camera.position.set(0, Math.sin(phi) * r, Math.cos(phi) * r).add(TARGET)
    this.camera.quaternion.setFromAxisAngle(X_AXIS, -phi)
  }

  updateCamera() {
    const t = this.dive
    const e1 = ease.inOutCubic(clamp(t / 0.62))
    const phi = lerp(START, Math.PI / 2, e1)
    const e2 = ease.inOutQuart(clamp((t - 0.34) / 0.66))
    const r = Math.exp(lerp(Math.log(this.radius), Math.log(this.endRadius), e2))
    this.placeCamera(phi, r)
    this.camera.updateMatrixWorld()
  }

  setPointer(clientX, clientY) {
    this.ndc.set((clientX / this.w) * 2 - 1, -(clientY / this.h) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
  }

  // 是否指在酒坛上
  hitJar(clientX, clientY) {
    if (!this.built) return false
    this.setPointer(clientX, clientY)
    return this.raycaster.intersectObjects(this.pickables, false).length > 0
  }

  setWaterTexture(texture) {
    if (this.built) this.liquidMat.uniforms.uWaterTex.value = texture
  }

  // 液面上那张“水面画面”在屏幕上占的宽度比例：用来决定水面该按多大的分辨率渲染
  liquidScreenFraction() {
    if (!this.built) return 0
    const half = this.liquidMat.uniforms.uMapSize.value.x / 2
    const a = this._tmpA.set(-half, 0, 0).applyMatrix4(this.liquid.matrixWorld).project(this.camera)
    const b = this._tmpB.set(half, 0, 0).applyMatrix4(this.liquid.matrixWorld).project(this.camera)
    return Math.hypot(b.x - a.x, b.y - a.y) / 2
  }

  // 酒坛在屏幕上的外框（用于提示文字和键盘焦点按钮）
  screenBounds() {
    const v = new THREE.Vector3()
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of this.profile.filter((_, i) => i % 8 === 0)) {
      for (let k = 0; k < 12; k++) {
        const th = (k / 12) * Math.PI * 2
        v.set(Math.sin(th) * p.x, p.y, Math.cos(th) * p.x).project(this.camera)
        const sx = (v.x * 0.5 + 0.5) * this.w
        const sy = (-v.y * 0.5 + 0.5) * this.h
        x0 = Math.min(x0, sx)
        x1 = Math.max(x1, sx)
        y0 = Math.min(y0, sy)
        y1 = Math.max(y1, sy)
      }
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  update(dt) {
    this.time += dt
    if (!this.built) {
      this.camera.updateMatrixWorld()
      this.lineMat.uniforms.uProgress.value = this.lineProgress
      return
    }
    this.updateCamera()
    const k = smoothstep(0, 1, this.intro)
    const breathe = 1 + Math.sin(this.time * 0.8) * 0.04
    const lightFade = 1 - smoothstep(0.55, 1, this.dive) * 0.7
    this.key.intensity = 2.2 * k * lightFade
    this.rim.intensity = (2.6 + this.hover * 1.2) * k * breathe * lightFade
    this.fill.intensity = 0.3 * k * lightFade
    this.scene.environmentIntensity = (0.85 + this.hover * 0.25) * k * lightFade

    const rest = this.theme.clear ? 0.5 : 0.35 // 静止时液面的亮度：清水在暗坛里透出一点光
    const glow = lerp(rest, 1, smoothstep(0.2, 0.8, this.dive))
    this.liquidMat.uniforms.uIntro.value = glow * k
    if (this.mouthLight) this.mouthLight.intensity = 0.07 * glow * k
    this.liquidMat.uniforms.uEffects.value = 1 - smoothstep(0.55, 1, this.dive)
    this.liquidMat.uniforms.uEdgeFade.value = 1 - smoothstep(0.84, 0.97, this.dive)

    // 白线停在画面中线上。点击后它从两端向中间收拢，收进坛后；返回时再从中间向两侧铺开
    const gather = ease.inOutCubic(smoothstep(0, 0.3, this.dive))
    this.lineMat.uniforms.uY.value = 0
    this.lineMat.uniforms.uProgress.value = this.lineProgress * (1 - gather)
    this.lineMat.uniforms.uOpacity.value = this.lineOpacity
  }

  render() {
    this.renderer.setRenderTarget(null)
    this.renderer.render(this.scene, this.camera)
  }
}
