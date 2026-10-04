/**
 * 监测站评定单：白化等级与分级规程版本归监测站。
 * 与外业底质记录（fieldRecord）按站位编号 + 属名对账：
 * 对得上 → active；对不上 → suspended（挂起，各认一遍）。
 */
import type { BleachLevel } from './coralRecord'
import { BLEACH_LEVELS } from './coralRecord'

/** 评定单状态：active 已对账 / suspended 挂起（对账未匹配，各认一遍） */
export type AssessmentStatus = 'active' | 'suspended'

export const ASSESSMENT_STATUSES: AssessmentStatus[] = ['active', 'suspended']

/** 监测站评定单 */
export interface AssessmentForm {
  id: string
  /** 对账匹配到的外业记录 id（未匹配为 null） */
  fieldRecordId: string | null
  /** 站位编号（对账键之一，来自样带所属站位） */
  siteNo: string
  /** 所属样带 id（出单时带入，便于回溯） */
  beltId: string | null
  /** 属名（对账键之一） */
  genus: string
  /** 白化等级（监测站评定） */
  bleachLevel: BleachLevel
  /** 分级规程版本，如 v1 / v2 */
  protocolVersion: string
  /** 对账状态 */
  status: AssessmentStatus
  /** 对账备注（挂起原因等） */
  reconcileNote: string
  /** 出单时间 */
  issuedAt: number
  createdAt: number
  updatedAt: number
}

/** 评定单草稿（监测站出单用） */
export interface AssessmentFormDraft {
  bleachLevel: BleachLevel
  protocolVersion: string
}

export function createEmptyAssessmentDraft(protocolVersion: string): AssessmentFormDraft {
  return {
    bleachLevel: '无',
    protocolVersion
  }
}

export { BLEACH_LEVELS }
