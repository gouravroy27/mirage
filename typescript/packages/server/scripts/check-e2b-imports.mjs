// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// The `./e2b` export is what a Cloudflare Worker imports to serve E2B, so
// nothing it adds at runtime may need Fastify, a Node stream, Node's
// process object or the Node host. This bundles the entry as wrangler
// resolves a Worker's imports, records every import esbuild resolves,
// static or dynamic, and fails naming each importer of a forbidden module.
// Third-party packages are walked whole. Of core, only what `./api` does
// not already load is walked: the Worker loads `./api` and its core
// modules today, so what `./e2b` adds on top is what this gate judges.
import { builtinModules } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE = '@struktoai/mirage-core'
const FORBIDDEN = [
  /^fastify$/,
  /^@fastify\//,
  /^(node:)?stream(\/.*)?$/,
  /^(node:)?process$/,
  /^@struktoai\/mirage-node(\/.*)?$/,
]
const BUILTINS = new Set(builtinModules)

/**
 * Bundle `entry` as a Worker would and report what it reaches.
 *
 * @param {import('esbuild').BuildOptions} entry The entry, as esbuild options.
 * @param {boolean} walkCore Whether to follow core's own imports.
 */
async function reach(entry, walkCore) {
  const found = []
  const builtins = new Set()
  const core = new Set()
  await build({
    ...entry,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    loader: { '.wasm': 'empty' },
    logLevel: 'error',
    plugins: [
      {
        name: 'watch-imports',
        setup(on) {
          on.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined
            if (FORBIDDEN.some((pattern) => pattern.test(args.path))) {
              found.push(`${relative(ROOT, args.importer)} imports ${args.path}`)
              return { path: args.path, external: true }
            }
            if (args.path.startsWith('node:') || BUILTINS.has(args.path)) {
              builtins.add(args.path)
              return { path: args.path, external: true }
            }
            if (args.path.startsWith(CORE)) {
              core.add(args.path)
              if (!walkCore) return { path: args.path, external: true }
            }
            return undefined
          })
        },
      },
    ],
  })
  return { found, builtins, core }
}

const e2b = await reach({ entryPoints: [resolve(ROOT, 'src/e2b/index.ts')] }, false)
const api = await reach({ entryPoints: [resolve(ROOT, 'src/api.ts')] }, false)
const added = [...e2b.core].filter((name) => !api.core.has(name)).sort()
const extra =
  added.length === 0
    ? { found: [], builtins: new Set() }
    : await reach(
        {
          stdin: {
            contents: added.map((name) => `import '${name}'`).join('\n'),
            resolveDir: ROOT,
          },
        },
        true,
      )
const found = [...e2b.found, ...extra.found]
const builtins = new Set([...e2b.builtins, ...extra.builtins])

console.log(`core modules ./e2b imports: ${e2b.core.size}, beyond ./api's: ${added.length}`)
console.log(`node built-ins reached: ${[...builtins].sort().join(', ') || 'none'}`)
if (found.length > 0) {
  console.error(`./e2b reaches modules a Worker cannot load:\n  ${found.join('\n  ')}`)
  process.exit(1)
}
console.log('./e2b reaches no forbidden module')
