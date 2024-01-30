import fs from 'fs'
import LRU from '@alloc/quick-lru'
import { parseCandidateStrings, IO, Parsing } from '@tailwindcss/oxide'
import * as sharedState from './sharedState'
import { generateRules } from './generateRules'
import log from '../util/log'
import cloneNodes from '../util/cloneNodes'
import { defaultExtractor } from './defaultExtractor'
import { flagEnabled } from '../featureFlags'

let env = sharedState.env

const builtInExtractors = {
  DEFAULT: defaultExtractor,
}

const builtInTransformers = {
  DEFAULT: (content) => content,
  svelte: (content) => content.replace(/(?:^|\s)class:/g, ' '),
}

function getExtractor(context, fileExtension) {
  let extractors = context.tailwindConfig.content.extract

  return (
    extractors[fileExtension] ||
    extractors.DEFAULT ||
    builtInExtractors[fileExtension] ||
    // Because we call `DEFAULT(context)`, the returning function is always a new function without a
    // stable identity. Marking it with `DEFAULT_EXTRACTOR` allows us to check if it is the default
    // extractor without relying on the function identity.
    Object.assign(builtInExtractors.DEFAULT(context), { DEFAULT_EXTRACTOR: true })
  )
}

function getTransformer(tailwindConfig, fileExtension) {
  let transformers = tailwindConfig.content.transform

  return (
    transformers[fileExtension] ||
    transformers.DEFAULT ||
    builtInTransformers[fileExtension] ||
    builtInTransformers.DEFAULT
  )
}

let extractorCache = new WeakMap()

// Scans template contents for possible classes. This is a hot path on initial build but
// not too important for subsequent builds. The faster the better though — if we can speed
// up these regexes by 50% that could cut initial build time by like 20%.
function getClassCandidates(content, extractor, candidates, seen) {
  if (!extractorCache.has(extractor)) {
    extractorCache.set(extractor, new LRU({ maxSize: 25000 }))
  }

  for (let line of content.split('\n')) {
    line = line.trim()

    if (seen.has(line)) {
      continue
    }
    seen.add(line)

    if (extractorCache.get(extractor).has(line)) {
      for (let match of extractorCache.get(extractor).get(line)) {
        candidates.add(match)
      }
    } else {
      let extractorMatches = extractor(line).filter((s) => s !== '!*')
      let lineMatchesSet = new Set(extractorMatches)

      for (let match of lineMatchesSet) {
        candidates.add(match)
      }

      extractorCache.get(extractor).set(line, lineMatchesSet)
    }
  }
}

/**
 *
 * @param {[import('./offsets.js').RuleOffset, import('postcss').Node][]} rules
 * @param {*} context
 */
function buildStylesheet(rules, context) {
  let sortedRules = context.offsets.sort(rules)

  let returnValue = {
    base: new Set(),
    defaults: new Set(),
    components: new Set(),
    utilities: new Set(),
    variants: new Set(),
  }

  for (let [sort, rule] of sortedRules) {
    returnValue[sort.layer].add(rule)
  }

  return returnValue
}

