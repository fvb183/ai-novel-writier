import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { androidWebSourceFingerprint } from './android-web-source-fingerprint.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const android = path.join(root, 'android')
const javaName = process.platform === 'win32' ? 'java.exe' : 'java'
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javaName) : javaName
const variant = process.argv.includes('--release') ? 'Release' : 'Debug'
const checkSigning = process.argv.includes('--check-signing')
if (!checkSigning && !fs.existsSync(path.join(root, 'mobile-dist', 'index.html'))) {
  throw new Error('Missing Android frontend. Run pnpm build:android:web first.')
}
if (!checkSigning) {
  let receipt
  try { receipt = JSON.parse(fs.readFileSync(path.join(root, 'mobile-dist', 'android-web-source.json'), 'utf8')) } catch { /* Rebuild is required below. */ }
  if (receipt?.version !== 1 || receipt.sourceSetSha256 !== androidWebSourceFingerprint(root)) {
    throw new Error('Android web build is stale. Run pnpm build:android:web before packaging. No APK was produced.')
  }
}
const check = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true })
if (check.error || check.status !== 0) {
  throw new Error('Android packaging requires JDK 17. Install it and set JAVA_HOME. No APK was produced.')
}
const version = /version "(\d+)/.exec(check.stderr || check.stdout)
if (!version || Number(version[1]) < 17) throw new Error('Android packaging requires JDK 17 or newer.')
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT
  && !fs.existsSync(path.join(android, 'local.properties'))) {
  throw new Error('Set ANDROID_HOME to an Android SDK with platform 35 and build-tools 35.0.0, or set sdk.dir in android/local.properties.')
}
const result = spawnSync(java, [
  '-classpath', path.join(android, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
  'org.gradle.wrapper.GradleWrapperMain', '--no-daemon', checkSigning ? (variant === 'Release' ? 'verifyReleaseSigning' : 'verifyDevelopmentSigning') : `assemble${variant}`,
], {
  cwd: android, stdio: 'inherit', windowsHide: true,
  env: {
    ...process.env,
    GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || path.join(root, '.runtime', 'gradle'),
    ANDROID_USER_HOME: process.env.ANDROID_USER_HOME || path.join(root, '.runtime', 'android-user'),
  },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (checkSigning) { console.log(`${variant} signing identity verified; no APK was built.`); process.exit(0) }
console.log(`Android ${variant.toLowerCase()} output: ${path.join(android, 'build', 'outputs', 'apk', variant.toLowerCase())}`)
