<script setup lang="ts">
/**
 * 模块 7：/assessments 白化评定单（监测站 · 评定端）
 * 监测站只录白化等级与分级规程版本；与外业底质分开保存。
 * - 对账键：站位编号 + 属名；对不上先挂起，外业 / 监测站各认一遍；
 * - 监测站「重试对账」只重算自己的评定单，船上底质一条不动；
 * - 换版前评定单按当时（旧版）规程留档，换版后的现行规程才计入当年礁区情况，两版不混算；
 * - 缺属名的外业底质逐条列出，等外业补属名。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, RefreshRight } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { COMMON_GENERA } from '@/types/substrate'
import {
  ASSESSMENT_STATUS_LABEL,
  BLEACH_LEVELS,
  PROTOCOL_CUTOVER_DATE,
  PROTOCOL_LABEL,
  PROTOCOL_SHORT,
  PROTOCOL_VERSIONS,
  SUSPEND_REASON_LABEL,
  createEmptyAssessmentDraft,
  type AssessmentStatus,
  type BleachAssessment,
  type BleachLevel,
  type ProtocolVersion
} from '@/types/assessment'
import { initDatabase } from '@/utils/db'

const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const retrying = ref(false)
const statusFilter = ref<AssessmentStatus | 'all'>('all')
const protocolFilter = ref<ProtocolVersion | 'all'>('all')
const keyword = ref('')
const selectedIds = ref<string[]>([])

const form = reactive(createEmptyAssessmentDraft(new Date().toISOString().slice(0, 10)))

const allAssessments = computed(() =>
  [...surveyStore.assessments].sort((a, b) => {
    const rank: Record<AssessmentStatus, number> = { suspended: 0, matched: 1, archived: 2 }
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
    return b.updatedAt - a.updatedAt
  })
)

const filtered = computed(() =>
  allAssessments.value.filter((a) => {
    if (statusFilter.value !== 'all' && a.status !== statusFilter.value) return false
    if (protocolFilter.value !== 'all' && a.protocolVersion !== protocolFilter.value) return false
    if (keyword.value.trim()) {
      const kw = keyword.value.trim()
      if (!`${a.siteNo}${a.genus}${a.remark}`.includes(kw)) return false
    }
    return true
  })
)

const stats = computed(() => ({
  matched: surveyStore.assessments.filter((a) => a.status === 'matched' && a.protocolVersion === 'GB-CURRENT-2024').length,
  suspended: surveyStore.suspendedAssessments.length,
  archived: surveyStore.archivedAssessments.length,
  missingGenus: surveyStore.missingGenusSubstrates.length,
  untrustedVersion: surveyStore.assessments.filter((a) => a.status === 'archived' && !a.protocolKnown).length
}))

function suspendLabel(reason: string): string {
  return SUSPEND_REASON_LABEL[reason as keyof typeof SUSPEND_REASON_LABEL] ?? '待两边认领'
}

/** 挂起 / 旧版留档行底色区分 */
function assessmentRowClass(p: { row: BleachAssessment }): string {
  return p.row.status === 'suspended' ? 'row-suspended' : p.row.status === 'archived' ? 'row-archived' : ''
}

/** 挂起单对应的外业底质定位提示（同站位底质属名清单），方便监测站核对 */
function substrateHint(a: BleachAssessment): string {
  if (a.status !== 'suspended') return ''
  const site = reefStore.sites.find((s) => s.no === a.siteNo)
  if (!site) return '站位编号在当前站位表中查不到'
  const beltIds = new Set(beltStore.belts.filter((b) => b.siteId === site.id).map((b) => b.id))
  const genera = [
    ...new Set(
      surveyStore.substrates
        .filter((sub) => beltIds.has(sub.beltId) && sub.genus.trim())
        .map((sub) => sub.genus)
    )
  ]
  return genera.length > 0 ? `该站位外业底质属名：${genera.join('、')}` : '该站位底质暂无属名记录'
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyAssessmentDraft(new Date().toISOString().slice(0, 10)))
  dialogVisible.value = true
}

