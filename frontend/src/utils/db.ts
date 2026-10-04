/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - v3：底质记录拆成外业记录（fieldRecords）+ 监测站评定单（assessmentForms），
 *   旧 corals 表按属名拆分迁移；升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 外业记录/评定单/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord, BleachLevel, CoralForm } from '@/types/coralRecord'
import type { FieldRecord } from '@/types/fieldRecord'
import type { AssessmentForm } from '@/types/assessmentForm'
import type { FishCount } from '@/types/fishCount'
import { splitCoralsToRecords, type MissingGenusItem } from '@/utils/migrate'
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_V1 } from '@/utils/protocol'
import { createId } from '@/utils/id'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id',
  migrationIssues: 'gbcoralbelt:migration-issues'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  /** 外业底质记录（船上那份） */
  fieldRecords: FieldRecord[]
  /** 监测站评定单 */
  assessmentForms: AssessmentForm[]
  /** 旧版珊瑚记录（v2 及以前备份可能含此字段，导入时按属名拆分） */
  corals?: CoralRecord[]
  fishes: FishCount[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  fieldRecords!: Table<FieldRecord, string>
  assessmentForms!: Table<AssessmentForm, string>
  /** 旧版珊瑚记录表（v3 起仅迁移期间读取，迁移后清空） */
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2).stores({
      reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
      sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
      belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
      corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
      fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
    })

    // v3：底质记录拆成外业记录 + 监测站评定单；旧 corals 表保留索引用于迁移读取
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        fieldRecords: 'id, beltId, genus, form, coverCm, updatedAt',
        assessmentForms: 'id, fieldRecordId, siteNo, beltId, genus, bleachLevel, protocolVersion, status, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：旧版珊瑚记录（无规程版本）按属名拆成外业记录 + 监测站评定单
        const [oldCorals, belts, sites] = await Promise.all([
          tx.table('corals').toArray(),
          tx.table('belts').toArray(),
          tx.table('sites').toArray()
        ])
        const { fieldRecords, assessmentForms, missingGenus } = splitCoralsToRecords(
          oldCorals,
          belts as Belt[],
          sites as Site[]
        )
        if (fieldRecords.length > 0) await tx.table('fieldRecords').bulkPut(fieldRecords)
        if (assessmentForms.length > 0) await tx.table('assessmentForms').bulkPut(assessmentForms)
        await tx.table('corals').clear()
        // 缺属名的逐条列入迁移问题清单
        if (missingGenus.length > 0) writeMigrationIssues(missingGenus)
      })
  }
}

export const db = new CoralBeltDatabase()

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 迁移问题清单 ------------------------------ */

/** 写入迁移问题清单（缺属名逐条列出） */
export function writeMigrationIssues(issues: MissingGenusItem[]): void {
  try {
    localStorage.setItem(LS_KEYS.migrationIssues, JSON.stringify(issues))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

/** 读取迁移问题清单 */
export function readMigrationIssues(): MissingGenusItem[] {
  try {
    const raw = localStorage.getItem(LS_KEYS.migrationIssues)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MissingGenusItem[]) : []
  } catch {
    return []
  }
}

/** 清空迁移问题清单 */
export function clearMigrationIssues(): void {
  try {
    localStorage.removeItem(LS_KEYS.migrationIssues)
  } catch {
    // 忽略
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  /** 规程版本，默认当前规程 v2 */
  protocolVersion?: string
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 外业记录 + 评定单 + 鱼类计数，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级；评定单以当前规程 v2 为主，含少量旧规程 v1 留档。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', protocolVersion: PROTOCOL_V1, remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', protocolVersion: PROTOCOL_V1, remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz01_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.fieldRecords, db.assessmentForms, db.fishes], async () => {
    const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
      createdAt: now + offset,
      updatedAt: now + offset
    })

    await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
    await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
    await db.belts.bulkPut(
      belts.map((belt, index) => {
        const { corals, fishes, ...rest } = belt
        void corals
        void fishes
        return { ...rest, ...stamp(200 + index) }
      })
    )

    // 外业记录 + 监测站评定单：每条旧珊瑚拆成一份外业记录 + 一份评定单
    const fieldRecords: FieldRecord[] = []
    const assessmentForms: AssessmentForm[] = []
    belts.forEach((belt, beltIndex) => {
      const site = sites.find((item) => item.id === belt.siteId)
      belt.corals.forEach((coral, coralIndex) => {
        const offset = 300 + beltIndex * 100 + coralIndex
        const fieldRecordId = `fld_${belt.id}_${coralIndex}`
        fieldRecords.push({
          id: fieldRecordId,
          beltId: belt.id,
          genus: coral.genus,
          form: coral.form,
          coverCm: coral.coverCm,
          remark: coral.remark,
          ...stamp(offset)
        })
        assessmentForms.push({
          id: `asm_${belt.id}_${coralIndex}`,
          fieldRecordId,
          siteNo: site?.no ?? '',
          beltId: belt.id,
          genus: coral.genus,
          bleachLevel: coral.bleachLevel,
          protocolVersion: coral.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
          status: 'active',
          reconcileNote: '',
          issuedAt: now + offset,
          ...stamp(offset)
        })
      })
    })
    await db.fieldRecords.bulkPut(fieldRecords)
    await db.assessmentForms.bulkPut(assessmentForms)

    await db.fishes.bulkPut(
      belts.flatMap((belt, beltIndex) =>
        belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
      )
    )
  })
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.fieldRecords, db.assessmentForms, db.corals, db.fishes],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.fieldRecords.clear(),
        db.assessmentForms.clear(),
        db.corals.clear(),
        db.fishes.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, fieldRecords, assessmentForms, fishes] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.fieldRecords.count(),
    db.assessmentForms.count(),
    db.fishes.count()
  ])
  return { reefs, sites, belts, fieldRecords, assessmentForms, corals: fieldRecords, fishes }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
