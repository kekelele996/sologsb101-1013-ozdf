<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 底质记录（外业组 · 船上端）
 * 只录属名初判、形态、覆盖长度与底质备注；白化等级与分级规程版本归监测站评定单。
 * 外业补录 / 覆盖只写底质表，不会顶掉监测站改过的属名与等级。
 * 表内回显每条底质对应的评定单状态，挂起单外业组可在本页「认领一遍」。
 * 复用 <StatBadge>、<EmptyPanel>、<BleachTag>（评定单等级只读）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { COMMON_GENERA, CORAL_FORMS, parseSubstratePaste } from '@/types/substrate'
import type { CoralForm, SubstrateRecord } from '@/types/substrate'
import { ASSESSMENT_STATUS_LABEL, PROTOCOL_SHORT, SUSPEND_REASON_LABEL } from '@/types/assessment'
import { coralCoveragePct, groupByForm, groupByGenus } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const pasteWarnings = ref<string[]>([])
const form = reactive({
  genus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  remark: ''
})

/** 本样带外业底质 */
const records = computed(() => surveyStore.substratesOfBelt(beltId.value))

/** 本样带评定单（监测站那份，只读回显） */
const assessmentsMap = computed(() => {
  const map = new Map(surveyStore.assessmentsOfBelt(beltId.value).map((a) => [a.substrateId, a]))
  // 挂起单 substrateId 为 null，另存一份按属名提示
  return map
})
const suspendedHere = computed(() =>
  surveyStore.assessmentsOfBelt(beltId.value).filter((a) => a.status === 'suspended')
)

const genusGroups = computed(() => groupByGenus(records.value).map((group) => ({ ...group, count: records.value.filter((r) => r.genus === group.genus).length })))
const formGroups = computed(() => groupByForm(records.value))

const stats = computed(() => {
  const list = records.value
  const coverCmTotal = list.reduce((sum, r) => sum + r.coverCm, 0)
  const currentRows = surveyStore.currentRowsOfBelt(beltId.value)
  const assessedCover = currentRows.reduce((sum, r) => sum + r.coverCm, 0)
  return {
    substrateCount: list.length,
    missingGenusCount: list.filter((r) => !r.genus.trim()).length,
    coverCmTotal,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    assessedCount: currentRows.length,
    assessedCover
  }
})

function assessmentOf(substrateId: string) {
  return assessmentsMap.value.get(substrateId) ?? null
}

function suspendLabel(reason: string): string {
  return SUSPEND_REASON_LABEL[reason as keyof typeof SUSPEND_REASON_LABEL] ?? '待两边认领'
}

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

/** 缺属名行高亮 */
function substrateRowClass(p: { row: SubstrateRecord }): string {
  return !p.row.genus.trim() ? 'row-missing-genus' : ''
}

