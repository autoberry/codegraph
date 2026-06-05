# CodeGraph 原生支持 QoderCLI — Installer Target 设计

- 状态：Draft
- 日期：2026-06-06
- 关联需求：`design/workitem/cg_ref_v1_20260606.md` — `{REQ}` 为 CodeGraph 增加对 QoderCLI 的支持
- 范围：`codegraph install` CLI / installer 子系统

## 背景

CodeGraph 当前通过可插拔的 `AgentTarget` 抽象（`src/installer/targets/`）原生支持 8 种编程 Agent（Claude Code、Cursor、Codex CLI、opencode、Hermes、Gemini、Antigravity、Kiro）。运行时 MCP server 已与 Agent 解耦；只需新增一个 target 实现，`codegraph install` 即能探测、写入、卸载对应 Agent 的 MCP 配置。

QoderCLI 是 Alibaba 出品的 CLI 编程 Agent，类似 Claude Code / Codex CLI。当前 CodeGraph 不支持它 — 用户需手动复制 MCP server 片段到配置文件。本需求要求 `codegraph install` 像对 Claude / Codex 那样原生支持 QoderCLI：探测安装、写入 MCP 配置、安装完成后用户在 QoderCLI 中可见 codegraph 工具并触发调用。

## 目标 / 非目标

**目标**
- 用户运行 `codegraph install`，QoderCLI 已装时自动出现在 multiselect 并默认勾选
- 用户运行 `codegraph install --target=qoder`（或 `--target=auto`、`--target=all`）能正确写入 QoderCLI MCP 配置
- 安装完成后用户在 QoderCLI 内 `/mcp reload`，可见 codegraph MCP server 与其工具
- 支持 global（用户级）和 local（项目级）两种安装位置
- 完全幂等、可逆（uninstall 反向）

**非目标**
- 不写 `~/.qoder/AGENTS.md` 等 instructions 文件 — 现行做法（issue #529）依赖 MCP server 的 `initialize` instructions，QoderCLI 同样会走该通道
- 不实现 QoderCLI 端的 permissions allowlist（即使 QoderCLI 后续支持类似机制，本期不实现，留作后续工单）
- 不实现 `<repo>/.qoder/settings.local.json`（本地、gitignore）这一第三种作用域 — 两档 Location 抽象只映射 user 与 project shared

## 关键事实

QoderCLI MCP 配置文件（已查证）：

| Scope | 文件 | mcpServers 位置 |
|---|---|---|
| user | `~/.qoder/settings.json` | top-level `mcpServers` |
| project shared | `<repo>/.qoder/settings.json` | top-level `mcpServers` |
| project local | `<repo>/.qoder/settings.local.json` | top-level `mcpServers` |

JSON 格式，不是 TOML。`settings.json` 同时承载用户偏好等其它配置 — 必须 surgical 编辑，不可 wholesale 覆盖。

## 关键决策

- **Location 映射**：`global` → `~/.qoder/settings.json`（user 作用域）；`local` → `<cwd>/.qoder/settings.json`（project shared，可被团队 commit）。与 Claude target 的 local→`./.mcp.json` 思路一致。不使用 `settings.local.json`。
- **detect 安装判定**：`fs.existsSync(configDir(loc))`，与 Codex / Claude 的目录探测策略一致，不依赖 PATH。
- **写入内容**：仅 `mcpServers.codegraph`。不写指令文件、不写 permissions。
- **registry 注册**：加入 `ALL_TARGETS` 末尾，受 `auto` / `all` / 交互式 multiselect 自然覆盖。
- **TargetId**：扩展 `'qoder'`。

## 架构

复用现有 `AgentTarget` 抽象，零新增基础设施：

```
src/installer/targets/
├── qoder.ts          ← 新增：实现 AgentTarget
├── registry.ts       ← 修改：ALL_TARGETS 末尾追加 qoderTarget
├── types.ts          ← 修改：TargetId 联合扩 'qoder'
└── shared.ts         ← 复用：readJsonFile / writeJsonFile / jsonDeepEqual / getMcpServerConfig
```

`src/installer/index.ts`（orchestrator）、`src/bin/codegraph.ts`（CLI 入口）无需改动 — 它们都通过 `ALL_TARGETS` / `getTarget(id)` / `resolveTargetFlag(value, loc)` 间接消费 registry。

## `qoder.ts` 实现要点

**路径辅助**
```ts
function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.qoder')
    : path.join(process.cwd(), '.qoder');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
```

**接口实现**

