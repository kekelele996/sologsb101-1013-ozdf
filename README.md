# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，外业组逐条记录底质（属名初判与覆盖长度），监测站另开白化评定单（白化等级与分级规程版本），两边按「站位编号 + 属名」对账；并记录鱼类计数、按现行分级规程汇总当年礁区情况。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、CoralRecord、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人），回显已录记录数、覆盖率与白化指数，朝向排序校验 |
| `/belts/:id/corals` | 外业底质记录（外业组） | SubstrateRecord、Belt、BleachAssessment | 按属名与形态逐条录入覆盖长度（白化等级不在此录），回显对应评定单状态、外业侧认领挂起单、缺属名补录、批量粘贴 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量，按类别筛选与批量改类别，按科名和体长段汇总并折算密度（尾/100 m²） |
| `/assessments` | 白化评定单（监测站） | BleachAssessment、SubstrateRecord、Site、Belt | 监测站录白化等级与分级规程版本，按站位编号 + 属名对账；挂起单两边各认一遍、监测站重试（只动评定单）；旧版规程留档；缺属名底质逐条列出 |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 现行规程当年白化分布与按样带/按礁区汇总、旧版规程留档单列（两版不混算）、结构版本查看、全量 JSON 导入导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    ├── src/
    │   ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
    │   ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
    │   ├── env.d.ts
    │   ├── types/              # reef / site / belt / substrate（外业底质）/ assessment（监测站评定单）/ fishCount / filter
    │   ├── stores/             # reefStore / beltStore / surveyStore（含自动对账、认领、重试）
    │   ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
    │   ├── hooks/              # useIdbTable / useCoverage
    │   ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry（外业底质）/ AssessmentReview（监测站评定单）/ FishEntry / CoverageView
    │   ├── router/index.ts     # 路由表（路径与提示词逐字一致）
    │   ├── styles/main.css
    │   └── utils/              # bleach.ts（白化与覆盖度算法）/ db.ts（Dexie 封装 v3）/ export.ts（导入导出与结论）/ reconcile.ts（站位编号+属名对账）/ migration.ts（旧记录按属名拆两份）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（v3）**：`reefs`（礁区）、`sites`（站位）、`belts`（样带）、`substrates`（外业底质：属名初判 + 覆盖长度）、`assessments`（监测站评定单：白化等级 + 分级规程版本）、`fishes`（鱼类与无脊椎动物计数）。
- **两份记录的职责边界**：外业补录 / 覆盖只写 `substrates`，监测站改属名、改白化等级只写 `assessments`，互不覆盖。两边以「站位编号 + 属名」对账：唯一命中即 `matched`；对不上 `suspended` 挂起并记原因（站位缺失 / 属名对不上 / 缺属名 / 一对多歧义），外业、监测站各认一遍（`fieldAck` / `stationAck`）后，由监测站「重试对账」——重试只重算监测站自己的评定单，船上底质一条不动。
- **分级规程版本**：旧版 `GB-OLD-2010` 与现行 `GB-CURRENT-2024`，换版日 `2025-01-01`。换版日之前的评定单按当时版本 `archived` 永久留档（`/coverage` 底部单独列示）；仅现行规程、已对上的评定单计入当年礁区情况，两版不混算。评定日期早于换版日时强制旧版、不允许改级。
- **升级迁移（v2/v1 → v3）**：`db.version(3)` 新增 `substrates` / `assessments` 两表并删除旧 `corals` 表；`.upgrade()` 调 `utils/migration.ts` 按属名把旧珊瑚记录拆两份——覆盖长度进底质、白化等级进评定单。旧数据没有规程版本字段，评定单统一按旧规程挂着留档（`protocolKnown=false`）；缺属名的只拆出底质并逐条进缺属名清单（不生成评定单）。
- **旧备份导入**：`/coverage` 导入 v1/v2 备份（带 `corals` 数组）时走与升级同一套 `splitLegacyCorals` 拆分；查不到规程版本的老评定按旧规程挂着，缺属名逐条列出。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 个礁区 / 4 个站位 / 6 条样带 / 16 条外业底质 / 17 张评定单 / 12 条计数记录），覆盖「已对上 / 挂起待认（属名对不上、站位缺失）/ 旧版留档 / 缺属名」全部对账情形与「无 / 轻 / 中 / 重 / 死亡」全部白化等级。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新；底质 / 评定单 / 站位 / 样带任一变化都会触发一轮合并的自动对账。
- **算法口径**：珊瑚覆盖率 = 外业底质覆盖长度合计 / 样带长度 × 100%；当年白化指数 = 现行规程已对上评定单按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4）；挂起与旧版留档不参与；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²）。
- **备份与恢复**：`/coverage` 页可导出含六张表的 JSON 快照（v3），支持「覆盖导入」与「追加导入（重新分配 id，评定单随底质重映射）」；v1/v2 旧备份导入时自动按属名拆两份。备份时间写入 `localStorage`，页脚与汇总页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
