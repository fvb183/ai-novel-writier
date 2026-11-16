/** Runtime handles are local capabilities, even when saved beside author text.
 * Transfer the author checkpoint/progress without another replica's execution handle. */
export const isAuthorCheckpointPath = (relativePath: string): boolean => relativePath.normalize('NFKC').toLowerCase() === 'partial_arch.json'
export function projectAuthorFileBytes(relativePath: string, bytes: Buffer): Buffer {
  if (!isAuthorCheckpointPath(relativePath)) return bytes
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return bytes }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bytes
  const record = value as Record<string, unknown>
  const keys = ['world_building_generation_handle', 'synopsis_generation_handle']
  if (!keys.some(key => Object.hasOwn(record, key))) return bytes
  for (const key of keys) delete record[key]
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
}
export function assertProjectAuthorFileBytes(relativePath: string, bytes: Buffer): void {
  if (!projectAuthorFileBytes(relativePath, bytes).equals(bytes)) throw new Error('PROJECT_SYNC_ASSET_RUNTIME_AUTHORITY')
}
