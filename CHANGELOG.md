# 更新日志(Changelog)

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格,版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-10-26

### 新增
- **工作区切换中心**:活动栏新增「工作区管理」视图,手动分组制
  - 添加单个 `.code-workspace` 文件(归入「未归类」)或添加多项目文件夹(扫描其子文件夹建分组)
  - 单击条目展开操作行:切换到该工作区 / 打开工作区(新窗口)/ 置顶 / 添加备用名 / 忽略
  - 备用名写入 `.code-workspace` 文件的 `vscext_wpmanager.wpnickname` 字段,随文件走;非标准 JSON 拒写
  - 每组顶部可选「已忽略工作区」节点(默认隐藏,右键分组以 ✓ 开关切换)
  - 分组内容镜像磁盘:激活时全量扫描一次,此后 `fs.watch` 事件驱动增量刷新
  - 当前工作区高亮、文件失效 ⚠ 标记、右键从列表移除(不动磁盘文件)

## [0.6.1] - 2026-10-28

### 变更
- 工作区文件备用名字段更名:`vscext_wpmanager` → **`wpmanager`**(只读 `wpmanager.wpnickname`,旧字段不再读取、也不做清理,文件里的旧字段原样保留)

## [0.5.0] - 2026-02

### 新增
- 生成 `.code-workspace`(generate)
- 新建项目(newproject):选目录 + 项目名,生成后自动打开
- 拷贝当前文件绝对路径(copycurrentpath)
- 送 Photoshop(editimginPS,支持多图)
