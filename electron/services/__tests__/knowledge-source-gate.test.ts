import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertKnowledgeSourceIdle, assertKnowledgeSourceLease, withKnowledgeSourceGate, type KnowledgeSourceLease } from '../knowledge-source-gate'

const root = (name: string) => path.resolve('synthetic-gate', name)
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('explicit knowledge source leases', () => {
  it('allows awaited nested calls only with the same active root lease', async () => {
    const calls: string[] = []
    await withKnowledgeSourceGate(root('nested'), async lease => {
      calls.push('outer')
      assertKnowledgeSourceIdle(root('nested'), lease)
      await withKnowledgeSourceGate(root('nested'), async inner => {
        expect(inner).toBe(lease)
        calls.push('inner')
        await Promise.resolve()
        assertKnowledgeSourceLease(root('nested'), inner)
      }, lease)
      calls.push('done')
    })
    expect(calls).toEqual(['outer', 'inner', 'done'])
    assertKnowledgeSourceIdle(root('nested'))
  })

  it('queues independent work across awaits and preserves FIFO order', async () => {
    const entered = deferred(), release = deferred()
    const calls: number[] = []
    const first = withKnowledgeSourceGate(root('fifo'), async lease => {
      calls.push(1); entered.resolve()
      await release.promise
      await withKnowledgeSourceGate(root('fifo'), () => { calls.push(2) }, lease)
    })
    await entered.promise
    const second = withKnowledgeSourceGate(root('fifo'), () => { calls.push(3) })
    const third = withKnowledgeSourceGate(root('fifo'), () => { calls.push(4) })
    await Promise.resolve()
    expect(calls).toEqual([1])
    expect(() => assertKnowledgeSourceIdle(root('fifo'))).toThrow('GENERATION_KNOWLEDGE_BUSY')
    release.resolve()
    await Promise.all([first, second, third])
    expect(calls).toEqual([1, 2, 3, 4])
  })

  it('rejects forged, different-root and expired leases rather than treating them as authority', async () => {
    let expired!: KnowledgeSourceLease
    await withKnowledgeSourceGate(root('owner'), async lease => {
      expired = lease
      await expect(withKnowledgeSourceGate(root('other'), () => true, lease)).rejects.toThrow('LEASE_ROOT_MISMATCH')
    })
    await expect(withKnowledgeSourceGate(root('owner'), () => true, expired)).rejects.toThrow('LEASE_EXPIRED')
    await expect(withKnowledgeSourceGate(root('owner'), () => true, {} as KnowledgeSourceLease)).rejects.toThrow('LEASE_EXPIRED')
  })

  it('does not let detached work inherit authority, and releases after a failed operation', async () => {
    const ready = deferred(), resume = deferred()
    let detached!: Promise<unknown>
    const failed = withKnowledgeSourceGate(root('failure'), async lease => {
      detached = resume.promise.then(() => withKnowledgeSourceGate(root('failure'), () => 'stale', lease))
      ready.resolve()
      throw new Error('operation-failed')
    })
    await ready.promise
    await expect(failed).rejects.toThrow('operation-failed')
    await expect(withKnowledgeSourceGate(root('failure'), () => 'next')).resolves.toBe('next')
    resume.resolve()
    await expect(detached).rejects.toThrow('LEASE_EXPIRED')
  })

  it('allows different project roots concurrently', async () => {
    const entered = deferred(), release = deferred()
    const first = withKnowledgeSourceGate(root('parallel-a'), async () => { entered.resolve(); await release.promise })
    await entered.promise
    await expect(withKnowledgeSourceGate(root('parallel-b'), () => 'b')).resolves.toBe('b')
    release.resolve()
    await first
  })
})
