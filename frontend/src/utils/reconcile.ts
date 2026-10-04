/**
 * 对账与旧数据拆分（纯函数，供 surveyStore、db v3 升级迁移、备份导入共用）。
 *
 * 对账键：站位编号 + 属名。
 * - 对上：评定单挂到唯一一条外业底质记录；
 * - 对不上：挂起并记原因，外业组、监测站各认一遍（fieldAck / stationAck）；
 * - 换版前的评定单（旧版规程）永久留档，不再参与对账，也不计入当年礁区情况。
 *
 * 监测站重试对账只重算评定单（底物记录不动），所以这里只产出评定单的新值。
 */
import type { BleachAssessment } from '@/types/assessment'
import { PROTOCOL_OLD } from '@/types/assessment'
import type { SubstrateRecord } from '@/types/substrate'
import type { Belt } from '@/types/belt'
import type { Site } from '@/types/site'

/** 对账上下文：当前站位、样带与外业底质（监测站重试时船上那份保持不变） */
export interface ReconcileContext {
  sites: Pick<Site, 'id' | 'no'>[]
  belts: Pick<Belt, 'id' | 'siteId'>[]
  substrates: SubstrateRecord[]
}

/** 一条待对账评定单的最小输入（重试 / 自动对账都走同一套） */
export type ReconcileInput = Pick<
  BleachAssessment,
  'id' | 'substrateId' | 'beltId' | 'siteNo' | 'genus' | 'protocolVersion'
>

/** 对账后需要回写的评定单字段 */
export interface ReconcilePatch {
  id: string
  substrateId: string | null
  beltId: string | null
  status: BleachAssessment['status']
  suspendReason: BleachAssessment['suspendReason']
  /** 状态发生变化（重新对上或重新挂起）时清掉两边认领标记 */
  resetAcks: boolean
}

/**
 * 单条评定单对账：先按站位编号定位站位，再按属名在外业底质里找。
 * 同一样带优先（外业补录覆盖常见于同带重录）；命中多条则挂起，不自动认领。
 */
export function reconcileOne(assessment: ReconcileInput, ctx: ReconcileContext): ReconcilePatch {
  // 换版前的评定单：按当时版本留档，冻结，不参与对账
  if (assessment.protocolVersion === PROTOCOL_OLD) {
    return {
      id: assessment.id,
      substrateId: assessment.substrateId,
      beltId: assessment.beltId,
      status: 'archived',
      suspendReason: '',
      resetAcks: false
    }
  }

  if (!assessment.genus || !assessment.genus.trim()) {
    return suspend(assessment, 'genus-missing')
  }
  const site = ctx.sites.find((item) => item.no === assessment.siteNo)
  if (!site) {
    return suspend(assessment, 'site-missing')
  }
  const siteBeltIds = new Set(
    ctx.belts.filter((belt) => belt.siteId === site.id).map((belt) => belt.id)
  )
  const sameGenus = ctx.substrates.filter(
    (sub) => siteBeltIds.has(sub.beltId) && sub.genus.trim() === assessment.genus.trim()
  )
  if (sameGenus.length === 0) {
    // 站位在、属名对不上（含外业该属名整组缺失）
    return suspend(assessment, 'substrate-missing')
  }
  if (sameGenus.length > 1) {
    return suspend(assessment, 'ambiguous')
  }
  const hit = sameGenus[0]
  return {
    id: assessment.id,
    substrateId: hit.id,
    beltId: hit.beltId,
    status: 'matched',
    suspendReason: '',
    resetAcks: true
  }
}

function suspend(assessment: ReconcileInput, reason: BleachAssessment['suspendReason']): ReconcilePatch {
  return {
    id: assessment.id,
    substrateId: null,
    beltId: null,
    status: 'suspended',
    suspendReason: reason,
    resetAcks: true
  }
}

/**
 * 批量对账：只回写状态确实变化的评定单。
 * 已挂起、两边都已认过的单子不在自动对账里反复抖动（等待监测站显式重试）。
 */
export function reconcileAssessments(
  assessments: BleachAssessment[],
  ctx: ReconcileContext
): Array<{ id: string; patch: Partial<BleachAssessment> }> {
  const substrateById = new Map(ctx.substrates.map((sub) => [sub.id, sub]))
  const changes: Array<{ id: string; patch: Partial<BleachAssessment> }> = []

  for (const assessment of assessments) {
    // 旧版留档：冻结
    if (assessment.protocolVersion === PROTOCOL_OLD) {
      if (assessment.status !== 'archived') {
        changes.push({
          id: assessment.id,
          patch: { status: 'archived', suspendReason: '', substrateId: assessment.substrateId, beltId: assessment.beltId }
        })
      }
      continue
    }

    // 挂起且两边都认过：等监测站显式「重试我的评定单」，自动对账不碰
    if (assessment.status === 'suspended' && assessment.fieldAck && assessment.stationAck) {
      continue
    }

    // 已对上：原底物缺失，或（站位编号 + 属名）对账键已不满足（如外业改了属名）→ 重对
    if (assessment.status === 'matched') {
      const linked = assessment.substrateId ? substrateById.get(assessment.substrateId) : undefined
      const stillValid =
        linked &&
        (() => {
          const belt = ctx.belts.find((b) => b.id === linked.beltId)
          const site = belt ? ctx.sites.find((s) => s.id === belt.siteId) : undefined
          return !!site && site.no === assessment.siteNo && linked.genus.trim() === assessment.genus.trim()
        })()
      if (!stillValid) {
        const patch = reconcileOne(assessment, ctx)
        changes.push({ id: assessment.id, patch: toPatch(patch) })
      }
      continue
    }

    const patch = reconcileOne(assessment, ctx)
    if (
      patch.status !== assessment.status ||
      patch.substrateId !== assessment.substrateId ||
      patch.beltId !== assessment.beltId ||
      patch.suspendReason !== assessment.suspendReason
    ) {
      changes.push({ id: assessment.id, patch: toPatch(patch) })
    }
  }
  return changes
}

function toPatch(patch: ReconcilePatch): Partial<BleachAssessment> {
  const out: Partial<BleachAssessment> = {
    substrateId: patch.substrateId,
    beltId: patch.beltId,
    status: patch.status,
    suspendReason: patch.suspendReason
  }
  if (patch.resetAcks) {
    out.fieldAck = false
    out.stationAck = false
  }
  return out
}
