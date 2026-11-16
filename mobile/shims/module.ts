import Database from './sqlite'
import * as Arrow from 'apache-arrow'
export function createRequire(_url?: any) {
  return Object.assign((name: string) => {
    if (name === 'better-sqlite3') return Database
    if (name === 'apache-arrow') return Arrow
    throw Object.assign(new Error(`Desktop module is unavailable on Android: ${name}`), { code: 'MODULE_NOT_FOUND' })
  }, { resolve: (name: string) => { if (name === 'better-sqlite3') return 'android:sqlite'; throw new Error(`Module unavailable: ${name}`) } })
}
export default { createRequire }
