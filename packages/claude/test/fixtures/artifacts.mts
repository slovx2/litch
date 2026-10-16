import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach } from 'node:test'

let caseName = ''
beforeEach((context) => {
  caseName = context.name
})

export async function saveArtifact(kind: string, value: unknown): Promise<void> {
  const directory = process.env.PROTOCOL_ARTIFACT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  const text = JSON.stringify(
    {
      formatVersion: 1,
      runId: process.env.PROTOCOL_RUN_ID ?? 'untracked',
      engine: 'claude-code',
      caseName,
      caseIds: caseName.match(/\b[A-Z]+-[A-Za-z0-9-]+/g) ?? [],
      kind,
      payload: value,
    },
    (key, entry: unknown) =>
      typeof entry === 'string' &&
      /authorization|api.?key|access.?token|refresh.?token|password|secret/i.test(key)
        ? '[redacted]'
        : entry,
    2,
  )
  await writeFile(join(directory, `${kind}-${randomUUID()}.json`), text)
}
