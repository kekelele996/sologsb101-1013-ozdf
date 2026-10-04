/**
 * 旧数据拆分：把合用一份的珊瑚记录（corals）按属名拆成
 * 外业底质记录（fieldRecords）+ 监测站评定单（assessmentForms）。
 * 升级迁移与导入旧备份共用同一拆法。
 * 查不到版本的老评定按旧规程（v1）挂起；缺属名的逐条列出。
 */
import type { CoralRecord } from '@/types/coralRecord'
import type { FieldRecord } from '@/types/fieldRecord'
import type { AssessmentForm } from '@/types/assessmentForm'
import type { Belt } from '@/types/belt'
import type { Site } from '@/types/site'
import { createId } from '@/utils/id'
import { PROTOCOL_V1 } from '@/utils/protocol'

/** 缺属名记录的清单条目（逐条列出用） */
export interface MissingGenusItem {
  /** 原珊瑚记录 id */
  coralId: string
  beltId: string
  coverCm: number
  bleachLevel: string
  reason: string
}

/** 拆分结果 */
export interface SplitResult {
  fieldRecords: FieldRecord[]
  assessmentForms: AssessmentForm[]
  /** 缺属名、无法拆分的记录（逐条列出） */
  missingGenus: MissingGenusItem[]
}

/** 由样带 id 解析站位编号 */
function siteNoOfBelt(beltId: string, belts: Belt[], sites: Site[]): string {
  const belt = belts.find((item) => item.id === beltId)
  if (!belt) return ''
  const site = sites.find((item) => item.id === belt.siteId)
  return site?.no ?? ''
}

/**
 * 按属名拆分旧珊瑚记录。
 * - 有属名：拆成一条外业记录 + 一条评定单（旧规程 v1，挂起）
 * - 缺属名：逐条列入 missingGenus，不生成记录
 */
export function splitCoralsToRecords(
  corals: CoralRecord[],
  belts: Belt[],
  sites: Site[],
  now = Date.now()
): SplitResult {
  const fieldRecords: FieldRecord[] = []
  const assessmentForms: AssessmentForm[] = []
  const missingGenus: MissingGenusItem[] = []

  corals.forEach((coral) => {
    const genus = (coral.genus ?? '').trim()
    if (!genus) {
      missingGenus.push({
        coralId: coral.id,
        beltId: coral.beltId,
        coverCm: coral.coverCm,
        bleachLevel: coral.bleachLevel,
        reason: '缺属名，无法按属名拆出评定单'
      })
      return
    }

    const siteNo = siteNoOfBelt(coral.beltId, belts, sites)
    const fieldRecordId = createId('fld')
    fieldRecords.push({
      id: fieldRecordId,
      beltId: coral.beltId,
      genus,
      form: coral.form ?? '枝状',
      coverCm: coral.coverCm ?? 0,
      remark: coral.remark ?? '',
      createdAt: coral.createdAt ?? now,
      updatedAt: coral.updatedAt ?? now
    })

    assessmentForms.push({
      id: createId('asm'),
      fieldRecordId,
      siteNo,
      beltId: coral.beltId,
      genus,
      bleachLevel: coral.bleachLevel ?? '无',
      protocolVersion: PROTOCOL_V1,
      status: 'suspended',
      reconcileNote: '旧数据升级：无规程版本，按旧规程挂起留档',
      issuedAt: coral.createdAt ?? now,
      createdAt: now,
      updatedAt: now
    })
  })

  return { fieldRecords, assessmentForms, missingGenus }
}
