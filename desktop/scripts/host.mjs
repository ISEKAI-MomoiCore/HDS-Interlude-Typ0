/**
 * M0 无头验证入口：直接以系统 Node 启动 Koishi 官方 worker，
 * 与 Electron 主进程的 spawn 方式完全一致（同一 entry、同一环境变量）。
 * 注意：必须走 CJS require——@koishijs/loader 的 ESM 入口对 koishi 的
 * 命名导出探测不可靠（Class extends value is not a constructor）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Loader 以 cwd（= 工程根）解析该相对路径；data 目录同理（instance/data）。
process.env.KOISHI_CONFIG_FILE ||= 'instance/koishi.yml'

const { Loader } = require('@koishijs/loader')
const { Logger: KoishiLogger } = require('@koishijs/core')

const loader = new Loader()
await loader.init(process.env.KOISHI_CONFIG_FILE)
const config = await loader.readConfig(true)
const app = await loader.createApp()
await app.start()
