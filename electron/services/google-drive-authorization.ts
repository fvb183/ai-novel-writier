import path from 'node:path'
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { safeStorage, shell } from 'electron'
import { getGlobalDataRoot } from './app-data-locator'
import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { GOOGLE_DRIVE_SCOPE, type GoogleDriveAuthorization, type GoogleDriveAuthStatus } from '../../src/shared/google-drive-sync'
import { deviceProtectedStorageAvailable } from './device-protected-storage'
import { networkFetch } from './network-fetch'
import { createDriveRequestBudget, driveAbortError, waitForAbortable, waitForDriveResponse, withDriveResponseBudget } from './google-drive-request-budget'

interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }
interface Document { version: 1; clientId: string; encrypted?: string; encryptedClientSecret?: string }
export interface GoogleAuthorizationOptions {
  read(): unknown
  write(value: Document): void
  storage: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> & { getSelectedStorageBackend?(): string }
  open(url: string): Promise<unknown>
  fetch?: typeof fetch
  authorizationEndpoint?: string
  tokenEndpoint?: string
  revokeEndpoint?: string
  timeoutMs?: number
}
function fail(code: string): never { throw new Error(code) }
async function tokenResponse(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > 32_768) { await response.body?.cancel().catch(() => {}); fail('GOOGLE_AUTH_RESPONSE_INVALID') }
  const reader = response.body?.getReader(), parts: Uint8Array[] = []
  let size = 0
  if (!reader) fail('GOOGLE_AUTH_RESPONSE_INVALID')
  try {
    for (;;) {
      const part = await reader.read().catch(() => fail('GOOGLE_AUTH_NETWORK_FAILED')); if (part.done) break
      size += part.value.byteLength
      if (size > 32_768) { await reader.cancel().catch(() => {}); fail('GOOGLE_AUTH_RESPONSE_INVALID') }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('GOOGLE_AUTH_RESPONSE_INVALID')
    return value as Record<string, unknown>
  } catch { return fail('GOOGLE_AUTH_RESPONSE_INVALID') }
}
const validClientId = (value: unknown): value is string => typeof value === 'string' && value.length <= 300 && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value)
const validClientSecret = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value)
const validTokens = (value: unknown): value is Tokens => {
  const input = value as Tokens | undefined
  return Boolean(input && typeof input.accessToken === 'string' && input.accessToken.length > 0 && input.accessToken.length <= 16_384
    && Number.isFinite(input.expiresAt) && (!input.refreshToken || typeof input.refreshToken === 'string' && input.refreshToken.length <= 16_384))
}

