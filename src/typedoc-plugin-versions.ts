import fs from 'node:fs'
import libpath from 'node:path'

import {Application, JSX} from 'typedoc'

export function load(app: Application) {
  const pkgver = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version
  let rootpath = app.options.getValue('out')
  app.options.addReader({
    name: 'plugin-versions',
    order: Infinity, // run last
    supportsPackages: false,
    read(opt): void {
      rootpath = opt.getValue('out')
      opt.setValue('out', `${rootpath}/${pkgver}`)
    }
  })

  app.renderer.hooks.on('head.end', (ctx) => JSX.createElement('script', {
    src: ctx.relativeURL('../version-selector.js'),
    type: 'module'}))

  app.renderer.on('endRender', () => {
    const dirs = fs.readdirSync(rootpath, {withFileTypes: true})
      .filter(item => item.isDirectory() && /^\d.*/.test(item.name))
      .map(item => item.name)
      .sort((a, b) => a < b ? 1 : -1) // TODO more sophisticated semver compare
    dirs.unshift('latest')

    app.logger.info(`writing versions.js: ${dirs.join(' ')}`)
    fs.writeFileSync(`${rootpath}/versions.js`, 'export default ' + JSON.stringify(dirs))

    const src = app.options.getValue('out')
    const dest = `${rootpath}/latest`
    fs.rmSync(dest, {recursive: true, force: true})
    // gh-pages doesn't like symlinks
    // TODO use url rewrite rules
    fs.cpSync(src, dest, {recursive: true})
    app.logger.info(`Documentation generated at ${libpath.relative('.', dest)}`)
  })
}
