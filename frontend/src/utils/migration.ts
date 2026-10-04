/**
 * 旧数据升级拆分：把 v1/v2 合用的珊瑚记录（CoralRecord）按属名拆成两份——
 * 属名初判 + 覆盖长度 → 外业底质记录（substrates）；
 * 白化等级 + 分级规程版本 → 监测站评定单（assessments）。
 *
 * 旧数据没有规程版本字段：统一按旧规程（GB-OLD-2010）挂着、留档，
 * protocolKnown=false，不计入当年礁区情况。
 * 缺属名的：底质记录照样拆出（genus 留空），逐条进缺属名清单，不生成评定单。
 * 导进来的旧备份（v1/v2 快照）也走同一个拆法。
 */
import type { BleachAssessment, BleachLevel } from '@/types/assessment'
import { PROTOCOL_OLD } from '@/types/assessment'
import type { CoralForm, SubstrateRecord } from '@/types/substrate'

/** 旧版合用记录（v1/v2 的 corals 表结构，仅升级 / 旧备份导入时出现） */
export interface LegacyCoralRow {
  id?: unknown
  beltId?: unknown
  genus?: unknown
  form?: unknown
  coverCm?: unknown
  bleachLevel?: unknown
  remark?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

/** 缺属名清单条目（逐条列出，供评定页提示外业补属名） */
export interface MissingGenusItem {
  substrateId: string
  beltId: string
  coverCm: number
  remark: string
  source: 'legacy' | 'live'
}

export interface LegacySplitResult {
  substrates: SubstrateRecord[]
  assessments: BleachAssessment[]
  /** 缺属名的底质（旧数据逐条列出） */
  missingGenus: MissingGenusItem[]
}

/** 旧 id 可能带任意字符，清洗成稳定的新主键 */
function legacyId(raw: unknown, prefix: string, fallback: string): string {
  const base = String(raw ?? '').replace(/[^a-zA-Z0-9]/g, '_')
  return `${prefix}_${base || fallback}`
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asTimestamp(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 按属名把旧珊瑚记录拆成底质 + 评定单。
 * @param rows 旧 corals 表 / 旧备份里的 corals 数组
 * @param siteNoOfBelt 样带 id → 站位编号（评定单对账键需要站位编号）
 * @param now 缺时间戳时的兜底时间（升级用 Date.now()）
 */
export function splitLegacyCorals(
  rows: LegacyCoralRow[],
  siteNoOfBelt: (beltId: string) => string,
  now: number
): LegacySplitResult {
  const substrates: SubstrateRecord[] = []
  const assessments: BleachAssessment[] = []
  const missingGenus: MissingGenusItem[] = []

  rows.forEach((row, index) => {
    const fallback = `legacy_${index}`
    const beltId = String(row.beltId ?? '')
    const genus = typeof row.genus === 'string' ? row.genus.trim() : ''
    const form = (typeof row.form === 'string' ? row.form : '枝状') as CoralForm
    const coverCm = asNumber(row.coverCm, 0)
    const bleachLevel = (typeof row.bleachLevel === 'string' ? row.bleachLevel : '无') as BleachLevel
    const remark = typeof row.remark === 'string' ? row.remark : ''
    const createdAt = asTimestamp(row.createdAt, now + index)
    const updatedAt = asTimestamp(row.updatedAt, createdAt)
    const assessedDate = new Date(createdAt).toISOString().slice(0, 10)

    const substrateId = legacyId(row.id, 'sub', fallback)
    const substrate: SubstrateRecord = {
      id: substrateId,
      beltId,
      genus,
      form,
      coverCm,
      remark,
      createdAt,
      updatedAt
    }
    substrates.push(substrate)

    // 缺属名：逐条列出，不生成评定单（无法按站位编号 + 属名对账）
    if (!genus) {
      missingGenus.push({ substrateId, beltId, coverCm, remark, source: 'legacy' })
      return
    }

    // 旧评定没有规程版本：按旧规程挂着留档，protocolKnown=false
    assessments.push({
      id: legacyId(row.id, 'asm', fallback),
      substrateId,
      beltId: beltId || null,
      siteNo: siteNoOfBelt(beltId),
      genus,
      bleachLevel,
      protocolVersion: PROTOCOL_OLD,
      protocolKnown: false,
      assessedDate,
      status: 'archived',
      suspendReason: '',
      fieldAck: false,
      stationAck: false,
      retryCount: 0,
      remark: '旧版记录升级拆分：规程版本未记录，按旧版分级规程留档',
      createdAt,
      updatedAt
    })
  })

  return { substrates, assessments, missingGenus }
}
