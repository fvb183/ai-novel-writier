import { createHash } from 'node:crypto'
import type { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { parseStageModelIds } from '../../src/shared/model-stage-routing'
import { parseModelSettingsSnapshot, type ModelSettingsSnapshot } from '../../src/shared/model-settings-sync'
import { tryReadJsonFile, writeJsonFile, updateGlobalConfig, MODELS_CONFIG_PATH, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'

interface StoreOptions {
  readModels(): ModelProfile[]; readConfig(): GlobalConfig
  writeModels(models: ModelProfile[]): void; updateConfig(update: (config: GlobalConfig) => GlobalConfig): boolean
}
const fail = (code: string): never => { throw new Error(code) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const preferences = (config: GlobalConfig) => ({ defaultModelId: config.defaultModelId ?? null,
  defaultEmbeddingModelId: config.defaultEmbeddingModelId ?? null, stageModelIds: config.stageModelIds ?? {} })
const read = <T,>(file: string, fallback: T): T => {
  const result = tryReadJsonFile<T>(file)
  if (result.status === 'error') fail('MODEL_SYNC_LOCAL_CONFIG_INVALID')
  return result.status === 'ok' ? result.value : fallback
}
const defaultStore: StoreOptions = {
  readModels: () => read<ModelProfile[]>(MODELS_CONFIG_PATH, []), readConfig: () => read(GLOBAL_CONFIG_PATH, {...DEFAULT_GLOBAL_CONFIG}),
  writeModels: value => writeJsonFile(MODELS_CONFIG_PATH,value), updateConfig: updateGlobalConfig,
}
export class ModelSettingsStore {
  constructor(private options: StoreOptions = defaultStore) {}
  capture() {
    const models = this.options.readModels(), config = this.options.readConfig()
    if (!Array.isArray(models) || models.some(m => !m || typeof m.id !== 'string') || !config || typeof config !== 'object' || Array.isArray(config)) fail('MODEL_SYNC_LOCAL_CONFIG_INVALID')
    return { models, config, revision: hash([models,preferences(config)]) }
  }
  snapshot(): ModelSettingsSnapshot {
    const { models,config } = this.capture()
    const selected = (id: string | null | undefined, purpose: string) => models.some(m => m.id === id && m.purposes?.includes(purpose as never)) ? id! : null
    const stageModelIds = Object.fromEntries(Object.entries(parseStageModelIds(config.stageModelIds)).filter(([,id]) => selected(id,'generation')))
    return parseModelSettingsSnapshot({format:'ai-novel-model-settings',version:1,models:models.map(m => {
      const {id,name,provider,protocol,modelName,apiKey,baseUrl,temperature,maxTokens,purposes,capabilities,capabilitySources,reasoningOverride,reasoningMapping,embeddingOptions}=m
      return JSON.parse(JSON.stringify({id,name,provider,protocol,modelName,apiKey,baseUrl,temperature,maxTokens,purposes,capabilities,capabilitySources,reasoningOverride,reasoningMapping,embeddingOptions}))
    }),defaultModelId:selected(config.defaultModelId,'generation'),defaultEmbeddingModelId:selected(config.defaultEmbeddingModelId,'embedding'),stageModelIds})
  }
  apply(value: ModelSettingsSnapshot, expectedRevision: string, check: () => void): number {
    const snapshot=parseModelSettingsSnapshot(value), before=this.capture()
    if (before.revision !== expectedRevision) fail('MODEL_SYNC_LOCAL_CHANGED')
    const incoming=new Map(snapshot.models.map(m => [m.id,m])), merged=before.models.map(m => incoming.get(m.id) ?? m)
    for (const m of snapshot.models) if (!before.models.some(previous => previous.id === m.id)) merged.push(m)
    check()
    this.options.writeModels(merged)
    try {
      if (!this.options.updateConfig(current => {
        check()
        if (hash(preferences(current)) !== hash(preferences(before.config))) fail('MODEL_SYNC_LOCAL_CHANGED')
        return {...current,defaultModelId:snapshot.defaultModelId,defaultEmbeddingModelId:snapshot.defaultEmbeddingModelId,stageModelIds:snapshot.stageModelIds}
      })) fail('MODEL_SYNC_LOCAL_CONFIG_INVALID')
    } catch (error) {
      try {
        if (hash(this.options.readModels()) !== hash(merged)) fail('MODEL_SYNC_IMPORT_ROLLBACK_FAILED')
        this.options.writeModels(before.models)
      } catch { fail('MODEL_SYNC_IMPORT_ROLLBACK_FAILED') }
      throw error
    }
    return snapshot.models.length
  }
}
