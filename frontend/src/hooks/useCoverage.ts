/**
 * useCoverage：按样带或站位汇总珊瑚覆盖率、白化占比与鱼类密度。
 * 覆盖率来自外业记录（fieldRecords）；白化指数/等级/分布来自监测站评定单（assessmentForms），
 * 且只计当前规程版本——两版不能混算。
 * 被珊瑚计数页（/belts/:id/corals）、鱼类计数页（/belts/:id/fishes）
 * 与覆盖度汇总页（/coverage）消费。
 */
import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import type { BleachLevel, CoralForm } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { FieldRecord } from '@/types/fieldRecord'
import type { FishCount } from '@/types/fishCount'
import { isCurrentProtocol } from '@/utils/protocol'
import {
  bleachGrade,
  bleachIndex,
  bleachedSharePct,
  coralCoveragePct,
  fishDensity,
  groupByForm,
  groupByGenus,
  round
} from '@/utils/bleach'

/** 单条样带的覆盖度成果 */
export interface BeltCoverage {
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  reefId: string
  reefName: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4（仅当前规程评定单） */
  bleachIndex: number
  grade: BleachLevel
  /** 白化占比（%） */
  bleachedSharePct: number
  /** 各白化等级累计覆盖长度 */
  distribution: Record<BleachLevel, number>
  /** 按属名分组的覆盖长度 */
  byGenus: Array<{ genus: string; coverCm: number }>
  /** 按形态分组的覆盖长度 */
  byForm: Array<{ form: CoralForm; coverCm: number }>
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
}

