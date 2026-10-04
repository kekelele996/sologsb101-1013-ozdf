/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 *
 * v3 备份含 reefs / sites / belts / substrates / assessments / fishes 六张表。
 * v1/v2 旧备份的 corals 数组在导入时按「属名」拆成外业底质 + 监测站评定单，
 * 与数据库升级走同一套拆分（utils/migration.ts），旧评定单按旧规程留档。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import { BLEACH_LEVELS, PROTOCOL_CURRENT, type BleachLevel } from '@/types/assessment'
import type { SubstrateRecord } from '@/types/substrate'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import { splitLegacyCorals, type LegacyCoralRow } from '@/utils/migration'

/** v3 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'substrates', 'assessments', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, substrates, assessments, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.substrates.toArray(),
    db.assessments.toArray(),
    db.fishes.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    substrates,
    assessments,
    fishes
  }
}

/**
 * 校验外部 JSON 是否为本站可识别的备份文件。
 * 同时兼容 v1/v2 旧备份（带 corals 数组、无 substrates/assessments），
 * 旧备份在校验通过后由 normalizeLegacyPayload 拆分。
 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Record<string, unknown>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of ['reefs', 'sites', 'belts', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  const hasV3 = Array.isArray(obj.substrates) && Array.isArray(obj.assessments)
  const hasLegacy = Array.isArray(obj.corals)
  if (!hasV3 && !hasLegacy) {
    errors.push('需含 substrates + assessments（v3）或旧版 corals 数组，无法识别的底质/评定数据')
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const base = {
    app: 'gbcoralbelt' as const,
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: (obj.reefs ?? []) as BackupPayload['reefs'],
    sites: (obj.sites ?? []) as BackupPayload['sites'],
    belts: (obj.belts ?? []) as BackupPayload['belts'],
    fishes: (obj.fishes ?? []) as BackupPayload['fishes']
  }

  if (hasV3) {
    return {
      ok: true,
      errors,
      payload: {
        ...base,
        substrates: (obj.substrates ?? []) as SubstrateRecord[],
        assessments: (obj.assessments ?? []) as BackupPayload['assessments']
      }
    }
  }

  // 旧备份：按属名拆成外业底质 + 监测站评定单
  const payload = splitLegacyPayload({
    ...base,
    corals: (obj.corals ?? []) as LegacyCoralRow[]
  })
  return { ok: true, errors, payload }
}

/** 旧版（v1/v2）备份结构：六表之外带 corals */
type LegacyPayloadInput = Omit<BackupPayload, 'substrates' | 'assessments'> & { corals: LegacyCoralRow[] }

/** 把旧备份的 corals 按属名拆两份（导进来的旧备份照升级时同一个拆法） */
export function splitLegacyPayload(input: LegacyPayloadInput): BackupPayload {
  const siteIdToNo = new Map(input.sites.map((site) => [site.id, site.no]))
  const beltSite = new Map(input.belts.map((belt) => [belt.id, belt.siteId]))
  const siteNoOfBelt = (beltId: string): string => siteIdToNo.get(beltSite.get(beltId) ?? '') ?? ''
  const split = splitLegacyCorals(input.corals, siteNoOfBelt, Date.parse(input.exportedAt) || Date.now())
  const { corals, ...rest } = input
  void corals
  return {
    ...rest,
    dbVersion: DB_VERSION,
    substrates: split.substrates,
    assessments: split.assessments
  }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    substrates: payload.substrates.length,
    assessments: payload.assessments.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.substrates, db.assessments, db.fishes],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.substrates.bulkPut(payload.substrates)
      await db.assessments.bulkPut(payload.assessments)
      await db.fishes.bulkPut(payload.fishes)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  // 旧备份拆出的评定单沿用底质旧 id 关联；重映射底质时同步换 substrateId / beltId
  const substrateMap = new Map<string, string>()
  const substrates = payload.substrates.map((sub) => {
    const id = createId('sub')
    substrateMap.set(sub.id, id)
    return { ...sub, id, beltId: beltMap.get(sub.beltId) ?? sub.beltId }
  })
  const assessments = payload.assessments.map((asm) => {
    const remappedBelt = asm.beltId ? beltMap.get(asm.beltId) ?? asm.beltId : null
    return {
      ...asm,
      id: createId('asm'),
      beltId: remappedBelt,
      substrateId: asm.substrateId ? substrateMap.get(asm.substrateId) ?? asm.substrateId : null
    }
  })
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return { ...payload, reefs, sites, belts, substrates, assessments, fishes }
}

