import path from 'node:path'

declare const leaseBrand: unique symbol
/** A local capability, never serialized or inferred from a process-global context. */
export type KnowledgeSourceLease = Readonly<{ [leaseBrand]: true }>
const leases = new WeakMap<KnowledgeSourceLease, { key: string; active: boolean }>()
const tails = new Map<string, Promise<void>>()
const normalized = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)

export function assertKnowledgeSourceLease(projectStorageRoot: string, lease: KnowledgeSourceLease): void {
  const state = leases.get(lease)
  if (!state?.active) throw new Error('GENERATION_KNOWLEDGE_LEASE_EXPIRED')
  if (state.key !== normalized(projectStorageRoot)) throw new Error('GENERATION_KNOWLEDGE_LEASE_ROOT_MISMATCH')
}

export function assertKnowledgeSourceIdle(projectStorageRoot: string, lease?: KnowledgeSourceLease): void {
  if (lease) {
    assertKnowledgeSourceLease(projectStorageRoot, lease)
    return
  }
  const key = normalized(projectStorageRoot)
  if (tails.has(key)) throw new Error('GENERATION_KNOWLEDGE_BUSY')
}

/** Serializes canonical KB changes with a short source verification/formal-write boundary. */
export async function withKnowledgeSourceGate<T>(
  projectStorageRoot: string,
  operation: (lease: KnowledgeSourceLease) => T | Promise<T>,
  lease?: KnowledgeSourceLease,
): Promise<T> {
  if (lease) {
    assertKnowledgeSourceLease(projectStorageRoot, lease)
    return operation(lease)
  }
  const key = normalized(projectStorageRoot)
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  tails.set(key, tail)
  await previous
  const ownedLease = Object.freeze({}) as KnowledgeSourceLease
  const state = { key, active: true }
  leases.set(ownedLease, state)
  try {
    return await operation(ownedLease)
  } finally {
    // Detached work may retain the object, but it cannot retain a released lock.
    state.active = false
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
