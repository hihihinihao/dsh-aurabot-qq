// 云端语音识别：把一段 16kHz 单声道 WAV 交给配置好的 ASR 服务，换回文字。
// 只做「选中了哪个 provider、参数怎么合、失败怎么报」这三件事；具体请求在 providers.js 里。
// 聊天里任何一层识别失败都不会影响回复，调用方会继续试 QQ 自带 / DSH 识别。

import { asrProvider, resolveProviderConfig } from './providers.js'

/** 现在有没有配置云端识别（面板里选了 provider 才算）。 */
export function asrConfigured(voice) {
  return Boolean(voice && voice.asrProvider && asrProvider(voice.asrProvider))
}

/** 面板「测试」用：返回 provider 名字和合并后的配置（不含密钥原文）。 */
export function asrInfo(voice) {
  const def = asrProvider(voice?.asrProvider)
  if (!def) return { ok: false, message: '没选云端识别服务' }
  const c = resolveProviderConfig(def, voice?.asrConfig?.[def.id])
  return { ok: true, id: def.id, name: def.name, model: c.model || '', baseUrl: c.baseUrl || '' }
}

/**
 * @param {Buffer} buffer 16kHz 单声道 PCM16 WAV
 * @param {object} voice 整份 voice 配置
 * @returns {Promise<string>} 识别出来的文字（可能为空）
 */
export async function transcribeAudio(buffer, voice, log, { timeoutMs = 60000, fetchImpl } = {}) {
  const def = asrProvider(voice?.asrProvider)
  if (!def) throw new Error('没选云端识别服务')
  const config = resolveProviderConfig(def, voice?.asrConfig?.[def.id])
  const started = Date.now()
  const r = await def.transcribe({ buffer, config, log, timeoutMs, fetchImpl })
  const text = String(r && typeof r === 'object' ? (r.text ?? r.transcript ?? '') : (r ?? '')).trim()
  log?.debug?.(`云端识别（${def.name}）用时 ${Date.now() - started}ms，得到 ${text.length} 字`)
  return text
}
