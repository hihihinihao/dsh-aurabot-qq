// 语义检索：默认关闭、增量同步、余弦召回、BM25 降级、面板状态/重建。全部假 fetch，不联网。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let normalize
let publicConfig
let createMemoryStore
let createVectorIndex
const log = { info() {}, warn() {}, debug() {} }
const calls = []
let dir

const vectorOf = (text) => /猫|宠物|年糕/.test(text) ? [1, 0, 0] : /护士|医院|杭州/.test(text) ? [0, 1, 0] : [0, 0, 1]
const fake = async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push({ url, body })
  return {
    ok: true,
    json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })).reverse() }),
  }
}
const hub = { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [], lastTextOf: () => '', prevTextOf: () => '' }

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-vector-'))
  process.env.AURABOT_DATA_DIR = dir
  ;({ normalize, publicConfig } = await import('../src/core/config.js'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ createVectorIndex } = await import('../src/features/memory-vector.js'))
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const item = (id, text, about = '') => ({ id, text, about, aboutName: '', importance: 0.6, at: Date.now(), source: 'tool' })

test('默认关闭：不请求、不建文件；配置默认值完整', async () => {
  const cfg = normalize({})
  assert.deepEqual(cfg.memory.vector, {
    enabled: false, provider: 'siliconflow', baseUrl: '', model: '', apiKey: '',
    dimensions: 0, minSimilarity: 0.55, queryTimeoutMs: 3000,
  })
  const idx = createVectorIndex({ getConfig: () => cfg, log, fetchImpl: fake })
  const before = calls.length
  await idx.sync([item('a', '小明养了一只猫')])
  assert.equal(calls.length, before, '没开就不发请求')
  assert.equal(await idx.queryVector('宠物'), null)
  assert.equal(idx.count([item('a', '小明养了一只猫')]), 0)
})

test('打开后增量同步：按 id 存向量，按余弦相似度召回', async () => {
  const cfg = normalize({ memory: { vector: { enabled: true, baseUrl: 'http://localhost:1234/v1/', model: 'fake', apiKey: 'k' } } })
  const store = createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: fake })
  store.add({ text: '小明养了一只橘猫叫年糕', about: '30000001', aboutName: '小明', source: 'tool' })
  store.add({ text: '阿花在杭州当护士', about: '30000002', aboutName: '阿花', source: 'tool' })
  await store.vectorSync()
  const s = store.vectorStatus()
  assert.equal(s.indexed, 2)
  assert.equal(s.total, 2)
  assert.equal(s.dims, 3)
  assert.equal(s.configured, true)

  const hits = await store.recallWithVector('宠物')
  assert.equal(hits[0].it.text, '小明养了一只橘猫叫年糕', '关键词没命中也能靠语义想起来')
  const nurse = await store.recallWithVector('医院上班')
  assert.equal(nurse[0].it.text, '阿花在杭州当护士')
})

test('关键词命中照常；有向量时按名次融合，分数不直接相加', async () => {
  const cfg = normalize({ memory: { vector: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'fake' } } })
  const store = createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: fake })
  const hits = await store.recallWithVector('年糕')
  assert.ok(hits.length > 0)
  assert.equal(hits[0].it.text, '小明养了一只橘猫叫年糕')
  assert.ok(hits[0].score > 0)
  assert.ok((hits[0].why || []).some((x) => x === '（语义相关）' || x === '年糕'))
})

test('服务出错时静默退回关键词，不影响调用；重建索引清空后能再同步', async () => {
  const cfg = normalize({ memory: { vector: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'fake' } } })
  const bad = async () => ({ ok: false, status: 401 })
  const store = createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: bad })
  await store.vectorSync()
  const hits = await store.recallWithVector('宠物')
  assert.deepEqual(hits, [], '没有关键词、向量又失败，就什么也不返回')

  const good = createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: fake })
  good.add({ text: '小明养了一只橘猫叫年糕', about: '30000001', aboutName: '小明', source: 'tool' })
  good.add({ text: '阿花在杭州当护士', about: '30000002', aboutName: '阿花', source: 'tool' })
  assert.equal(good.vectorReset(), true)
  assert.equal(good.vectorStatus().indexed, 0)
  await good.vectorSync()
  assert.equal(good.vectorStatus().indexed, 2)
})

test('面板测试返回维度；密钥不回传', async () => {
  const cfg = normalize({ memory: { vector: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'fake', apiKey: 'sk-vector-secret' } } })
  const store = createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: fake })
  const r = await store.vectorTest('今天想吃白米饭')
  assert.equal(r.dims, 3)
  const pub = publicConfig(cfg)
  assert.equal(pub.memory.vector.apiKey, '')
  assert.equal(pub.memory.vector.apiKeySet, true)
})
