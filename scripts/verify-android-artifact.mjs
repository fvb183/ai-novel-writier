#!/usr/bin/env node
/** Bind an APK to the exact web assets, Android package and public signing identity. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { unzipSync } from 'fflate'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'
import { androidWebSourceFingerprint } from './android-web-source-fingerprint.mjs'

const root = path.resolve(import.meta.dirname, '..')
const arguments_ = process.argv.slice(2)
const explicitApk = arguments_.find(value => !value.startsWith('--'))
const reportArgument = arguments_.find(value => value.startsWith('--report='))?.slice('--report='.length)
const reportPath = path.resolve(root, reportArgument || '.runtime/android-delivery-report.json')
const reportRelative = path.relative(path.join(root, '.runtime'), reportPath)
assert.ok(reportRelative && !reportRelative.startsWith('..') && !path.isAbsolute(reportRelative), 'Artifact report must remain inside this checkout .runtime')
const outputDirectory = path.join(root, 'android/build/outputs/apk/debug')
const output = explicitApk ? null : JSON.parse(fs.readFileSync(path.join(outputDirectory, 'output-metadata.json'), 'utf8'))
if (output) assert.equal(output.elements?.length, 1, 'Specify an APK explicitly for split outputs')
const apk = path.resolve(explicitApk || path.join(outputDirectory, output.elements[0].outputFile))
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
assert.ok(sdk, 'Set ANDROID_HOME for Android package/signature verification')
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
const tools = path.join(sdk, 'build-tools', '35.0.0')
const run = (executable, args, cwd = root) => {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `Verification failed: ${result.stderr || result.stdout}`)
  return result.stdout
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = fs.readFileSync(apk)
// Windows aapt cannot reliably decode a Unicode absolute argv path. Its cwd is
// passed through CreateProcessW, so an ASCII APK basename avoids lossy decoding.
const badging = run(path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', path.basename(apk)], path.dirname(apk))
const signed = run(java, ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk])
const metadata = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging)
assert.ok(metadata, 'Android package metadata is missing')
const applicationLabel = /^application-label:'([^']+)'/m.exec(badging)?.[1]
const expectedLabel = /<string name="app_name">([^<]+)<\/string>/.exec(fs.readFileSync(path.join(root, 'android/res/values/strings.xml'), 'utf8'))?.[1]
assert.ok(expectedLabel, 'Android source application label is missing')
assert.equal(applicationLabel, expectedLabel, 'APK application label differs from source')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(metadata[3], pkg.version, 'APK and app version differ')
assert.ok(['io.github.ethanyoq.ainovelwriter.dev', 'io.github.ethanyoq.ainovelwriter'].includes(metadata[1]), 'Unexpected Android application ID')
assert.match(signed, /Verified using v[23] scheme.*true/)
const signingCertificateSha1 = /^Signer #1 certificate SHA-1 digest: (.+)$/m.exec(signed)?.[1]
const expectedSigner = process.env.AI_NOVEL_ANDROID_EXPECTED_DEBUG_CERT_SHA1?.replaceAll(':', '').toLowerCase()
if (expectedSigner) assert.equal(signingCertificateSha1, expectedSigner, 'APK signing certificate differs from the expected upgrade identity')
const extracted = unzipSync(bytes, { filter: entry => entry.name.startsWith('assets/') })
const native = unzipSync(bytes, { filter: entry => /^classes\d*\.dex$/.test(entry.name) })
const containsNative = marker => Object.values(native).some(value => Buffer.from(value).includes(Buffer.from(marker)))
assert.ok(containsNative('Lio/github/ethanyoq/ainovelwriter/GoogleDriveAuthorization;'), 'APK lacks the Android Google authorization host')
assert.ok(containsNative('Lio/github/ethanyoq/ainovelwriter/DeviceSecureStorage;'), 'APK lacks device-bound secure storage')
assert.ok(containsNative('google.cancel') && containsNative('google.invalidate'), 'APK lacks current authorization lifecycle operations')
assert.ok(containsNative('manual') && containsNative('无效重定向模式'), 'APK lacks current manual redirect validation')
assert.ok(containsNative('sqlite.schemaSnapshot'), 'APK lacks the batched schema bridge operation')
assert.ok(containsNative('fs.installExclusive') && containsNative('installExclusiveFile'), 'APK lacks the accepted Android exclusive-install implementation')
const nativeDex = Object.entries(native).map(([name, value]) => ({ path: name, bytes: value.length, sha256: digest(value) })).sort((left, right) => left.path.localeCompare(right.path))
assert.ok(nativeDex.length, 'APK contains no native DEX files')
const nativeSources = ['NativeBridge.java', 'GoogleDriveAuthorization.java', 'DeviceSecureStorage.java', 'MainActivity.java', 'GenerationService.java'].map(name => {
  const file = path.join(root, 'android/java/io/github/ethanyoq/ainovelwriter', name)
  return { path: path.relative(root, file).replaceAll('\\', '/'), sha256: digest(fs.readFileSync(file)) }
})
const webRoot = path.join(root, 'mobile-dist')
const webSourceReceipt = JSON.parse(fs.readFileSync(path.join(webRoot, 'android-web-source.json'), 'utf8'))
assert.equal(webSourceReceipt.version, 1, 'Missing Android web source receipt')
assert.equal(webSourceReceipt.sourceSetSha256, androidWebSourceFingerprint(root), 'Android web source receipt is stale')
function files(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name)
    return entry.isDirectory() ? files(directory, name) : [name]
  }).sort()
}
const manifest = files(webRoot).map(relative => {
  const archive = `assets/${relative.replaceAll('\\', '/')}`
  const original = fs.readFileSync(path.join(webRoot, relative))
  assert.ok(extracted[archive], `APK lacks a web resource: ${relative}`)
  assert.equal(digest(extracted[archive]), digest(original), `APK contains a stale web resource: ${relative}`)
  return { path: relative.replaceAll('\\', '/'), bytes: original.length, sha256: digest(original) }
})
const packaged = Object.keys(extracted).filter(name => !name.endsWith('/')).sort()
assert.deepEqual(packaged, manifest.map(entry => `assets/${entry.path}`).sort(), 'APK contains extra stale web resources')
const report = {
  checkedAt: new Date().toISOString(), apk, bytes: bytes.length, sha256: digest(bytes),
  build: readBuildFingerprint(root),
  webSourceSetSha256: webSourceReceipt.sourceSetSha256, webSourcesMatched: true, batchedSchemaBridgePackaged: true,
  packageName: metadata[1], versionCode: Number(metadata[2]), versionName: metadata[3], applicationLabel, applicationLabelMatched: true, exclusiveInstallPackaged: true,
  minSdk: Number(/^sdkVersion:'(\d+)'/m.exec(badging)?.[1]), targetSdk: Number(/^targetSdkVersion:'(\d+)'/m.exec(badging)?.[1]),
  signingCertificateSha1,
  signingCertificateSha256: /^Signer #1 certificate SHA-256 digest: (.+)$/m.exec(signed)?.[1],
  signatureVerified: true, nativeAuthorizationPackaged: true, deviceSecureStoragePackaged: true, manualRedirectPackaged: true,
  nativeDex, nativeSources,
  ...(expectedSigner ? { upgradeCertificateMatched: true } : {}),
  webAssetsVerified: manifest.length, webAssets: manifest,
  deviceTest: false, googleAuthorizationTest: false,
}
fs.mkdirSync(path.join(root, '.runtime'), { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, webAssets: undefined }))
