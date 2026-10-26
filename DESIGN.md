# Workspace Manager v0.6.0 设计 — 工作区切换中心

> 基底:lan.wpmanager v0.5.0 演进 · 定位:工作区切换中心 · 形态:侧边栏 TreeView + 命令
> 本期聚焦:**.code-workspace 文件的管理与一键切换**

> ## ⚠ 二次修订(用户拍板,以此为准)
>
> 推翻首版「自动扫描 scanDirs + 收藏/最近/全部 + checkbox 收藏」模型,改为**手动添加制**:
>
> - **无任何自动搜索/自动收录**;树结构 = 每个用户添加的「多项目文件夹」一个分组(按添加顺序)+ 内置「未归类」分组(收手动添加的单个 .code-workspace),组内按名称排序
> - **registry v2**:`{version:2, roots:[{id,addedAt}], entries:[{id, root:''|根路径, alias, addedAt, lastOpenedAt, openCount}]}`;v1 自动迁移(workspace 条目进未归类,folder 条目丢弃)
> - **分组内容镜像磁盘**:激活时全量扫一次并建立 `fs.watch`(recursive)监听各分组根;之后磁盘变化 → 防抖 1.5s → 只重扫受影响的根,平时零扫描,视图展开也不再全量重扫;监听建立失败的根(网络盘/权限)在视图可见时兑底重扫;扫描不抢其他分组的条目;未归类条目不清理(文件消失仅标 ⚠ 失效)
> - **新增 3 个贡献命令**(添加/移除必须有入口):`addWorkspaceFile`(标题栏+面板,选 .code-workspace 归未归类)、`addProjectFolder`(标题栏+面板,建分组并扫描子文件夹)、`removeWorkspaceEntry`(右键 view/item/context,条目单删/分组根级联删,不碰磁盘文件);`_openEntry` 仍不贡献
> - **配置**:删除 `scanDirs`/`recentCount`;保留 `scanMaxDepth`(1-8,默认 3)与 `scanExcludeNames`(作用于分组根扫描)
> - 收藏/最近/全部、checkbox 全部移除;单击切换、失效 ⚠ 标记、当前条目 `folder-active` 高亮保留
> - 下文 §4(配置)、§5(视图)、§6(命令)、§8(交互)、§12(阶段)中与本节冲突的描述,以本节为准;§9 新增坑:TreeView 行内按钮 `onDidTriggerItemButton` 是 proposed API,稳定面不存在(真机 1.100/1.143 实测),QuickPickItem.buttons 才是稳定 API
>
> 背景:首版 P1 真机激活报错(`treeView.onDidTriggerItemButton is not a function`)后先改 checkbox 方案,随后用户重定义模型为手动分组制,一并落地。
>
> - **历次微调(用户拍板,当前实现以此为准)**:①单击条目**不再直接切换**——条目变为 Expanded 父节点,**操作行作为其子级渲染,真实缩进分层**(再点收起,换选迁移;选中态 id 带选择序号 `::sel<N>`,避开 VSCode 按 id 持久化折叠状态;树条目行内按钮是 proposed API 不可用,操作行是替代呈现);**操作行顺序(用户指定)**:①切换到该工作区(本窗,arrow-swap)②打开工作区(新窗口,folder-opened)③置顶(pinned)④添加备用名(edit)⑤忽略(eye-closed);被忽略条目=切换/打开/取消忽略;②每个分组(含未归类)可有「**已忽略工作区**」子节点(eye-closed,默认收起),忽略 = 收进该节点并**同时清置顶**;③**置顶 = 组内置顶**(排序最前 + pinned 图标);④registry **v3**(+`ignored`/`pinned`/`alias` 字段,v2 自动迁移);⑤**不再代为安装扩展**——用户自行 F5 调试(已加 `.vscode/launch.json`,extensionHost);⑥图标组:条目=window、置顶=pinned、分组根=folder-library、未归类=archive(TreeItem.label 不支持 $(codicon) 内联,图标一律 iconPath);⑦**launch.json 已隔离调试宿主 user-data-dir**(--user-data-dir=${env:APPDATA}\\wpmanager-dev-host + --disable-extensions)——共用会致 exthost 134 成对崩溃=用户所见“闪退”(launch.json 本身曾因编辑吃掉数组收尾而 F5 即闪退,改 JSON 后必须 JSONC 校验);⑧**备用名文件化(用户拍板)**:显示名优先读 .code-workspace 内 `vscext_wpmanager.wpnickname`(JSON.parse,容错注释/坏文件→回退注册表 alias→回退文件名);添加备用名 = 读文件→改该字段→整个 JSON 重序列化写回(tab 缩进),注册表 alias 同步一份作兜底;**非标准 JSON 拒写并报错,绝不改写带注释的文件**;读取带 mtime+size 缓存,自写后主动失效(mtime 粒度不可靠);⑨**已忽略节点默认隐藏(用户拍板,解决“一直置顶有点烦”)**:右键分组根/未归类 →「显示已忽略项目」,**开启态同一菜单项以 ✓ 前缀呈现(hideIgnoredWorkspaces 标题=“✓ 显示已忽略项目”,点击即取消勾;用户指定不要换成“隐藏已忽略项目”文案)**,两条命令 showIgnoredWorkspaces/hideIgnoredWorkspaces 菜单文案按 contextValue 的 ign-shown/ign-hidden 标记路由,commandPalette when:false 屏蔽,状态持久化在 roots[].showIgnored 与 registry.ungroupedShowIgnored,隐藏时节点与子项都不渲染(注册表数据不动)

