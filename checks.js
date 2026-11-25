/**
 * 出稿硬约束自检。
 *
 * 为什么要有这一层：跨段重复只抓「两段撞车」，而返工的大头是硬约束违规
 * （北方话、破折号、禁词、套话、膨胀、专名丢失）。这些都能机器判，不该让人手查。
 *
 * 口径全部来自作者定过的规矩：
 * - 北方话：里头/外头/前头/后头/下头/哪儿
 * - 破折号：本书归零
 * - 硬禁词：目光微凝（及其变体）
 * - 套话：同一段里连用两个以上就算
 * - 膨胀：润色后汉字 / 原文汉字 - 1，超过 +40% 标黄
 * - 专名：原文里的《》功法名 + 调用方给的 mustKeep[]，逐个查还在不在
 */

const NORTHERN = ['里头', '外头', '前头', '后头', '下头', '哪儿']
const BANNED = ['目光微凝', '目光一凝', '目光一凛', '目光微沉']
const CLICHES = ['眼中闪过', '瞳孔一缩', '瞬间洞悉', '不置可否', '只见', '此时此刻', '深吸一口气', '微微一愣', '嘴角勾起']

const countOf = (text, word) => {
  let count = 0
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(word, from)
    if (at < 0) break
    count += 1
    from = at + word.length
  }
  return count
}

const pureChars = (text) => String(text || '').replace(/\s/g, '').length

/** 从原文里抽《》中的专名（功法、典籍、阵法名等） */
export function properNamesOf(text) {
  const found = new Set()
  const matched = String(text || '').match(/《[^》\n]{1,20}》/g) || []
  for (const item of matched) found.add(item)
  return [...found]
}

/**
 * 审一段：原文 vs 成稿。
 * mustKeep：调用方点名要保留的词（没有《》包着的也认）。
 */
export function auditPart(original, output, mustKeep = []) {
  const source = String(original || '')
  const body = String(output || '')
  const inChars = pureChars(source)
  const outChars = pureChars(body)
  const inflation = inChars > 0 ? outChars / inChars - 1 : 0

  const northern = []
  for (const word of NORTHERN) {
    const n = countOf(body, word)
    if (n > 0) northern.push({ word, count: n })
  }

  const banned = []
  for (const word of BANNED) {
    const n = countOf(body, word)
    if (n > 0) banned.push({ word, count: n })
  }

  /* 套话：按空行切段，同一段里出现 ≥2 个不同套话才报（单个是正常写作） */
  const paragraphs = body.split(/\n+/).filter((line) => line.trim() !== '')
  const clicheHits = []
  paragraphs.forEach((paragraph, index) => {
    const hits = CLICHES.filter((word) => paragraph.includes(word))
    if (hits.length >= 2) clicheHits.push({ segment: index + 1, words: hits })
  })

  /* 专名：原文有的《》名 + 调用方点名要留的，逐个查成稿还在不在 */
  const musts = [...new Set([...properNamesOf(source), ...mustKeep.filter(Boolean)])]
  const missing = musts.filter((name) => !body.includes(name))

  const dashes = countOf(body, '——')

  const problems = []
  if (inflation > 0.4) problems.push('膨胀 +' + Math.round(inflation * 100) + '%')
  if (northern.length > 0) problems.push('北方话 ' + northern.reduce((sum, item) => sum + item.count, 0) + ' 处')
  if (dashes > 0) problems.push('破折号 ' + dashes)
  if (banned.length > 0) problems.push('禁词 ' + banned.map((item) => item.word).join('/'))
  if (clicheHits.length > 0) problems.push('套话连用 ' + clicheHits.length + ' 段')
  if (missing.length > 0) problems.push('专名缺 ' + missing.join('/'))

  return { inChars, outChars, inflation, northern, dashes, banned, clicheHits, musts, missing, problems }
}

export function renderAudit(report) {
  const lines = ['# 硬约束自检 · ' + report.stamp, '', '> 由润色插件自动生成；口径见 LIB 的 checks 注释。', '']
  const header = '| 段 | 原文 | 成稿 | 膨胀 | 北方话 | 破折号 | 禁词 | 套话 | 专名 | 结论 |'
  lines.push(header, '|---|---|---|---|---|---|---|---|---|---|')
  for (const part of report.parts) {
    lines.push(
      '| ' +
        (part.index + 1) +
        ' | ' +
        part.inChars +
        ' | ' +
        part.outChars +
        ' | ' +
        (part.inflation >= 0 ? '+' : '') +
        Math.round(part.inflation * 100) +
        '% | ' +
        (part.northern.length ? part.northern.map((item) => item.word + '×' + item.count).join(' ') : '—') +
        ' | ' +
        part.dashes +
        ' | ' +
        (part.banned.length ? part.banned.map((item) => item.word + '×' + item.count).join(' ') : '—') +
        ' | ' +
        (part.clicheHits.length ? part.clicheHits.map((item) => '第' + item.segment + '段 ' + item.words.join('/')).join('；') : '—') +
        ' | ' +
        (part.missing.length ? '缺 ' + part.missing.join(' ') : '✓') +
        ' | ' +
        (part.problems.length ? '⚠ ' + part.problems.join('；') : '✓') +
        ' |',
    )
  }
  lines.push('')
  lines.push('## 合计', '')
  lines.push('- 原文 ' + report.total.inChars + ' 字 → 成稿 ' + report.total.outChars + ' 字（' + (report.total.inflation >= 0 ? '+' : '') + Math.round(report.total.inflation * 100) + '%）')
  lines.push('- 报警 ' + report.total.problemParts + ' 段')
  if (report.notes.length > 0) {
    lines.push('', '## 附注', '')
    for (const note of report.notes) lines.push('- ' + note)
  }
  return lines.join('\n') + '\n'
}
