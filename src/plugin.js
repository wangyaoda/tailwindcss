import postcss from 'postcss'
import lightningcss, { Features } from 'lightningcss'
import browserslist from 'browserslist'
import setupTrackingContext from './lib/setupTrackingContext'
import processTailwindFeatures from './processTailwindFeatures'
import { env } from './lib/sharedState'
import { findAtConfigPath } from './lib/findAtConfigPath'
import { handleImportAtRules } from './lib/handleImportAtRules'
import { version as tailwindVersion } from '../package.json'

function license() {
  return `/* ! tailwindcss v${tailwindVersion} | MIT License | https://tailwindcss.com */\n`
}

// 导出一个 装饰器 ? tailwindcss
module.exports = function tailwindcss(configOrPath) {
  return {
    postcssPlugin: 'tailwindcss',
    plugins: [
      env.DEBUG &&
        function (root) {
          console.log('\n')
          console.time('JIT TOTAL')
          return root
        },
      ...handleImportAtRules(),

      async function (root, result) {
        // Use the path for the `@config` directive if it exists, otherwise use the
        // path for the file being processed
        // 如果存在，则使用 `@config` 指令的路径，否则使用
        // 正在处理的文件的路径
        configOrPath = findAtConfigPath(root, result) ?? configOrPath

        // 在框架执行过程中将需要的数据装到 context 中
        // 使用 setupTrackingContext 函数 获取到 context , context是一个函数
        let context = setupTrackingContext(configOrPath)

        if (root.type === 'document') {
          let roots = root.nodes.filter((node) => node.type === 'root')

          for (const root of roots) {
            if (root.type === 'root') {
              await processTailwindFeatures(context)(root, result)
            }
          }

          return
        }
        // 无论如何都会执行 processTailwindFeatures 函数
        await processTailwindFeatures(context)(root, result)
      },

      function lightningCssPlugin(_root, result) {
        let map = result.map ?? result.opts.map

        let intermediateResult = result.root.toResult({
          map: map ? { inline: true } : false,
        })

        let intermediateMap = intermediateResult.map?.toJSON?.() ?? map

        try {
          let resolvedBrowsersListConfig = browserslist.findConfig(
            result.opts.from ?? process.cwd()
          )?.defaults
          let defaultBrowsersListConfig = require('../package.json').browserslist
          let browsersListConfig = resolvedBrowsersListConfig ?? defaultBrowsersListConfig

          let transformed = lightningcss.transform({
            filename: result.opts.from,
            code: Buffer.from(intermediateResult.css),
            minify: false,
            sourceMap: !!intermediateMap,
            targets: lightningcss.browserslistToTargets(browserslist(browsersListConfig)),
            errorRecovery: true,
            drafts: {
              customMedia: true,
            },
            nonStandard: {
              deepSelectorCombinator: true,
            },
            include: Features.Nesting,
            exclude: Features.LogicalProperties,
          })

          let code = transformed.code.toString()

          // https://postcss.org/api/#sourcemapoptions
          if (intermediateMap && transformed.map != null) {
            let prev = transformed.map.toString()

            if (typeof intermediateMap === 'object') {
              intermediateMap.prev = prev
            } else {
              code = `${code}\n/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
                prev
              ).toString('base64')} */`
            }
          }

          result.root = postcss.parse(license() + code, {
            ...result.opts,
            map: intermediateMap,
          })
        } catch (err) {
          if (err.source && typeof process !== 'undefined' && process.env.JEST_WORKER_ID) {
            let lines = err.source.split('\n')
            err = new Error(
              [
                'Error formatting using Lightning CSS:',
                '',
                ...[
                  '```css',
                  ...lines.slice(Math.max(err.loc.line - 3, 0), err.loc.line),
                  ' '.repeat(err.loc.column - 1) + '^-- ' + err.toString(),
                  ...lines.slice(err.loc.line, err.loc.line + 2),
                  '```',
                ],
              ].join('\n')
            )
          }

          if (Error.captureStackTrace) {
            Error.captureStackTrace(err, lightningCssPlugin)
          }
          throw err
        }
      },

      env.DEBUG &&
        function (root) {
          console.timeEnd('JIT TOTAL')
          console.log('\n')
          return root
        },
    ].filter(Boolean),
  }
}

// 标准的 PostCSS 插件的写法，也就是说tailwindCSS本质就是一个PostCSS插件
module.exports.postcss = true
