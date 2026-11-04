// 云端语音服务注册表：TTS（文字转语音）和 ASR（语音转文字）各一张表。
//
// 想加一家新厂商时，不用改聊天、配置和面板的核心逻辑：
//   1. 写一个 { id, name, fields, defaults, synthesize() }（或 transcribe()）
//   2. 在文件末尾 registerTtsProvider(def) / registerAsrProvider(def)
//   3. 配置和面板会自动多出这一项，用户填的字段按 fields 自动保存、自动脱敏
//
// 内置：硅基流动（OpenAI 兼容）、OpenAI、豆包（火山 openspeech v1）。
// 都是把音频当 Buffer 交回去/收进来，不落临时文件；失败由调用方决定退回哪种内置方式。

import { randomUUID } from 'node:crypto'

const TTS = new Map()
const ASR = new Map()

/** 面板和配置只认这里声明过的字段；别的键不会进配置。 */
function cleanFields(fields) {
  return (fields || []).map((f) => ({
    key: String(f.key || '').trim(),
    label: String(f.label || f.key || ''),
    type: ['text', 'password', 'number', 'select'].includes(f.type) ? f.type : 'text',
    placeholder: String(f.placeholder || ''),
    hint: String(f.hint || ''),
    options: (f.options || []).map((o) => ({ value: o.value, label: o.label || String(o.value) })),
    default: f.default,
    min: f.min,
    max: f.max,
    step: f.step,
    secret: Boolean(f.secret),
  })).filter((f) => f.key)
}

function define(kind, def) {
  const fields = cleanFields(def.fields)
  const defaults = {}
  for (const f of fields) defaults[f.key] = f.default ?? (f.type === 'number' ? 0 : '')
  return {
    ...def,
    kind,
    fields,
    defaults: { ...defaults, ...(def.defaults || {}) },
  }
}

export function registerTtsProvider(def) {
  const d = define('tts', def)
  TTS.set(d.id, d)
  return d
}

export function registerAsrProvider(def) {
  const d = define('asr', def)
  ASR.set(d.id, d)
  return d
}

export function ttsProvider(id) {
  return TTS.get(String(id || '')) || null
}

export function asrProvider(id) {
  return ASR.get(String(id || '')) || null
}

export function listTtsProviders() {
  return [...TTS.values()]
}

export function listAsrProviders() {
  return [...ASR.values()]
}

/** 面板要的公开描述：字段 + 默认值，不带函数。 */
export function publicProviders() {
  const pub = (d) => ({ id: d.id, name: d.name, description: d.description || '', fields: d.fields, defaults: d.defaults })
  return { ok: true, tts: listTtsProviders().map(pub), asr: listAsrProviders().map(pub) }
}

/** 把用户配置和默认值合起来；空串 / 没填就用默认值。 */
export function resolveProviderConfig(def, raw) {
  const out = { ...def.defaults }
  if (raw && typeof raw === 'object') {
    for (const f of def.fields) {
      const v = raw[f.key]
      if (v === undefined || v === null || v === '') continue
      if (f.type === 'number') {
        const n = Number(v)
        if (Number.isFinite(n)) out[f.key] = n
      } else if (f.type === 'select') {
        if (!f.options.length || f.options.some((o) => String(o.value) === String(v))) out[f.key] = v
      } else {
        out[f.key] = String(v).trim()
      }
    }
  }
  if (out.baseUrl) out.baseUrl = String(out.baseUrl).trim().replace(/\/+$/, '')
  return out
}

