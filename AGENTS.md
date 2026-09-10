<!-- bmad:context -->
<!-- Verified 2026-09-10 against 4115c31. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Vivido

Vivido 是以 Expo、React Native 和严格 TypeScript 构建的离线优先日记应用。业务数据保存在本地 SQLite，媒体文件保存在应用沙盒；`App.tsx` 在字体与数据库初始化完成后才挂载导航。当前 `src/` 是实现事实来源；`_bmad-output/` 中的 architecture、epics 和 spec 仅用于理解历史设计与约束。

## Policy

- 保持离线优先：除现有 GitHub 链接外，不要引入后端、云同步或网络数据层。
- 不要引入 AI 功能、全局状态库或新的第三方依赖；在既有 Expo SDK 与本地能力中实现需求。
- 当历史规划或 `CLAUDE.md` 与 `src/` 冲突时，以当前源码为准；不要为同步实现而改写历史 BMad 产物，除非任务明确要求。

## Where things are

- 应用启动、字体加载和根导航：`App.tsx`；路由类型：`src/types/index.ts`。
- 业务 SQLite、schema 迁移、草稿与发现页查询：`src/services/database.ts`；媒体落盘/清理：`src/services/storage.ts`；备份导入导出：`src/services/backup.ts`。
- 屏幕放在 `src/screens/`，可复用 UI 在 `src/components/`，跨屏逻辑在 `src/hooks/`；主题 token 在 `src/theme/index.ts`。
- 下一阶段的历史决策与验收背景：`_bmad-output/architecture.md`、`_bmad-output/epics.md`、`_bmad-output/specs/spec-vivido-next/SPEC.md`。

## Running and verifying

- 修改 TypeScript 后运行 `npx tsc --noEmit`；当前未配置 lint 或自动化测试脚本。
- 修改原生 Expo 配置（如 `app.json`）后，先运行 `npx expo prebuild --platform android`，再进行本地 Android 构建。

## Conventions that differ from defaults

- 日记业务读写只经由 `src/services/database.ts`；新增数据库服务函数先检查 `db`，跨表写入使用 `withTransactionAsync`。
- 数据库列使用 camelCase，业务时间戳使用毫秒 `number`；修改 schema 时同步维护 `SCHEMA_VERSION` 与迁移/兼容路径。
- UI 偏好使用 `expo-sqlite/kv-store` 和 `usePreference`，键名采用 `pref.<domain>.<item>`；不要写入业务数据库或备份。
- 新增或修改媒体时，经 `storage.saveMedia()` 复制到 `documentDirectory/media/` 后再入库；删除日记或已移除媒体时同时清理对应文件。媒体类型保持 `'image' | 'video' | 'audio'`，展示顺序使用 `position`。
- 保持现有 `expo-file-system/legacy` 导入路径；不要混用新版文件系统 API。
- 新增或修改 UI 应优先使用 `src/theme/index.ts` 的颜色和字体 token，维持现有暖色视觉系统。
- 页面获得焦点后通过既有 `useFocusEffect`/服务层重新读取数据；SQLite 是业务状态事实来源。
- 发现页词云始终基于最近 30 天数据，忽略日期、月份和时间范围筛选，但保留搜索词与标签筛选；分词规则留在 `src/utils/wordcloud.ts`。
- 编辑器允许标题、正文或媒体任一项为空，但三者不能同时为空；保留草稿自动保存和保存成功后清除草稿的流程。

## Known pitfalls

- 录音组件不要改回 `useAudioRecorder`：当前手动在 effect 中创建和释放 `AudioModule.AudioRecorder`，以避免 Android 的 shared-object release 崩溃。
- 新增录音行为前保留录音权限检查及 `setAudioModeAsync({ allowsRecording: true })`；iOS 麦克风文案和 Android 权限位于 `app.json`。
- 备份格式当前为 v3，但导入必须继续接受 v1/v2；不要把支持版本校验简化为只接受当前版本。

<!-- /bmad:context -->
