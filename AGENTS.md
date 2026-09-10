<!-- bmad:context -->
<!-- Verified 2026-09-10 against 4115c31. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Vivido

Vivido 是离线优先的 Expo / React Native 日记应用。业务数据位于本地 SQLite，媒体文件位于应用沙箱；`src/` 是实现事实来源。`_bmad-output/` 中的历史规划只用于理解约束，不能覆盖当前源代码或已批准的现行规格。

## Policy

- 保持离线优先：不得引入后端、云同步、网络数据层或 AI 功能。
- 不得引入全局状态库。新增第三方依赖须有任务级明确决策；已批准的 Block Editor TextBlock POC 仅可引入其验证通过的原生输入依赖。
- 当前源代码与历史规划或 `CLAUDE.md` 冲突时，以当前源代码为准，除非任务明确更新合同。
- `content TEXT` 是日记正文唯一持久化源；不得引入 HTML 或 JSON Document 持久化。

## Where things are

- 应用启动和导航：`App.tsx`；路由类型：`src/types/index.ts`。
- 业务 SQLite、schema、草稿和发现页：`src/services/database.ts`；媒体存储：`src/services/storage.ts`；备份：`src/services/backup.ts`。
- 页面：`src/screens/`；共享 UI：`src/components/`；跨页面 hook：`src/hooks/`；主题 token：`src/theme/index.ts`。
- Block Editor 工作：编辑 `src/editor/` 或编辑器/媒体路径前，先阅读 `aidocs/Vivido_轻量Block_Editor_V1_需求与技术规格.md` 及其实施方案。

## Running and verifying

- 使用 `npm install` 安装项目依赖；Vivido 工作不得要求 Python 或 `uv`。
- 修改 TypeScript 后运行 `npx tsc --noEmit`。
- 使用 `npm start` 启动 development client。
- Android 原生或 Dev Client 工作使用 `npx expo run:android` 或文档中的 Expo/Gradle 流程。新增原生依赖后必须重建 development client。
- 缺少 BMAD 辅助工具或 `uv` 不得阻断 TypeScript/React Native 开发；改用仓库的 Node/Expo 工具链。

## Conventions that differ from defaults

- 业务读写只经由 `src/services/database.ts`；新 DB service 先守卫 `db`，跨表写入使用 `withTransactionAsync`，列名使用 camelCase，业务时间戳使用毫秒 `number`。
- UI 偏好通过 `usePreference` 保存在 `expo-sqlite/kv-store`；不得写入业务数据库或备份。
- 媒体在创建稳定记录前必须先经 `storage.saveMedia()` 落盘。Block Editor 的 staged 文件只在日记/草稿持久化提交成功后成为稳定引用；删除 Block 先删除文档引用。物理清理只能在提交后再次确认不存在有效 diary 或 draft 引用时 best-effort 执行；不得在 autosave、取消编辑或写入失败时清理。
- `MediaItem.type` 保持 `'image' | 'video' | 'audio'`；保留 `position` 以兼容 legacy。未被新 markup 引用的旧附件不能仅因此判定为 orphan。
- 保持 `expo-file-system/legacy` 导入；新增或修改 UI 使用 theme token。
- 业务数据通过现有 `useFocusEffect`/service 路径重读；SQLite 仍是业务状态真源。
- 发现页词云始终使用最近 30 天，忽略日期、月份和时间范围筛选，但保留搜索词和标签筛选。
- 编辑器允许标题、正文或媒体列表任一为空，但三者不能同时为空；保留草稿自动保存，且只在最终保存成功后清除草稿。

## Known pitfalls

- 不得将 effect 中管理的 `AudioModule.AudioRecorder` 改回 `useAudioRecorder`；它用于规避 Android shared-object release 崩溃。保留录音权限和 `setAudioModeAsync({ allowsRecording: true })`。
- 备份格式为 v3，但导入必须继续接受 v1/v2。
- Block Editor 不得自行实现 IME、caret、selection、完整 Markdown parser 或跨 Block 格式化。TextBlock provider 必须通过 Android 中文 IME、selection command、highlight、active mark、undo/redo、性能及 SDK 55/RN 0.83 Dev Client 兼容性 Gate。
<!-- /bmad:context -->
