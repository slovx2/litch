export interface ExtensionAssembly {
  output: string
  background: string
  pointer: string
  pointerDefine: string
  identity: { key: string; id: string }
  manifest: { version: string; key: string; [key: string]: unknown }
  icons?: readonly string[]
}
export declare function extensionId(key: string): string
export declare function assembleExtension(options: ExtensionAssembly): Promise<{
  directory: string
  id: string
  version: string
}>
