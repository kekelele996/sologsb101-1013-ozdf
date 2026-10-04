/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 * v3 起底质记录拆成外业记录（fieldRecords）+ 监测站评定单（assessmentForms）；
 * 导入旧备份（含 corals 无 fieldRecords）时按属名拆法拆分。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import { createId } from '@/utils/id'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import type { FieldRecord } from '@/types/fieldRecord'
import type { AssessmentForm } from '@/types/assessmentForm'
import { splitCoralsToRecords } from '@/utils/migrate'
import { isCurrentProtocol } from '@/utils/protocol'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名（新版六张表） */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'fieldRecords', 'assessmentForms', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, fieldRecords, assessmentForms, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.fieldRecords.toArray(),
    db.assessmentForms.toArray(),
    db.fishes.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    fieldRecords,
    assessmentForms,
    fishes
  }
}

/** 从备份载荷取出外业记录与评定单：新版直接取，旧版（含 corals）按属名拆分 */
export function extractRecords(payload: BackupPayload): {
  fieldRecords: FieldRecord[]
  assessmentForms: AssessmentForm[]
} {
  if (Array.isArray(payload.fieldRecords)) {
    return { fieldRecords: payload.fieldRecords, assessmentForms: payload.assessmentForms ?? [] }
  }
  // 旧版备份：corals 按属名拆成外业记录 + 评定单
  const { fieldRecords, assessmentForms } = splitCoralsToRecords(
    payload.corals ?? [],
    payload.belts,
    payload.sites
  )
  return { fieldRecords, assessmentForms }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of ['reefs', 'sites', 'belts', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  // 新版需 fieldRecords + assessmentForms；旧版需 corals
  const hasNew = Array.isArray(obj.fieldRecords) && Array.isArray(obj.assessmentForms)
  const hasOld = Array.isArray(obj.corals)
  if (!hasNew && !hasOld) {
    errors.push('fieldRecords / assessmentForms 字段缺失或不是数组（旧版备份需含 corals）')
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    fieldRecords: Array.isArray(obj.fieldRecords) ? obj.fieldRecords : [],
    assessmentForms: Array.isArray(obj.assessmentForms) ? obj.assessmentForms : [],
    corals: Array.isArray(obj.corals) ? obj.corals : undefined,
    fishes: obj.fishes ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  const { fieldRecords, assessmentForms } = extractRecords(payload)
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    fieldRecords: payload.fieldRecords.length,
    assessmentForms: payload.assessmentForms.length,
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
  const { fieldRecords, assessmentForms } = extractRecords(payload)
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.fieldRecords, db.assessmentForms, db.fishes],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.fieldRecords.bulkPut(fieldRecords)
      await db.assessmentForms.bulkPut(assessmentForms)
      await db.fishes.bulkPut(payload.fishes)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const { fieldRecords, assessmentForms } = extractRecords(payload)
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  const fieldMap = new Map<string, string>()

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
  const remappedFields = fieldRecords.map((record) => {
    const id = createId('fld')
    fieldMap.set(record.id, id)
    return { ...record, id, beltId: beltMap.get(record.beltId) ?? record.beltId }
  })
  const remappedForms = assessmentForms.map((form) => ({
    ...form,
    id: createId('asm'),
    fieldRecordId: form.fieldRecordId ? fieldMap.get(form.fieldRecordId) ?? form.fieldRecordId : null,
    beltId: form.beltId ? beltMap.get(form.beltId) ?? form.beltId : form.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return {
    ...payload,
    reefs,
    sites,
    belts,
    fieldRecords: remappedFields,
    assessmentForms: remappedForms,
    corals: undefined,
    fishes
  }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率（外业记录）与白化指数（当前规程评定单） */
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
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4（仅当前规程评定单） */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权，仅当前规程评定单） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const { fieldRecords, assessmentForms } = extractRecords(payload)
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const recordsByBelt = new Map<string, FieldRecord[]>()
  fieldRecords.forEach((record) => {
    const list = recordsByBelt.get(record.beltId) ?? []
    list.push(record)
    recordsByBelt.set(record.beltId, list)
  })
  const formsByBelt = new Map<string, AssessmentForm[]>()
  assessmentForms.forEach((form) => {
    if (!form.beltId) return
    const list = formsByBelt.get(form.beltId) ?? []
    list.push(form)
    formsByBelt.set(form.beltId, list)
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
      const records = recordsByBelt.get(belt.id) ?? []
      const forms = (formsByBelt.get(belt.id) ?? []).filter((form) => isCurrentProtocol(form.protocolVersion))
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(records.reduce((sum, record) => sum + record.coverCm, 0), 1)
      // 白化指数按覆盖长度加权：用外业记录的覆盖长度 × 对应评定单等级
      const coverByKey = new Map<string, number>()
      records.forEach((record) => {
        const key = `${record.beltId}__${record.genus.trim()}`
        coverByKey.set(key, (coverByKey.get(key) ?? 0) + record.coverCm)
      })
      const bleachRecords = forms.map((form) => ({
        coverCm: coverByKey.get(`${belt.id}__${form.genus.trim()}`) ?? 0,
        bleachLevel: form.bleachLevel
      }))
      const index = bleachIndex(bleachRecords)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          bleachRecords
            .filter((record) => record.bleachLevel === level)
            .reduce((sum, record) => sum + record.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
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
        grade,
        bleachedSharePct: bleachedSharePct(bleachRecords),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          records.length === 0
            ? '该样带尚未录入外业底质记录'
            : grade === '无'
              ? `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(bleachRecords)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级（仅当前规程评定单） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const { fieldRecords } = extractRecords(payload)
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const records = fieldRecords.filter((record) => beltIds.has(record.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      coralCount: records.length,
      coverCmTotal: round(records.reduce((sum, record) => sum + record.coverCm, 0), 1),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}
