// D-42：只复用 48 小时内、完整且成功的夜间 Full；基线必须在候选的祖先链上。
export function selectNightlyBase(runs, { now = Date.now(), isAncestor }) {
  const candidates = runs
    .filter(
      (run) =>
        run.event === 'schedule' &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        run.path === '.github/workflows/full.yml' &&
        Number.isSafeInteger(run.id) &&
        /^[a-f0-9]{40}$/.test(run.head_sha),
    )
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  const rejected = []
  for (const run of candidates) {
    const age = now - Date.parse(run.updated_at)
    if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60_000) {
      rejected.push(`Full #${run.id} 超出 48 小时或时间无效`)
      continue
    }
    if (!isAncestor(run.head_sha)) {
      rejected.push(`Full #${run.id} 不是候选的祖先`)
      continue
    }
    return {
      sha: run.head_sha,
      run: run.id,
      attempt: run.run_attempt,
      completedAt: run.updated_at,
      url: run.html_url,
      reason: `复用祖先夜间 Full #${run.id}，距完成 ${Math.floor(age / 60_000)} 分钟`,
    }
  }
  return {
    sha: null,
    run: null,
    reason: rejected.length ? rejected.join('；') : '找不到成功的夜间完整 Full 基线',
  }
}
