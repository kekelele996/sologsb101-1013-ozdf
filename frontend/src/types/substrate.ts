/**
 * 底质记录（外业组 · 船上端）。
 * 只承载外业组负责的两项：属名初判与覆盖长度；
 * 白化等级与分级规程版本归监测站的评定单（types/assessment.ts）。
 * 外业补录 / 覆盖只写本表，不会顶掉监测站改过的属名与等级。
 */

/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 底质记录：样带内某属名、某形态的覆盖长度（外业组录入） */
export interface SubstrateRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名初判（外业组）。旧数据可能为空串：影像无法定属，挂缺属名清单逐条补 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 底质备注（病敌害、断枝、影像定属失败等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 底质录入草稿（存于 surveyStore） */
export interface SubstrateDraft {
  genus: string
  form: CoralForm
  coverCm: number
  remark: string
}

export function createEmptySubstrateDraft(): SubstrateDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    remark: ''
  }
}

/** 常见属名（表单联想用，外业组与监测站共用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '表孔珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/** 批量粘贴解析出的一行底质记录（外业端不再录白化等级） */
export interface SubstratePasteRow {
  genus: string
  form: CoralForm
  coverCm: number
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度」。
 * 兼容旧模板多出的第 4 列白化等级：外业端无权录入，解析为告警并忽略，不进底质表。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 */
export function parseSubstratePaste(text: string): {
  rows: SubstratePasteRow[]
  errors: string[]
  warnings: string[]
} {
  const rows: SubstratePasteRow[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「属名,形态,覆盖长度(cm)」三列`)
      return
    }
    const form = cells[1] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[1]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[2])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    if (cells.length >= 4 && cells[3].length > 0) {
      warnings.push(`第 ${index + 1} 行带了白化等级「${cells[3]}」，等级归监测站评定单，已忽略该列`)
    }
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1))
    })
  })
  return { rows, errors, warnings }
}