function timeout(ms) {
  return AbortSignal.timeout(Math.max(1000, Number(ms) || 60000))
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('没填服务地址')
  let url
  try { url = new URL(base) } catch (error) { throw new Error('服务地址不对：' + base) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址只支持 http / https')
  return base + path
}

async function readBody(r) {
  try { return await r.text() } catch (error) { return '' }
}

function errorText(r, body) {
  return `HTTP ${r.status}：${String(body || '').slice(0, 200)}`
}

// ---------------- TTS ----------------

/**
 * OpenAI 兼容的 /audio/speech：硅基流动、OpenAI 以及大多数兼容网关都是这个形状。
 * 返回二进制音频（不是 JSON），所以直接收 Buffer。
 */
function openaiTts({ id, name, description, baseUrl, model, voice, format = 'mp3', speed = 1 }) {
  return {
    id,
    name,
    description,
    fields: [
      { key: 'baseUrl', label: '服务地址', placeholder: baseUrl, hint: '一般以 /v1 结尾' },
      { key: 'apiKey', label: 'API Key', type: 'password', secret: true, placeholder: 'sk-…' },
      { key: 'model', label: '模型', placeholder: model, hint: '例如 FunAudioLLM/CosyVoice2-0.5B' },
      { key: 'voice', label: '音色', placeholder: voice, hint: '例如 FunAudioLLM/CosyVoice2-0.5B:claire' },
      { key: 'format', label: '格式', type: 'select', options: [{ value: 'mp3', label: 'mp3' }, { value: 'wav', label: 'wav' }, { value: 'opus', label: 'opus' }], default: format },
      { key: 'speed', label: '语速', type: 'number', min: 0.25, max: 4, step: 0.05, placeholder: '1', default: speed, hint: '0.25 ~ 4，默认 1' },
    ],
    defaults: { baseUrl, model, voice, format, speed },
    async synthesize({ text, config, fetchImpl = globalThis.fetch, timeoutMs }) {
      const url = joinUrl(config.baseUrl, '/audio/speech')
      const headers = { 'content-type': 'application/json' }
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
      const body = {
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: config.format || 'mp3',
      }
      const speed = Number(config.speed)
      if (Number.isFinite(speed) && speed > 0 && speed !== 1) body.speed = speed
      const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: timeout(timeoutMs), redirect: 'error' })
      if (!r.ok) throw new Error(errorText(r, await readBody(r)))
      const buffer = Buffer.from(await r.arrayBuffer())
      if (buffer.length < 400) throw new Error('返回的音频太短：' + buffer.toString('utf8').slice(0, 160))
      return { buffer, mime: r.headers.get('content-type') || `audio/${config.format || 'mpeg'}`, format: config.format || 'mp3' }
    },
  }
}

/**
 * 豆包语音（火山引擎 openspeech）v1 非流式接口：POST JSON，音频在 data 字段里（base64）。
 * 历史接口但仍在用；v3 是 SSE 分块，需要时再加一个 provider。
 */
