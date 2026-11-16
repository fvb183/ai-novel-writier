import type { ModelProfile } from './ipc-channels'
import { isModelStage, type StageModelIds } from './model-stage-routing'
import { isReasoningMapping, reasoningAdapterFitsProtocol, REASONING_EFFORTS } from './reasoning-types'

export const MODEL_SETTINGS_MAX_BYTES = 2 * 1024 * 1024
export interface ModelSettingsSnapshot {
  format: 'ai-novel-model-settings'; version: 1; models: ModelProfile[]
  defaultModelId: string | null; defaultEmbeddingModelId: string | null; stageModelIds: StageModelIds
}
export interface ModelSettingsPreview {
  token: string; modelNames: string[]; total: number; embeddings: number; added: number; updated: number
}
const fail = (): never => { throw new Error('MODEL_SYNC_CONFIG_INVALID') }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const text = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) return fail()
  return value
}
const fields = ['id','name','provider','protocol','modelName','apiKey','baseUrl','temperature','maxTokens','purposes',
  'capabilities','capabilitySources','reasoningOverride','reasoningMapping','embeddingOptions']
const capabilityKeys = ['contextWindowTokens','maxOutputTokens','reasoning','structuredOutput','usage']
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
/** Bounded, allowlisted settings only; no proxy, local paths, OAuth credentials or arbitrary config keys. */
export function parseModelSettingsSnapshot(value: unknown): ModelSettingsSnapshot {
  const input = record(value)
  if (Object.keys(input).some(key => !['format','version','models','defaultModelId','defaultEmbeddingModelId','stageModelIds'].includes(key))
    || input.format !== 'ai-novel-model-settings' || input.version !== 1 || !Array.isArray(input.models) || input.models.length > 200) fail()
  const models = (input.models as unknown[]).map(raw => {
    const m = record(raw)
    if (Object.keys(m).some(key => !fields.includes(key))) fail()
    text(m.id, 256); text(m.name, 512, true); text(m.modelName, 512, true); text(m.apiKey, 32768, true); text(m.baseUrl, 4096)
    let url: URL; try { url = new URL(m.baseUrl as string) } catch { return fail() }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.hash) fail()
    if (!['openai','gemini','deepseek','ollama','bigmodel','novelai','xai','siliconflow','custom'].includes(String(m.provider))
      || !['openai','gemini'].includes(String(m.protocol)) || typeof m.temperature !== 'number' || !Number.isFinite(m.temperature)
      || m.temperature < 0 || m.temperature > 2 || !integer(m.maxTokens, 0, 100_000_000)
      || !Array.isArray(m.purposes) || !m.purposes.length || m.purposes.length > 4
      || m.purposes.some(p => !['generation','refinement','summary','embedding'].includes(p)) || new Set(m.purposes).size !== m.purposes.length) fail()
    if (m.capabilities !== undefined) {
      const cap = record(m.capabilities)
      for (const [key, v] of Object.entries(cap)) {
        if (!capabilityKeys.includes(key) || !(v === null || (key === 'contextWindowTokens' || key === 'maxOutputTokens' ? integer(v, 0, 100_000_000) : typeof v === 'boolean'))) fail()
      }
    }
    if (m.capabilitySources !== undefined && Object.entries(record(m.capabilitySources)).some(([key,v]) => !capabilityKeys.includes(key) || !['endpoint','preset','manual','unknown'].includes(String(v)))) fail()
    if (m.reasoningOverride !== undefined && !['auto',...REASONING_EFFORTS].includes(m.reasoningOverride as never)) fail()
    if (m.reasoningMapping !== undefined && (!isReasoningMapping(m.reasoningMapping) || !reasoningAdapterFitsProtocol(m.protocol, m.reasoningMapping.adapter))) fail()
    if (m.embeddingOptions !== undefined) {
      const o = record(m.embeddingOptions)
      if (Object.keys(o).some(key => !['chunkSize','chunkOverlap','batchSize'].includes(key)) || !integer(o.chunkSize,100,4000)
        || !integer(o.chunkOverlap,0,Number(o.chunkSize)-1) || !integer(o.batchSize,1,50)) fail()
    }
    return JSON.parse(JSON.stringify(m)) as ModelProfile
  })
  if (new Set(models.map(m => m.id)).size !== models.length) fail()
  const defaultId = (id: unknown, purpose: string): string | null => {
    if (id === null) return null
    if (typeof id !== 'string' || !models.some(m => m.id === id && m.purposes.includes(purpose as never))) return fail()
    return id
  }
  const stageModelIds: Record<string,string> = {}
  for (const [stage,id] of Object.entries(record(input.stageModelIds))) {
    if (!isModelStage(stage) || typeof id !== 'string' || !models.some(m => m.id === id && m.purposes.includes('generation'))) fail()
    stageModelIds[stage] = id as string
  }
  return { format: 'ai-novel-model-settings', version: 1, models, defaultModelId: defaultId(input.defaultModelId,'generation'),
    defaultEmbeddingModelId: defaultId(input.defaultEmbeddingModelId,'embedding'), stageModelIds }
}
export function encodeModelSettings(snapshot: ModelSettingsSnapshot): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(parseModelSettingsSnapshot(snapshot)))
  if (bytes.length > MODEL_SETTINGS_MAX_BYTES) fail()
  return bytes
}
export function decodeModelSettings(bytes: Uint8Array): ModelSettingsSnapshot {
  if (bytes.length > MODEL_SETTINGS_MAX_BYTES) fail()
  try { return parseModelSettingsSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  catch { return fail() }
}
