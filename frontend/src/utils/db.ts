/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 底质记录/评定单/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * v3：底质记录（外业组：属名初判 + 覆盖长度）与白化评定单（监测站：白化等级 +
 * 分级规程版本）拆成 substrates / assessments 两张表；升级时把旧 corals
 * 按属名拆两份，旧评定单按旧规程留档，缺属名逐条进清单。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { SubstrateRecord } from '@/types/substrate'
import type { BleachAssessment } from '@/types/assessment'
import type { FishCount } from '@/types/fishCount'
import { splitLegacyCorals } from '@/utils/migration'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  /** 外业底质记录（属名初判 + 覆盖长度） */
  substrates: SubstrateRecord[]
  /** 监测站白化评定单（白化等级 + 分级规程版本） */
  assessments: BleachAssessment[]
  fishes: FishCount[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  substrates!: Table<SubstrateRecord, string>
  assessments!: Table<BleachAssessment, string>
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

    // v3：底质（外业）与评定单（监测站）拆表；旧 corals 按属名拆两份后废弃
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        substrates: 'id, beltId, genus, form, coverCm, updatedAt',
        assessments:
          'id, substrateId, beltId, siteNo, genus, bleachLevel, protocolVersion, status, assessedDate, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        // v2 的 corals 表在 v3 删除（拆进 substrates / assessments）
        corals: null
      })
      .upgrade(async (tx) => {
        // 从 v1 直升时 Dexie 会先执行 v2 的 upgrade 补齐旧表必填字段；
        // 这里只做 v3 拆分：把旧 corals 按属名拆成外业底质 + 监测站评定单。
        // corals 在本版声明删除，但删除在本升级事务提交后才生效，事务内仍可读。
        const [legacyCorals, beltRows, siteRows] = await Promise.all([
          tx.table('corals').toArray(),
          tx.table('belts').toArray(),
          tx.table('sites').toArray()
        ])
        const siteIdToNo = new Map<string, string>(
          siteRows.map((site: { id?: unknown; no?: unknown }) => [String(site.id), String(site.no ?? '')])
        )
        const beltSite = new Map<string, string>(
          beltRows.map((belt: { id?: unknown; siteId?: unknown }) => [String(belt.id), String(belt.siteId ?? '')])
        )
        const siteNoOfBelt = (beltId: string): string => siteIdToNo.get(beltSite.get(beltId) ?? '') ?? ''

        const split = splitLegacyCorals(legacyCorals, siteNoOfBelt, Date.now())
        if (split.substrates.length > 0) await tx.table('substrates').bulkPut(split.substrates)
        if (split.assessments.length > 0) await tx.table('assessments').bulkPut(split.assessments)
        // 缺属名的旧记录不进评定单；缺属名清单由页面按 substrates.genus 实时列出
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

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

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedSubstrate {
  id: string
  beltId: string
  genus: string
  form: SubstrateRecord['form']
  coverCm: number
  remark: string
}

interface SeedAssessment {
  id: string
  substrateId: string | null
  beltId: string | null
  siteNo: string
  genus: string
  bleachLevel: BleachAssessment['bleachLevel']
  protocolVersion: BleachAssessment['protocolVersion']
  protocolKnown: boolean
  assessedDate: string
  status: BleachAssessment['status']
  suspendReason?: BleachAssessment['suspendReason']
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
  substrates: SeedSubstrate[]
  assessments: SeedAssessment[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 6 条样带。
 * 底质（外业）与评定单（监测站）分两张表；
 * 含换版前旧规程留档、挂起待认（属名对不上 / 孤单 / 缺属名）与现行已对上三类，
 * 保证评定页、对账流程与当年汇总都有真实内容、层级路由也能命中真实 id。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const oldDate = '2024-06-18'
  const { PROTOCOL_OLD, PROTOCOL_CURRENT } = await import('@/types/assessment')

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
    { id: 'site_ql_01', reefId: 'reef_ql01', no: 'S-01', lat: 19.5621, lng: 110.7924, depthM: 4.2, substrate: '珊瑚礁石' },
    { id: 'site_ql_02', reefId: 'reef_ql01', no: 'S-02', lat: 19.5487, lng: 110.8103, depthM: 8.6, substrate: '礁砂' },
    { id: 'site_yr_01', reefId: 'reef_yr02', no: 'S-01', lat: 16.8342, lng: 112.3286, depthM: 12.4, substrate: '砾石' },
    { id: 'site_dz_01', reefId: 'reef_dz03', no: 'S-01', lat: 18.6712, lng: 110.4913, depthM: 6.8, substrate: '岩礁' }
  ]

  /** 现行规程、已对上的评定单（播种时即对账成功） */
  const cur = (
    id: string,
    substrateId: string,
    beltId: string,
    siteNo: string,
    genus: string,
    bleachLevel: SeedAssessment['bleachLevel'],
    assessedDate: string,
    remark = ''
  ): SeedAssessment => ({
    id,
    substrateId,
    beltId,
    siteNo,
    genus,
    bleachLevel,
    protocolVersion: PROTOCOL_CURRENT,
    protocolKnown: true,
    assessedDate,
    status: 'matched',
    remark
  })

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      substrates: [
        { id: 'sub_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, remark: '长势良好' },
        { id: 'sub_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, remark: '局部褪色' },
        { id: 'sub_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, remark: '' },
        { id: 'sub_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, remark: '' }
      ],
      assessments: [
        cur('asm_ql01a_1', 'sub_ql01a_1', 'belt_ql01_a', 'S-01', '鹿角珊瑚属', '无', today),
        cur('asm_ql01a_2', 'sub_ql01a_2', 'belt_ql01_a', 'S-01', '杯形珊瑚属', '轻', today),
        cur('asm_ql01a_3', 'sub_ql01a_3', 'belt_ql01_a', 'S-01', '滨珊瑚属', '无', today),
        // 监测站把外业初判「软珊瑚属」复核成「表孔珊瑚属」：属名对不上，挂起各认一遍
        {
          id: 'asm_ql01a_4',
          substrateId: null,
          beltId: null,
          siteNo: 'S-01',
          genus: '表孔珊瑚属',
          bleachLevel: '轻',
          protocolVersion: PROTOCOL_CURRENT,
          protocolKnown: true,
          assessedDate: today,
          status: 'suspended',
          suspendReason: 'substrate-missing',
          remark: '监测站复核改属，待外业确认'
        }
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
      substrates: [
        { id: 'sub_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, remark: '边缘白化明显' },
        { id: 'sub_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, remark: '' },
        { id: 'sub_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, remark: '大面积白化，部分死亡' }
      ],
      assessments: [
        cur('asm_ql01b_1', 'sub_ql01b_1', 'belt_ql01_b', 'S-01', '蔷薇珊瑚属', '中', today),
        cur('asm_ql01b_2', 'sub_ql01b_2', 'belt_ql01_b', 'S-01', '蜂巢珊瑚属', '轻', today),
        cur('asm_ql01b_3', 'sub_ql01b_3', 'belt_ql01_b', 'S-01', '鹿角珊瑚属', '重', today)
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
      substrates: [
        { id: 'sub_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, remark: '' },
        { id: 'sub_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, remark: '仅存骨骼，附着藻类' }
      ],
      assessments: [
        cur('asm_ql02a_1', 'sub_ql02a_1', 'belt_ql02_a', 'S-02', '滨珊瑚属', '无', today),
        cur('asm_ql02a_2', 'sub_ql02a_2', 'belt_ql02_a', 'S-02', '陀螺珊瑚属', '死亡', today)
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
      substrates: [
        { id: 'sub_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, remark: '' },
        { id: 'sub_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, remark: '水流较强区域' },
        { id: 'sub_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, remark: '' }
      ],
      assessments: [
        cur('asm_yr01a_1', 'sub_yr01a_1', 'belt_yr01_a', 'S-01', '星珊瑚属', '轻', today),
        cur('asm_yr01a_2', 'sub_yr01a_2', 'belt_yr01_a', 'S-01', '柳珊瑚属', '中', today),
        cur('asm_yr01a_3', 'sub_yr01a_3', 'belt_yr01_a', 'S-01', '石芝珊瑚属', '无', today)
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      substrates: [
        { id: 'sub_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, remark: '受台风扰动后白化' },
        { id: 'sub_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, remark: '' },
        // 影像无法定属：缺属名底质，逐条进缺属名清单，外业补属名后才能对账
        { id: 'sub_dz01a_3', beltId: 'belt_dz01_a', genus: '', form: '块状', coverCm: 140, remark: '影像定属失败，待补' }
      ],
      assessments: [
        cur('asm_dz01a_1', 'sub_dz01a_1', 'belt_dz01_a', 'S-01', '杯形珊瑚属', '重', today),
        cur('asm_dz01a_2', 'sub_dz01a_2', 'belt_dz01_a', 'S-01', '蜂巢珊瑚属', '中', today)
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    },
    {
      // 换版前样带：评定单按当时（旧版）规程留档，不计入当年礁区情况，两版不混算
      id: 'belt_ql02_old',
      siteId: 'site_ql_02',
      no: 'T-99',
      lengthM: 30,
      orientation: '北',
      surveyDate: oldDate,
      observer: '周渝',
      substrates: [
        { id: 'sub_ql02old_1', beltId: 'belt_ql02_old', genus: '滨珊瑚属', form: '块状', coverCm: 980, remark: '换版前航次' },
        { id: 'sub_ql02old_2', beltId: 'belt_ql02_old', genus: '鹿角珊瑚属', form: '枝状', coverCm: 420, remark: '换版前航次' }
      ],
      assessments: [
        {
          id: 'asm_ql02old_1',
          substrateId: 'sub_ql02old_1',
          beltId: 'belt_ql02_old',
          siteNo: 'S-02',
          genus: '滨珊瑚属',
          bleachLevel: '轻',
          protocolVersion: PROTOCOL_OLD,
          protocolKnown: true,
          assessedDate: oldDate,
          status: 'archived',
          remark: '按换版前旧版分级规程评定，留档封存'
        },
        {
          id: 'asm_ql02old_2',
          substrateId: 'sub_ql02old_2',
          beltId: 'belt_ql02_old',
          siteNo: 'S-02',
          genus: '鹿角珊瑚属',
          bleachLevel: '重',
          protocolVersion: PROTOCOL_OLD,
          protocolKnown: true,
          assessedDate: oldDate,
          status: 'archived',
          remark: '按换版前旧版分级规程评定，留档封存'
        }
      ],
      fishes: []
    }
  ]

  // 孤单：监测站录了站位 S-09 的评定单，当前站位表查不到，挂起（重试只动本单）
  const orphanAssessment: SeedAssessment = {
    id: 'asm_orphan_1',
    substrateId: null,
    beltId: null,
    siteNo: 'S-09',
    genus: '鹿角珊瑚属',
    bleachLevel: '中',
    protocolVersion: PROTOCOL_CURRENT,
    protocolKnown: true,
    assessedDate: today,
    status: 'suspended',
    suspendReason: 'site-missing',
    remark: '站位编号待核，可能是外业未建档站位'
  }

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.substrates, db.assessments, db.fishes],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { substrates, assessments, fishes, ...rest } = belt
          void substrates
          void assessments
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      let offset = 0
      for (const [beltIndex, belt] of belts.entries()) {
        for (const [subIndex, sub] of belt.substrates.entries()) {
          await db.substrates.put({ ...sub, ...stamp(300 + beltIndex * 100 + subIndex) })
          offset += 1
        }
        for (const [asmIndex, asm] of belt.assessments.entries()) {
          await db.assessments.put({
            ...asm,
            suspendReason: asm.suspendReason ?? '',
            fieldAck: false,
            stationAck: false,
            retryCount: 0,
            ...stamp(600 + beltIndex * 100 + asmIndex)
          })
          offset += 1
        }
        for (const [fishIndex, fish] of belt.fishes.entries()) {
          await db.fishes.put({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) })
        }
      }
      void offset
      await db.assessments.put({
        ...orphanAssessment,
        suspendReason: orphanAssessment.suspendReason ?? '',
        fieldAck: false,
        stationAck: false,
        retryCount: 0,
        ...stamp(900)
      })
    }
  )
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
    [db.reefs, db.sites, db.belts, db.substrates, db.assessments, db.fishes],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.substrates.clear(),
        db.assessments.clear(),
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
  const [reefs, sites, belts, substrates, assessments, fishes] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.substrates.count(),
    db.assessments.count(),
    db.fishes.count()
  ])
  return { reefs, sites, belts, substrates, assessments, fishes }
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
