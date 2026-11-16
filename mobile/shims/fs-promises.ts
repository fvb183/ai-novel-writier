import { promises } from './fs'
export const { readFile, writeFile, appendFile, stat, lstat, readdir, realpath, mkdir, mkdtemp, rename, rm, unlink, rmdir, open, access, copyFile, chmod, link } = promises
export { FileHandle } from './fs'
export default promises
