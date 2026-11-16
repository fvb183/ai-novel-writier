import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A source receipt, not a backup, secret scanner, Git receipt, or build verifier.
// Read only this checkout; the historical C: baseline and the D: adaptation are admitted. Never resolve the old source path in the
// recovery manifest, walk dependency/runtime trees, or follow filesystem links.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineName = 'recovery-source-manifest.json';
const outputName = '.runtime/final-source-overlay.json';
const admittedRoots = new Map([
  ['AI-Novel-Writer-r2-recovery-2026-10-29', 'c:\\'],
  ['AI-Novel-Writer-1.4-adaptation', 'd:\\'],
]);
const admittedDrive = admittedRoots.get(path.basename(root));
if (!admittedDrive || (process.platform === 'win32' && path.parse(root).root.toLowerCase() !== admittedDrive)) {
  throw new Error('This recorder is restricted to the named recovery or D: adaptation checkout.');
}
if (process.argv.slice(2).some(value => value !== '--verify')) {
  throw new Error('Usage: node scripts/record-final-source-overlay.mjs [--verify]');
}
const verifyOnly = process.argv.includes('--verify');
const sourceRoots = new Set([
  '.github', '.storybook', '.release', 'build', 'android', 'docs', 'electron', 'mobile',
  'plugins', 'public', 'scripts', 'src', 'test',
]);
const excludedDirectories = new Set([
  'node_modules', '.runtime', 'mobile-dist', 'release', '.git', '.gradle',
  '.vitest-attachments', '.pnpm-store', '.review-temp', '.workbuddy',
  '.agents', '.claude', '.codex', '.superpowers', '.worktrees',
  '.android-font-cache', '.ssh', '.aws', '.azure', '.gnupg',
  '.ai-novel', '.vela', 'userdata', 'user-data', 'user_data',
  'account-data', 'runtime-data', 'appdata', 'logs',
]);
const excludedRootDirectories = new Set([
  'account', 'accounts', 'profile', 'profiles', '.config', '.local', '.cache',
  '.android', '.npm', '.vscode', '.idea', 'backup', 'backups', 'output',
]);
const sourceExtensions = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.json5', '.jsonl',
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.icns', '.bmp', '.ttf', '.otf', '.woff', '.woff2', '.mp4', '.webm',
  '.sh', '.bash', '.zsh', '.cmd', '.bat', '.ps1', '.py', '.sql', '.yaml',
  '.yml', '.xml', '.java', '.kt', '.kts', '.gradle', '.properties',
  '.toml', '.ini', '.pro', '.proto', '.m', '.mm', '.h', '.c', '.cpp',
  '.csv', '.snap', '.graphql', '.gql', '.webmanifest',
]);
const rootFileNames = new Set([
  '.eslintrc.cjs', '.gitattributes', '.gitignore', 'license', 'package.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'electron-builder.json5',
  'recovery-source-manifest.json', 'recovery-manifest.json', 'recovered-dependency.json',
  '启动电脑版.cmd', '启动电脑版-1.4适配.cmd',
  '启动电脑版-登录与项目修复.cmd', '启动电脑版-主线续章修复.cmd',
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const normalize = value => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid relative path.');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) ||
      normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe manifest relative path.');
  }
  return normalized;
};
const directoryReason = relative => {
  const parts = normalize(relative).toLowerCase().split('/');
  if (parts.some(part => excludedDirectories.has(part))) return 'dependency-build-runtime-or-account-subtree';
  if (parts.some(part => part.startsWith('dist'))) return 'dist-build-output';
  if (excludedRootDirectories.has(parts[0])) return 'local-account-tool-or-output-subtree';
  if (parts[0] === 'android' && parts.slice(1).includes('build')) return 'android-build-output';
  return null;
};
const fileReason = relative => {
  const normalized = normalize(relative);
  const lower = normalized.toLowerCase();
  const parts = lower.split('/');
  const name = parts.at(-1);
  const parentReason = parts.length > 1 ? directoryReason(parts.slice(0, -1).join('/')) : null;
  if (parentReason) return parentReason;
  if (name === '.env' || name.startsWith('.env.')) return 'environment-file';
  if (/\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i.test(name) ||
      /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(name)) return 'private-key-or-certificate-material';
  if (['.npmrc', '.netrc', '_netrc', 'key.properties', 'local.properties',
    'google-services.json', 'googleservice-info.plist'].includes(name) ||
      /^(?:credentials?|tokens?|secrets?|auth|authorization|service[_-]?account|client[_-]?secret|oauth[_-]?client|signing)(?:[._-].*)?\.(?:json|json5|jsonl|yaml|yml|properties|ini|txt)$/i.test(name)) {
    return 'credential-or-local-machine-configuration';
  }
  if (/\.(?:db(?:-wal|-shm)?|sqlite(?:3)?(?:-wal|-shm)?|lance|txn|manifest)$/i.test(name)) return 'project-runtime-database-or-index';
  if (/\.(?:tsbuildinfo|log|apk|aab|exe|msi|zip|7z|dmg|asar|map)$/i.test(name)) return 'generated-build-or-delivery-output';
  if (parts.length === 1) {
    if (rootFileNames.has(name) || /\.md$/i.test(name) ||
        /^(?:tsconfig|vite|vitest)(?:\.[^.]+)*\.(?:json|ts)$/i.test(name)) return null;
    if (/^(?:android.*-test-report|.*-receipt|.*-manifest)\.json$/i.test(name)) return null;
    return 'outside-root-source-allowlist';
  }
  if (!sourceRoots.has(parts[0])) return 'outside-source-root-allowlist';
  if (['.gitignore', '.gitattributes', 'license', 'gradlew', 'gradlew.bat', 'gradle-wrapper.jar'].includes(name)) return null;
  if (!sourceExtensions.has(path.posix.extname(name))) return 'outside-source-format-allowlist';
  return null;
};
const category = relative => {
  if (!relative.includes('/') && /^(?:recovery.*\.json|recovered-dependency\.json|.*-test-report\.json)$/i.test(relative)) return 'delivery-metadata';
  if (relative.startsWith('docs/') || /\.md$/i.test(relative)) return 'documentation';
  if (/(?:^|\/)(?:__tests__|tests?|fixtures|__screenshots__)(?:\/|$)|\.(?:test|spec|browser|probe)\./i.test(relative)) return 'test-or-fixture';
  if (relative.startsWith('scripts/')) return 'source-tooling';
  if (!relative.includes('/') || relative.startsWith('.github/') || relative.startsWith('.storybook/')) return 'build-or-repository-configuration';
  return 'product-source-or-asset';
};
const absolute = relative => path.join(root, ...normalize(relative).split('/'));
const requireRegularParents = relative => {
  const parts = normalize(relative).split('/');
  for (let count = 0; count < parts.length; count++) {
    const ancestor = count === 0 ? root : path.join(root, ...parts.slice(0, count));
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source ancestor must be a regular directory.');
  }
};
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const hashRegularFile = relative => {
  requireRegularParents(relative);
  const target = absolute(relative);
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Source file must be regular and must not be a link.');
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (stamp(before) !== stamp(opened)) throw new Error('Source changed before opening.');
    const digest = sha256(fs.readFileSync(descriptor));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) throw new Error('Source changed while hashing.');
    return { path: relative, bytes: Number(after.size), sha256: digest, category: category(relative), stamp: stamp(after) };
  } finally {
    fs.closeSync(descriptor);
  }
};
const enumerate = () => {
  const included = [];
  const excludedFiles = [];
  const excludedSubtrees = [];
  const walk = relative => {
    const location = relative ? absolute(relative) : root;
    for (const entry of fs.readdirSync(location, { withFileTypes: true }).sort((a, b) => lexical(a.name, b.name))) {
      const candidate = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        excludedFiles.push({ path: candidate, reason: 'filesystem-link-not-followed' });
      } else if (entry.isDirectory()) {
        const reason = directoryReason(candidate) ?? (!relative && !sourceRoots.has(entry.name.toLowerCase()) ? 'outside-source-root-allowlist' : null);
        if (reason) excludedSubtrees.push({ path: candidate, reason });
        else walk(candidate);
      } else if (entry.isFile()) {
        const reason = fileReason(candidate);
        if (reason) excludedFiles.push({ path: candidate, reason });
        else included.push(candidate);
      } else {
        excludedFiles.push({ path: candidate, reason: 'non-regular-filesystem-entry' });
      }
    }
  };
  walk('');
  return { included: included.sort(lexical), excludedFiles, excludedSubtrees };
};
const startedAt = new Date().toISOString();
const baselineFile = hashRegularFile(baselineName);
const baseline = JSON.parse(fs.readFileSync(absolute(baselineName), 'utf8'));
if (!Array.isArray(baseline.sourceFiles) || baseline.sourceFiles.length !== 2212 ||
    !Array.isArray(baseline.links) || !Array.isArray(baseline.failures) ||
    baseline.links.length !== 0 || baseline.failures.length !== 0) {
  throw new Error('Unexpected recovery baseline structure/count; inspect without reading old source.');
}
const baselineByPath = new Map();
const baselineCasePaths = new Set();
for (const item of baseline.sourceFiles) {
  const relative = normalize(item.path);
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/i.test(item.sha256) ||
      baselineCasePaths.has(relative.toLowerCase())) throw new Error('Invalid or duplicate baseline source record.');
  baselineCasePaths.add(relative.toLowerCase());
  baselineByPath.set(relative, { path: relative, bytes: item.bytes, sha256: item.sha256.toLowerCase() });
}
const enumeration = enumerate();
const currentFiles = enumeration.included.map(hashRegularFile);
const currentByPath = new Map(currentFiles.map(item => [item.path, item]));
if (currentByPath.get(baselineName)?.sha256 !== baselineFile.sha256) throw new Error('Recovery manifest changed during audit.');
const unchanged = [];
const changed = [];
const missing = [];
const excludedBaseline = [];
for (const original of [...baselineByPath.values()].sort((a, b) => lexical(a.path, b.path))) {
  const reason = fileReason(original.path);
  if (reason) {
    // Deliberately omit even the old digest of excluded sensitive/runtime data.
    excludedBaseline.push({ path: original.path, reason });
    continue;
  }
  const current = currentByPath.get(original.path);
  if (!current) {
    try {
      requireRegularParents(original.path);
      fs.lstatSync(absolute(original.path));
      throw new Error(`Baseline entry exists but was not selected as a regular source file: ${original.path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    missing.push({ path: original.path, oldSha256: original.sha256, newSha256: null, oldBytes: original.bytes, category: category(original.path) });
  } else if (current.sha256 !== original.sha256 || current.bytes !== original.bytes) {
    changed.push({ path: original.path, oldSha256: original.sha256, newSha256: current.sha256,
      oldBytes: original.bytes, newBytes: current.bytes, category: current.category });
  } else {
    unchanged.push({ path: original.path, sha256: current.sha256, bytes: current.bytes, category: current.category });
  }
}
const additions = currentFiles.filter(item => !baselineByPath.has(item.path)).map(({ stamp: ignored, ...item }) => item);
// Detect name-set changes and obvious concurrent writes without pretending this
// ordinary filesystem audit is a transaction or an immutable build snapshot.
const finalEnumeration = enumerate();
if (JSON.stringify(enumeration.included) !== JSON.stringify(finalEnumeration.included)) throw new Error('Source selection changed during audit.');
for (const item of currentFiles) {
  requireRegularParents(item.path);
  const stat = fs.lstatSync(absolute(item.path), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stamp(stat) !== item.stamp) throw new Error(`Source changed during audit: ${item.path}`);
}
const inventory = currentFiles.map(({ stamp: ignored, ...item }) => item);
const setDigest = entries => sha256(entries.map(item => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join(''));
const currentSourceSetSha256 = setDigest(inventory);
const currentProductAndSupportSetSha256 = setDigest(inventory.filter(item => item.category !== 'delivery-metadata'));
const countsByCategory = entries => Object.fromEntries([...new Set(entries.map(item => item.category))].sort(lexical)
  .map(value => [value, entries.filter(item => item.category === value).length]));
const receipt = {
  schemaVersion: 1,
  kind: 'recovery-source-overlay-audit',
  startedAt, completedAt: new Date().toISOString(), root,
  provenance: {
    baselineManifest: { path: baselineName, sha256: baselineFile.sha256, createdAt: baseline.createdAt,
      recordedSourceFiles: baseline.sourceFiles.length, recordedLinks: baseline.links.length, recordedFailures: baseline.failures.length },
    baselineMeaning: 'The recovery manifest records equality at the original recovery-copy time only. It is not proof that current C: files still equal D: files.',
    currentMeaning: 'The selected C: source files now include the overlay listed below. Missing paths do not establish deletion intent or a rename.',
    oldSourceAccessed: false, gitAccessed: false,
    gitMeaning: 'No Git repository, commit, tracked-file list, or clean-working-tree claim was used or manufactured.',
  },
  selectionPolicy: {
    version: 1,
    sourceRoots: [...sourceRoots].sort(lexical),
    rootSourceFileNames: [...rootFileNames].sort(lexical),
    rootSourcePatterns: ['*.md', '(tsconfig|vite|vitest)(.*).(json|ts)', '*-test-report.json', '*-receipt.json', '*-manifest.json'],
    sourceExtensions: [...sourceExtensions].sort(lexical),
    exclusions: [
      'node_modules and dependency caches; every .runtime directory; dist*; mobile-dist; release; .git',
      'android/**/build and every .gradle directory; generated build/package/log/compiler state',
      'local account/tool directories and project runtime .ai-novel/.vela, SQLite/Lance/index data (including test runtime fixtures)',
      '.env and .env.*; private key/certificate formats and conventional credential/local-machine files',
      'filesystem links and unsupported source roots/formats; excluded subtrees are never traversed',
    ],
    excludedDirectoryNames: [...excludedDirectories].sort(lexical),
    excludedRootDirectoryNames: [...excludedRootDirectories].sort(lexical),
    excludedSensitiveFileContentsReadOrHashed: false,
    secretDetectionLimit: 'Path/format allowlists exclude conventional credential files before opening. This audit does not inspect source text for embedded secrets or certify their absence.',
  },
  summary: {
    baselineTotal: baseline.sourceFiles.length,
    baselineCompared: unchanged.length + changed.length + missing.length,
    baselineExcluded: excludedBaseline.length,
    unchanged: unchanged.length, changed: changed.length, missing: missing.length, added: additions.length,
    currentSelectedFiles: inventory.length,
    currentSelectedBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
    changedByCategory: countsByCategory(changed), addedByCategory: countsByCategory(additions),
  },
  currentSourceSetSha256, currentProductAndSupportSetSha256,
  digestEncoding: 'SHA-256 of sorted UTF-8 entries: relativePath + NUL + decimalByteSize + NUL + lowercaseSHA256 + LF',
  baselineComparison: { unchanged, changed, missing, excluded: excludedBaseline },
  additions,
  currentSourceFiles: inventory,
  excludedCurrentFiles: enumeration.excludedFiles,
  excludedCurrentSubtrees: enumeration.excludedSubtrees,
  limitations: [
    'A timestamped C: source-only observation, not an atomic filesystem snapshot, digital signature, backup, or release artifact verification.',
    'No D: original, installed-account directory, provider endpoint, or Google account was accessed.',
    'Dependency/runtime/output/credential data are outside this source set; delivery metadata is explicitly categorized and may change later.',
    'Per-file identity/size/timestamps and final selected names were rechecked; later changes require recording a new receipt.',
  ],
};
if (verifyOnly) {
  requireRegularParents(outputName);
  const previousStat = fs.lstatSync(absolute(outputName));
  if (!previousStat.isFile() || previousStat.isSymbolicLink() || previousStat.nlink !== 1) {
    throw new Error('Receipt to verify must be a private regular file.');
  }
  const previous = JSON.parse(fs.readFileSync(absolute(outputName), 'utf8'));
  const matches = previous.currentSourceSetSha256 === currentSourceSetSha256 &&
    previous.provenance?.baselineManifest?.sha256 === baselineFile.sha256;
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), receipt: outputName, matches,
    currentSourceSetSha256, summary: receipt.summary }));
  if (!matches) process.exitCode = 1;
} else {
  const runtime = path.join(root, '.runtime');
  if (!fs.existsSync(runtime)) fs.mkdirSync(runtime);
  requireRegularParents(outputName);
  const runtimeStat = fs.lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error('Receipt directory must not be a link.');
  const target = absolute(outputName);
  let existing;
  try { existing = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('Receipt target must be a private regular file.');
  }
  const temporary = path.join(runtime, `final-source-overlay-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(JSON.stringify({ receipt: outputName, currentSourceSetSha256, summary: receipt.summary }));
}
