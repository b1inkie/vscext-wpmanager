# Workspace Manager(wpmanager)

工作区管理插件:生成/新建/管理 `.code-workspace` 工作区(后续会加入更多工作区管理能力)。扩展 ID:`lan.wpmanager`,仓库计划名:`vscext-wpmanager`(暂不上传)。

## 用法

1. 打开命令面板(VSCode 内置:顶部菜单「查看→命令面板」)
2. 执行 **Generate .code-workspace**(生成)或 **New Project**(新建项目)
3. 项目根目录下生成 `<文件夹名>.code-workspace`,内容:

```jsonc
{
	"folders": [
		{
			"path": "."
		}
	],
	"settings": {
		"editor.tabSize": 4,
		"workbench.editor.showTabs": "none",
		"explorer.openEditors.sortOrder": "alphabetical",
		"workbench.colorTheme": "Monokai",
		"editor.emptySelectionClipboard": false,
		"editor.formatOnPaste": true
	}
}
```

- 文件已存在时会弹窗确认是否覆盖
- 生成后自动打开该工作区(同窗口切换为 workspace 模式;若有未保存的编辑器,VSCode 会先询问保存)

### 在 Photoshop 中编辑图片 / Edit Image in Photoshop(lan: Edit Image in Photoshop)

- **首次使用需配置**:`wpmanager.photoshopPath`(Photoshop.exe 完整路径)。未配置时执行命令会提示「去设置中填写」,并附「打开设置」按钮一键直达该配置项
- 触发方式:命令面板执行(作用于当前打开的图片,或资源管理器中选中的图片——支持多选一次送入 PS),或资源管理器/图片标签页右键;命令面板场景下会短暂借用剪贴板解析选中项并立即恢复原内容
- 支持 png/jpg/jpeg/gif/bmp/webp/tiff/ico,仅支持本地文件
- 在 PS 中保存后,VSCode 的图片预览会自动刷新,形成编辑闭环
### 拷贝当前文件绝对路径 / Copy Current File Path(lan: Copy Current File Path)

- 把当前激活编辑器里文件的绝对路径写入剪贴板(Windows 下为反斜杠原生路径)
- 没有打开文件 / 文件尚未保存(untitled)时会报错提示
### 新建项目 / New Project(lan: New Project)

**Step 1 — 选择项目目录**(一个弹窗搞定三种方式):

- 第一行输入框:直接输入目录路径后回车(路径不存在会在弹窗内提示,不会关闭)
- 第二行:`浏览...选择目录`,点击呼出系统资源管理器手动选择
- 第三行起:**历史目录**——每次选过的目录自动记入本地(跨工作区,最多 10 条,最近优先置顶);每行带 ✏️/🗑 按钮,可设置**备用名**(列表里显示备用名,右侧仍显示完整路径,看不懂一堆路径时一目了然)也可随时删除

**Step 2 — 输入项目名** → 在所选目录下创建 `<项目名>/` 文件夹并生成 `<项目名>.code-workspace`(内容同上),随后自动打开

- 项目名合法性校验:不能包含 `\\ / : * ? " < > |` 等字符,不能以点/空格结尾,不能是 `CON`、`COM1` 等保留名;同名项目已存在时报错且不覆盖
- 旧版本的"默认项目目录"配置会在首次使用时自动迁移为历史首条

## 本地化

- 清单(命令标题/描述):`package.nls.json`(默认英文)+ `package.nls.zh-cn.json`,随 VSCode 界面语言切换
- 运行时消息:`l10n/bundle.l10n.json` + `l10n/bundle.l10n.zh-cn.json`,代码中用 `vscode.l10n.t('key')`,占位符用 `{0}`
## 本地调试

用 VSCode 打开本目录,按 `F5`(扩展开发宿主),在宿主窗口里打开任意文件夹后执行命令。

## 打包 vsix

```bash
npm run package

## 开发者/Developer

- **b1inkie** — [Gitee](https://gitee.com/b1inkie)
- License: MIT
```