---

## 1. 目标与定位

把 wpmanager 从「四个散装命令」升级为**工作区切换中心**:

- 核心闭环:看到所有工作区 → 一键切换(同窗口 / 新窗口)→ 打开过的自然浮上来
- `.code-workspace` 文件是一等公民:P1 自动扫描发现,手动添加入口 P2;收藏置顶、失效标记本期就有
- 已有 4 命令(generate / newproject / copycurrentpath / editimginPS)原样保留,新增能力全部挂进同一棵树

**不做的**(明确出界):项目模板、目录占用统计、清理向导、Webview 面板、多机同步。

## 2. 现状与演进关系

| 已有 | 处理 |
|---|---|
| `wpmanager.generate` | 保留;生成后顺手询问「是否加入切换列表」(P2) |
| `wpmanager.newproject` | 保留不动;Step2 建目录后已自动生成 workspace 文件 |
| `wpmanager.copycurrentpath` / `editimginPS` | 不动 |
| `globalState['wpmanager.projectDirHistory']` | 不动(属于 newproject 域) |
| `DIR_HISTORY_MAX`/按钮/弹窗等模式 | **新代码直接复用既有约定**(见 §8) |

新增域独立存储键,与 newproject 历史互不干扰。

## 3. 数据模型与存储

存储:`globalState['wpmanager.workspaceRegistry']`(与现有历史同一机制,同一扩展 ID 升级无损;导出/导入放 P3)。

```js
// 注册表条目
{
  id: 'd:\\code\\fe\\fe.code-workspace',  // 规范化绝对路径,天然唯一(去重键)
  type: 'workspace',                       // 'workspace'(.code-workspace 文件) | 'folder'(普通文件夹)
  alias: '',                               // 用户自定义显示名,空则用文件名/目录名
  tags: [],                                // P2 启用
  pinned: false,                           // 收藏置顶
  addedAt: 1700000000000,
  lastOpenedAt: 0,                         // 0 = 从未打开;切换前先写入(见 §9-1)
  openCount: 0
}
// 结构:{ version: 1, entries: [...] }   // version 预留迁移
```

**路径去重(Windows 坑)**:`id` 一律 `path.normalize(fsPath)`;比较键取 `win32 ? id.toLowerCase() : id`。现有 `recordDirHistory` 用原样字符串比较,存在大小写重复的隐患——新代码不复刻这个问题(旧历史不回改)。

**排序规则(树的「全部」组)**:置顶优先 → `lastOpenedAt` 降序 → `addedAt` 降序。「最近」组取 `lastOpenedAt > 0` 前 `recentCount` 条。

## 4. 配置项(package.json contributes.configuration)

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `wpmanager.scanDirs` | `string[]` | `[]` | 扫描 `*.code-workspace` 的根目录(空=不扫描,全靠手动添加) |
| `wpmanager.scanMaxDepth` | `number` | `3` | 递归深度 1~8 |
| `wpmanager.scanExcludeNames` | `string[]` | `["node_modules",".git",".venv","dist"]` | 按目录名排除(纯 JS 约束,不上 glob) |
| `wpmanager.recentCount` | `number` | `5` | 「最近」组展示条数 |

不设 `confirmBeforeSwitch`——切换本身就是明确意图,加确认反而烦。

## 5. 视图设计(TreeView)

活动栏新增容器 `wpmanager`(单色 SVG 24×24,自绘「层叠窗口」图标),视图 `wpmanager.workspaces`,标题「工作区」。

```
┌ Workspace Manager ─────────────────────┐
│  (P2:标题栏 ↻ ➕ 📄 🔍)                │  ← view/title
├────────────────────────────────────────┤
│ ▾ ★ 收藏 (2)                           │  ← 固定分组,collapsible
│     ★ 前端工作台          D:\code\fe   │  ← label=alias|文件名  description=父目录
│     ★ mcu                D:\work\mcu   │
│ ▾ 最近                                  │
│     games.code-workspace  D:\code      │
│     playground            D:\tmp       │
│ ▸ 全部 (7)                              │  ← 默认收起,P1 内改默认展开
│     utils.code-workspace  D:\code      │
│     ⚠ old.code-workspace  (已失效)      │  ← 失效标记:stat 失败
└────────────────────────────────────────┘
```