function openEdit(a: BleachAssessment): void {
  if (a.status === 'archived') {
    ElMessage.warning('换版前留档的评定单按当时版本封存，不再改级')
    return
  }
  editingId.value = a.id
  Object.assign(form, {
    siteNo: a.siteNo,
    genus: a.genus,
    bleachLevel: a.bleachLevel,
    protocolVersion: a.protocolVersion,
    assessedDate: a.assessedDate,
    remark: a.remark
  })
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.siteNo.trim()) {
    ElMessage.warning('请填写站位编号（对账键之一）')
    return
  }
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名（对账键之一）')
    return
  }
  if (!form.assessedDate) {
    ElMessage.warning('请选择评定日期')
    return
  }
  // 规程版本以评定日期为准：换版日之前只能按旧版留档
  const forcedVersion: ProtocolVersion =
    form.assessedDate < PROTOCOL_CUTOVER_DATE ? 'GB-OLD-2010' : form.protocolVersion
  submitting.value = true
  try {
    if (editingId.value) {
      await surveyStore.updateAssessment(editingId.value, {
        siteNo: form.siteNo.trim(),
        genus: form.genus.trim(),
        bleachLevel: form.bleachLevel,
        protocolVersion: forcedVersion,
        assessedDate: form.assessedDate,
        remark: form.remark.trim(),
        // 改了键字段要重新对账：先复位连接，自动对账会重算；旧版日期直接留档
        status: forcedVersion === 'GB-OLD-2010' ? 'archived' : 'suspended',
        suspendReason: forcedVersion === 'GB-OLD-2010' ? '' : 'substrate-missing',
        substrateId: null,
        beltId: null
      })
      ElMessage.success('评定单已更新，已按站位编号 + 属名重新对账')
    } else {
      const created = await surveyStore.createAssessment({
        siteNo: form.siteNo.trim(),
        genus: form.genus.trim(),
        bleachLevel: form.bleachLevel,
        protocolVersion: forcedVersion,
        protocolKnown: true,
        assessedDate: form.assessedDate,
        remark: form.remark.trim()
      })
      ElMessage[created.status === 'matched' ? 'success' : 'warning'](
        created.status === 'matched' ? '评定单已与外业底质对上，计入当年' : '评定单没对上，已挂起，待两边各认一遍'
      )
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeAssessment(a: BleachAssessment): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除站位 ${a.siteNo}「${a.genus}」的评定单？外业底质不受影响。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await surveyStore.removeAssessment(a.id)
  ElMessage.success('评定单已删除')
}

/** 监测站认领一遍（只标记监测站侧） */
async function stationAck(a: BleachAssessment): Promise<void> {
  await surveyStore.ackAssessment(a.id, 'station')
  ElMessage.success('监测站已认领一遍')
}

/** 监测站重试对账：只动自己的评定单，船上底质不改 */
async function retryOne(a: BleachAssessment): Promise<void> {
  if (!(a.fieldAck && a.stationAck)) {
    ElMessage.warning('挂起单需外业、监测站各认一遍后，监测站才能重试对账')
    return
  }
  retrying.value = true
  try {
    const result = await surveyStore.retryAssessmentReconcile([a.id])
    if (result.stillSuspended === 0) ElMessage.success('重试成功，评定单已对上，计入当年')
    else ElMessage.warning(`仍对不上（第 ${a.retryCount + 1} 次重试），继续挂起，请再各认一遍`)
  } finally {
    retrying.value = false
  }
}

/** 批量重试所有「两边都认过」的挂起单 */
async function retryAllAcknowledged(): Promise<void> {
  const ids = surveyStore.suspendedAssessments.filter((a) => a.fieldAck && a.stationAck).map((a) => a.id)
  if (ids.length === 0) {
    ElMessage.warning('没有两边都认过、可重试的挂起单')
    return
  }
  retrying.value = true
  try {
    const result = await surveyStore.retryAssessmentReconcile(ids)
    ElMessage.success(`重试 ${result.retried} 条，对上 ${result.retried - result.stillSuspended} 条，仍挂起 ${result.stillSuspended} 条`)
  } finally {
    retrying.value = false
  }
}

/** 缺属名底质 → 跳外业底质页补属名 */
function gotoSubstrate(substrateId: string): void {
  const sub = surveyStore.substrates.find((s) => s.id === substrateId)
  if (sub) window.open(`#/belts/${sub.beltId}/corals`, '_self')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">白化评定单（监测站）</h2>
        <p class="gb-hint">
          监测站只评定白化等级与分级规程版本，按「站位编号 + 属名」与外业底质对账；对不上先挂起各认一遍，
          监测站重试只改评定单。换版（{{ PROTOCOL_CUTOVER_DATE }}）前的评定单按旧版规程留档，现行规程才计入当年礁区情况。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" :loading="retrying" @click="retryAllAcknowledged">批量重试已双认挂起单</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建评定单</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="现行已对上" :value="stats.matched" suffix="单" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="挂起待认" :value="stats.suspended" suffix="单" :tone="stats.suspended > 0 ? 'warning' : 'success'" icon="WarningFilled" />
      <StatBadge label="旧版留档" :value="stats.archived" suffix="单" tone="info" icon="Files" />
      <StatBadge label="缺属名底质" :value="stats.missingGenus" suffix="条" :tone="stats.missingGenus > 0 ? 'warning' : 'success'" icon="EditPen" />
      <StatBadge label="版本未查实" :value="stats.untrustedVersion" suffix="单" tone="info" icon="QuestionFilled" />
    </div>

    <!-- 缺属名清单：逐条列出 -->
    <el-card v-if="surveyStore.missingGenusSubstrates.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>缺属名底质清单（{{ surveyStore.missingGenusSubstrates.length }} 条）</h3>
        <span class="gb-hint">缺属名无法按站位编号 + 属名对账，需外业补属名；旧升级数据与新录数据都在此逐条列出</span>
      </div>
      <el-table :data="surveyStore.missingGenusSubstrates" border stripe size="small" class="gb-table-compact">
        <el-table-column label="站位编号" width="110">
          <template #default="{ row }">
            {{ surveyStore.siteNoOfBelt(row.beltId) || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="形态" width="100" prop="form" />
        <el-table-column label="覆盖长度 (cm)" width="140" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.coverCm }}</span></template>
        </el-table-column>
        <el-table-column prop="remark" label="底质备注" min-width="180" show-overflow-tooltip />
        <el-table-column label="处理" width="160">
          <template #default="{ row }">
            <el-button size="small" type="warning" plain @click="gotoSubstrate(row.id)">去外业页补属名</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-filterline">
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="suspended">挂起待认</el-radio-button>
          <el-radio-button value="matched">已对上</el-radio-button>
          <el-radio-button value="archived">旧版留档</el-radio-button>
        </el-radio-group>
        <el-select v-model="protocolFilter" size="small" style="width: 200px">
          <el-option label="全部规程版本" value="all" />
          <el-option v-for="v in PROTOCOL_VERSIONS" :key="v" :label="PROTOCOL_SHORT[v]" :value="v" />
        </el-select>
        <el-input v-model="keyword" size="small" clearable placeholder="搜站位编号 / 属名 / 备注" style="width: 240px" />
      </div>

      <EmptyPanel
        v-if="filtered.length === 0"
        title="没有符合条件的评定单"
        description="监测站可按站位编号 + 属名新建评定单；现行规程、已对上的单子才计入当年礁区情况。"
        compact
      />

      <el-table v-else :data="filtered" border stripe class="gb-table-compact" :row-class-name="assessmentRowClass">
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'matched' ? 'success' : row.status === 'suspended' ? 'warning' : 'info'" effect="plain">
              {{ ASSESSMENT_STATUS_LABEL[row.status as AssessmentStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="siteNo" label="站位编号" width="100" />
        <el-table-column prop="genus" label="属名（监测站复核）" min-width="150" />
        <el-table-column label="白化等级" width="130">
          <template #default="{ row }">
            <BleachTag :level="row.bleachLevel as BleachLevel" size="small" :plain="true" />
          </template>
        </el-table-column>
        <el-table-column label="规程版本" min-width="190">
          <template #default="{ row }">
            <div class="gb-mono">{{ PROTOCOL_LABEL[row.protocolVersion as ProtocolVersion] }}</div>
            <div v-if="row.status === 'archived' && !row.protocolKnown" class="gb-hint">旧数据未记录版本，按旧规程挂着留档</div>
          </template>
        </el-table-column>
        <el-table-column prop="assessedDate" label="评定日期" width="120" />
        <el-table-column label="对账说明 / 认领" min-width="280">
          <template #default="{ row }">
            <div v-if="row.status === 'suspended'" class="asm-note">
              <el-alert type="warning" :title="suspendLabel(row.suspendReason)" :closable="false" show-icon style="padding: 2px 8px" />
              <div class="gb-hint">{{ substrateHint(row) }}</div>
              <div class="ack-line">
                <el-tag size="small" :type="row.fieldAck ? 'success' : 'info'" effect="plain">
                  外业{{ row.fieldAck ? '已认' : '未认' }}
                </el-tag>
                <el-tag size="small" :type="row.stationAck ? 'success' : 'info'" effect="plain">
                  监测站{{ row.stationAck ? '已认' : '未认' }}
                </el-tag>
                <span class="gb-hint">重试 {{ row.retryCount }} 次</span>
                <el-button size="small" plain @click="stationAck(row)">监测站认领</el-button>
                <el-button
                  size="small"
                  type="primary"
                  :disabled="!(row.fieldAck && row.stationAck)"
                  :loading="retrying"
                  @click="retryOne(row)"
                >
                  重试对账
                </el-button>
              </div>
            </div>
            <div v-else-if="row.status === 'archived'" class="gb-hint">
              换版前评定，按当时版本留档，不计入当年礁区情况
            </div>
            <div v-else class="gb-hint">已按站位编号 + 属名对上外业底质，计入当年</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :disabled="row.status === 'archived'" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="removeAssessment(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑评定单' : '新建评定单'" width="560px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="站位编号" required>
          <el-input v-model="form.siteNo" placeholder="对账键，如 S-01" maxlength="20" />
        </el-form-item>
        <el-form-item label="属名" required>
          <el-input v-model="form.genus" list="asm-genus-options" placeholder="监测站复核后的属名，如 鹿角珊瑚属" maxlength="30" />
          <datalist id="asm-genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">{{ level }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="评定日期" required>
          <el-date-picker v-model="form.assessedDate" type="date" value-format="YYYY-MM-DD" :clearable="false" />
        </el-form-item>
        <el-form-item label="分级规程版本" required>
          <el-radio-group v-model="form.protocolVersion" :disabled="form.assessedDate < PROTOCOL_CUTOVER_DATE">
            <el-radio v-for="v in PROTOCOL_VERSIONS" :key="v" :value="v">{{ PROTOCOL_LABEL[v] }}</el-radio>
          </el-radio-group>
          <div v-if="form.assessedDate < PROTOCOL_CUTOVER_DATE" class="gb-hint">
            评定日期早于换版日 {{ PROTOCOL_CUTOVER_DATE }}，强制按旧版规程留档，不计入当年
          </div>
        </el-form-item>
        <el-form-item label="评定备注">
          <el-input v-model="form.remark" placeholder="如：监测站复核改属 / 影像复核" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重新对账' : '提交并对账' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}
.page__actions {
  display: flex;
  gap: 8px;
}
.gb-filterline {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.asm-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ack-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
:deep(.row-suspended) {
  background: #fdf6ec;
}
:deep(.row-archived) {
  background: #f4f4f5;
  color: #6b7280;
}
</style>