function doubaoV1Tts() {
  return {
    id: 'doubao',
    name: '豆包语音（火山）',
    description: '火山引擎豆包语音合成 v1（历史接口，仍可用）：AppID + Access Token，音频在 JSON 的 data 字段。只支持 v3 的新音色暂未适配',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '在火山引擎语音控制台复制' },
      { key: 'accessToken', label: 'Access Token', type: 'password', secret: true, placeholder: '在火山引擎语音控制台复制' },
      { key: 'cluster', label: 'Cluster', placeholder: 'volcano_tts', hint: '一般就是 volcano_tts' },
      { key: 'voiceType', label: '音色 ID', placeholder: 'zh_female_vv_uranus_bigtts', hint: '控制台「音色列表」里的 voice_type；2.0 音色一般带 uranus' },
      { key: 'format', label: '格式', type: 'select', options: [{ value: 'mp3', label: 'mp3' }, { value: 'wav', label: 'wav' }, { value: 'pcm', label: 'pcm' }], default: 'mp3' },
      { key: 'sampleRate', label: '采样率', type: 'number', min: 8000, max: 48000, placeholder: '24000', default: 24000 },
      { key: 'speedRatio', label: '语速', type: 'number', min: 0.2, max: 3, step: 0.05, placeholder: '1', default: 1 },
    ],
    defaults: {
      appId: '',
      accessToken: '',
      cluster: 'volcano_tts',
      voiceType: 'zh_female_vv_uranus_bigtts',
      format: 'mp3',
      sampleRate: 24000,
      speedRatio: 1,
    },
    async synthesize({ text, config, fetchImpl = globalThis.fetch, timeoutMs }) {
      if (!config.appId) throw new Error('没填豆包 AppID')
      if (!config.accessToken) throw new Error('没填豆包 Access Token')
      const body = {
        app: { appid: config.appId, token: config.accessToken, cluster: config.cluster || 'volcano_tts' },
        user: { uid: 'aurabot' },
        audio: {
          voice_type: config.voiceType,
          encoding: config.format || 'mp3',
          rate: Number(config.sampleRate) || 24000,
          speed_ratio: Number(config.speedRatio) || 1,
        },
        request: { reqid: randomUUID(), text, text_type: 'plain', operation: 'query' },
      }
      const r = await fetchImpl('https://openspeech.bytedance.com/api/v1/tts', {
        method: 'POST',
        headers: { authorization: `Bearer; ${config.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeout(timeoutMs),
        redirect: 'error',
      })
      const raw = await readBody(r)
      if (!r.ok) throw new Error(errorText(r, raw))
      let json
      try { json = JSON.parse(raw) } catch (error) { throw new Error('豆包返回的不是 JSON：' + raw.slice(0, 160)) }
      if (json.code !== 3000 || !json.data) throw new Error(`豆包合成失败（code=${json.code ?? '-'}，${json.message || json.msg || '-'}）`)
      const buffer = Buffer.from(String(json.data), 'base64')
      if (buffer.length < 400) throw new Error('豆包返回的音频太短')
      return { buffer, mime: `audio/${config.format || 'mpeg'}`, format: config.format || 'mp3' }
    },
  }
}

// ---------------- ASR ----------------

/**
 * OpenAI 兼容的 /audio/transcriptions：multipart 上传 wav，返回 { text }。
 * 硅基流动用 FunAudioLLM/SenseVoiceSmall；OpenAI 用 whisper-1。
 */
function openaiAsr({ id, name, description, baseUrl, model, language = '' }) {
  return {
    id,
    name,
    description,
    fields: [
      { key: 'baseUrl', label: '服务地址', placeholder: baseUrl, hint: '一般以 /v1 结尾' },
      { key: 'apiKey', label: 'API Key', type: 'password', secret: true, placeholder: 'sk-…' },
      { key: 'model', label: '模型', placeholder: model, hint: '例如 FunAudioLLM/SenseVoiceSmall' },
      { key: 'language', label: '语言', placeholder: 'zh（可留空）', hint: '只对支持 language 的模型有效' },
    ],
    defaults: { baseUrl, model, language },
    async transcribe({ buffer, config, fetchImpl = globalThis.fetch, timeoutMs }) {
      if (!buffer || !buffer.length) throw new Error('没有音频')
      const url = joinUrl(config.baseUrl, '/audio/transcriptions')
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'voice.wav')
      form.append('model', config.model)
      if (config.language) form.append('language', config.language)
      const headers = {}
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
      const r = await fetchImpl(url, { method: 'POST', headers, body: form, signal: timeout(timeoutMs), redirect: 'error' })
      const raw = await readBody(r)
      if (!r.ok) throw new Error(errorText(r, raw))
      let json
      try { json = JSON.parse(raw) } catch (error) { throw new Error('识别服务返回的不是 JSON：' + raw.slice(0, 160)) }
      const text = String(json.text || json.transcript || '').trim()
      return { text }
    },
  }
}

registerTtsProvider(openaiTts({
  id: 'siliconflow',
  name: '硅基流动',
  description: 'OpenAI 兼容 /audio/speech，内置 CosyVoice2；也支持上传的参考音色',
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
}))

registerTtsProvider(openaiTts({
  id: 'openai',
  name: 'OpenAI 语音',
  description: 'OpenAI 官方 /audio/speech（也可以填任意兼容网关）',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
}))

registerTtsProvider(doubaoV1Tts())

registerAsrProvider(openaiAsr({
  id: 'siliconflow',
  name: '硅基流动',
  description: 'OpenAI 兼容 /audio/transcriptions，内置 SenseVoiceSmall',
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
}))

registerAsrProvider(openaiAsr({
  id: 'openai',
  name: 'OpenAI 语音识别',
  description: 'OpenAI 官方 /audio/transcriptions（whisper-1）或兼容网关',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
}))