- **当前工作区不单独成组**:当前条目 icon 用 `folder-active` 并在 tooltip 标注「当前」。来源:`vscode.workspace.workspaceFile`(workspace 模式)/ `workspaceFolders[0]`(文件夹模式)。P1 激活时**自动收录**:未入库则落一条(文件夹模式→type:folder),已存在则跳过。
- 同一条目可同时出现在「收藏」「最近」「全部」;TreeItem `id = "${entry.id}::${section}"` 保证不冲突。
- TreeItem 属性:
  - label:`$(star-full) ` 前缀仅收藏行;icon:workspace 文件→`json`,文件夹→`folder`,当前→`folder-active`,失效→`circle-slash`
  - description:父目录;tooltip:Markdown(完整路径 / 标签 / 打开次数 / 上次打开时间)
  - `contextValue`:`entry` / `entry,stale` / `entry,pinned`(+`current`)(P1 暂无菜单消费,保留给测试与 P2 when 过滤)
- **收藏 = 原生 checkbox**(`TreeItem.checkboxState` + `TreeView.onDidChangeCheckboxState`,稳定 API;注意 TreeItem 行内按钮 `onDidTriggerItemButton` 是 proposed API,稳定面不存在,真机 1.100 实测无此成员)。「新窗口打开」无零命令入口,后置 P2(命令化后走右键菜单/命令)
- **右键菜单(P2)**:打开(本窗口)、打开(新窗口)、置顶/取消、重命名别名、编辑标签、复制路径、在资源管理器中显示、从列表移除、删除工作区文件(模态确认,P3)、重新定位(P3,失效项专属)
- 刷新时机:每次视图可见(`onDidChangeVisibility`)自动重扫 scanDirs + 一轮失效 stat(P1 无手动刷新按钮,毫秒级成本)。**不挂 fs.watch**(过度工程)。

## 6. 命令策略(P1 零贡献)

P1 的 `contributes.commands` 不新增任何条目(命令面板零噪音、零 `menus` 贡献)。内部只注册一个命令,供树节点单击使用:

| 内部命令 | 参数 | 说明 |
|---|---|---|
| `wpmanager._openEntry` | entry, newWindow? | 树节点单击=`item.command` 绑 newWindow=false;newWindow=true 参数预留给 P2 右键菜单/命令复用 |

约定:`_` 前缀命令**永不贡献**(若隐式激活不生效需补 `onView:wpmanager.workspaces`,见 §9-2)。

**P2 命令化**时贡献面板命令(全部挂 `category: %command.category%`):`openWorkspace`(无参调用→QuickPick 选条目)、`addCurrentWorkspace`、`addWorkspaceFile`、`scanWorkspaces`、`refreshWorkspaces`、`togglePinWorkspace`、`renameWorkspaceEntry`、`removeWorkspaceEntry`;`editWorkspaceTags`/`copyWorkspacePath`/`revealWorkspaceInOS` P2~P3;`deleteWorkspaceFile`/`relocateWorkspaceEntry` P3。

视图点击行为:单击节点 = 本窗口打开(`item.command`)。失效节点单击 → 提示不可打开(引导修正 scanDirs 或等 P2 的重新定位)。

## 7. 切换机制

```js
// workspace 文件与文件夹统一走 openFolder(源码内已验证可用,generate 命令同款)
await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(entry.id), newWindow === true);
```

- 本窗口切换 = 窗口重载,扩展重新激活 → **必须先更新 `lastOpenedAt/openCount` 再执行切换**,切换后的提示信息大概率随重载消失(接受,不补偿)。
- P1 无命令面板入口;未开任何目录时,树仅显示扫描与收录结果(面板无参调用恢复于 P2)。

## 8. 交互流(P2 生效:命令面板回退 + 复用既有约定)

(P2)无参数调用(命令面板入口)→ QuickPick 列注册表条目:样式与 `pickProjectDir` 一致(`matchOnDescription`、输入即过滤、失效项 `alwaysShow` 置底)。**全部沿用踩坑记录里的约定**:

1. items 在 `show()` 前一次性赋值,禁止 show 后立刻二次赋值(渲染竞态空行)
2. `buttons` 必须是 `{iconPath: new ThemeIcon(x), tooltip}` 形状;行内按钮识别走 `btnId(e, 'xxx')`
3. 呼出系统对话框前先 `pick.hide()` + `suppressHide` 抑制 `onDidHide`(addWorkspaceFile 选文件对话框同款处理)
4. 名称/路径输入框校验失败 → `validationMessage` 不关窗

