/**
 * Fill in the repository metadata that a published package should carry.
 *
 * `npm` and the GitHub page both read `repository`, `homepage`, and `bugs` from
 * the manifest; seven packages plus the root have to agree, and hand-editing
 * eight JSON files is how they stop agreeing. This takes one URL and writes all
 * of them, idempotently.
 *
 * Run with: node scripts/set-repository.mjs https://github.com/<owner>/<repo> [--dry-run]
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['bundle', 'governance', 'memory', 'panel', 'scaffold', 'store', 'tools']

const raw = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (typeof raw !== 'string' || raw.trim() === '') {
  console.error('usage: node scripts/set-repository.mjs https://github.com/<owner>/<repo> [--dry-run]')
  process.exit(1)
}

/** Normalize the input to `https://github.com/<owner>/<repo>`. */
function normalize(input) {
  const text = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text)
  if (match === null) {
    console.error(`not a GitHub repository URL: ${input}`)
    console.error('expected: https://github.com/<owner>/<repo>')
    process.exit(1)
  }
  return { owner: match[1], repo: match[2], web: text }
}

const { owner, repo, web } = normalize(raw)
const fields = {
  repository: { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` },
  homepage: `${web}#readme`,
  bugs: { url: `${web}/issues` },
}

/** Insert one repository line under the first H1 of the README, once. */
async function updateReadme() {
  const path = join(projectRoot, 'README.md')
  const text = await readFile(path, 'utf8')
  const line = `> 仓库：${web}`
  if (text.includes(line)) return 'unchanged'
  const lines = text.split('\n')
  const heading = lines.findIndex(entry => entry.startsWith('# '))
  if (heading === -1) throw new Error('README.md has no H1 to anchor the repository line')
  lines.splice(heading + 1, 0, '', line)
  const next = lines.join('\n')
  if (!dryRun) await writeFile(path, next, 'utf8')
  return 'updated'
}

let changed = 0
for (const name of PACKAGES) {
  const path = join(projectRoot, 'packages', `pseudo-agi-${name}`, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const before = JSON.stringify([manifest.repository, manifest.homepage, manifest.bugs])
  const merged = { ...manifest, ...fields }
  // Keep the conventional order: metadata right after license.
  const ordered = {}
  for (const key of ['name', 'version', 'description', 'type', 'main', 'types', 'exports', 'files',
    'author', 'license', 'repository', 'homepage', 'bugs', 'keywords', 'engines', 'publishConfig',
    'dsh', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies',
    'bundledDependencies', 'scripts']) {
    if (key in merged) ordered[key] = merged[key]
  }
  for (const key of Object.keys(merged)) {
    if (!(key in ordered)) throw new Error(`pseudo-agi-${name}: unhandled key ${key}`)
  }
  const after = JSON.stringify([ordered.repository, ordered.homepage, ordered.bugs])
  if (after === before) continue
  if (!dryRun) await writeFile(path, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
  changed++
  console.log(`  ${dryRun ? 'would update' : 'updated'} pseudo-agi-${name}`)
}

const rootPath = join(projectRoot, 'package.json')
const rootManifest = JSON.parse(await readFile(rootPath, 'utf8'))
const withRoot = { repository: fields.repository, ...rootManifest }
if (JSON.stringify(withRoot.repository) !== JSON.stringify(rootManifest.repository)) {
  if (!dryRun) await writeFile(rootPath, `${JSON.stringify(withRoot, null, 2)}\n`, 'utf8')
  changed++
  console.log(`  ${dryRun ? 'would update' : 'updated'} root package.json`)
}

const readmeState = await updateReadme()
console.log(`  README.md ${dryRun ? '(dry run)' : readmeState}`)
console.log(`${dryRun ? 'dry run: ' : ''}${changed} manifest(s) ${dryRun ? 'would change' : 'changed'}`)
