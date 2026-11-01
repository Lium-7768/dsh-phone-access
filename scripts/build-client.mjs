/**
 * Build the browser half into the module format the DSH client loader expects.
 *
 * The client module system provides `react` itself and never loads a bare ES
 * module from a package, so the entry is bundled into one
 * `window.__ModuleLoader__.load({ id, factory })` call with `react` left external
 * and handed to the factory through its `require`.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = 'dsh-phone-access'

const result = await build({
  entryPoints: [resolve(root, 'client/index.jsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  external: ['react'],
  logLevel: 'warning',
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var React = require("react");
${body}
    return module.exports;
  },
});
`
const { writeFile } = await import('node:fs/promises')
await writeFile(resolve(root, 'client/client.js'), wrapped)
console.log(`client/client.js ${wrapped.length} bytes`)
