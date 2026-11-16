import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { Locale } from '../../../i18n/types'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { ModelForm } from '../ModelForm'

const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

const model: ModelProfile = {
  id: 'form-model',
  name: 'Form model',
  provider: 'openai',
  protocol: 'openai',
  modelName: 'gpt-test',
  apiKey: 'browser-fixture-credential',
  baseUrl: 'http://127.0.0.1:9/v1',
  temperature: 0.7,
  maxTokens: 4000,
  purposes: ['generation'],
}

async function renderFailedTest(locale: Locale, error: string, profile = model) {
  useLocaleStore.setState({ locale })
  useLLMStore.setState({
    testConnection: vi.fn(async () => ({ success: false, error })),
    discoverModels: vi.fn(async () => ({ success: true as const, models: [] })),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const renderModel = (draft: ModelProfile) => root?.render(
    <ModelForm
      model={draft}
      onChange={renderModel}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      saving={false}
      purposeOptions={profile.purposes}
      presets={BUILTIN_PRESETS}
    />,
  )
  await act(async () => { renderModel(profile) })
  await act(async () => page.getByRole('button', { name: locale === 'en-US' ? 'Test connection' : '测试连接' }).click())
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLLMStore.setState(originalLLMState, true)
  useLocaleStore.setState(originalLocaleState, true)
})

describe('model connection test result (#484)', () => {
  it('keeps an embedding HTTP 402 diagnostic visible beyond three seconds, then clears it when the model changes', async () => {
    await renderFailedTest('zh-CN', '检索模型请求失败（HTTP 402）。请在控制台核对账户状态与费用账单。', { ...model, purposes: ['embedding'] })
    await expect.element(page.getByText(/HTTP 402/u)).toBeVisible()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3200)) })
    await expect.element(page.getByText(/HTTP 402/u)).toBeVisible()

    await act(async () => {
      await page.getByPlaceholder('从列表选择，或直接输入模型名称').fill('different-embedding-model')
    })
    expect(container?.textContent).not.toContain('HTTP 402')
  })

  it('ignores a connection result that arrives after the embedding configuration has changed', async () => {
    await renderFailedTest('zh-CN', '检索模型请求失败（HTTP 402）。', { ...model, purposes: ['embedding'] })
    let finish: ((result: { success: boolean; error?: string }) => void) | undefined
    await act(async () => {
      useLLMStore.setState({ testConnection: vi.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { finish = resolve })) })
    })
    await act(async () => { await page.getByRole('button', { name: '测试连接', exact: true }).click() })
    await act(async () => {
      await page.getByPlaceholder('从列表选择，或直接输入模型名称').fill('new-config-before-old-result')
    })
    await act(async () => { finish?.({ success: false, error: 'stale diagnostic HTTP 401' }) })

    expect(container?.textContent).not.toContain('HTTP 401')
    expect(container?.textContent).not.toContain('HTTP 402')
    await expect.element(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled()
  })

  it.each([
    ['zh-CN', '连接失败：模型的最大输出 Tokens 无效。请在设置里为这个模型填一个正整数后重试。'],
    ['en-US', 'Connection failed: The model’s max output tokens setting is invalid. Enter a positive whole number for this model in Settings, then try again.'],
  ] as const)('explains a registered failure code in %s instead of showing the bare code', async (locale, expected) => {
    await renderFailedTest(locale, 'MODEL_OUTPUT_LIMIT_INVALID')

    await expect.element(page.getByText(expected, { exact: true })).toBeVisible()
    expect(container?.textContent).not.toContain('MODEL_OUTPUT_LIMIT_INVALID')
  })

  it('keeps Chinese provider text out of the English result', async () => {
    await renderFailedTest('en-US', '模型请求失败（HTTP 401）。')

    await expect.element(page.getByText('Connection failed', { exact: true })).toBeVisible()
    expect(container?.textContent).not.toMatch(/\p{Script=Han}/u)
  })
})