/** 单个站位的覆盖度汇总 */
export interface SiteCoverage {
  siteId: string
  siteNo: string
  reefId: string
  reefName: string
  depthM: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  /** 站位平均覆盖率（各样本带覆盖率均值） */
  avgCoveragePct: number
  avgBleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

/** 按覆盖长度排序的外业记录行（珊瑚计数页表格用） */
export interface FieldRow {
  record: FieldRecord
  /** 占样带长度比例（%） */
  coverSharePct: number
}

export interface UseCoverageResult {
  /** 指定样带的覆盖度成果 */
  beltCoverage: (beltId: string | null | undefined) => ComputedRef<BeltCoverage | null>
  /** 指定站位下全部样带的汇总 */
  siteCoverage: (siteId: string | null | undefined) => ComputedRef<SiteCoverage | null>
  /** 全部样带的覆盖度成果（按白化指数降序） */
  allBeltCoverages: ComputedRef<BeltCoverage[]>
  /** 全部站位的覆盖度汇总 */
  allSiteCoverages: ComputedRef<SiteCoverage[]>
  /** 全局白化等级分布 */
  globalDistribution: ComputedRef<Record<BleachLevel, number>>
  /** 指定样带的外业记录行（按覆盖长度降序） */
  fieldRows: (beltId: string | null | undefined) => ComputedRef<FieldRow[]>
  /** 指定样带的鱼类计数行 */
  fishRows: (beltId: string | null | undefined) => ComputedRef<Array<{ record: FishCount; density: number }>>
}

const EMPTY_DISTRIBUTION = (): Record<BleachLevel, number> => ({ 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 })

/**
 * 组合式函数：基于三个 store 的响应式列表派生覆盖度、白化占比与鱼类密度。
 */
export function useCoverage(): UseCoverageResult {
  const reefStore = useReefStore()
  const beltStore = useBeltStore()
  const surveyStore = useSurveyStore()

  const { reefs, sites } = storeToRefs(reefStore)
  const { belts } = storeToRefs(beltStore)
  const { fieldRecords, assessmentForms, fishes } = storeToRefs(surveyStore)

  const siteOf = (siteId: string) => sites.value.find((site) => site.id === siteId) ?? null
  const reefOf = (reefId: string) => reefs.value.find((reef) => reef.id === reefId) ?? null

  /** 某样带用于白化指数的记录：外业覆盖长度 × 当前规程评定单等级 */
  function bleachRecordsOfBelt(beltId: string): Array<{ coverCm: number; bleachLevel: BleachLevel }> {
    const records = fieldRecords.value.filter((record) => record.beltId === beltId)
    const forms = assessmentForms.value.filter(
      (form) => form.beltId === beltId && isCurrentProtocol(form.protocolVersion)
    )
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

  function buildBeltCoverage(beltId: string): BeltCoverage | null {
    const belt = belts.value.find((item) => item.id === beltId)
    if (!belt) return null
    const site = siteOf(belt.siteId)
    const reef = site ? reefOf(site.reefId) : null
    const beltRecords = fieldRecords.value.filter((record) => record.beltId === belt.id)
    const bleachRecords = bleachRecordsOfBelt(belt.id)
    const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
    const coverCmTotal = round(
      beltRecords.reduce((sum, record) => sum + record.coverCm, 0),
      1
    )
    const index = bleachIndex(bleachRecords)
    const distribution = EMPTY_DISTRIBUTION()
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        bleachRecords
          .filter((record) => record.bleachLevel === level)
          .reduce((sum, record) => sum + record.coverCm, 0),
        1
      )
    })
    const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    const invertebrateTotal = beltFishes
      .filter((fish) => fish.category === '无脊椎动物')
      .reduce((sum, fish) => sum + fish.count, 0)
    return {
      beltId: belt.id,
      beltNo: belt.no,
      siteId: site?.id ?? '',
      siteNo: site?.no ?? '—',
      reefId: reef?.id ?? '',
      reefName: reef?.name ?? '未知礁区',
      lengthM: belt.lengthM,
      orientation: belt.orientation,
      surveyDate: belt.surveyDate,
      observer: belt.observer,
      coralCount: beltRecords.length,
      coverCmTotal,
      coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(bleachRecords),
      distribution,
      byGenus: groupByGenus(beltRecords),
      byForm: groupByForm(beltRecords),
      fishTotal,
      invertebrateTotal,
      fishDensity: fishDensity(fishTotal, belt.lengthM)
    }
  }

  function beltCoverage(beltId: string | null | undefined): ComputedRef<BeltCoverage | null> {
    return computed(() => (beltId ? buildBeltCoverage(beltId) : null))
  }

  const allBeltCoverages = computed<BeltCoverage[]>(() =>
    belts.value
      .map((belt) => buildBeltCoverage(belt.id))
      .filter((item): item is BeltCoverage => item !== null)
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  function buildSiteCoverage(siteId: string): SiteCoverage | null {
    const site = siteOf(siteId)
    if (!site) return null
    const reef = reefOf(site.reefId)
    const siteBelts = belts.value.filter((belt) => belt.siteId === site.id)
    const beltIds = new Set(siteBelts.map((belt) => belt.id))
    const siteRecords = fieldRecords.value.filter((record) => beltIds.has(record.beltId))
    const siteFishes = fishes.value.filter((fish) => beltIds.has(fish.beltId))
    const coverCmTotal = round(
      siteRecords.reduce((sum, record) => sum + record.coverCm, 0),
      1
    )
    const coverages = siteBelts.map((belt) => {
      const beltRecords = siteRecords.filter((record) => record.beltId === belt.id)
      return coralCoveragePct(
        beltRecords.reduce((sum, record) => sum + record.coverCm, 0),
        belt.lengthM
      )
    })
    const indices = siteBelts.map((belt) => bleachIndex(bleachRecordsOfBelt(belt.id)))
    const avgBleachIndex =
      indices.length === 0 ? 0 : round(indices.reduce((sum, value) => sum + value, 0) / indices.length, 2)
    const fishTotal = siteFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    const totalBeltLength = siteBelts.reduce((sum, belt) => sum + belt.lengthM, 0)
    return {
      siteId: site.id,
      siteNo: site.no,
      reefId: reef?.id ?? '',
      reefName: reef?.name ?? '未知礁区',
      depthM: site.depthM,
      beltCount: siteBelts.length,
      coralCount: siteRecords.length,
      coverCmTotal,
      avgCoveragePct:
        coverages.length === 0 ? 0 : round(coverages.reduce((sum, value) => sum + value, 0) / coverages.length, 2),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      bleachedSharePct: bleachedSharePct(
        siteBelts.flatMap((belt) => bleachRecordsOfBelt(belt.id))
      ),
      fishTotal,
      invertebrateTotal: siteFishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0),
      fishDensity: fishDensity(fishTotal, totalBeltLength)
    }
  }

  function siteCoverage(siteId: string | null | undefined): ComputedRef<SiteCoverage | null> {
    return computed(() => (siteId ? buildSiteCoverage(siteId) : null))
  }

  const allSiteCoverages = computed<SiteCoverage[]>(() =>
    sites.value
      .map((site) => buildSiteCoverage(site.id))
      .filter((item): item is SiteCoverage => item !== null)
      .sort((a, b) => b.avgBleachIndex - a.avgBleachIndex)
  )

  const globalDistribution = computed<Record<BleachLevel, number>>(() => {
    const distribution = EMPTY_DISTRIBUTION()
    const allBleachRecords: Array<{ coverCm: number; bleachLevel: BleachLevel }> = []
    belts.value.forEach((belt) => {
      allBleachRecords.push(...bleachRecordsOfBelt(belt.id))
    })
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        allBleachRecords
          .filter((record) => record.bleachLevel === level)
          .reduce((sum, record) => sum + record.coverCm, 0),
        1
      )
    })
    return distribution
  })

  function fieldRows(beltId: string | null | undefined): ComputedRef<FieldRow[]> {
    return computed(() => {
      if (!beltId) return []
      const belt = belts.value.find((item) => item.id === beltId)
      const beltLengthCm = belt ? belt.lengthM * 100 : 0
      return fieldRecords.value
        .filter((record) => record.beltId === beltId)
        .map((record) => ({
          record,
          coverSharePct: beltLengthCm > 0 ? round((record.coverCm / beltLengthCm) * 100, 1) : 0
        }))
        .sort((a, b) => b.record.coverCm - a.record.coverCm)
    })
  }

  function fishRows(beltId: string | null | undefined): ComputedRef<Array<{ record: FishCount; density: number }>> {
    return computed(() => {
      if (!beltId) return []
      const belt = belts.value.find((item) => item.id === beltId)
      const lengthM = belt?.lengthM ?? 0
      return fishes.value
        .filter((fish) => fish.beltId === beltId)
        .map((record) => ({ record, density: fishDensity(record.count, lengthM) }))
        .sort((a, b) => b.record.count - a.record.count)
    })
  }

  return {
    beltCoverage,
    siteCoverage,
    allBeltCoverages,
    allSiteCoverages,
    globalDistribution,
    fieldRows,
    fishRows
  }
}
