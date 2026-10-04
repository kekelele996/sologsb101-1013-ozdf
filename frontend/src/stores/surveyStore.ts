/**
 * 普查 store：维护外业底质记录、监测站评定单、鱼类计数与覆盖度派生值。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes 与 /coverage 三页。
 * 底质记录拆成两份：外业组维护属名初判 + 覆盖长度；监测站维护白化等级 + 规程版本。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import { createId } from '@/utils/id'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { FieldRecord } from '@/types/fieldRecord'
import type { AssessmentForm, AssessmentStatus } from '@/types/assessmentForm'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import { reconcileForms, retryMonitoringForms, summarizeReconcile } from '@/utils/reconcile'
import { isCurrentProtocol, CURRENT_PROTOCOL_VERSION } from '@/utils/protocol'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false
  }
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
  coralCount: number
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
  const fieldRecords = ref<FieldRecord[]>([])
  const assessmentForms = ref<AssessmentForm[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
  /** 外业记录草稿（跨页面保留） */
  const fieldDraft = ref({
    genus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<FieldRecord>(() => db.fieldRecords).subscribe((rows) => {
      fieldRecords.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<AssessmentForm>(() => db.assessmentForms).subscribe((rows) => {
      assessmentForms.value = rows
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 某样带的外业记录（按覆盖长度降序） */
  function fieldRecordsOfBelt(beltId: string | null | undefined): FieldRecord[] {
    if (!beltId) return []
    return fieldRecords.value
      .filter((record) => record.beltId === beltId)
      .sort((a, b) => b.coverCm - a.coverCm)
  }

  /** 某样带的监测站评定单 */
  function assessmentFormsOfBelt(beltId: string | null | undefined): AssessmentForm[] {
    if (!beltId) return []
    return assessmentForms.value
      .filter((form) => form.beltId === beltId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 站位 id → 站位编号 */
  function siteNoOfBelt(beltId: string): string {
    const belt = belts.value.find((item) => item.id === beltId)
    if (!belt) return ''
    const site = sites.value.find((item) => item.id === belt.siteId)
    return site?.no ?? ''
  }

  /**
   * 某样带用于白化指数计算的记录：外业覆盖长度 × 当前规程评定单等级。
   * 两版不能混算——只取当前规程（v2）评定单。
   */
  function bleachRecordsOfBelt(beltId: string): Array<{ coverCm: number; bleachLevel: BleachLevel }> {
    const records = fieldRecordsOfBelt(beltId)
    const forms = assessmentFormsOfBelt(beltId).filter((form) => isCurrentProtocol(form.protocolVersion))
    const coverByKey = new Map<string, number>()
    records.forEach((record) => {
      const key = `${record.beltId}__${record.genus.trim()}`
      coverByKey.set(key, (coverByKey.get(key) ?? 0) + record.coverCm)
    })
    return forms.map((form) => ({
      coverCm: coverByKey.get(`${beltId}__${form.genus.trim()}`) ?? 0,
      bleachLevel: form.bleachLevel
    }))
  }

  /** 样带 id → 外业记录数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: fieldRecords.value.filter((record) => record.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const records = fieldRecords.value.filter((record) => record.beltId === belt.id)
        const bleachRecords = bleachRecordsOfBelt(belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          records.reduce((sum, record) => sum + record.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            bleachRecords
              .filter((record) => record.bleachLevel === level)
              .reduce((sum, record) => sum + record.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(bleachRecords)
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
          coralCount: records.length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(bleachRecords),
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

  /** 全局白化等级分布与总体指数（仅当前规程评定单） */
  const globalStats = computed(() => {
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    const allBleachRecords: Array<{ coverCm: number; bleachLevel: BleachLevel }> = []
    belts.value.forEach((belt) => {
      const bleachRecords = bleachRecordsOfBelt(belt.id)
      bleachRecords.forEach((record) => {
        distribution[record.bleachLevel] = round(
          distribution[record.bleachLevel] + record.coverCm,
          1
        )
        allBleachRecords.push(record)
      })
    })
    const index = bleachIndex(allBleachRecords)
    return {
      coralCount: fieldRecords.value.length,
      fishCount: fishes.value.length,
      assessmentFormCount: assessmentForms.value.length,
      coverCmTotal: round(
        fieldRecords.value.reduce((sum, record) => sum + record.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(allBleachRecords),
      distribution
    }
  })

  /** 对账统计 */
  const reconcileStats = computed(() => summarizeReconcile(assessmentForms.value))

  /** 待评定的外业记录（尚无当前规程评定单） */
  const pendingRecords = computed<FieldRecord[]>(() => {
    const keys = new Set(
      assessmentForms.value
        .filter((form) => isCurrentProtocol(form.protocolVersion))
        .map((form) => `${form.beltId}__${form.genus.trim()}`)
    )
    return fieldRecords.value.filter(
      (record) => !keys.has(`${record.beltId}__${record.genus.trim()}`)
    )
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchFieldDraft(patch: Partial<typeof fieldDraft.value>): void {
    fieldDraft.value = { ...fieldDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 外业底质记录 ------------------------------ */

  async function createFieldRecord(
    beltId: string,
    payload: Omit<FieldRecord, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FieldRecord> {
    const now = Date.now()
    const row: FieldRecord = { ...payload, beltId, id: createId('fld'), createdAt: now, updatedAt: now }
    await db.fieldRecords.put(row)
    return row
  }

  async function updateFieldRecord(id: string, patch: Partial<FieldRecord>): Promise<void> {
    await db.fieldRecords.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFieldRecord(id: string): Promise<void> {
    await db.fieldRecords.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有外业记录） */
  async function importFieldRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number }>
  ): Promise<number> {
    const now = Date.now()
    const records: FieldRecord[] = rows.map((row, index) => ({
      id: createId('fld'),
      beltId,
      genus: row.genus,
      form: row.form,
      coverCm: row.coverCm,
      remark: '',
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fieldRecords], async () => {
      await db.fieldRecords.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fieldRecords.bulkPut(records)
    })
    return records.length
  }

  /* ------------------------------ 监测站评定单 ------------------------------ */

  /** 出评定单：为指定外业记录发布白化等级 + 规程版本 */
  async function issueAssessmentForm(
    fieldRecordId: string,
    bleachLevel: BleachLevel,
    protocolVersion: string = CURRENT_PROTOCOL_VERSION
  ): Promise<AssessmentForm> {
    const now = Date.now()
    const record = fieldRecords.value.find((item) => item.id === fieldRecordId)
    const row: AssessmentForm = {
      id: createId('asm'),
      fieldRecordId,
      siteNo: record ? siteNoOfBelt(record.beltId) : '',
      beltId: record?.beltId ?? null,
      genus: record?.genus ?? '',
      bleachLevel,
      protocolVersion,
      status: 'active',
      reconcileNote: '',
      issuedAt: now,
      createdAt: now,
      updatedAt: now
    }
    await db.assessmentForms.put(row)
    return row
  }

  async function updateAssessmentForm(id: string, patch: Partial<AssessmentForm>): Promise<void> {
    await db.assessmentForms.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeAssessmentForm(id: string): Promise<void> {
    await db.assessmentForms.delete(id)
  }

  /** 对账：按站位编号 + 属名重新匹配全部评定单 */
  async function reconcileAll(): Promise<{ active: number; suspended: number }> {
    const updated = reconcileForms(assessmentForms.value, fieldRecords.value, belts.value, sites.value)
    await db.transaction('rw', [db.assessmentForms], async () => {
      await db.assessmentForms.bulkPut(updated)
    })
    return summarizeReconcile(updated)
  }

  /**
   * 监测站重试：只重新对账自己出的评定单。
   * 外业记录（船上那份）不传入、不改动。
   */
  async function retryMonitoring(): Promise<{ active: number; suspended: number }> {
    const updated = retryMonitoringForms(assessmentForms.value, fieldRecords.value, belts.value, sites.value)
    await db.transaction('rw', [db.assessmentForms], async () => {
      await db.assessmentForms.bulkPut(updated)
    })
    return summarizeReconcile(updated)
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
    fieldRecords,
    assessmentForms,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    fieldDraft,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    reconcileStats,
    pendingRecords,
    start,
    fieldRecordsOfBelt,
    assessmentFormsOfBelt,
    fishesOfBelt,
    bleachRecordsOfBelt,
    fishSummaryOfBelt,
    patchFilter,
    resetFilter,
    patchFieldDraft,
    patchFishDraft,
    createFieldRecord,
    updateFieldRecord,
    removeFieldRecord,
    importFieldRows,
    issueAssessmentForm,
    updateAssessmentForm,
    removeAssessmentForm,
    reconcileAll,
    retryMonitoring,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