export default function expandTailwindAtRules(context) {
  return async (root) => {

    // ------start 数据初始过程---------
    /*
    将我们最原始的CSS转换成JavaScript对象并存在 layerNodes 对象中
    这里面用到了 PostCSS 中的一些 api，也就是说我们最开始的 CSS 经过 PostCSS 处理，然后再经过这一部分代码进行处理。
    处理下面这部分：
      @tailwind base;
      @tailwind components;
      @tailwind utilities;
    */
    let layerNodes = {
      base: null,
      components: null,
      utilities: null,
      variants: null,
    }

    root.walkAtRules((rule) => {
      // Make sure this file contains Tailwind directives. If not, we can save
      // a lot of work and bail early. Also we don't have to register our touch
      // file as a dependency since the output of this CSS does not depend on
      // the source of any templates. Think Vue <style> blocks for example.
      if (rule.name === 'tailwind') {
        if (Object.keys(layerNodes).includes(rule.params)) {
          layerNodes[rule.params] = rule
        }
      }
    })

    if (Object.values(layerNodes).every((n) => n === null)) {
      return root
    }

    // ---

    // Find potential rules in changed files
    // ------end 数据初始过程------


    let candidates = new Set([...(context.candidates ?? []), sharedState.NOT_ON_DEMAND])
    let seen = new Set()

    env.DEBUG && console.time('Reading changed files')

    /** @type {[item: {file?: string, content?: string}, meta: {transformer: any, extractor: any}][]} */
    let regexParserContent = []

    /** @type {{file?: string, content?: string}[]} */
    let rustParserContent = []

    // ------ start 入口文件分析过程 ---------
    /* 分析入口文件 tailwind.config.js 如下：
        module.exports = {
            content: ["index.html"],
          }
      上面的入口文件在经过转换器和抽取器处理之后就会形成候选样式
      getTransformer 转换器
      getExtractor 抽取器
      抽取器，其实抽取器就是一个很复杂的正则表达式集合，
      在这个正则的处理之后，就会把我们的原始文件内容处理成下面的形式并放到一个 set 集合中：
      要做的就是把真正的样式给找出来进行处理，比如：text-3xl 、font-bold 这样的。

      eg：Set(36) { [String: '*'], '!doctype', 'html', 'head', 'meta', 'charset', 'UTF-8', 'name', 'viewport', 'content', 'width', 'device-width,', 'initial-scale', '1', '0', 'link', 'href', 'dist/output.css', 'rel', 'stylesheet', '/dist/output', 'css', '/head', 'body', 'h1', 'class', 'text-3xl', 'font-bold', 'underline', 'text-green-100', 'Hello', 'world', 'world!', '/h1', '/body', '/html' }

      如果没有设置入口，[也就是什么都不配置] 也就是说 content: [] 是一个空的或者没有这个属性，
      那最后生成的候选样式集合中只有一个元素 [String: '*']，这也说明如果我们什么都不配置也会生成一些基础的样式，
      因为这些基础的样式在 TailwindCSS 看来就是必须的，无论有无入口文件。
    */
    for (let item of context.changedContent) {
      let transformer = getTransformer(context.tailwindConfig, item.extension)
      let extractor = getExtractor(context, item.extension)

      if (
        flagEnabled(context.tailwindConfig, 'oxideParser') &&
        transformer === builtInTransformers.DEFAULT &&
        extractor?.DEFAULT_EXTRACTOR === true
      ) {
        // 放到这个集合之中
        rustParserContent.push(item)
      } else {
        regexParserContent.push([item, { transformer, extractor }])
      }
    }

    // Read files using our newer, faster parser when:
    // - Oxide is enabled; AND
    // - The file is using default transfomers and extractors
    if (rustParserContent.length > 0) {
      for (let candidate of parseCandidateStrings(
        rustParserContent,
        IO.Parallel | Parsing.Parallel
      )) {
        candidates.add(candidate)
      }
    }

    // Otherwise, read any files in node and parse with regexes
    const BATCH_SIZE = 500

    for (let i = 0; i < regexParserContent.length; i += BATCH_SIZE) {
      let batch = regexParserContent.slice(i, i + BATCH_SIZE)

      await Promise.all(
        batch.map(async ([{ file, content }, { transformer, extractor }]) => {
          content = file ? await fs.promises.readFile(file, 'utf8') : content
          getClassCandidates(transformer(content), extractor, candidates, seen)
        })
      )
    }

    // ------end 入口文件分析过程---------

    env.DEBUG && console.timeEnd('Reading changed files')

    // ---

    // Generate the actual CSS
    let classCacheCount = context.classCache.size

    env.DEBUG && console.time('Generate rules')
    env.DEBUG && console.time('Sorting candidates')
    // TODO: only sort if we are not using the oxide parser (flagEnabled(context.tailwindConfig,
    // 'oxideParser')) AND if we got all the candidates form the oxideParser alone. This will not
    // be the case currently if you have custom transformers / extractors.
    let sortedCandidates = new Set(
      [...candidates].sort((a, z) => {
        if (a === z) return 0
        if (a < z) return -1
        return 1
      })
    )

     // ------start 真正样式生成过程---------
    env.DEBUG && console.timeEnd('Sorting candidates')
    generateRules(sortedCandidates, context)
    env.DEBUG && console.timeEnd('Generate rules')
    // ------start 真正样式生成过程---------



  // ------start 把真正样式添加到AST---------
    // We only ever add to the classCache, so if it didn't grow, there is nothing new.
    env.DEBUG && console.time('Build stylesheet')
    // 在之前保存到的 context.ruleCache 样式又会转化被保存到了 context.stylesheetCache 中
    if (context.stylesheetCache === null || context.classCache.size !== classCacheCount) {
      context.stylesheetCache = buildStylesheet([...context.ruleCache], context)
    }
    env.DEBUG && console.timeEnd('Build stylesheet')

    let {
      defaults: defaultNodes,
      base: baseNodes,
      components: componentNodes,
      utilities: utilityNodes,
      variants: screenNodes,
    } = context.stylesheetCache

    // ---

    // Replace any Tailwind directives with generated CSS
    /*
      最终判断第一步初始化数据中是否有相关类型，
      如果有则从 stylesheetCache 中把对应的样式取出保存到 AST 中，然后最后再把 @tailwind base; 这样的指令移除。
    */
    if (layerNodes.base) {
      layerNodes.base.before(
        cloneNodes([...baseNodes, ...defaultNodes], layerNodes.base.source, {
          layer: 'base',
        })
      )
      layerNodes.base.remove()
    }

    if (layerNodes.components) {
      layerNodes.components.before(
        cloneNodes([...componentNodes], layerNodes.components.source, {
          layer: 'components',
        })
      )
      layerNodes.components.remove()
    }

    if (layerNodes.utilities) {
      layerNodes.utilities.before(
        cloneNodes([...utilityNodes], layerNodes.utilities.source, {
          layer: 'utilities',
        })
      )
      layerNodes.utilities.remove()
    }

    // We do post-filtering to not alter the emitted order of the variants
    const variantNodes = Array.from(screenNodes).filter((node) => {
      const parentLayer = node.raws.tailwind?.parentLayer

      if (parentLayer === 'components') {
        return layerNodes.components !== null
      }

      if (parentLayer === 'utilities') {
        return layerNodes.utilities !== null
      }

      return true
    })

    if (layerNodes.variants) {
      layerNodes.variants.before(
        cloneNodes(variantNodes, layerNodes.variants.source, {
          layer: 'variants',
        })
      )
      layerNodes.variants.remove()
    } else if (variantNodes.length > 0) {
      let cloned = cloneNodes(variantNodes, undefined, {
        layer: 'variants',
      })

      cloned.forEach((node) => {
        let parentLayer = node.raws.tailwind?.parentLayer ?? null

        node.walk((n) => {
          if (!n.source) {
            n.source = layerNodes[parentLayer].source
          }
        })
      })

      root.append(cloned)
    }

    // TODO: Why is the root node having no source location for `end` possible?
    root.source.end = root.source.end ?? root.source.start

    // If we've got a utility layer and no utilities are generated there's likely something wrong
    const hasUtilityVariants = variantNodes.some(
      (node) => node.raws.tailwind?.parentLayer === 'utilities'
    )

    if (layerNodes.utilities && utilityNodes.size === 0 && !hasUtilityVariants) {
      log.warn('content-problems', [
        'No utility classes were detected in your source files. If this is unexpected, double-check the `content` option in your Tailwind CSS configuration.',
        'https://tailwindcss.com/docs/content-configuration',
      ])
    }

    // ---

    if (env.DEBUG) {
      console.log('Potential classes: ', candidates.size)
      console.log('Active contexts: ', sharedState.contextSourcesMap.size)
    }

    // Clear the cache for the changed files
    context.changedContent = []

    // Cleanup any leftover @layer atrules
    root.walkAtRules('layer', (rule) => {
      if (Object.keys(layerNodes).includes(rule.params)) {
        rule.remove()
      }
    })
    // ------end 把真正样式添加到AST---------

  }
}

/*
TailwindCSS 自带 tree-shaking 功能，
TailwindCSS 早期版本是没这样的功能，那个时候会把 TailwindCSS 中所有的样式都生成出来，
但 TaiwindCSS 3 之后这个功能已被实现，从而大大降低了生成的样式体积。
*/
