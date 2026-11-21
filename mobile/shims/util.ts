export function isDeepStrictEqual(left: any, right: any): boolean {
  const activeLeft = new WeakMap<object, object>()
  const activeRight = new WeakMap<object, object>()
  function same(a: any, b: any): boolean {
    if (Object.is(a, b)) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    // JSON persistence duplicates shared subobjects. Only active ancestors are
    // cycles; equal values on independent branches may have different identities.
    if (activeLeft.has(a) || activeRight.has(b)) return activeLeft.get(a) === b && activeRight.get(b) === a
    activeLeft.set(a, b)
    activeRight.set(b, a)
    try {
      return sameContents(a, b)
    } finally {
      activeLeft.delete(a)
      activeRight.delete(b)
    }
  }
  function sameContents(a: any, b: any): boolean {
    if (a instanceof Date) return Object.is(a.getTime(), b.getTime())
    if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex
    if (ArrayBuffer.isView(a)) {
      if (a.byteLength !== b.byteLength) return false
      const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
      return aa.every((value, i) => value === bb[i])
    }
    if (a instanceof ArrayBuffer) return same(new Uint8Array(a), new Uint8Array(b))
    if (a instanceof Map) return a.size === b.size && [...a].every(([key, value]) => [...b].some(([other, item]) => same(key, other) && same(value, item)))
    if (a instanceof Set) return a.size === b.size && [...a].every(value => [...b].some(item => same(value, item)))
    const aa = Reflect.ownKeys(a).filter(key => Object.prototype.propertyIsEnumerable.call(a, key))
    const bb = Reflect.ownKeys(b).filter(key => Object.prototype.propertyIsEnumerable.call(b, key))
    return aa.length === bb.length && aa.every(key => Object.prototype.propertyIsEnumerable.call(b, key) && same(a[key], b[key]))
  }
  return same(left, right)
}
export function promisify(fn: (...args: any[]) => any) {
  return (...args: any[]) => new Promise((resolve, reject) => fn(...args, (error: any, result: any) => error ? reject(error) : resolve(result)))
}
export const TextEncoder = globalThis.TextEncoder
export const TextDecoder = globalThis.TextDecoder
export default { isDeepStrictEqual, promisify, TextEncoder, TextDecoder }
