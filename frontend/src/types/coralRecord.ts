/**
 * 珊瑚与白化共享类型：形态、白化等级、常见属名。
 * 外业底质记录（fieldRecord）与监测站评定单（assessmentForm）共用同一套等级口径。
 */

/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/**
 * 旧版珊瑚记录（v2 及以前，外业组与监测站合用一份）。
 * v3 起拆成外业记录（fieldRecord）+ 监测站评定单（assessmentForm），
 * 此类型仅用于升级迁移与旧备份导入时读取历史数据。
 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}
