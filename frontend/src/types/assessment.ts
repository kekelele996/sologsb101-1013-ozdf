/**
 * 白化评定单（监测站 · 评定端）。
 * 只承载监测站负责的两项：白化等级与分级规程版本。
 * 与外业底质记录（types/substrate.ts）拆成两份，各自写入，互不覆盖。
 * 对账键：站位编号 + 属名；对不上先挂起，两边各认一遍。
 */

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 分级规程版本：旧版（换版前留档）与现行版（换版后才计入当年礁区情况） */
export type ProtocolVersion = 'GB-OLD-2010' | 'GB-CURRENT-2024'

/** 旧版分级规程（换版前评定单按当时版本留档，不参与当年汇总） */
export const PROTOCOL_OLD: ProtocolVersion = 'GB-OLD-2010'
/** 现行分级规程（换版后评定单才计入当年礁区情况，两版不能混算） */
export const PROTOCOL_CURRENT: ProtocolVersion = 'GB-CURRENT-2024'

export const PROTOCOL_VERSIONS: ProtocolVersion[] = [PROTOCOL_OLD, PROTOCOL_CURRENT]

export const PROTOCOL_LABEL: Record<ProtocolVersion, string> = {
  [PROTOCOL_OLD]: '旧版分级规程（2010 试行）',
  [PROTOCOL_CURRENT]: '现行分级规程（2024 修订）'
}

export const PROTOCOL_SHORT: Record<ProtocolVersion, string> = {
  [PROTOCOL_OLD]: '旧版规程',
  [PROTOCOL_CURRENT]: '现行规程'
}

/** 现行规程启用（换版）日期：此前日期的评定一律按旧版留档 */
export const PROTOCOL_CUTOVER_DATE = '2025-01-01'

/** 评定单对账状态：已对上 / 挂起 / 换版前留档 */
export type AssessmentStatus = 'matched' | 'suspended' | 'archived'

export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = {
  matched: '已对上',
  suspended: '挂起待认',
  archived: '旧版留档'
}

/** 挂起原因（对不上先挂起，各认一遍） */
export type SuspendReason =
  | 'genus-mismatch' // 同站位同属名在外业底质里对不上
  | 'substrate-missing' // 站位在但缺该属名的底质记录
  | 'site-missing' // 站位编号在当前站位表里查不到
  | 'genus-missing' // 评定单或底质缺属名，无法按属名对账
  | 'ambiguous' // 同键命中多条，不敢自动认
  | ''

export const SUSPEND_REASON_LABEL: Record<Exclude<SuspendReason, ''>, string> = {
  'genus-mismatch': '站位编号能对上、属名对不上',
  'substrate-missing': '站位在，但外业底质缺该属名',
  'site-missing': '站位编号在当前站位表中查不到',
  'genus-missing': '缺属名，无法按属名对账',
  ambiguous: '同站位同属名命中多条，需人工认领'
}

/**
 * 白化评定单：监测站对某站位、某属名的一条评定。
 * substrateId 能对上时指向外业底质记录；对不上为 null 并挂起。
 */
export interface BleachAssessment {
  id: string
  /** 对账命中的外业底质记录；挂起时为 null（监测站重试只改本单，不动船上那份） */
  substrateId: string | null
  /** 命中时随底质定位到的样带 */
  beltId: string | null
  /** 站位编号（对账键之一，沿用外业站位编号，站位删档后仍留痕） */
  siteNo: string
  /** 属名（监测站复核后的属名，对账键之一） */
  genus: string
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 分级规程版本 */
  protocolVersion: ProtocolVersion
  /** 规程版本是否查实。旧数据没有版本字段，按旧规程挂着，标记为未查实 */
  protocolKnown: boolean
  /** 评定日期（YYYY-MM-DD），换版前归旧版留档 */
  assessedDate: string
  /** 对账状态 */
  status: AssessmentStatus
  /** 挂起原因 */
  suspendReason: SuspendReason
  /** 外业组是否已认领一遍 */
  fieldAck: boolean
  /** 监测站是否已认领一遍 */
  stationAck: boolean
  /** 监测站重试对账次数（重试只动评定单自己） */
  retryCount: number
  /** 评定备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 评定单草稿（监测站新建 / 改级） */
export interface AssessmentDraft {
  siteNo: string
  genus: string
  bleachLevel: BleachLevel
  protocolVersion: ProtocolVersion
  assessedDate: string
  remark: string
}

export function createEmptyAssessmentDraft(today: string): AssessmentDraft {
  return {
    siteNo: '',
    genus: '',
    bleachLevel: '无',
    protocolVersion: PROTOCOL_CURRENT,
    assessedDate: today,
    remark: ''
  }
}

/** 按评定日期判定规程版本：换版日之前一律旧版，之后默认现行 */
export function protocolForDate(date: string): ProtocolVersion {
  if (typeof date === 'string' && date.length > 0 && date < PROTOCOL_CUTOVER_DATE) {
    return PROTOCOL_OLD
  }
  return PROTOCOL_CURRENT
}

/** 是否计入当年礁区情况：仅现行规程、且已对上的评定单参与；旧版留档不混算 */
export function countsInCurrentYear(a: Pick<BleachAssessment, 'protocolVersion' | 'status'>): boolean {
  return a.protocolVersion === PROTOCOL_CURRENT && a.status === 'matched'
}

/** 是否为换版前留档（旧规程，按当时版本封存） */
export function isArchivedProtocol(a: Pick<BleachAssessment, 'protocolVersion'>): boolean {
  return a.protocolVersion === PROTOCOL_OLD
}
