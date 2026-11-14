# Covan 文档导航

这里是 Covan 的唯一文档入口。项目采用 **Spec-driven AI development**：先明确行为契约，再修改实现和测试。

产品介绍、三张真实应用演示截图与快速上手见[项目 README](../README.md)；运行 `npm run screenshots:readme` 可使用隔离临时 profile 和本地 Mock 服务重新生成截图。

## 文档分工

| 文档 | 回答的问题 | 权威性 |
| --- | --- | --- |
| [PRD](PRD.md) | 为什么做、为谁做、用户验收标准是什么 | 产品范围 |
| [SPEC](SPEC.md) | 当前已实现的行为、数据、IPC 与边界条件 | **实现的单一事实来源** |
| [ARCHITECTURE](ARCHITECTURE.md) | 模块如何协作、为何这样设计；标注待实施的章节为设计提案 | 技术决策 |
| [DESIGN](DESIGN.md) | 信息架构、交互和视觉准则 | 体验决策 |
| [ROADMAP](ROADMAP.md) | 下一步候选项、优先级与未完成工作 | 计划，不代表已实现 |
| [BUGFIXES](BUGFIXES.md) | 关键故障的症状、根因、修复与回归测试 | 维护记录 |
| [Cindy 近期能力借鉴报告](CINDY_REFERENCE_2026-09-20.md) | Cindy 近期合入能力与 Covan 的差距、取舍和建议顺序 | 调研结论，不定义实现契约 |
| [OpenMausBot 借鉴报告](OPENMAUSBOT_REFERENCE_2026-10-17.md) | 同类产品在审批、密钥、工具可见性与模型选择上的做法与迁移建议 | 调研结论，不定义实现契约 |
| [CHANGELOG](../CHANGELOG.md) | 用户在每个版本能感知到的变化 | 发布记录 |

`archive/` 仅保存历史交付快照，不作为开发依据。

操作浏览器（2026-10-30 更新）：Bot 资料可选择内置 Chromium 或本地 Chrome/Edge；聊天画面卡 → 右侧投流面板支持直接接管，独立工作台仍可打开；API Bot 默认自动执行网页交互、上传/下载；登录或验证码以聊天/工作台接管卡暂停，完成后自动续跑；每步确认仍可选。当前边界见 [SPEC](SPEC.md#可操作浏览器2026-10-29)，设计见 [Architecture](ARCHITECTURE.md#8-可扩展工具层workspacets--tools--agentruntimets)，回归命令 `npm run test:browser`。

2026-11-02：Goals 支持任务状态机与异步专家派单：满额排队、等待释放名额、暂停后沿检查点继续、专家报告到齐自动唤醒主责，交付由用户验收。本地后台执行不锁聊天，同会话可运行两项目标；任务卡可明确补充要求，主责可咨询用户配置的协作 Bot，专家报告与文件回写目标。执行、取消和文件目录独立，重启暂停已开始任务，保留检查点和未处理输入，由用户继续。当前契约见 [Goals](SPEC.md#54b-goals本机共享目标g1-第一批)，回归命令 `npm run test:goal-tasks`。 引用后台任务回复可在普通输入框继续原任务，带来源／送达回执，并优先处理已有任务的新要求；同 profile 重复启动只唤起原窗口。本地原型代码借鉴见 [任务续接](ARCHITECTURE.md#1312-本地-super-agent-原型代码借鉴与任务续接2026-11-02)。文章思路、实现程度与简图见 [Super-agent 借鉴对照](ARCHITECTURE.md#1311-super-agent-文章借鉴范围与示意)。

2026-10-29：Goals 可选择主责并「执行下一步」，自动记录本轮结果、关联真实交付文件；聊天已支持带页码/行号的 PDF、UTF-8 文本与代码附件。契约见 [Goals](SPEC.md#54b-goals本机共享目标g1-第一批)、[聊天文档附件](SPEC.md#聊天文档附件2026-10-29)，回归命令 `npm run test:productivity`。

Goals 专题（**G1 第一批已实现**，2026-10-27）：[产品需求与验收](PRD.md#513-goals对话内目标管理与-agent-协作g1-第一批已实现2026-10-27) · [当前契约](SPEC.md#54b-goals本机共享目标g1-第一批) · [技术设计](ARCHITECTURE.md#13-goals-技术设计g1-第一批已实现2026-10-27) · [卡片交互](DESIGN.md#7-goals-对话卡片g1-第一批已实现) · [交付计划](ROADMAP.md#goals第二批共享协作与交互完善)。SQLite 共享存储、受控工具、四种消息内卡片和本地刷新已可用；卡片审批令牌、分页失效和固定位置仍在 Roadmap。

Agent 主页（**已实现**，2026-10-27）：[产品与验收](PRD.md#514-agent-个人主页已实现2026-10-27) · [当前契约](SPEC.md#54c-agent-个人主页持久化-openui-布局) · [技术设计](ARCHITECTURE.md#14-agent-主页技术设计已实现2026-10-27) · [交互设计](DESIGN.md#8-agent-个人主页已实现)。每个 Bot 保存一份本机校验过的 OpenUI 主页；主页可嵌入真实 GoalsBoard，但不复制目标数据或绕过受控写入。

## 冲突处理

1. 当文档冲突时，已实现行为以 `SPEC.md` 和可执行测试为准。
2. PRD 说明产品意图，不复制数据库字段或 TypeScript 签名。
3. Architecture 说明技术决策，不再定义一套与 SPEC 平行的接口。
4. Roadmap 中的内容都是未完成项；完成后应移出，并同步 SPEC 与 CHANGELOG。
5. 待实施设计必须明确标注状态并链接 Roadmap；不把提案写成当前 SPEC 或已发布 Changelog。开始实现时将生效契约迁入 SPEC，并在原提案处保留技术理由与引用。
6. 如代码与 SPEC 不一致，不新建“临时说明”。在同一变更中修正代码或 SPEC。

## 变更路由

| 变更类型 | 必须更新 |
| --- | --- |
| 新用户能力 | PRD 验收标准、SPEC、相关测试、CHANGELOG |
| 数据库 / IPC / Agent 协议 | SPEC、契约类型、migration/回归测试；必要时更新 Architecture |
| 视觉或交互原则 | DESIGN、UI 回归测试、CHANGELOG |
| Bugfix | 回归测试、BUGFIXES；用户可感知时更新 CHANGELOG |
| 仅重构 | Architecture（若边界变化）和测试；不虚构产品变化 |

AI 贡献者的必须流程见根目录 [AGENTS.md](../AGENTS.md)。
