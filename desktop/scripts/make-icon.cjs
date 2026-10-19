// ☕ 应用图标生成（可复现）：build/twemoji-2615.svg → build/icon-png/*.png → build/icon.ico
// 栅格化用 puppeteer-core + Edge headless（与 UI 测试同一浏览器栈）；ICO 采用
// PNG 条目（Vista+ 均支持，electron-builder 亦接受）。
// 图形来源：Twemoji 2615（hot beverage），CC-BY 4.0——署名见 README「许可证」。
const path = require('node:path')
const fs = require('node:fs')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const root = path.resolve(__dirname, '..')
const buildDir = path.join(root, 'build')
const svgPath = path.join(buildDir, 'twemoji-2615.svg')
const pngDir = path.join(buildDir, 'icon-png')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICO_SIZES = [16, 24, 32, 48, 64, 256]

;(async () => {
  if (!fs.existsSync(svgPath)) throw new Error(`缺少 ${svgPath}（Twemoji 2615，CC-BY 4.0）`)
  fs.mkdirSync(pngDir, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    // file:// 子资源在 about:blank 页被拦——SVG 以 data URL 内联
    const svgDataUrl = 'data:image/svg+xml;base64,' + fs.readFileSync(svgPath).toString('base64')
    for (const size of SIZES) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
      await page.setContent(`<body style="margin:0"><img src="${svgDataUrl}" width="${size}" height="${size}">`, { waitUntil: 'load' })
      await page.evaluate(() => document.images[0].decode())
      const buffer = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
      fs.writeFileSync(path.join(pngDir, `icon-${size}.png`), buffer)
      if (buffer.length < 100) throw new Error(`icon-${size}.png 疑似空白（${buffer.length}B）`)
    }
  } finally { await browser.close() }

  // ICO（PNG 条目）：header(6B) + N×16B 目录 + PNG 数据
  const entries = ICO_SIZES.map(size => ({ size, data: fs.readFileSync(path.join(pngDir, `icon-${size}.png`)) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = Buffer.alloc(entries.length * 16)
  entries.forEach((entry, index) => {
    const base = index * 16
    dir.writeUInt8(entry.size === 256 ? 0 : entry.size, base)          // 宽（0=256）
    dir.writeUInt8(entry.size === 256 ? 0 : entry.size, base + 1)      // 高
    dir.writeUInt8(0, base + 2)                                        // 调色板数
    dir.writeUInt8(0, base + 3)                                        // 保留
    dir.writeUInt16LE(1, base + 4)                                     // planes
    dir.writeUInt16LE(32, base + 6)                                    // bpp
    dir.writeUInt32LE(entry.data.length, base + 8)                     // 字节数
    dir.writeUInt32LE(offset, base + 12)                               // 数据偏移
    offset += entry.data.length
  })
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, dir, ...entries.map(entry => entry.data)]))
  fs.copyFileSync(path.join(pngDir, 'icon-256.png'), path.join(buildDir, 'icon.png'))
  console.log(`icon ok: ${SIZES.length} png + icon.ico(${fs.statSync(path.join(buildDir, 'icon.ico')).size}B)`)
})().catch(error => { console.error(error); process.exit(1) })
