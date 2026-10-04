/**
 * 普查 store：维护外业底质、监测站评定单、鱼类计数三类记录与对账状态，
 * 以及覆盖度 / 白化评定的派生值。
 *
 * 职责边界（外业补录覆盖不再顶掉监测站的属名与等级）：
 * - 底质 substrates：外业组只写属名初判、形态、覆盖长度、备注；
 * - 评定单 assessments：监测站只写白化等级、分级规程版本、评定日期、复核属名；
 * - 对账按「站位编号 + 属名」，对不上先挂起，两边各认一遍（fieldAck/stationAck）；
 * - 监测站重试对账只重算自己的评定单，船上底质一条不动。
 *
 * 当年礁区情况只计现行规程（GB-CURRENT-2024）且已对上的评定单；
 * 旧版规程评定单按当时版本留档，两版不混算。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { SubstrateDraft, SubstrateRecord, CoralForm } from '@/types/substrate'
import { createEmptySubstrateDraft } from '@/types/substrate'
import {
  BLEACH_LEVELS,
  PROTOCOL_CURRENT,
  countsInCurrentYear,
  protocolForDate,
  type AssessmentDraft,
  type AssessmentStatus,
  type BleachAssessment,
  type BleachLevel,
  type ProtocolVersion,
  type SuspendReason
} from '@/types/assessment'
import { createEmptyAssessmentDraft } from '@/types/assessment'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  round
} from '@/utils/bleach'
import { reconcileAssessments, reconcileOne, type ReconcileContext } from '@/utils/reconcile'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return { keyword: '', reefIds: [], bleachLevels: [], onlyBleached: false }
}

/** 一条底质 × 评定单的对账连接行（当年统计的最小单位） */
export interface JoinedCoralRow {
  substrate: SubstrateRecord
  assessment: BleachAssessment
  siteNo: string
  beltId: string
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/** 覆盖度汇总行 */
export interface CoverageSummaryRow {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  /** 外业底质条数 */
  substrateCount: number
  /** 已对上（计入白化）的条数 */
  assessedCount: number
  /** 挂起待认条数 */
  suspendedCount: number
  /** 旧版留档条数 */
  archivedCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

export const useSurveyStore = defineStore('survey', () => {
  const substrates = ref<SubstrateRecord[]>([])
  const assessments = ref<BleachAssessment[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())

  /** 外业底质录入草稿 */
  const substrateDraft = ref<SubstrateDraft>(createEmptySubstrateDraft())
  /** 监测站评定单草稿 */
  const assessmentDraft = ref<AssessmentDraft>(
    createEmptyAssessmentDraft(new Date().toISOString().slice(0, 10))
  )
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false
  let reconcileScheduled = false

  /* ------------------------------ 索引 / 关系 ------------------------------ */

  const siteById = computed(() => new Map(sites.value.map((site) => [site.id, site])))
  const beltById = computed(() => new Map(belts.value.map((belt) => [belt.id, belt])))
  const substrateById = computed(() => new Map(substrates.value.map((sub) => [sub.id, sub])))

  function siteNoOfBelt(beltId: string | null | undefined): string {
    if (!beltId) return ''
    const belt = beltById.value.get(beltId)
    if (!belt) return ''
    return siteById.value.get(belt.siteId)?.no ?? ''
  }

  function start(): void {
    if (started) return
    started = true
    watchTable<SubstrateRecord>(() => db.substrates).subscribe((rows) => {
      substrates.value = rows
      ready.value = true
      error.value = null
      scheduleReconcile()
    })
    watchTable<BleachAssessment>(() => db.assessments).subscribe((rows) => {
      assessments.value = rows
      scheduleReconcile()
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
      scheduleReconcile()
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
      scheduleReconcile()
    })
  }

  /** 某样带的外业底质（按覆盖长度降序） */
  function substratesOfBelt(beltId: string | null | undefined): SubstrateRecord[] {
    if (!beltId) return []
    return substrates.value
      .filter((sub) => sub.beltId === beltId)
      .sort((a, b) => b.coverCm - a.coverCm)
  }

  /** 某底质记录当前挂着的评定单（一条底质至多对应一条已对上的评定单） */
  function assessmentOfSubstrate(substrateId: string): BleachAssessment | null {
    return assessments.value.find((a) => a.substrateId === substrateId) ?? null
  }

  /** 某样带的评定单 */
  function assessmentsOfBelt(beltId: string | null | undefined): BleachAssessment[] {
    if (!beltId) return []
    return assessments.value.filter((a) => a.beltId === beltId)
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 底质数 / 评定数 / 鱼类数（样带列表回显用） */
  const beltRecordCounts = computed<
    Record<string, { substrateCount: number; assessedCount: number; fishCount: number }>
  >(() => {
    const counts: Record<string, { substrateCount: number; assessedCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      const subs = substrates.value.filter((sub) => sub.beltId === belt.id)
      const assessed = assessments.value.filter(
        (a) => a.beltId === belt.id && countsInCurrentYear(a)
      ).length
      counts[belt.id] = {
        substrateCount: subs.length,
        assessedCount: assessed,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /* ------------------------------ 对账连接 ------------------------------ */

  /**
   * 当年计入的白化行：现行规程 + 已对上。
   * 覆盖长度取外业底质（船上那份），白化等级取监测站评定单，按 substrateId 连接。
   */
  const currentBleachRows = computed<JoinedCoralRow[]>(() => {
    const rows: JoinedCoralRow[] = []
    for (const a of assessments.value) {
      if (!countsInCurrentYear(a) || !a.substrateId) continue
      const sub = substrateById.value.get(a.substrateId)
      if (!sub) continue
      rows.push({
        substrate: sub,
        assessment: a,
        siteNo: a.siteNo,
        beltId: sub.beltId,
        genus: a.genus || sub.genus,
        form: sub.form,
        coverCm: sub.coverCm,
        bleachLevel: a.bleachLevel
      })
    }
    return rows
  })

  /** 旧版留档的白化行（按当时版本封存，展示但不进当年汇总） */
  const archivedBleachRows = computed<JoinedCoralRow[]>(() => {
    const rows: JoinedCoralRow[] = []
    for (const a of assessments.value) {
      if (a.protocolVersion !== 'GB-OLD-2010' || !a.substrateId) continue
      const sub = substrateById.value.get(a.substrateId)
      if (!sub) continue
      rows.push({
        substrate: sub,
        assessment: a,
        siteNo: a.siteNo,
        beltId: sub.beltId,
        genus: a.genus || sub.genus,
        form: sub.form,
        coverCm: sub.coverCm,
        bleachLevel: a.bleachLevel
      })
    }
    return rows
  })

  /** 某样带当年计入的白化行 */
  function currentRowsOfBelt(beltId: string | null | undefined): JoinedCoralRow[] {
    if (!beltId) return []
    return currentBleachRows.value.filter((row) => row.beltId === beltId)
  }

  /** 某批样带 id 内当年计入的白化行 */
  function currentRowsOfBelts(beltIds: Set<string>): JoinedCoralRow[] {
    return currentBleachRows.value.filter((row) => beltIds.has(row.beltId))
  }

  /** 缺属名的外业底质（旧升级数据与新录数据统一按此实时逐条列出） */
  const missingGenusSubstrates = computed(() =>
    substrates.value.filter((sub) => !sub.genus || !sub.genus.trim())
  )

  /** 挂起待认的评定单 */
  const suspendedAssessments = computed(() =>
    assessments.value.filter((a) => a.status === 'suspended')
  )

  /** 旧版留档评定单 */
  const archivedAssessments = computed(() =>
    assessments.value.filter((a) => a.status === 'archived')
  )

  /* ------------------------------ 覆盖度汇总 ------------------------------ */

  /** 覆盖度汇总行（全部样带，白化只计现行规程已对上的评定单） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltSubs = substrates.value.filter((sub) => sub.beltId === belt.id)
        const beltAssessments = assessments.value.filter((a) => a.beltId === belt.id)
        const currentRows = currentRowsOfBelt(belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltSubs.reduce((sum, sub) => sum + sub.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            currentRows
              .filter((row) => row.bleachLevel === level)
              .reduce((sum, row) => sum + row.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(currentRows)
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        return {
          beltId: belt.id,
          beltNo: belt.no,
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          substrateCount: beltSubs.length,
          assessedCount: currentRows.length,
          suspendedCount: beltAssessments.filter((a) => a.status === 'suspended').length,
          archivedCount: beltAssessments.filter((a) => a.status === 'archived').length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(currentRows),
          distribution,
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(fishTotal, belt.lengthM)
        }
      })
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  /** 按筛选条件过滤后的覆盖度行 */
  const filteredCoverageRows = computed<CoverageSummaryRow[]>(() =>
    coverageRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.bleachLevels.length > 0) {
        const matched = filter.value.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (filter.value.onlyBleached && row.bleachedSharePct <= 0) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached
  )

  /** 全局当年统计（仅现行规程已对上） */
  const globalStats = computed(() => {
    const rows = currentBleachRows.value
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        rows.filter((row) => row.bleachLevel === level).reduce((sum, row) => sum + row.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(rows)
    return {
      substrateCount: substrates.value.length,
      assessmentCount: assessments.value.length,
      suspendedCount: suspendedAssessments.value.length,
      archivedCount: archivedAssessments.value.length,
      missingGenusCount: missingGenusSubstrates.value.length,
      fishCount: fishes.value.length,
      coverCmTotal: round(
        substrates.value.reduce((sum, sub) => sum + sub.coverCm, 0),
        1
      ),
      assessedCoverCmTotal: round(
        rows.reduce((sum, row) => sum + row.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(rows),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchSubstrateDraft(patch: Partial<SubstrateDraft>): void {
    substrateDraft.value = { ...substrateDraft.value, ...patch }
  }

  function patchAssessmentDraft(patch: Partial<AssessmentDraft>): void {
    assessmentDraft.value = { ...assessmentDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 自动对账 ------------------------------ */

  function reconcileContext(): ReconcileContext {
    return {
      sites: sites.value.map((s) => ({ id: s.id, no: s.no })),
      belts: belts.value.map((b) => ({ id: b.id, siteId: b.siteId })),
      substrates: substrates.value
    }
  }

  /** 数据变化后合并一轮自动对账（微任务里跑，一次写入批量更新） */
  function scheduleReconcile(): void {
    if (reconcileScheduled) return
    reconcileScheduled = true
    void Promise.resolve().then(async () => {
      reconcileScheduled = false
      try {
        await runAutoReconcile()
      } catch {
        // 订阅初期数据可能未齐，忽略本轮，下一次变化再对
      }
    })
  }

  async function runAutoReconcile(): Promise<number> {
    if (assessments.value.length === 0) return 0
    const changes = reconcileAssessments(assessments.value, reconcileContext())
    if (changes.length === 0) return 0
    const now = Date.now()
    await db.transaction('rw', [db.assessments], async () => {
      for (const { id, patch } of changes) {
        await db.assessments.update(id, { ...patch, updatedAt: now } as never)
      }
    })
    return changes.length
  }

  /**
   * 监测站重试对账：只重算监测站自己出的评定单，船上底质一条不动。
   * 可传指定评定单（单条重试）；不传则重试全部挂起单。
   * 返回仍未对上的数量。
   */
  async function retryAssessmentReconcile(ids?: string[]): Promise<{ retried: number; stillSuspended: number }> {
    const targets = assessments.value.filter(
      (a) => a.status === 'suspended' && (ids === undefined || ids.includes(a.id))
    )
    if (targets.length === 0) return { retried: 0, stillSuspended: 0 }
    const ctx = reconcileContext()
    const now = Date.now()
    let stillSuspended = 0
    await db.transaction('rw', [db.assessments], async () => {
      for (const a of targets) {
        const patch = reconcileOne(a, ctx)
        if (patch.status === 'matched') {
          await db.assessments.update(a.id, {
            substrateId: patch.substrateId,
            beltId: patch.beltId,
            status: 'matched',
            suspendReason: '',
            fieldAck: false,
            stationAck: false,
            updatedAt: now
          } as never)
        } else {
          // 还是对不上：留在挂起，重试次数 +1，两边认领标记清回，等下一轮各认一遍
          stillSuspended += 1
          await db.assessments.update(a.id, {
            substrateId: null,
            beltId: null,
            status: 'suspended',
            suspendReason: patch.suspendReason,
            fieldAck: false,
            stationAck: false,
            retryCount: a.retryCount + 1,
            updatedAt: now
          } as never)
        }
      }
    })
    return { retried: targets.length, stillSuspended }
  }

  /** 外业组 / 监测站各认一遍：只标记自己那一侧，不动对方数据 */
  async function ackAssessment(
    id: string,
    side: 'field' | 'station'
  ): Promise<void> {
    const patch: Partial<BleachAssessment> = { updatedAt: Date.now() }
    if (side === 'field') patch.fieldAck = true
    else patch.stationAck = true
    await db.assessments.update(id, patch as never)
  }

  /* ------------------------------ 外业底质 ------------------------------ */

  async function createSubstrate(
    beltId: string,
    payload: Omit<SubstrateRecord, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<SubstrateRecord> {
    const now = Date.now()
    const row: SubstrateRecord = { ...payload, beltId, id: createId('sub'), createdAt: now, updatedAt: now }
    await db.substrates.put(row)
    return row
  }

  async function updateSubstrate(id: string, patch: Partial<SubstrateRecord>): Promise<void> {
    await db.substrates.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeSubstrate(id: string): Promise<void> {
    await db.substrates.delete(id)
  }

  /** 批量导入粘贴行（覆盖该样带原有外业底质；关联评定单不受影响，下轮自动重对） */
  async function importSubstrateRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number }>
  ): Promise<number> {
    const now = Date.now()
    const records: SubstrateRecord[] = rows.map((row, index) => ({
      id: createId('sub'),
      beltId,
      genus: row.genus.trim(),
      form: row.form,
      coverCm: row.coverCm,
      remark: '',
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.substrates], async () => {
      await db.substrates.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.substrates.bulkPut(records)
    })
    return records.length
  }

  /* ------------------------------ 监测站评定单 ------------------------------ */

  /**
   * 监测站新建评定单：按站位编号 + 属名即时对账，对不上直接挂起。
   */
  async function createAssessment(
    payload: Omit<
      BleachAssessment,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'substrateId'
      | 'beltId'
      | 'status'
      | 'suspendReason'
      | 'fieldAck'
      | 'stationAck'
      | 'retryCount'
    >
  ): Promise<BleachAssessment> {
    const now = Date.now()
    const draft: BleachAssessment = {
      ...payload,
      id: createId('asm'),
      substrateId: null,
      beltId: null,
      status: 'suspended',
      suspendReason: '',
      fieldAck: false,
      stationAck: false,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }
    const patch = reconcileOne(draft, reconcileContext())
    draft.substrateId = patch.substrateId
    draft.beltId = patch.beltId
    draft.status = patch.status
    draft.suspendReason = patch.suspendReason
    await db.assessments.put(draft)
    return draft
  }

  async function updateAssessment(id: string, patch: Partial<BleachAssessment>): Promise<void> {
    await db.assessments.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeAssessment(id: string): Promise<void> {
    await db.assessments.delete(id)
  }

  /** 批量改写白化等级（只作用于监测站评定单；旧版留档不允许批量改） */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: BleachLevel): Promise<number> {
    const now = Date.now()
    await db.assessments
      .where('id')
      .anyOf(ids)
      .modify((a) => {
        if (a.status === 'archived') return
        a.bleachLevel = bleachLevel
        a.updatedAt = now
      })
    return ids.length
  }

  /* ------------------------------ 鱼类计数 ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = { ...payload, beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    await db.fishes.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  return {
    // 原始表
    substrates,
    assessments,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    substrateDraft,
    assessmentDraft,
    fishDraft,
    // 关系 / 查询
    beltRecordCounts,
    substratesOfBelt,
    assessmentOfSubstrate,
    assessmentsOfBelt,
    fishesOfBelt,
    siteNoOfBelt,
    // 对账连接
    currentBleachRows,
    archivedBleachRows,
    currentRowsOfBelt,
    currentRowsOfBelts,
    missingGenusSubstrates,
    suspendedAssessments,
    archivedAssessments,
    // 汇总
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    // 筛选 / 草稿
    start,
    patchFilter,
    resetFilter,
    patchSubstrateDraft,
    patchAssessmentDraft,
    patchFishDraft,
    // 对账动作
    runAutoReconcile,
    retryAssessmentReconcile,
    ackAssessment,
    // 外业底质
    createSubstrate,
    updateSubstrate,
    removeSubstrate,
    importSubstrateRows,
    // 监测站评定单
    createAssessment,
    updateAssessment,
    removeAssessment,
    bulkSetBleachLevel,
    // 鱼类
    createFish,
    updateFish,
    removeFish,
    importFishRows,
    fishSummaryOfBelt,
    // 常量透出
    protocolForDate,
    PROTOCOL_CURRENT
  }
})

export type {
  AssessmentStatus,
  BleachLevel,
  ProtocolVersion,
  SuspendReason
}