export class DesktopGoogleDriveAuthorization implements GoogleDriveAuthorization {
  private document: Document
  private tokens?: Tokens
  private clientSecret?: string
  private cancelPending?: () => void
  private refreshing?: { promise: Promise<string>; controller: AbortController; subscribers: Set<symbol> }
  private epoch = 0
  constructor(private options: GoogleAuthorizationOptions) {
    const document = options.read() as Document | null
    if (document && (document.version !== 1 || document.clientId !== '' && !validClientId(document.clientId)
      || [document.encrypted, document.encryptedClientSecret].some(value => value !== undefined && (typeof value !== 'string' || value.length > 131_072)))) fail('GOOGLE_CREDENTIAL_STORE_INVALID')
    this.document = document ?? { version: 1, clientId: '' }
    if (this.document.encryptedClientSecret && this.encryptedStorage()) {
      try {
        const secret = options.storage.decryptString(Buffer.from(this.document.encryptedClientSecret, 'base64'))
        if (!validClientSecret(secret)) fail('GOOGLE_CREDENTIAL_STORE_INVALID')
        this.clientSecret = secret
      } catch { fail('GOOGLE_CREDENTIAL_STORE_INVALID') }
    }
    if (this.document.encrypted && this.encryptedStorage()) {
      try {
        const tokens: unknown = JSON.parse(options.storage.decryptString(Buffer.from(this.document.encrypted, 'base64')))
        if (!validTokens(tokens)) fail('GOOGLE_CREDENTIAL_STORE_INVALID')
        this.tokens = tokens
      } catch { fail('GOOGLE_CREDENTIAL_STORE_INVALID') }
    }
  }
  private encryptedStorage(): boolean {
    return deviceProtectedStorageAvailable(this.options.storage)
  }
  private save(tokens?: Tokens): void {
    this.tokens = tokens
    const document: Document = { version: 1, clientId: this.document.clientId }
    if (this.clientSecret && this.encryptedStorage()) {
      try { document.encryptedClientSecret = this.options.storage.encryptString(this.clientSecret).toString('base64') }
      catch { /* Keep the client secret only in memory; never persist plaintext. */ }
    }
    if (tokens && this.encryptedStorage()) {
      try { document.encrypted = this.options.storage.encryptString(JSON.stringify(tokens)).toString('base64') }
      catch { /* Keep this authorization in memory; never persist plaintext. */ }
    }
    this.options.write(document); this.document = document
  }
  async status(): Promise<GoogleDriveAuthStatus> {
    return { platform: 'desktop', available: true, configured: validClientId(this.document.clientId), authorized: Boolean(this.tokens),
      clientId: this.document.clientId, clientSecretConfigured: Boolean(this.clientSecret),
      persistence: this.encryptedStorage() && (!this.clientSecret || Boolean(this.document.encryptedClientSecret))
        && (!this.tokens || Boolean(this.document.encrypted)) ? 'os-backed' : 'session-only' }
  }
  async configure(clientId: string, clientSecret?: string): Promise<void> {
    if (!validClientId(clientId)) fail('GOOGLE_CLIENT_ID_INVALID')
    if (clientSecret !== undefined && clientSecret !== '' && !validClientSecret(clientSecret)) fail('GOOGLE_CLIENT_SECRET_INVALID')
    const secret = clientSecret === undefined ? clientId === this.document.clientId ? this.clientSecret : undefined : clientSecret || undefined
    if (clientId === this.document.clientId && secret === this.clientSecret) return
    this.cancel(); this.clientSecret = secret; this.document = { version: 1, clientId }; this.save()
  }
  cancel(): void { this.epoch++; this.refreshing?.controller.abort(new Error('GOOGLE_AUTH_CANCELLED')); this.cancelPending?.() }
  private async tokenRequest(parameters: Record<string, string>, oldRefresh?: string, signal?: AbortSignal): Promise<string> {
    const epoch = this.epoch
    const budget = createDriveRequestBudget(signal, 30_000)
    try {
      if (budget.signal.aborted) throw driveAbortError(budget.signal)
      let response: Response
      try { response = withDriveResponseBudget(await waitForDriveResponse((this.options.fetch ?? networkFetch)(this.options.tokenEndpoint ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...parameters, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}) }), signal: budget.signal }), budget), budget) }
      catch { return fail('GOOGLE_AUTH_NETWORK_FAILED') }
      if (epoch !== this.epoch) { await response.body?.cancel().catch(() => {}); fail('GOOGLE_AUTH_CANCELLED') }
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          // Provider descriptions may contain private request data. Only expose our fixed codes.
          const result = await tokenResponse(response)
          if (signal?.aborted) throw driveAbortError(signal)
          if (epoch !== this.epoch) fail('GOOGLE_AUTH_CANCELLED')
          if (result.error === 'invalid_client' || result.error === 'unauthorized_client') fail('GOOGLE_CLIENT_REJECTED')
          if (result.error === 'invalid_scope') fail('GOOGLE_AUTH_SCOPE_INVALID')
          if (result.error === 'invalid_grant') { this.save(); fail('GOOGLE_AUTH_REQUIRED') }
          if (result.error === 'invalid_request') {
            // Inspect known provider wording without returning its private text.
            if (typeof result.error_description === 'string' && /^(?:client_secret is (?:missing|required)|missing required (?:parameter|field):? client_secret)\.?$/i.test(result.error_description.trim())) fail('GOOGLE_CLIENT_SECRET_REQUIRED')
            fail('GOOGLE_AUTH_REQUEST_REJECTED')
          }
          fail('GOOGLE_AUTH_RESPONSE_INVALID')
        }
        await response.body?.cancel().catch(() => {})
        return fail('GOOGLE_AUTH_NETWORK_FAILED')
      }
      const result = await tokenResponse(response)
      if (signal?.aborted) throw driveAbortError(signal)
      if (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || Number(result.expires_in) <= 0
        || result.scope !== undefined && typeof result.scope !== 'string') fail('GOOGLE_AUTH_RESPONSE_INVALID')
      if (typeof result.scope === 'string' && !result.scope.split(' ').includes(GOOGLE_DRIVE_SCOPE)) fail('GOOGLE_AUTH_SCOPE_INVALID')
      const tokens = { accessToken: result.access_token, refreshToken: result.refresh_token ?? oldRefresh, expiresAt: Date.now() + Number(result.expires_in) * 1000 }
      if (!validTokens(tokens)) fail('GOOGLE_AUTH_RESPONSE_INVALID')
      if (budget.signal.aborted) throw driveAbortError(budget.signal)
      if (epoch !== this.epoch) fail('GOOGLE_AUTH_CANCELLED')
      this.save(tokens); return tokens.accessToken
    } catch (error) {
      if (budget.signal.aborted) throw signal?.aborted ? driveAbortError(signal) : new Error('GOOGLE_AUTH_TIMEOUT')
      throw error
    } finally { budget.finish() }
  }
  private async refreshToken(signal?: AbortSignal): Promise<string> {
    if (this.refreshing?.controller.signal.aborted) this.refreshing = undefined
    if (!this.refreshing) {
      const operation = { promise: undefined as unknown as Promise<string>, controller: new AbortController(), subscribers: new Set<symbol>() }
      operation.promise = this.tokenRequest({ grant_type: 'refresh_token', client_id: this.document.clientId, refresh_token: this.tokens!.refreshToken! }, this.tokens!.refreshToken, operation.controller.signal)
        .finally(() => { if (this.refreshing === operation) this.refreshing = undefined })
      this.refreshing = operation
    }
    const operation = this.refreshing, subscriber = Symbol()
    operation.subscribers.add(subscriber)
    try { return await waitForAbortable(operation.promise, signal) }
    finally {
      operation.subscribers.delete(subscriber)
      if (!operation.subscribers.size && signal?.aborted) operation.controller.abort(driveAbortError(signal))
    }
  }
  async accessToken(interactive: boolean, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw driveAbortError(signal)
    if (!validClientId(this.document.clientId)) fail('GOOGLE_CLIENT_NOT_CONFIGURED')
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) return this.tokens.accessToken
    if (this.tokens?.refreshToken) {
      try { return await this.refreshToken(signal) } catch (error) { if (signal?.aborted || !interactive || !(error instanceof Error) || error.message !== 'GOOGLE_AUTH_REQUIRED') throw error }
    }
    if (!interactive) fail('GOOGLE_AUTH_REQUIRED')
    if (this.cancelPending) fail('GOOGLE_AUTH_BUSY')
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return new Promise<string>((resolve, reject) => {
      let done = false, exchanging = false, timer: ReturnType<typeof setTimeout> | undefined
      const exchangeController = new AbortController()
      const abort = () => finish(signal ? driveAbortError(signal) : new Error('GOOGLE_AUTH_CANCELLED'))
      const finish = (error?: Error, token?: string) => {
        if (done) return; done = true
        if (error) { this.epoch++; exchangeController.abort(error) }
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.cancelPending = undefined
        if (server.listening) server.close()
        server.closeAllConnections()
        if (error) reject(error); else resolve(token!)
      }
      const server = http.createServer(async (request, response) => {
        const address = server.address()
        if (!address || typeof address === 'string') return
        const host = `127.0.0.1:${address.port}`
        if (request.method !== 'GET' || request.headers.host !== host) { response.writeHead(404).end(); return }
        let url: URL
        try { url = new URL(request.url ?? '/', `http://${host}`) } catch { response.writeHead(400).end('Invalid authorization response.'); return }
        if (url.origin !== `http://${host}` || url.pathname !== '/oauth/google/callback') { response.writeHead(404).end(); return }
        const received = url.searchParams.get('state') ?? ''
        if (url.searchParams.getAll('state').length !== 1 || !/^[a-zA-Z0-9_-]{43}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) { response.writeHead(400).end('Invalid authorization state.'); return }
        if (exchanging || done) { response.writeHead(409).end(); return }
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer')
        const codes = url.searchParams.getAll('code'), errors = url.searchParams.getAll('error')
        if (codes.length > 1 || errors.length > 1 || codes.length && errors.length) { response.writeHead(400).end('Invalid authorization response.'); return }
        if (errors.length) { response.end('Google 授权未完成。请返回 AI小说编辑器查看结果。\nAuthorization was not completed. Return to AI Novel Editor.', () => finish(new Error('GOOGLE_AUTH_CANCELLED'))); return }
        const code = url.searchParams.get('code')
        if (!code || code.length > 8192) { response.writeHead(400).end('Invalid authorization response.'); return }
        exchanging = true
        try { const token = await this.tokenRequest({ grant_type: 'authorization_code', client_id: this.document.clientId, code,
          code_verifier: verifier, redirect_uri: `http://${host}/oauth/google/callback` }, undefined, exchangeController.signal)
          response.end('Google 账户授权已完成。请返回 AI小说编辑器，应用将继续检查 Google Drive 连接。\nGoogle authorization completed. Return to AI Novel Editor to check the Drive connection.', () => finish(undefined, token)) }
        catch (error) {
          const failure = error instanceof Error ? error : new Error('GOOGLE_AUTH_FAILED')
          // Receiving a code is not success: the token exchange can still fail after consent.
          response.statusCode = 502
          response.end('Google 连接未完成。请返回 AI小说编辑器查看原因并重试。\nGoogle connection did not complete. Return to AI Novel Editor for details.', () => finish(failure))
        }
      })
      server.once('error', () => finish(new Error('GOOGLE_CALLBACK_FAILED')))
      this.cancelPending = () => finish(new Error('GOOGLE_AUTH_CANCELLED'))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new Error('GOOGLE_AUTH_TIMEOUT')), this.options.timeoutMs ?? 180_000)
      server.listen(0, '127.0.0.1', () => {
        if (done) { server.close(); return }
        const address = server.address()
        if (!address || typeof address === 'string') { finish(new Error('GOOGLE_CALLBACK_FAILED')); return }
        const url = new URL(this.options.authorizationEndpoint ?? 'https://accounts.google.com/o/oauth2/v2/auth')
        url.search = new URLSearchParams({ client_id: this.document.clientId, redirect_uri: `http://127.0.0.1:${address.port}/oauth/google/callback`,
          response_type: 'code', scope: GOOGLE_DRIVE_SCOPE, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
        this.options.open(url.href).catch(() => finish(new Error('GOOGLE_BROWSER_FAILED')))
      })
    })
  }
  async disconnect(): Promise<void> {
    this.cancel()
    const token = this.tokens?.refreshToken ?? this.tokens?.accessToken
    this.save()
    if (!token) return
    try {
      const result = await (this.options.fetch ?? networkFetch)(this.options.revokeEndpoint ?? 'https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(30_000) })
      await result.body?.cancel().catch(() => {})
      if (!result.ok && result.status !== 400) fail('GOOGLE_REVOCATION_UNCONFIRMED')
    } catch { fail('GOOGLE_REVOCATION_UNCONFIRMED') }
  }
  async invalidate(): Promise<void> {
    this.cancel()
    this.save(this.tokens?.refreshToken ? { ...this.tokens, expiresAt: 0 } : undefined)
  }
}

export function createGoogleDriveAuthorization(): GoogleDriveAuthorization {
  const file = path.join(getGlobalDataRoot(), 'google-drive-authorization.json')
  return new DesktopGoogleDriveAuthorization({ storage: safeStorage, open: url => shell.openExternal(url),
    read: () => { const result = tryReadJsonFile(file); if (result.status === 'error') fail('GOOGLE_CREDENTIAL_STORE_INVALID'); return result.status === 'ok' ? result.value : null },
    write: value => writeJsonFile(file, value) })
}
