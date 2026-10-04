/**
 * 对账逻辑：监测站评定单与外业底质记录按站位编号 + 属名对账。
 * 对得上 → active 并关联外业记录；对不上 → suspended 挂起，各认一遍。
 * 监测站重试只重新对账自己出的评定单，外业记录（船上那份）不动。
 */
import type { AssessmentForm } from '@/types/assessmentForm'
import type { FieldRecord } from '@/types/fieldRecord'
import type { Belt } from '@/types/belt'
import type { Site } from '@/types/site'

/** 对账键：站位编号 + 属名（属名去空格，避免繁简/空格差异） */
export function reconcileKey(siteNo: string, genus: string): string {
  return `${siteNo.trim()}__${genus.trim()}`
}

/** 由样带 id 解析站位编号 */
function siteNoOfBelt(beltId: string, belts: Belt[], sites: Site[]): string {
  const belt = belts.find((item) => item.id === beltId)
  if (!belt) return ''
  const site = sites.find((item) => item.id === belt.siteId)
  return site?.no ?? ''
}

/**
 * 对账：评定单 vs 外业记录。
 * 仅改写评定单状态与关联外业记录，外业记录不做任何改动。
 */
export function reconcileForms(
  forms: AssessmentForm[],
  fieldRecords: FieldRecord[],
  belts: Belt[],
  sites: Site[]
): AssessmentForm[] {
  const fieldKeyToId = new Map<string, string>()
  fieldRecords.forEach((record) => {
    const siteNo = siteNoOfBelt(record.beltId, belts, sites)
    const key = reconcileKey(siteNo, record.genus)
    if (!fieldKeyToId.has(key)) fieldKeyToId.set(key, record.id)
  })

  return forms.map((form) => {
    const key = reconcileKey(form.siteNo, form.genus)
    const matchedFieldId = fieldKeyToId.get(key) ?? null
    if (matchedFieldId) {
      return {
        ...form,
        status: 'active',
        fieldRecordId: matchedFieldId,
        reconcileNote: ''
      }
    }
    return {
      ...form,
      status: 'suspended',
      fieldRecordId: null,
      reconcileNote: '对账未匹配到外业记录（站位编号 + 属名），先挂起各认一遍'
    }
  })
}

/**
 * 监测站重试：只重新对账自己出的评定单。
 * 外业记录（船上那份）不传入、不改动。
 */
export function retryMonitoringForms(
  forms: AssessmentForm[],
  fieldRecords: FieldRecord[],
  belts: Belt[],
  sites: Site[]
): AssessmentForm[] {
  return reconcileForms(forms, fieldRecords, belts, sites)
}

/** 统计对账结果 */
export function summarizeReconcile(forms: AssessmentForm[]): { active: number; suspended: number } {
  return {
    active: forms.filter((form) => form.status === 'active').length,
    suspended: forms.filter((form) => form.status === 'suspended').length
  }
}
