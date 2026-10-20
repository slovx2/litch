// 计划模式里模型回答中的 `<proposed_plan>` 块：块里的是计划（plan 条目），块外的是普通回答（agentMessage）。
// 照上游 codex（rust-v0.163.0 的 codex-rs/utils/stream-parser 里 ProposedPlanParser / TaggedLineParser）的规则：
// 标签要独占一行（前后可以有空白），按行判断；一行的开头还可能是标签时先攒着，确定不是了再放出去，
// 所以普通文字基本不延迟，只有以 `<` 开头的那一行要等到看清楚。

const OPEN_TAG = '<proposed_plan>'
const CLOSE_TAG = '</proposed_plan>'

export type ProposedPlanSegment =
  | { type: 'text'; text: string }
  | { type: 'planStart' }
  | { type: 'planDelta'; text: string }
  | { type: 'planEnd' }

export class ProposedPlanParser {
  private inPlan = false
  private detectTag = true
  private line = ''

  push(chunk: string): ProposedPlanSegment[] {
    const segments: ProposedPlanSegment[] = []
    let run = ''
    for (const ch of chunk) {
      if (this.detectTag) {
        if (run) {
          this.text(run, segments)
          run = ''
        }
        this.line += ch
        if (ch === '\n') {
          this.finishLine(segments)
          continue
        }
        const slug = this.line.trimStart()
        if (!slug || isTagPrefix(slug)) continue
        const buffered = this.line
        this.line = ''
        this.detectTag = false
        this.text(buffered, segments)
        continue
      }
      run += ch
      if (ch === '\n') {
        this.text(run, segments)
        run = ''
        this.detectTag = true
      }
    }
    if (run) this.text(run, segments)
    return segments
  }

  // 一段回答说完了：攒着的那一行按完整的一行算，没合上的计划块就此合上。
  finish(): ProposedPlanSegment[] {
    const segments: ProposedPlanSegment[] = []
    if (this.line) {
      const buffered = this.line
      this.line = ''
      const slug = buffered.replace(/\n$/, '').trim()
      if (slug === OPEN_TAG && !this.inPlan) {
        add(segments, { type: 'planStart' })
        this.inPlan = true
      } else if (slug === CLOSE_TAG && this.inPlan) {
        add(segments, { type: 'planEnd' })
        this.inPlan = false
      } else this.text(buffered, segments)
    }
    if (this.inPlan) add(segments, { type: 'planEnd' })
    this.inPlan = false
    this.detectTag = true
    return segments
  }

  private finishLine(segments: ProposedPlanSegment[]): void {
    const line = this.line
    this.line = ''
    this.detectTag = true
    const slug = line.replace(/\n$/, '').trim()
    if (slug === OPEN_TAG && !this.inPlan) {
      add(segments, { type: 'planStart' })
      this.inPlan = true
      return
    }
    if (slug === CLOSE_TAG && this.inPlan) {
      add(segments, { type: 'planEnd' })
      this.inPlan = false
      return
    }
    this.text(line, segments)
  }

  private text(text: string, segments: ProposedPlanSegment[]): void {
    add(segments, this.inPlan ? { type: 'planDelta', text } : { type: 'text', text })
  }
}

function isTagPrefix(slug: string): boolean {
  const trimmed = slug.trimEnd()
  return OPEN_TAG.startsWith(trimmed) || CLOSE_TAG.startsWith(trimmed)
}

// 相邻的同类文字并成一段，空的不要
function add(segments: ProposedPlanSegment[], segment: ProposedPlanSegment): void {
  if (segment.type === 'text' || segment.type === 'planDelta') {
    if (!segment.text) return
    const last = segments.at(-1)
    if (last?.type === segment.type) {
      last.text += segment.text
      return
    }
  }
  segments.push(segment)
}
