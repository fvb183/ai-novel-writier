import path from 'node:path'

const checks = new Map<string, () => void>(), queues = new Map<string, Promise<void>>(), busy = new Set<string>()
const key = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
export function registerProjectAssetAccess(root: string, check: () => void): () => void {
  const id = key(root)
  if (checks.has(id)) throw new Error('PROJECT_SYNC_ASSET_ACCESS_ALREADY_REGISTERED')
  checks.set(id, check)
  return () => { if (checks.get(id) === check) checks.delete(id) }
}
export function projectAssetRecoveryNeeded(storageRoot: string): boolean {
  try { checks.get(key(storageRoot))?.(); return false }
  catch (error) { if (error instanceof Error && error.message === 'PROJECT_SYNC_ASSET_NOT_READY') return true; throw error }
}
/** Called after the ordinary project/session/path authorization, never instead of it. */
export function assertProjectAssetFileAccess(storageRoot: string, file: string, writing = false): void {
  const relative = path.relative(storageRoot, path.resolve(file)).split(path.sep).join('/')
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return
  if (!['prompts', 'skills', 'writing-skills.json', 'partial_arch', 'partial_arch.json', 'chapter_creation_log.json', 'avatars', 'knowledge-copies']
    .includes(relative.split('/')[0]!.normalize('NFKC').toLowerCase())) return
  const id = key(storageRoot)
  checks.get(id)?.()
  if (writing && busy.has(id)) throw new Error('PROJECT_SYNC_ASSET_BUSY')
}
export async function withProjectAssetMutation<T>(root: string, revalidate: () => void, operation: () => Promise<T>): Promise<T> {
  const id = key(root), prior = queues.get(id) ?? Promise.resolve()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const waiting = prior.catch(() => {}).then(() => barrier); queues.set(id, waiting)
  try {
    await prior.catch(() => {}); revalidate(); busy.add(id)
    return await operation()
  } finally {
    busy.delete(id); release()
    if (queues.get(id) === waiting) queues.delete(id)
  }
}
