/**
 * 外业底质记录（船上那份）：属名初判、形态与覆盖长度归外业组。
 * 与监测站的评定单（assessmentForm）按站位编号 + 属名对账，两边互不覆盖。
 */
import type { CoralForm } from './coralRecord'
import { CORAL_FORMS } from './coralRecord'

/** 外业底质记录：样带内某属名、某形态的覆盖长度（外业组负责） */
export interface FieldRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名初判，如 鹿角珊瑚属 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 备注（病敌害、断枝等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 外业记录草稿（存于 surveyStore） */
export interface FieldDraft {
  genus: string
  form: CoralForm
  coverCm: number
  remark: string
}

export function createEmptyFieldDraft(): FieldDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    remark: ''
  }
}

/** 批量粘贴解析出的一行外业记录 */
export interface FieldPasteRow {
  genus: string
  form: CoralForm
  coverCm: number
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度(cm)」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 * 兼容旧格式「属名,形态,覆盖长度,白化等级」——第 4 列白化等级忽略（外业记录不承载等级）。
 */
export function parseFieldPaste(text: string): { rows: FieldPasteRow[]; errors: string[] } {
  const rows: FieldPasteRow[] = []
  const errors: string[] = []
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
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1))
    })
  })
  return { rows, errors }
}