function openCreate(): void {
  editingId.value = null
  form.genus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(record: SubstrateRecord): void {
  editingId.value = record.id
  form.genus = record.genus
  form.form = record.form
  form.coverCm = record.coverCm
  form.remark = record.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名初判（影像无法定属可先存空，随后在缺属名清单补录）')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      genus: form.genus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await surveyStore.updateSubstrate(editingId.value, payload)
      ElMessage.success('底质记录已更新（监测站评定单不受影响，会按站位编号 + 属名重新对账）')
    } else {
      await surveyStore.createSubstrate(beltId.value, payload)
      ElMessage.success('底质记录已新增，覆盖长度计入覆盖率')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/** 缺属名补录：直接打开编辑弹窗 */
function fillGenus(record: SubstrateRecord): void {
  openEdit(record)
}

async function removeRecord(record: SubstrateRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${record.genus || '（缺属名）'}（${record.form}）」覆盖 ${record.coverCm} cm 的底质记录？监测站评定单会转为挂起、不会被删除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeSubstrate(record.id)
  ElMessage.success('底质记录已删除，相关评定单转挂起待重对')
}

/** 外业组对挂起评定单认领一遍（只标记外业侧，不动监测站数据） */
async function fieldAck(substrateId: string): Promise<void> {
  const asm = assessmentOf(substrateId)
  if (!asm) return
  await surveyStore.ackAssessment(asm.id, 'field')
  ElMessage.success('外业组已认领；待监测站也认领后，由监测站重试对账')
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteWarnings.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseSubstratePaste(pasteText.value)
  pasteErrors.value = parsed.errors
  pasteWarnings.value = parsed.warnings
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「属名,形态,覆盖长度」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseSubstratePaste(pasteText.value)
  pasteErrors.value = parsed.errors
  pasteWarnings.value = parsed.warnings
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行外业底质覆盖该样带现有 ${records.value.length} 条底质记录；白化等级在监测站评定单里、不受影响。确认导入？`,
      '外业补录覆盖确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await surveyStore.importSubstrateRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  ElMessage.success(`已导入 ${count} 条底质记录`)
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的底质记录`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>外业底质记录</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 底质记录（外业组）
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
          </h2>
          <p class="gb-hint">
            外业只录「属名初判 + 覆盖长度」；白化等级与分级规程版本由监测站在
            <el-link type="primary" :underline="false" href="/assessments">评定单</el-link>
            里填，两边分开保存，外业补录覆盖不会顶回监测站的修改。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增底质记录</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="底质记录" :value="stats.substrateCount" suffix="条" icon="Histogram" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="info" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
        <StatBadge label="已对上评定" :value="stats.assessedCount" suffix="条" icon="CircleCheckFilled" />
        <StatBadge label="缺属名" :value="stats.missingGenusCount" suffix="条" :tone="stats.missingGenusCount > 0 ? 'warning' : 'success'" icon="WarningFilled" />
      </div>

      <el-alert
        v-if="suspendedHere.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`有 ${suspendedHere.length} 条监测站评定单按站位编号 + 属名没对上，已挂起。请外业核对属名后在下方「外业认领」，再由监测站重试。`"
      />

      <el-card v-if="records.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>外业覆盖汇总（覆盖长度 cm）</h3>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按属名初判分组</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus || '空'" class="gb-bar">
                <span>{{ group.genus || '（缺属名）' }}</span>
                <span class="gb-bar__track">
                  <span class="gb-bar__fill" :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm · {{ group.count }} 条</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span class="gb-bar__fill" :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="records.length === 0"
        title="该样带还没有底质记录"
        description="外业按属名与形态录入覆盖长度（白化等级由监测站另单评定）；也可以批量粘贴导入整段摸底数据。"
        action-text="新增底质记录"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="records" border stripe class="gb-table-compact" :row-class-name="substrateRowClass">
        <el-table-column prop="genus" label="属名初判（外业）" min-width="150">
          <template #default="{ row }">
            <span v-if="row.genus.trim()">{{ row.genus }}</span>
            <el-button v-else text type="warning" size="small" @click="fillGenus(row)">缺属名 · 点击补录</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="form" label="形态" width="100" />
        <el-table-column label="覆盖长度 (cm)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="监测站评定单（只读）" min-width="260">
          <template #default="{ row }">
            <template v-if="assessmentOf(row.id)">
              <div class="asm-cell">
                <BleachTag :level="assessmentOf(row.id)!.bleachLevel" size="small" :plain="true" />
                <el-tag size="small" effect="plain" :type="assessmentOf(row.id)!.status === 'matched' ? 'success' : 'info'">
                  {{ ASSESSMENT_STATUS_LABEL[assessmentOf(row.id)!.status] }}
                </el-tag>
                <el-tag size="small" type="info" effect="plain">{{ PROTOCOL_SHORT[assessmentOf(row.id)!.protocolVersion] }}</el-tag>
              </div>
              <div v-if="assessmentOf(row.id)!.status === 'suspended'" class="gb-hint">
                {{ suspendLabel(assessmentOf(row.id)!.suspendReason) }}
              </div>
            </template>
            <span v-else class="gb-hint">监测站尚未出评定单</span>
          </template>
        </el-table-column>
        <el-table-column label="外业认领" width="110" align="center">
          <template #default="{ row }">
            <el-button
              v-if="assessmentOf(row.id)?.status === 'suspended'"
              size="small"
              :type="assessmentOf(row.id)!.fieldAck ? 'success' : 'warning'"
              plain
              @click="fieldAck(row.id)"
            >
              {{ assessmentOf(row.id)!.fieldAck ? '外业已认' : '外业认领' }}
            </el-button>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="底质备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑底质记录' : '新增底质记录'" width="540px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="属名初判" required>
          <el-input v-model="form.genus" list="genus-options" placeholder="如：鹿角珊瑚属；无法定属可留空后进缺属名清单" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="底质备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 影像定属失败" maxlength="60" />
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon title="白化等级不在外业这边填，由监测站按分级规程在评定单里评定。" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增记录' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入底质记录" width="620px">
      <p class="gb-hint">
        每行一条，格式「属名,形态,覆盖长度(cm)」，逗号 / 制表符 / 分号均可。白化等级不用带（监测站另单评定）。示例：<br />
        <span class="gb-mono">鹿角珊瑚属,枝状,860</span><br />
        <span class="gb-mono">蔷薇珊瑚属;叶状;720</span><br />
        <span class="gb-mono">滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="鹿角珊瑚属,枝状,860" />
      <div v-if="pasteWarnings.length > 0" class="page__notes">
        <el-alert v-for="(warning, index) in pasteWarnings" :key="`w-${index}`" type="info" :title="warning" :closable="false" show-icon />
      </div>
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="`e-${index}`" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}
.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}
.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}
.page__errors,
.page__notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}
.asm-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
:deep(.row-missing-genus) {
  background: #fdf6ec;
}
</style>
