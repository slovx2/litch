/** 首次失败先交付；取现场失败只能补充信息，不能替换真正失败的步骤。 */
export async function diagnoseFailure(report, error, collect, publish = console.error) {
  report.failure = describeFailure(error)
  publish(`PROJECTIONS_FAILURE ${JSON.stringify(report)}`)
  try {
    await collect()
  } catch (diagnosticError) {
    report.diagnosticFailure = describeFailure(diagnosticError)
  }
  publish(`PROJECTIONS_DIAGNOSTICS ${JSON.stringify(report)}`)
}

function describeFailure(error) {
  return {
    stack: String(error?.stack ?? error),
    ...(error?.request ? { request: error.request } : {}),
    ...(error?.cause ? { cause: describeFailure(error.cause) } : {}),
  }
}
