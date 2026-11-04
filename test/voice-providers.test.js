// 云端语音 provider：TTS / ASR 的请求形状、配置收敛、密钥脱敏、失败回退。全部用假 fetch，不联网。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWav } from '../src/voice/wav.js'

let config
let providers
let tts
let asr
const log = { info() {}, warn() {}, debug() {} }
let dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-'))
  process.env.AURABOT_DATA_DIR = dir
  config = await import('../src/core/config.js')
  providers = await import('../src/voice/providers.js')
  tts = await import('../src/voice/tts.js')
  asr = await import('../src/voice/asr.js')
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const wav = (ms = 300) => buildWav(new Int16Array(Math.round(24000 * ms / 1000)), 24000)

test('provider 注册表暴露字段和默认值；以后加厂商不用改配置/面板', () => {
  const pub = providers.publicProviders()
  const sf = pub.tts.find((d) => d.id === 'siliconflow')
  const db = pub.tts.find((d) => d.id === 'doubao')
  const sa = pub.asr.find((d) => d.id === 'siliconflow')
  assert.ok(sf && db && sa)
  assert.ok(sf.fields.some((f) => f.key === 'apiKey' && f.secret))
  assert.equal(sf.defaults.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.equal(sa.defaults.model, 'FunAudioLLM/SenseVoiceSmall')
})

test('配置：云端字段按 provider 收敛，密钥在面板里不回显', () => {
  const c = config.normalize({
    voice: {
      engine: 'siliconflow',
      providerConfig: { siliconflow: { apiKey: 'sk-voice-secret', model: 'custom', 乱写: 'x', speed: '1.25' } },
      asrProvider: 'openai',
      asrConfig: { openai: { apiKey: 'sk-asr-secret' } },
    },
    memory: { vector: { enabled: true, apiKey: 'sk-vec-secret', minSimilarity: 2 } },
  })
  assert.equal(c.voice.engine, 'siliconflow')
  assert.deepEqual(c.voice.providerConfig.siliconflow, { apiKey: 'sk-voice-secret', model: 'custom', speed: 1.25 })
  assert.equal(c.voice.asrProvider, 'openai')
  assert.equal(c.voice.asrConfig.openai.apiKey, 'sk-asr-secret')
  assert.equal(c.voice.asrPrefer, 'qq', '默认 QQ 优先')
  assert.equal(config.normalize({ voice: { asrPrefer: 'cloud' } }).voice.asrPrefer, 'cloud')
  assert.equal(config.normalize({ voice: { asrPrefer: '乱写' } }).voice.asrPrefer, 'qq')
  assert.equal(c.memory.vector.minSimilarity, 0.95, '超范围夹回来')
  const pub = config.publicConfig(c)
  assert.equal(pub.voice.providerConfig.siliconflow.apiKey, '')
  assert.equal(pub.voice.providerConfig.siliconflow.apiKeySet, true)
  assert.equal(pub.voice.asrConfig.openai.apiKeySet, true)
  assert.equal(pub.memory.vector.apiKeySet, true)
  assert.equal(JSON.stringify(pub).includes('sk-voice-secret'), false)
  assert.equal(JSON.stringify(pub).includes('sk-asr-secret'), false)
})

test('硅基 TTS：POST /audio/speech，二进制音频落地', async (t) => {
  const audio = wav()
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => audio }
  }
  const old = globalThis.fetch
  globalThis.fetch = fake
  t.after(() => { globalThis.fetch = old })
  const cfg = config.normalize({ voice: { engine: 'siliconflow', providerConfig: { siliconflow: { apiKey: 'sk-1' } } } })
  const r = await tts.textToSpeech('你好呀', cfg.voice, log)
  assert.equal(r.engine, 'siliconflow')
  assert.ok(existsSync(r.file))
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/audio/speech')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-1')
  assert.equal(calls[0].body.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.equal(calls[0].body.input, '你好呀')
})

test('豆包 TTS：JSON data 里的 base64 能解成音频；错误码报清楚', async (t) => {
  const audio = wav()
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: true, text: async () => JSON.stringify({ code: 3000, message: 'Success', data: audio.toString('base64') }) }
  }
  const old = globalThis.fetch
  globalThis.fetch = fake
  t.after(() => { globalThis.fetch = old })
  const cfg = config.normalize({ voice: { engine: 'doubao', providerConfig: { doubao: { appId: 'app', accessToken: 'tok' } } } })
  const r = await tts.textToSpeech('晚安', cfg.voice, log)
  assert.equal(r.engine, 'doubao')
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v1/tts')
  assert.equal(calls[0].init.headers.authorization, 'Bearer; tok')
  assert.equal(calls[0].body.app.appid, 'app')
  assert.match(calls[0].body.request.reqid, /\w{8}-/)

  // 错误码 → 失败后回退（Windows 上没有语音时会抛，这里只验证错误信息）
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ code: 3001, message: 'invalid token' }) })
  const bad = config.normalize({ voice: { engine: 'doubao', providerConfig: { doubao: { appId: 'app', accessToken: 'bad' } } } })
  await assert.rejects(providers.ttsProvider('doubao').synthesize({ text: 'x', config: providers.resolveProviderConfig(providers.ttsProvider('doubao'), bad.voice.providerConfig.doubao) }), /invalid token/)
})

test('通用 HTTP TTS：POST + 自定义请求头 + JSON base64 响应', async (t) => {
  const audio = wav()
  let seen
  const old = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return { ok: true, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify({ code: 0, data: audio.toString('base64') })) }
  }
  t.after(() => { globalThis.fetch = old })
  const file = await tts.httpSynth('带"引号"的话', {
    urlTemplate: 'https://example.com/tts',
    method: 'POST',
    headers: 'Authorization: Bearer abc\n# 注释行\nX-Test: 1',
    body: '{"text":"{text}","reqid":"{reqid}"}',
  })
  assert.ok(existsSync(file))
  assert.equal(seen.url, 'https://example.com/tts')
  assert.equal(seen.init.headers.Authorization, 'Bearer abc')
  assert.equal(seen.init.headers['X-Test'], '1')
  assert.equal(JSON.parse(seen.init.body).text, '带"引号"的话', '引号被正确转义')
})

test('硅基 ASR：multipart 上传 wav，取回 text；没选 provider 不请求', async () => {
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, text: async () => JSON.stringify({ text: '今天想吃白米饭' }) }
  }
  const cfg = config.normalize({ voice: { asrProvider: 'siliconflow' } })
  assert.equal(asr.asrConfigured(cfg.voice), true)
  const text = await asr.transcribeAudio(wav(), cfg.voice, log, { fetchImpl: fake })
  assert.equal(text, '今天想吃白米饭')
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/audio/transcriptions')
  assert.ok(calls[0].init.body instanceof FormData)

  const off = config.normalize({})
  assert.equal(asr.asrConfigured(off.voice), false)
})