## 9. 技术要点与已知坑

1. **切换即重载**:任何异步收尾(状态写入、提示)必须排在 `executeCommand('vscode.openFolder', ...)` 之前。
2. **隐式激活不确定**:`engines ^1.74` 对 views 是否隐式生成 `onView:` 激活事件需要打包实测;若树视图不激活扩展,`activationEvents` 补 `"onView:wpmanager.workspaces"`(保留 `[]` 写法兼容旧 vsce 的话,改为显式数组)。
3. **Windows 路径去重**:统一 normalize + 比较键小写(§3)。
4. **扫描性能**:`fs.promises.readdir(withFileTypes)` 递归,深度上限 + 排除名短路;scanDirs 条目不存在则静默跳过并在结果里报告。
5. **活动栏图标**:必须单色 SVG(monochrome,`currentColor`),24×24;不能用彩色 PNG/emoji。
6. **失效检测频率**:仅刷新/展开时 stat,不做后台轮询;条目 < 几百,一轮 stat 毫秒级。
7. **数据迁移**:registry 结构带 `version: 1`;`get` 出来非对象/无 entries → 视为空表并重写,不做脏数据抢救(成本不值)。
8. **P1 零命令贡献**:新命令只注册不贡献(`_` 前缀=永不贡献约定);P2 引入命令时再定 `commandPalette` 屏蔽策略。
9. **TreeView 行内按钮不可用**:`TreeView.onDidTriggerItemButton`/`TreeItem.buttons` 是 proposed API(vscode.d.ts 稳定面里只有 `QuickPickItem.buttons`);P1 收藏改用 `TreeItem.checkboxState`(稳定,1.66+),踩坑于真机 1.100 激活报错。

## 10. i18n 清单约定

- 新键统一前缀 `ws.*`(workspace 切换域),进 `l10n/bundle.l10n.json` + `bundle.l10n.zh-cn.json`
- 命令标题进 `package.nls.json` / `package.nls.zh-cn.json`(P2 命令化时):`%command.openWorkspace%` 等,前缀沿用 `%command.category%`
- 视图标题 `%view.workspaces%` 进 nls
- P1 键量:视图标题 1 + 配置描述 4 + 运行时提示 ~8;P2 补命令标题 13 + 消息 ~20

## 11. 测试计划(test/smoke.js 扩展)

现有 24 用例(mock vscode + child_process + 剪贴板 + createQuickPick/ThemeIcon)。新增:

- **registry 纯逻辑**:增删改查、规范化去重(win32 大小写)、排序(置顶/最近/添加序)、version 容错
- **扫描**:临时目录 fixture(嵌套 workspace 文件 + 排除目录 + 超深),断言增量合入与报告
- **失效检测**:stat 抛 FileNotFound → 标记 stale
- **切换**:断言 openFolder 以 `(uri, newWindow)` 调用,且 lastOpenedAt/openCount 已先行写入
- **树**:mock `registerTreeDataProvider`/`createTreeView` 捕获 provider,断言分组结构与 id 唯一性
- **命令面板回退**:P2 实现时补(mock createQuickPick 已有基建)

目标:P1 24 → 35+ 用例,P2 命令化后补至 45+,保持零依赖纯 node 断言。

## 12. 实施阶段

- **P1 纯视图版·零命令(本次)**:registry 数据层 + TreeView(收藏/最近/全部)+ 激活时自动扫描 scanDirs 入库 + 自动收录当前工作区 + 单击切换 + checkbox 收藏 + 失效标记 + `package.json` 零新命令贡献(新窗口打开因 proposed API 受限后置 P2)
- **P2 命令化**:命令贡献进面板 + QuickPick 回退流 + 标题栏按钮(刷新/添加当前/选文件/扫描)+ 右键全量菜单 + generate 后询问入库
- **P3 管理增强**:标签分组 + 别名重命名 + 复制路径/资源管理器显示 + 删除文件(模态)+ 失效项重新定位 + 导出/导入 + 当前工作区徽标(badge)+ 排序设置项

每阶段:实现 → `node test/smoke.js` → `npm run package` → `code --install-extension` 实测(含隐式激活验证)→ 按 patch/minor 升版本(bump 到 `0.6.0` 在 P1 完成、P1~P3 同挂 0.6.x 或按节奏进 0.7)。

## 13. 待拍板

1. 「全部」组 P2 是否按标签分组展示(父节点=标签,无标签入「未分组」)——默认:是
2. 文件夹(type:folder)条目模型已支持;P1 自动收录当前工作区时,文件夹模式落为 folder 条目——默认:是
3. `scanDirs` 默认空(不自动扫)还是预填用户主目录——默认:空,设置页引导