/* ------------------------------ 覆盖度结论 ------------------------------ */

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 一条「底质 × 评定单」连接行（白化统计最小单位，仅现行已对上） */
interface JoinedRow {
  beltId: string
  genus: string
  coverCm: number
  bleachLevel: BleachLevel
}

/** 把快照按 substrateId 连接底质与评定单；只保留现行规程、已对上 */
function joinCurrentRows(payload: BackupPayload): JoinedRow[] {
  const substrateById = new Map(payload.substrates.map((sub) => [sub.id, sub]))
  const rows: JoinedRow[] = []
  for (const asm of payload.assessments) {
    if (asm.protocolVersion !== PROTOCOL_CURRENT || asm.status !== 'matched' || !asm.substrateId) continue
    const sub = substrateById.get(asm.substrateId)
    if (!sub) continue
    rows.push({ beltId: sub.beltId, genus: asm.genus || sub.genus, coverCm: sub.coverCm, bleachLevel: asm.bleachLevel })
  }
  return rows
}

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
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
  substrateCount: number
  assessedCount: number
  suspendedCount: number
  archivedCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行（白化只计现行规程已对上的评定单） */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const substratesByBelt = new Map<string, SubstrateRecord[]>()
  payload.substrates.forEach((sub) => {
    const list = substratesByBelt.get(sub.beltId) ?? []
    list.push(sub)
    substratesByBelt.set(sub.beltId, list)
  })
  const joinedRows = joinCurrentRows(payload)
  const currentByBelt = new Map<string, JoinedRow[]>()
  joinedRows.forEach((row) => {
    const list = currentByBelt.get(row.beltId) ?? []
    list.push(row)
    currentByBelt.set(row.beltId, list)
  })
  const assessmentsByBelt = new Map<string, typeof payload.assessments>()
  payload.assessments.forEach((asm) => {
    if (!asm.beltId) return
    const list = assessmentsByBelt.get(asm.beltId) ?? []
    list.push(asm)
    assessmentsByBelt.set(asm.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const subs = substratesByBelt.get(belt.id) ?? []
      const currentRows = currentByBelt.get(belt.id) ?? []
      const beltAssessments = assessmentsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        subs.reduce((sum, sub) => sum + sub.coverCm, 0),
        1
      )
      const index = bleachIndex(currentRows)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          currentRows.filter((row) => row.bleachLevel === level).reduce((sum, row) => sum + row.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      const coveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
      const share = bleachedSharePct(currentRows)
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
        substrateCount: subs.length,
        assessedCount: currentRows.length,
        suspendedCount: beltAssessments.filter((a) => a.status === 'suspended').length,
        archivedCount: beltAssessments.filter((a) => a.status === 'archived').length,
        coverCmTotal,
        coveragePct,
        bleachIndex: index,
        grade,
        bleachedSharePct: share,
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          currentRows.length === 0
            ? '该样带尚无现行规程、已对上的评定单（旧版留档 / 挂起不计入当年）'
            : grade === '无'
              ? `珊瑚覆盖率 ${coveragePct}%，当年评定未见白化`
              : `珊瑚覆盖率 ${coveragePct}%，白化指数 ${index}（${grade}），白化占比 ${share}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、当年平均白化指数与总体等级（旧版留档不混算） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  substrateCount: number
  assessedCount: number
  suspendedCount: number
  archivedCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const joinedRows = joinCurrentRows(payload)
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const subs = payload.substrates.filter((sub) => beltIds.has(sub.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    const reefAssessments = payload.assessments.filter((a) => (a.beltId ? beltIds.has(a.beltId) : false))
    void joinedRows
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      substrateCount: subs.length,
      assessedCount: reefAssessments.filter((a) => a.protocolVersion === PROTOCOL_CURRENT && a.status === 'matched')
        .length,
      suspendedCount: reefAssessments.filter((a) => a.status === 'suspended').length,
      archivedCount: reefAssessments.filter((a) => a.status === 'archived').length,
      coverCmTotal: round(
        subs.reduce((sum, sub) => sum + sub.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}
