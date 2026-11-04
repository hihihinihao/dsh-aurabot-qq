// 宿主路由冒烟：云端 provider 列表、ASR 未配置时的提示、向量状态。假 DSH + 假 OneBot，不联网。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
let mock, fake, api, dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-voice-routes-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const json = async (p, body) => (await fake.call(p, body)).json()

test('面板能拿到云端 TTS / ASR 的字段定义', async () => {
  const r = await json('/voice/providers')
  assert.equal(r.ok, true)
  assert.ok(r.tts.some((d) => d.id === 'siliconflow'))
  assert.ok(r.tts.some((d) => d.id === 'doubao'))
  assert.ok(r.asr.some((d) => d.id === 'siliconflow'))
  const key = r.tts.find((d) => d.id === 'siliconflow').fields.find((f) => f.key === 'apiKey')
  assert.equal(key.secret, true, '密钥字段标记为 secret')
})

test('没配云端识别时，测试接口给人话，不抛错', async () => {
  const r = await json('/voice/asr-provider-test', { text: '今天想吃白米饭' })
  assert.equal(r.ok, false)
  assert.match(r.message, /没选云端识别服务/)
})

test('向量状态默认关闭、未配置、0 条', async () => {
  const r = await json('/memory/vector/status')
  assert.equal(r.ok, true)
  assert.equal(r.enabled, false)
  assert.equal(r.configured, false)
  assert.equal(r.indexed, 0)
  assert.equal(r.total, 0)
})