| 方法 | 行为 |
|---|---|
| `id` | `'qoder'` |
| `displayName` | `'Qoder CLI'` |
| `docsUrl` | `'https://docs.qoder.com/'` |
| `supportsLocation(loc)` | 始终 `true`（global / local 均支持） |
| `detect(loc)` | `installed = fs.existsSync(configDir(loc))`；`alreadyConfigured = !!readJsonFile(settingsJsonPath(loc)).mcpServers?.codegraph`；`configPath = settingsJsonPath(loc)` |
| `install(loc, opts)` | 调用本地 `writeMcpEntry(loc)`：读 → deep-equal 命中 `unchanged` / 写入 `created` 或 `updated`；`opts.autoAllow` 忽略 |
| `uninstall(loc)` | 删 `mcpServers.codegraph`；若 `mcpServers` 空则一并删；不删整文件（保留用户其它配置） |
| `printConfig(loc)` | 返回 `# Add to <path>\n\n{ "mcpServers": { "codegraph": ... } }` |
| `describePaths(loc)` | `[settingsJsonPath(loc)]` |

**写入策略（与 Claude target 同型）**
1. `readJsonFile(settingsJsonPath(loc))` 取现有 JSON（不存在 → `{}`）
2. 若 `existing.mcpServers?.codegraph` 与 `getMcpServerConfig()` 经 `jsonDeepEqual` 相等 → `{ action: 'unchanged' }`
3. 否则置入 / 更新 `existing.mcpServers.codegraph`，目录不在则 `mkdirSync(..., { recursive: true })`，`writeJsonFile` 落盘
4. action：`before` 存在 → `updated`；`!fs.existsSync(file)` → `created`；否则 → `updated`

## 边界情况

- 目录不存在：`mkdirSync(configDir(loc), { recursive: true })` 后再写
- settings.json 不存在：从空 `{}` 起步，写出后 action=`created`
- settings.json 存在但 JSON 损坏：`readJsonFile` 抛错（与其它 target 一致行为）
- 已有兄弟 MCP server（如 `mcpServers.filesystem`）：仅改 `codegraph` 子键，其它键完整保留
- `mcpServers` 键不存在：先建空对象再插入，action=`updated`
- 重复安装：deep-equal 命中 → 字节级 unchanged
- local 在非 git 仓库：照写 `<cwd>/.qoder/settings.json`，与 Claude target 一致行为
- 跨平台：全部 `path.join + os.homedir()`

## 测试

**自动获益**：`__tests__/installer-targets.test.ts` 已对 `ALL_TARGETS` 跑契约（install / 幂等 / 兄弟保留 / uninstall / printConfig），qoderTarget 注册即被覆盖。

**针对性用例**（追加到 `installer-targets.test.ts`，不新建文件）：
1. global 写 `~/.qoder/settings.json`，local 写 `<cwd>/.qoder/settings.json`
2. install 不创建 `<cwd>/.qoder/settings.local.json`
3. install 不创建 `~/.qoder/AGENTS.md` 或任何指令文件、不写 permissions
4. `detect()` 在 `~/.qoder` / `<cwd>/.qoder` 不存在时 `installed === false`
5. `resolveTargetFlag('qoder', loc)` 返回单元素 `[qoderTarget]`
6. settings.json 已含 `mcpServers.filesystem` 时，install 后 `filesystem` 完整保留
7. 已有 `mcpServers.codegraph` 与目标一致时，install 返回 `unchanged` 且文件字节不变

**手动验证**
1. `npm run build && npm test`
2. `node dist/bin/codegraph.js install --target=qoder --location=global --yes`
3. 启动 QoderCLI，`/mcp reload`，`/mcp` 可见 `codegraph` server connected
4. 在 QoderCLI 内触发一次 codegraph 工具调用（如 `codegraph_search`）确认链路通畅

## CLI / 文档配套修改

- `README.md`：agents 支持列表加入 "Qoder CLI"
- `CHANGELOG.md`：新增条目 `feat(installer): native Qoder CLI target`
- `--help` / `--print-config` 输出自动包含 `qoder`（无需改 CLI 代码 — 由 `listTargetIds()` 派生）

## 风险

- QoderCLI 未来若变更 `~/.qoder/settings.json` schema（如重命名 `mcpServers`），需要同步更新该 target — 与所有 target 的固有风险等价
- 用户已手工编辑过 `mcpServers.codegraph`（如自定义 env）时，install 会被 deep-equal 检测出差异并覆盖。与 Claude target 行为一致；可接受

## 验收标准

- [ ] `codegraph install --target=qoder --location=global --yes` 在 `~/.qoder/settings.json` 注入 `mcpServers.codegraph`，不污染其它键
- [ ] 同命令在已配置情况下重跑，文件字节不变（`unchanged`）
- [ ] `codegraph install --target=qoder --location=local --yes` 写入 `<cwd>/.qoder/settings.json`
- [ ] `codegraph install --target=qoder --uninstall` 反向移除，仅删 `codegraph` 键
- [ ] QoderCLI `/mcp` 列出 codegraph，`/mcp reload` 后工具可调用
- [ ] `npm test` 全绿
