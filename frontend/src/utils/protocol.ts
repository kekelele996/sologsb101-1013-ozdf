/**
 * 分级规程版本：监测站评定单承载规程版本。
 * 换版前的评定单按当时版本留档，换版后的才计入当年礁区情况，两版不能混算。
 */

/** 旧规程（换版前，留档用） */
export const PROTOCOL_V1 = 'v1'
/** 新规程（当前，计入当年礁区情况） */
export const PROTOCOL_V2 = 'v2'
/** 当前分级规程版本 */
export const CURRENT_PROTOCOL_VERSION = PROTOCOL_V2

export interface ProtocolVersionOption {
  value: string
  label: string
  /** 是否为当前规程（计入当年礁区情况） */
  current: boolean
}

/** 规程版本选项（下拉与展示用） */
export const PROTOCOL_VERSIONS: ProtocolVersionOption[] = [
  { value: PROTOCOL_V1, label: '规程 v1（旧版 · 留档）', current: false },
  { value: PROTOCOL_V2, label: '规程 v2（当前 · 计入当年）', current: true }
]

/** 判断某版本是否为当前规程 */
export function isCurrentProtocol(version: string | null | undefined): boolean {
  return version === CURRENT_PROTOCOL_VERSION
}

/** 规程版本展示名 */
export function protocolLabel(version: string | null | undefined): string {
  if (!version) return '未知规程'
  const found = PROTOCOL_VERSIONS.find((item) => item.value === version)
  return found ? found.label : `未知规程（${version}）`
}
