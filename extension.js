const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** 生成的 .code-workspace 模板(注意:此处是合法 JSON,不能带尾逗号) */
const WORKSPACE_TEMPLATE = {
	folders: [
		{
			path: '.'
		}
	],
	settings: {
		'editor.tabSize': 4,
		'workbench.editor.showTabs': 'none',
		'explorer.openEditors.sortOrder': 'alphabetical',
		'workbench.colorTheme': 'Monokai',
		'editor.emptySelectionClipboard': false,
		'editor.formatOnPaste': true
	}
};

/** 把错误规整成可读文本(带错误码,方便定位权限/占用/磁盘满等问题) */
function describeError(err) {
	if (!err) { return String(err); }
	if (err.message) { return err.code ? `${err.message} (${err.code})` : err.message; }
	return String(err);
}
/** 项目目录历史在用户本地的存储键(globalState,跨工作区生效) */
const DIR_HISTORY_KEY = 'wpmanager.projectDirHistory';
const DIR_HISTORY_MAX = 10; // 最多保留多少条历史目录

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Photoshop 命令支持的图片扩展名 */
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?|ico)$/i;

/** 解析当前编辑上下文的文件:活动标签页(图片预览是自定义编辑器,tab.input 带 uri),其次活动文本编辑器 */
function resolveCurrentUri() {
	const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTab;
	const input = tab && tab.input;
	if (input && input.uri && typeof input.uri.fsPath === 'string') {
		return input.uri;
	}
	const editor = vscode.window.activeTextEditor;
	return editor && editor.document.uri;
}

/**
 * 解析「资源管理器选中但未打开」的文件(VSCode 没有公开 API 读资源管理器选中项)。
 * 利用内置 copyFilePath 命令:不带参数调用时它会把「资源管理器选中项,否则活动编辑器」的
 * 路径写入剪贴板(多选时按行分隔),拿到后立即恢复用户剪贴板。仅返回图片路径。
 */
async function resolveViaClipboard() {
	let prev;
	try {
		prev = await vscode.env.clipboard.readText();
	} catch {
		prev = undefined; // 剪贴板内容非文本,无法读取/恢复
	}
	let copied;
	try {
		await vscode.commands.executeCommand('copyFilePath');
		copied = await vscode.env.clipboard.readText();
	} catch {
		copied = undefined;
	}
	// 尽量恢复用户剪贴板(仅在发生过变化时)
	try {
		if (typeof prev === 'string' && prev.length > 0 && typeof copied === 'string' && prev !== copied) {
			await vscode.env.clipboard.writeText(prev);
		}
	} catch {
		// 恢复失败不影响主流程
	}
	if (typeof copied !== 'string' || !copied || copied === prev) {
		return []; // 命令没改写剪贴板 = 没解析到文件
	}
	return copied.split(/\r?\n/)
		.map((p) => p.trim())
		.filter((p) => p && IMAGE_EXT.test(p));
}
/** 项目名合法性:不能含 Windows 非法字符/保留名,不能以点或空格结尾 */
function isValidProjectName(name) {
	return !!name
		&& !INVALID_NAME_CHARS.test(name)
		&& !RESERVED_NAMES.test(name)
		&& !/[. ]$/.test(name);
}

/** 读取目录历史 */
async function loadDirHistory(context) {
	const hist = context.globalState.get(DIR_HISTORY_KEY);
	if (!Array.isArray(hist)) {
		return [];
	}
	return hist.filter((h) => h && typeof h.dir === 'string');
}

async function saveDirHistory(context, hist) {
	await context.globalState.update(DIR_HISTORY_KEY, hist);
}

/** 用户选定目录后记录历史(置顶、去重、保留原备用名、限制条数) */
async function recordDirHistory(context, dir) {
	const hist = await loadDirHistory(context);
	const old = hist.find((h) => h.dir === dir);
	const next = [{ dir, alias: old ? old.alias : '' }, ...hist.filter((h) => h.dir !== dir)].slice(0, DIR_HISTORY_MAX);
	await saveDirHistory(context, next);
}

/** 弹出系统目录选择器(取消返回 undefined) */
async function browseDir() {
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFolders: true,
		canSelectFiles: false,
		title: vscode.l10n.t('src.extension.np.browse'),
		openLabel: vscode.l10n.t('src.extension.np.browse')
	});
	return picked && picked[0];
}

/** 识别行内按钮:事件回传的 button 经过序列化会丢引用,按 iconPath.id 判断(兼容裸 id) */
function btnId(e, id) {
	const b = e && e.button;
	return !!b && ((b.iconPath && b.iconPath.id === id) || b.id === id);
}

/**
 * Step 1:选择项目目录,返回选定的目录 Uri(取消返回 undefined)。
 * 第一行:输入框直接输入目录路径后回车;第二行:浏览选择;第三行起:历史目录(可删除/设置备用名)。
 * 注意:先读齐历史、在 show() 前一次性赋值 items;show 后立刻二次赋值会触发列表渲染竞态(新行变空行)。
 */
async function pickProjectDir(context) {
	const hist = await loadDirHistory(context);
	return new Promise((resolve) => {
		let settled = false;
		let suppressHide = false; // 弹系统对话框期间抑制 onDidHide 结束流程
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		const pick = vscode.window.createQuickPick();
		pick.title = vscode.l10n.t('src.extension.np.dir_pick_title');
		pick.placeholder = vscode.l10n.t('src.extension.np.dir_placeholder');
		pick.matchOnDescription = true; // 输入路径片段也能过滤历史目录
		pick.ignoreFocusOut = true; // 输入路径时切出去复制路径,弹窗不消失

		// 注意:buttons 必须是 QuickInputButton 形状({ iconPath, tooltip }),
		// 直接塞裸 ThemeIcon 会让渲染器解析失败、整行画成空白行(v0.4.0~0.4.2 空白行 bug 根因)
		const btnEdit = {
			iconPath: new vscode.ThemeIcon('edit'),
			tooltip: vscode.l10n.t('src.extension.np.alias_btn_tooltip')
		};
		const btnTrash = {
			iconPath: new vscode.ThemeIcon('trash'),
			tooltip: vscode.l10n.t('src.extension.np.del_btn_tooltip')
		};
		const browseItem = {
			label: `$(folder-opened) ${vscode.l10n.t('src.extension.np.browse')}`,
			alwaysShow: true,
			browse: true
		};

		const toItems = (list) => list.map((h) => ({
			label: `$(folder) ${h.alias || path.basename(h.dir) || h.dir}`,
			description: h.dir,
			dir: h.dir,
			alias: h.alias || '',
			buttons: [btnEdit, btnTrash]
		}));

		// 历史已提前读好:items 在 show() 之前一次性赋值(避免渲染竞态空行)
		pick.items = [browseItem, ...toItems(hist)];

		// 删除/改备用名后刷新列表(此时弹窗已稳定渲染,二次赋值安全)
		const render = async () => {
			pick.items = [browseItem, ...toItems(await loadDirHistory(context))];
		};

		// 行内按钮:删除历史 / 设置备用名
		pick.onDidTriggerItemButton(async (e) => {
			const item = e.item;
			if (btnId(e, 'trash')) {
				await saveDirHistory(context, (await loadDirHistory(context)).filter((h) => h.dir !== item.dir));
				await render();
			} else if (btnId(e, 'edit')) {
				const alias = await vscode.window.showInputBox({
					title: vscode.l10n.t('src.extension.np.alias_title', item.dir),
					placeHolder: vscode.l10n.t('src.extension.np.alias_placeholder'),
					value: item.alias || ''
				});
				if (alias === undefined) {
					return; // 取消,不修改
				}
				const hist = await loadDirHistory(context);
				const entry = hist.find((h) => h.dir === item.dir);
				if (entry) {
					entry.alias = alias.trim();
					await saveDirHistory(context, hist);
					await render();
				}
			}
		});

		pick.onDidAccept(async () => {
			const active = pick.selectedItems[0];
			// 1) 历史目录优先(选中了某条历史)
			if (active && active.dir) {
				done(vscode.Uri.file(active.dir));
				pick.hide();
				return;
			}
			// 2) 输入框有内容:优先当作目录路径(即使高亮停在浏览行——
			//    alwaysShow 的浏览行在过滤后常常是唯一可见项而被动高亮,不能代表用户想浏览)
			const raw = (pick.value || '').trim().replace(/^"(.+)"$/, '$1');
			if (raw) {
				const p = path.normalize(raw);
				let isDir = false;
				try {
					isDir = fs.statSync(p).isDirectory();
				} catch {
					isDir = false;
				}
				if (!isDir) {
					pick.validationMessage = vscode.l10n.t('src.extension.np.dir_invalid');
					return; // 不关弹窗,让用户改
				}
				done(vscode.Uri.file(p));
				pick.hide();
				return;
			}
			// 3) 输入框为空且选中浏览行 → 呼出系统资源管理器。
			// 系统对话框是模态的,弹它之前必须先收起 QuickPick 并抑制 onDidHide,
			// 否则对话框夺焦时 onDidHide 会抢先 done(undefined),选完的结果被丢弃(目录不入库、流程静默中断)
			if (active === browseItem) {
				suppressHide = true;
				pick.hide();
				const picked = await browseDir();
				if (picked) {
					done(picked);
				} else {
					suppressHide = false;
					pick.show(); // 取消浏览则回到弹窗
				}
				return;
			}
		});

		pick.onDidHide(() => {
			if (!suppressHide) {
				done(undefined);
			}
		});
		pick.show();
	});
}

/** 在指定文件夹内生成 <文件夹名>.code-workspace(含覆盖确认与生成后自动打开),供两个命令复用 */
async function writeWorkspaceFile(folderUri) {
	let baseName = path.basename(folderUri.fsPath);
	if (!baseName || /:$/.test(baseName)) {
		baseName = 'workspace'; // 盘符根目录等特殊情况兑底
	}
	const fileName = `${baseName}.code-workspace`;
	const targetUri = vscode.Uri.joinPath(folderUri, fileName);

	try {
		// 已存在时先确认,避免误覆盖用户改过的配置
		let exists = true; // 保守:确认不了状态时按已存在走确认流程
		try {
			await vscode.workspace.fs.stat(targetUri);
		} catch (e) {
			if (e && e.code === 'FileNotFound') {
				exists = false;
			}
			// 其他 stat 失败(权限/网络抖动等)保持 exists=true,交给确认弹窗与写入兑底
		}
		if (exists) {
			const overwriteBtn = vscode.l10n.t('src.extension.overwrite');
			const overwrite = await vscode.window.showWarningMessage(
				vscode.l10n.t('src.extension.exists_confirm', fileName),
				{ modal: true },
					overwriteBtn
			);
			if (overwrite !== overwriteBtn) {
				return;
			}
		}

		const content = JSON.stringify(WORKSPACE_TEMPLATE, null, '\t') + '\n';
		await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content));

		// 生成后自动打开工作区(同窗口切换为 workspace 模式,提示会随窗口重载而消失)
		vscode.window.showInformationMessage(vscode.l10n.t('src.extension.generated', fileName));
		try {
			await vscode.commands.executeCommand('vscode.openFolder', targetUri, false);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.open_fail', describeError(e)));
		}
	} catch (err) {
		vscode.window.showErrorMessage(vscode.l10n.t('src.extension.gen_fail', describeError(err)));
	}
}

// ==================== 工作区切换中心(v0.6.0 手动分组版) ====================
// 模型:两类来源——①单个 .code-workspace(归入内置「未归类」分组)②多项目文件夹(作为分组根,
// 扫描其子文件夹里的 .code-workspace 归入该分组)。扩展不做任何自动搜索/自动收录。

/** 注册表存储键(globalState) */
const REGISTRY_KEY = 'wpmanager.workspaceRegistry';
const REGISTRY_VERSION = 3;
/** 扫描多项目文件夹时默认排除的目录名(可用 wpmanager.scanExcludeNames 覆盖) */
const DEFAULT_SCAN_EXCLUDES = ['node_modules', '.git', '.venv', 'dist'];
const SCAN_DEPTH_MIN = 1;
const SCAN_DEPTH_MAX = 8;
const SCAN_DEPTH_DEFAULT = 3;
const WS_EXT = '.code-workspace';

/** 去重比较键(Windows 路径大小写不敏感,统一小写再比) */
function dedupeKey(p) {
	return process.platform === 'win32' ? p.toLowerCase() : p;
}

function makeEntry(id, root) {
	return {
		id: path.normalize(id),
		root: root ? path.normalize(root) : '', // '' = 未归类
		alias: '',
		ignored: false, // 收进分组顶部「已忽略工作区」
		pinned: false, // 组内置顶(排序优先 + $(pinned) 前缀)
		addedAt: Date.now(),
		lastOpenedAt: 0, // 0 = 从未打开(仅记录,不参与分组展示)
		openCount: 0
	};
}

/** 读取注册表;旧结构(v1/v2)迁移到 v3:v1 folder 条目丢弃,workspace 进未归类;统一补 ignored/pinned 默认值 */
async function loadRegistry(context) {
	const reg = context.globalState.get(REGISTRY_KEY);
	if (reg && typeof reg === 'object' && reg.version === REGISTRY_VERSION && Array.isArray(reg.roots) && Array.isArray(reg.entries)) {
		return reg;
	}
	if (reg && typeof reg === 'object' && Array.isArray(reg.entries)) {
		return {
			version: REGISTRY_VERSION,
			roots: Array.isArray(reg.roots) ? reg.roots.filter((r) => r && typeof r.id === 'string') : [],
			entries: reg.entries
				.filter((e) => e && typeof e.id === 'string' && e.type !== 'folder')
				.map((e) => ({
					id: e.id,
					root: typeof e.root === 'string' ? e.root : '',
					alias: e.alias || '',
					ignored: !!e.ignored,
					pinned: !!e.pinned,
					addedAt: e.addedAt || Date.now(),
					lastOpenedAt: e.lastOpenedAt || 0,
					openCount: e.openCount || 0
				}))
		};
	}
	return { version: REGISTRY_VERSION, roots: [], entries: [] };
}

async function saveRegistry(context, reg) {
	await context.globalState.update(REGISTRY_KEY, reg);
}

function findRoot(reg, fsPath) {
	const key = dedupeKey(path.normalize(fsPath));
	return reg.roots.find((r) => r && typeof r.id === 'string' && dedupeKey(r.id) === key);
}

function findEntry(reg, fsPath) {
	const key = dedupeKey(path.normalize(fsPath));
	return reg.entries.find((e) => e && typeof e.id === 'string' && dedupeKey(e.id) === key);
}

/** 设置忽略状态:忽略时同时取消置顶(收进分组顶部「已忽略工作区」) */
async function setIgnored(context, fsPath, ignored) {
	const reg = await loadRegistry(context);
	const entry = findEntry(reg, fsPath);
	if (!entry || entry.ignored === ignored) {
		return false;
	}
	entry.ignored = ignored;
	if (ignored) {
		entry.pinned = false;
	}
	await saveRegistry(context, reg);
	return true;
}

/** 组内置顶切换(被忽略条目不参与置顶) */
async function setPinned(context, fsPath, pinned) {
	const reg = await loadRegistry(context);
	const entry = findEntry(reg, fsPath);
	if (!entry || entry.ignored || entry.pinned === pinned) {
		return false;
	}
	entry.pinned = pinned;
	await saveRegistry(context, reg);
		return true;
	}

/** 注册表 alias 同步副本(显示名优先取工作区文件内 vscext_wpmanager.wpnickname;空串清除) */
async function setAlias(context, fsPath, alias) {
	const reg = await loadRegistry(context);
	const entry = findEntry(reg, fsPath);
	if (!entry) {
		return false;
	}
	entry.alias = alias || '';
	await saveRegistry(context, reg);
	return true;
	return true;
}

/** 添加单个 .code-workspace 到「未归类」;已在列表(任意分组)则不重复。返回 'added'|'exists'|'invalid' */
async function addWorkspaceFile(context, fsPath) {
	if (!fsPath || !path.basename(fsPath).endsWith(WS_EXT)) {
		return 'invalid';
	}
	const reg = await loadRegistry(context);
	if (findEntry(reg, fsPath)) {
		return 'exists';
	}
	reg.entries.push(makeEntry(fsPath, ''));
	await saveRegistry(context, reg);
	return 'added';
}

/** 添加多项目文件夹:登记为分组根,并立即扫描其子文件夹。返回新增工作区条数 */
async function addProjectFolder(context, fsPath) {
	if (!fsPath) {
		return 0;
	}
	const reg = await loadRegistry(context);
	const rootId = path.normalize(fsPath);
	if (!findRoot(reg, rootId)) {
		reg.roots.push({ id: rootId, addedAt: Date.now() });
		await saveRegistry(context, reg);
	}
	const added = scanRootFolder(context, rootId);
	startRootWatcher(context, rootId); // 新根立即建立监听,后续磁盘变化走事件驱动
	return added;
}

/** 递归收集目录下所有 .code-workspace(排除名短路,深度上限) */
async function collectWorkspaceFiles(root, depth, excludeNames, out) {
	let items;
	try {
		items = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return; // 无权限/不存在:静默跳过
	}
	for (const it of items) {
		const full = path.join(root, it.name);
		if (it.isDirectory()) {
			if (excludeNames.has(it.name) || depth <= 1) {
				continue;
			}
			await collectWorkspaceFiles(full, depth - 1, excludeNames, out);
		} else if (it.isFile() && it.name.endsWith(WS_EXT)) {
			out.push(full);
		}
	}
}

/** 重扫某个多项目文件夹:新文件合入(不抢其他分组的),消失的移除——分组内容镜像磁盘 */
async function scanRootFolder(context, rootId) {
	const cfg = vscode.workspace.getConfiguration('wpmanager');
	const depth = Math.max(SCAN_DEPTH_MIN, Math.min(SCAN_DEPTH_MAX, Number(cfg.get('scanMaxDepth')) || SCAN_DEPTH_DEFAULT));
	const excludeNames = new Set(cfg.get('scanExcludeNames') || DEFAULT_SCAN_EXCLUDES);
	const found = [];
	await collectWorkspaceFiles(rootId, depth, excludeNames, found);

	const reg = await loadRegistry(context);
	const key = dedupeKey(rootId);
	const scanned = new Set(found.map((f) => dedupeKey(f)));
	let changed = false;
	let added = 0;
	for (const f of found) {
		if (findEntry(reg, f)) {
			continue; // 已在列表(本分组或其他分组)不重复
		}
		reg.entries.push(makeEntry(f, rootId));
		added++;
		changed = true;
	}
	const before = reg.entries.length;
	reg.entries = reg.entries.filter((e) => !e.root || dedupeKey(e.root) !== key || scanned.has(dedupeKey(e.id)));
	if (reg.entries.length !== before) {
		changed = true;
	}
	if (changed) {
		await saveRegistry(context, reg);
	}
	return added;
}

/** 从列表移除:传 workspace 文件路径删单条;传分组根路径删整个分组及其条目(都不动磁盘文件) */
async function removeById(context, fsPath) {
	const reg = await loadRegistry(context);
	const key = dedupeKey(fsPath);
	const hadRoot = !!findRoot(reg, fsPath);
	const before = reg.entries.length;
	reg.entries = reg.entries.filter((e) => dedupeKey(e.id) !== key);
	if (hadRoot) {
		reg.roots = reg.roots.filter((r) => dedupeKey(r.id) !== key);
		reg.entries = reg.entries.filter((e) => !e.root || dedupeKey(e.root) !== key);
			stopRootWatcher(key); // 分组删了,监听一并撤
			watchBroken.delete(key);
	}
	const removed = reg.entries.length !== before || hadRoot;
	if (removed) {
		await saveRegistry(context, reg);
	}
	return removed;
}

/** 分组根目录监听:磁盘变化 → 防抖 → 只重扫受影响的那个根(替代“每次展开视图全量重扫”) */
const rootWatchers = new Map(); // 去重键 -> FSWatcher
const watchBroken = new Set(); // 监听建立失败的根(网络盘/权限):视图可见时兑底重扫
const watchDebounceTimers = new Map(); // 去重键 -> 防抖 timer
const SCAN_DEBOUNCE_MS = 1500;

/** 由 activate 注入:注册表可能变化后刷新树(避免 watcher 依赖 provider 作用域) */
let onRegistryChanged = () => {};
function startRootWatcher(context, rootId) {
	const key = dedupeKey(rootId);
	if (rootWatchers.has(key)) {
		return;
	}
	try {
		const w = fs.watch(rootId, { recursive: true }, () => {
			const prev = watchDebounceTimers.get(key);
			if (prev) {
				clearTimeout(prev);
			}
			watchDebounceTimers.set(key, setTimeout(async () => {
				watchDebounceTimers.delete(key);
				try {
					await scanRootFolder(context, rootId);
				} catch {
					// 扫描失败不致命,下次事件重试
				}
				onRegistryChanged();
			}, SCAN_DEBOUNCE_MS));
		});
		w.on('error', () => {
			stopRootWatcher(key);
			watchBroken.add(key); // 监听断掉:视图可见时兑底重扫
		});
		rootWatchers.set(key, w);
		watchBroken.delete(key);
	} catch {
		watchBroken.add(key);
	}
}

function stopRootWatcher(key) {
	const w = rootWatchers.get(key);
	if (w) {
		try {
			w.close();
		} catch {
			// 已失效的监听关闭报错无所谓
		}
		rootWatchers.delete(key);
	}
	const t = watchDebounceTimers.get(key);
	if (t) {
		clearTimeout(t);
		watchDebounceTimers.delete(key);
	}
}

function stopAllWatchers() {
	for (const key of [...rootWatchers.keys()]) {
		stopRootWatcher(key);
	}
}
/** 全量刷新(激活时):重扫所有分组根 + 建立磁盘监听 */
async function refreshWorkspaces(context, provider) {
	const reg = await loadRegistry(context);
	for (const r of reg.roots.slice()) {
		await scanRootFolder(context, r.id);
		startRootWatcher(context, r.id);
	}
	provider.bump();
}

/** 条目是否为「当前打开的工作区」(workspace 文件模式) */
function isCurrentEntry(vm) {
	const wsFile = vscode.workspace.workspaceFile;
	return !!(wsFile && wsFile.fsPath && dedupeKey(wsFile.fsPath) === dedupeKey(vm.id));
}

/** 设置分组「已忽略工作区」节点的显示开关(item=分组根 TreeItem 或未归类节点;默认隐藏) */
async function setShowIgnored(context, item, show) {
	const reg = await loadRegistry(context);
	if (item && item.wsRoot) {
		const root = findRoot(reg, item.wsRoot);
		if (!root) {
			return false;
		}
		root.showIgnored = show === true;
	} else if (item && item.wsSection === 'ungrouped') {
		reg.ungroupedShowIgnored = show === true;
	} else {
		return false;
	}
	await saveRegistry(context, reg);
	return true;
}

/** 工作区文件昵称缓存:按 mtime+size 失效,避免每次渲染都读文件 */
const nicknameCache = new Map(); // 去重键 -> { mtimeMs, size, nickname }

/** 读取 .code-workspace 里的 vscext_wpmanager.wpnickname(容错:非 JSON/无字段返回 '') */
async function readFileNickname(id, st) {
	const key = dedupeKey(id);
	const hit = nicknameCache.get(key);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
		return hit.nickname;
	}
	let nickname = '';
	try {
		const obj = JSON.parse(await fs.promises.readFile(id, 'utf8'));
		const n = obj && obj.vscext_wpmanager && obj.vscext_wpmanager.wpnickname;
		if (typeof n === 'string') {
			nickname = n.trim();
		}
	} catch {
		// 读取失败/非 JSON:视为无昵称
	}
	nicknameCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, nickname });
	return nickname;
}

/** 条目显示名:文件内 vscext_wpmanager.wpnickname → 注册表备用名 → 文件名 */
function entryDisplayName(vm) {
	if (vm.nickname && vm.nickname.trim()) {
		return vm.nickname.trim();
	}
	if (vm.alias && vm.alias.trim()) {
		return vm.alias.trim();
	}
	return path.basename(vm.id) || vm.id;
}

/** 条目 tooltip(完整路径 + 当前/失效标记) */
function buildTooltip(vm) {
	const md = new vscode.MarkdownString('', true); // true = 支持 $(codicon)
	const flags = [];
	if (vm.current) {
		flags.push(`$(folder-active) ${vscode.l10n.t('ws.tooltip.current')}`);
	}
	if (vm.stale) {
		flags.push(`$(circle-slash) ${vscode.l10n.t('ws.tooltip.stale')}`);
	}
	md.appendMarkdown(`**${entryDisplayName(vm)}**${flags.length ? `  ${flags.join(' · ')}` : ''}\n\n`);
	md.appendMarkdown(`- $(file) ${vscode.l10n.t('ws.tooltip.path')}: \`${vm.id}\`\n`);
	return md;
}

/** 打开条目(树单击)。同窗切换=窗口重载,必须先写打开记录再切换 */
async function openEntry(context, provider, vm, newWindow) {
	if (!vm || typeof vm.id !== 'string') {
		return;
	}
	try {
		await fs.promises.stat(vm.id);
	} catch {
		vscode.window.showWarningMessage(vscode.l10n.t('ws.entryMissing', vm.id));
		provider.bump(); // 让树上的失效标记即时生效
		return;
	}
	const reg = await loadRegistry(context);
	const stored = findEntry(reg, vm.id);
	if (stored) {
		stored.lastOpenedAt = Date.now();
		stored.openCount = (stored.openCount || 0) + 1;
		await saveRegistry(context, reg);
	}
	try {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(vm.id), newWindow === true);
	} catch (err) {
		vscode.window.showErrorMessage(vscode.l10n.t('ws.openFail', describeError(err)));
		return;
	}
	provider.bump();
}

/** 工作区树:每个多项目文件夹一个分组(按添加顺序),外加内置「未归类」分组 */
class WorkspacesProvider {
	constructor(context) {
		this.context = context;
		this.selectedId = ''; // 当前展开操作行的条目(去重键);'' = 无
		this.selectSeq = 0; // 选择序号:选中态 id 每次递增,避开 VSCode 按 id 持久化折叠状态
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}
	bump() {
		this._onDidChangeTreeData.fire(undefined);
	}
	dispose() {
		this._onDidChangeTreeData.dispose();
	}
	getTreeItem(item) {
		return item;
	}
	async getChildren(element) {
		if (!element) {
			return this.getGroups();
		}
		if (element.wsRoot) {
			return this.getEntriesUnder(element.wsRoot);
		}
		if (element.wsSection === 'ungrouped') {
			return this.getUngrouped();
		}
		if (element.wsIgnored) {
			return this.getIgnoredUnder(element.wsRootId || '');
		}
		if (element.wsEntry && element.wsActions) {
			return this.actionItems(element.wsEntry); // 选中条目的子级操作行(真实缩进分层)
		}
		return [];
	}
	/** 注册表条目 → 视图模型(浅拷贝补 stale/current,不污染存储数据) */
	async buildViewModels(reg) {
		const vms = reg.entries
			.filter((e) => e && typeof e.id === 'string')
			.map((e) => Object.assign({}, e, { stale: false, current: false, nickname: '' }));
		await Promise.all(vms.map(async (vm) => {
			try {
				const st = await fs.promises.stat(vm.id);
				vm.nickname = await readFileNickname(vm.id, st); // 文件内昵称(mtime+size 缓存)
			} catch {
				vm.stale = true;
			}
			vm.current = isCurrentEntry(vm);
		}));
		return vms;
	}
	async getGroups() {
		const reg = await loadRegistry(this.context);
		if (reg.roots.length === 0 && reg.entries.length === 0) {
			const empty = new vscode.TreeItem(vscode.l10n.t('ws.empty.title'), vscode.TreeItemCollapsibleState.None);
			empty.tooltip = vscode.l10n.t('ws.empty.hint');
			empty.contextValue = 'empty';
			return [empty];
		}
		const items = [];
		for (const r of reg.roots.slice().sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
			const item = new vscode.TreeItem(path.basename(r.id) || r.id, vscode.TreeItemCollapsibleState.Expanded);
			item.id = `root::${r.id}`;
			item.description = path.dirname(r.id);
			item.iconPath = new vscode.ThemeIcon('folder-library');
			item.contextValue = ['root', r.showIgnored ? 'ign-shown' : 'ign-hidden'].join(','); // 菜单 when 据此切换显示/隐藏文案
			item.tooltip = r.id;
			item.wsRoot = r.id;
			items.push(item);
		}
		if (reg.entries.some((e) => !e.root)) {
			const item = new vscode.TreeItem(vscode.l10n.t('ws.group.ungrouped'), vscode.TreeItemCollapsibleState.Expanded);
			item.id = 'group::ungrouped';
			item.iconPath = new vscode.ThemeIcon('archive');
			item.contextValue = ['group', reg.ungroupedShowIgnored ? 'ign-shown' : 'ign-hidden'].join(',');
			item.wsSection = 'ungrouped';
			items.push(item);
		}
		return items;
	}
	byNameAsc(vms) {
		return vms.sort((a, b) => entryDisplayName(a).localeCompare(entryDisplayName(b)));
	}
	async getEntriesUnder(rootId) {
		const reg = await loadRegistry(this.context);
		const vms = await this.buildViewModels(reg);
		const key = dedupeKey(rootId);
		const root = findRoot(reg, rootId);
		return this.groupRows(vms.filter((e) => e.root && dedupeKey(e.root) === key), rootId, !!(root && root.showIgnored));
	}
	async getUngrouped() {
		const reg = await loadRegistry(this.context);
		const vms = await this.buildViewModels(reg);
		return this.groupRows(vms.filter((e) => !e.root), '', reg.ungroupedShowIgnored === true);
	}
	async getIgnoredUnder(rootId) {
		const reg = await loadRegistry(this.context);
		const vms = await this.buildViewModels(reg);
		const key = dedupeKey(rootId);
		const list = rootId
			? vms.filter((e) => e.ignored && e.root && dedupeKey(e.root) === key)
			: vms.filter((e) => e.ignored && !e.root);
		const items = [];
		for (const vm of this.byNameAsc(list)) {
			items.push(this.entryItem(vm, `ignored::${rootId || 'ungrouped'}`, !!this.selectedId && dedupeKey(vm.id) === this.selectedId));
		}
		return items;
	}
	/** 组内行:可选的「已忽略工作区」子节点(默认隐藏,右键分组切换)+ 置顶条目 + 普通条目;选中条目变为可展开父节点,操作行作为其子级(缩进分层) */
	groupRows(mine, rootId, showIgnored) {
		const sectionKey = rootId || 'ungrouped';
		const items = [];
		if (showIgnored && mine.some((e) => e.ignored)) {
			const node = new vscode.TreeItem(vscode.l10n.t('ws.group.ignored'), vscode.TreeItemCollapsibleState.Collapsed);
			node.id = `ignored::${sectionKey}`;
			node.iconPath = new vscode.ThemeIcon('eye-closed');
			node.contextValue = 'ignored';
			node.wsIgnored = true;
			node.wsRootId = rootId;
			items.push(node);
		}
		const normal = this.byNameAsc(mine.filter((e) => !e.ignored));
		const ordered = [...normal.filter((e) => e.pinned), ...normal.filter((e) => !e.pinned)];
		for (const vm of ordered) {
			items.push(this.entryItem(vm, sectionKey, !!this.selectedId && dedupeKey(vm.id) === this.selectedId));
		}
		return items;
	}
	/** 操作行:忽略/置顶(被忽略条目为取消忽略)+ 打开;树条目行内按钮是 proposed API 不可用,这是替代呈现 */
	actionItems(vm) {
		const acts = [];
		acts.push(this.actionItem(vm, 'switch', 'arrow-swap', vscode.l10n.t('ws.act.switch')));
		acts.push(this.actionItem(vm, 'open', 'folder-opened', vscode.l10n.t('ws.act.open')));
		if (vm.ignored) {
			acts.push(this.actionItem(vm, 'unignore', 'eye', vscode.l10n.t('ws.act.unignore')));
		} else {
			acts.push(this.actionItem(vm, 'pin', 'pinned', vm.pinned ? vscode.l10n.t('ws.act.unpin') : vscode.l10n.t('ws.act.pin')));
			acts.push(this.actionItem(vm, 'alias', 'edit', vscode.l10n.t('ws.act.alias')));
			acts.push(this.actionItem(vm, 'ignore', 'eye-closed', vscode.l10n.t('ws.act.ignore')));
		}
		return acts;
	}
	/** 图标走 iconPath:TreeItem.label 不支持 $(codicon) 内联语法(只有 QuickPick label 支持) */
	actionItem(vm, act, icon, label) {
		const commands = {
			switch: { command: 'wpmanager._openEntry', arguments: [vm, false] },
			open: { command: 'wpmanager._openEntry', arguments: [vm, true] },
			pin: { command: 'wpmanager._setPinned', arguments: [vm, !vm.pinned] },
			alias: { command: 'wpmanager._setAlias', arguments: [vm] },
			ignore: { command: 'wpmanager._setIgnored', arguments: [vm, true] },
			unignore: { command: 'wpmanager._setIgnored', arguments: [vm, false] }
		};
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.id = `${vm.id}::act-${act}`;
		item.iconPath = new vscode.ThemeIcon(icon);
		item.contextValue = 'action';
		item.tooltip = label;
		item.command = Object.assign({ title: label }, commands[act]);
		return item;
	}
	entryItem(vm, section, selected) {
		const item = new vscode.TreeItem(entryDisplayName(vm), selected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// 选中态用带序号的独立 id:避开 VSCode 按 id 持久化折叠状态,保证操作行必定展开
		item.id = selected ? `${vm.id}::${section}::sel${this.selectSeq}` : `${vm.id}::${section}`;
		item.description = vm.stale ? vscode.l10n.t('ws.stale') : path.dirname(vm.id);
		// 图标走 iconPath:TreeItem.label 不支持 $(codicon) 内联语法(只有 QuickPick label 支持)
		item.iconPath = new vscode.ThemeIcon(vm.current ? 'folder-active' : (vm.stale ? 'circle-slash' : (vm.pinned ? 'pinned' : 'window')));
		item.tooltip = buildTooltip(vm);
		item.contextValue = ['entry', vm.stale ? 'stale' : '', vm.current ? 'current' : '', vm.ignored ? 'ignored' : ''].filter(Boolean).join(',');
		// 单击不直接切换:展开/收起该条目的操作行(打开走操作行里的「打开工作区」)
		item.command = { command: 'wpmanager._selectEntry', title: vscode.l10n.t('ws.open.title'), arguments: [vm] };
		item.wsEntry = vm; // 操作行/右键菜单回调取原始数据用
		if (selected) {
			item.wsActions = true; // getChildren 据此返回子级操作行
		}
		return item;
	}
}
function activate(context) {
	const generateCmd = vscode.commands.registerCommand('wpmanager.generate', async () => {
		const folders = vscode.workspace.workspaceFolders || [];
		if (folders.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.need_open_folder'));
			return;
		}
		// 多根工作区时让用户选择目标文件夹
		let folder = folders[0];
		if (folders.length > 1) {
			const picked = await vscode.window.showQuickPick(
				folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
				{ placeHolder: vscode.l10n.t('src.extension.select_folder') }
			);
			if (!picked) {
				return; // 用户取消选择
			}
			folder = picked.folder;
		}
		await writeWorkspaceFile(folder.uri);
	});

	const newProjectCmd = vscode.commands.registerCommand('wpmanager.newproject', async () => {
		// Step 1:选择项目目录(输入路径回车 / 浏览 / 历史目录)
		const dirUri = await pickProjectDir(context);
		if (!dirUri) {
			return; // 用户取消
		}
		await recordDirHistory(context, dirUri.fsPath); // 选过一次就记住

		// Step 2:输入项目名并创建
		const name = await vscode.window.showInputBox({
			placeHolder: vscode.l10n.t('src.extension.np.enter_name')
		});
		if (!name || !name.trim()) {
			return; // 用户取消或未填写
		}
		const projectName = name.trim();
		if (!isValidProjectName(projectName)) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.np.invalid_name', projectName));
			return;
		}

		const projectUri = vscode.Uri.joinPath(dirUri, projectName);
		try {
			try {
				await vscode.workspace.fs.stat(projectUri);
				vscode.window.showErrorMessage(vscode.l10n.t('src.extension.np.exists', projectName));
				return; // 已存在同名项目,不碰用户数据
			} catch {
				// 不存在,继续创建
			}
			await vscode.workspace.fs.createDirectory(projectUri);
			await writeWorkspaceFile(projectUri);
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.np.create_fail', describeError(err)));
		}
	});

	const copyPathCmd = vscode.commands.registerCommand('wpmanager.copycurrentpath', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.cp.no_file'));
			return;
		}
		const uri = editor.document.uri;
		if (uri.scheme !== 'file') {
			// 未保存的 untitled 文档没有磁盘路径
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.cp.untitled'));
			return;
		}
		try {
			const p = uri.fsPath;
			await vscode.env.clipboard.writeText(p);
			vscode.window.showInformationMessage(vscode.l10n.t('src.extension.cp.copied', p));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.cp.fail', describeError(err)));
		}
	});

	const editImgCmd = vscode.commands.registerCommand('wpmanager.editimginPS', async (resource) => {
		// 1) 未配置 PS 路径 → 提示去设置中配置,并可一键打开设置
		const psPath = String(vscode.workspace.getConfiguration('wpmanager').get('photoshopPath') || '').trim();
		if (!psPath) {
			const openBtn = vscode.l10n.t('src.extension.ps.open_settings');
			const picked = await vscode.window.showWarningMessage(vscode.l10n.t('src.extension.ps.no_ps_path'), openBtn);
			if (picked === openBtn) {
				try {
					await vscode.commands.executeCommand('workbench.action.openSettings', 'wpmanager.photoshopPath');
				} catch {
					// 打开设置失败不致命,用户也可手动打开设置
				}
			}
			return;
		}

		// 2) 解析目标图片:右键菜单传入 → 当前标签页/编辑器 → 资源管理器选中项(copyFilePath + 剪贴板往返)
		let candidates;
		if (resource && typeof resource.fsPath === 'string') {
			candidates = [resource]; // 右键菜单传入
		} else {
			const direct = resolveCurrentUri();
			if (direct && IMAGE_EXT.test(direct.fsPath)) {
				candidates = [direct]; // 当前就是图片
			} else {
				const viaClip = await resolveViaClipboard();
				candidates = viaClip.length
					? viaClip.map((p) => ({ scheme: 'file', fsPath: p }))
					: (direct ? [direct] : []);
			}
		}
		if (!candidates.length) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.no_image'));
			return;
		}
		const images = [];
		for (const uri of candidates) {
			if (uri.scheme !== 'file') {
				vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.not_local'));
				return;
			}
			if (!IMAGE_EXT.test(uri.fsPath)) {
				vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.not_image', uri.fsPath));
				return;
			}
			if (!fs.existsSync(uri.fsPath)) {
				vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.file_missing', uri.fsPath));
				return;
			}
			images.push(uri.fsPath);
		}
		if (!fs.existsSync(psPath)) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.path_invalid', psPath));
			return;
		}

		// 3) 拉起 PS(支持一次多张图片;不等它退出,冷启动慢也不阻塞)
		try {
			const child = spawn(psPath, images, { detached: true, stdio: 'ignore' });
			child.on('error', (e) => vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.start_fail', describeError(e))));
			child.unref();
			vscode.window.showInformationMessage(vscode.l10n.t('src.extension.ps.sent', images.join(', ')));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('src.extension.ps.start_fail', describeError(err)));
		}
	});

	// ===== 工作区切换中心(手动分组版:标题栏按钮添加,右键菜单移除) =====
	const provider = new WorkspacesProvider(context);
	onRegistryChanged = () => provider.bump();
	const treeView = vscode.window.createTreeView('wpmanager.workspaces', { treeDataProvider: provider, showCollapseAll: false });
	// 约定:`_` 前缀命令永不贡献进 package.json(命令面板零噪音),仅供树内部使用
	const openEntryCmd = vscode.commands.registerCommand('wpmanager._openEntry', (entry, newWindow) => openEntry(context, provider, entry, newWindow));

	// 单击条目:展开/收起操作行(不直接切换);再次单击同一条目收起
	const selectEntryCmd = vscode.commands.registerCommand('wpmanager._selectEntry', (vm) => {
		if (!vm || typeof vm.id !== 'string') {
			return;
		}
		const key = dedupeKey(vm.id);
		if (provider.selectedId === key) {
			provider.selectedId = ''; // 再点同一条目:收起
		} else {
			provider.selectedId = key;
			provider.selectSeq++;
		}
		provider.bump();
	});
	// 操作行:忽略/取消忽略(忽略同时取消置顶,收进分组顶部「已忽略工作区」)
	const setIgnoredCmd = vscode.commands.registerCommand('wpmanager._setIgnored', async (vm, ignored) => {
		if (vm && typeof vm.id === 'string') {
			await setIgnored(context, vm.id, ignored === true);
		}
		provider.selectedId = '';
		provider.bump();
	});
	// 操作行:添加备用名(输入框,留空清除;树标签即时换名)
	const setAliasCmd = vscode.commands.registerCommand('wpmanager._setAlias', async (vm) => {
		if (!vm || typeof vm.id !== 'string') {
			return;
		}
		const reg = await loadRegistry(context);
		const stored = findEntry(reg, vm.id);
		const alias = await vscode.window.showInputBox({
			title: vscode.l10n.t('ws.alias.title', entryDisplayName(vm)),
			placeHolder: vscode.l10n.t('ws.alias.placeholder'),
			value: stored ? stored.alias : ''
		});
		if (alias === undefined) {
			return; // 取消
		}
		const nickname = alias.trim();
		// 备用名写入工作区文件 vscext_wpmanager.wpnickname(随文件走);非标准 JSON 拒写,绝不改写带注释的文件
		let obj;
		try {
			obj = JSON.parse(await fs.promises.readFile(vm.id, 'utf8'));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t((err && err.code === 'ENOENT') ? 'ws.entryMissing' : 'ws.alias.fileInvalid', vm.id));
			return;
		}
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
			vscode.window.showErrorMessage(vscode.l10n.t('ws.alias.fileInvalid', vm.id));
			return;
		}
		obj.vscext_wpmanager = Object.assign({}, obj.vscext_wpmanager, { wpnickname: nickname });
		try {
			await fs.promises.writeFile(vm.id, JSON.stringify(obj, null, '\t') + '\n');
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('ws.alias.writeFail', describeError(err)));
			return;
		}
		nicknameCache.delete(dedupeKey(vm.id)); // 自己刚写的,直接失效缓存(mtime 粒度不可靠)
		// 注册表 alias 同步一份(文件字段缺失时兜底显示)
		await setAlias(context, vm.id, nickname);
		provider.selectedId = '';
		provider.bump();
	});
	// 操作行:置顶/取消置顶(组内排序优先 + $(pinned) 前缀)
	const setPinnedCmd = vscode.commands.registerCommand('wpmanager._setPinned', async (vm, pinned) => {
		if (vm && typeof vm.id === 'string') {
			await setPinned(context, vm.id, pinned === true);
		}
		provider.selectedId = '';
		provider.bump();
	});

	// 添加单个 .code-workspace(标题栏按钮/命令面板)→ 归入「未归类」
	const addFileCmd = vscode.commands.registerCommand('wpmanager.addWorkspaceFile', async () => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFolders: false,
			canSelectFiles: true,
			title: vscode.l10n.t('ws.addFile.dialogTitle'),
			openLabel: vscode.l10n.t('ws.addFile.openLabel'),
			filters: { Workspace: ['code-workspace'] }
		});
		if (!picked || !picked.length) {
			return; // 用户取消
		}
		let added = 0;
		for (const uri of picked) {
			const result = await addWorkspaceFile(context, uri.fsPath);
			if (result === 'added') {
				added++;
			} else if (result === 'invalid') {
				vscode.window.showErrorMessage(vscode.l10n.t('ws.addFile.invalid', uri.fsPath));
			} else {
				vscode.window.showInformationMessage(vscode.l10n.t('ws.addFile.exists', uri.fsPath));
			}
		}
		if (added > 0) {
			vscode.window.showInformationMessage(vscode.l10n.t('ws.addFile.added', String(added)));
			provider.bump();
		}
	});

	// 添加多项目文件夹(标题栏按钮/命令面板)→ 建分组并扫描其子文件夹
	const addFolderCmd = vscode.commands.registerCommand('wpmanager.addProjectFolder', async () => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFolders: true,
			canSelectFiles: false,
			title: vscode.l10n.t('ws.addFolder.dialogTitle'),
			openLabel: vscode.l10n.t('ws.addFolder.openLabel')
		});
		if (!picked || !picked[0]) {
			return; // 用户取消
		}
		const dir = picked[0].fsPath;
		const added = await addProjectFolder(context, dir);
		vscode.window.showInformationMessage(vscode.l10n.t('ws.addFolder.added', path.basename(dir) || dir, String(added)));
		provider.bump();
	});

	// 从列表移除(右键菜单):条目单删;分组根删除整个分组及其条目。都不删磁盘文件
	const removeCmd = vscode.commands.registerCommand('wpmanager.removeWorkspaceEntry', async (item) => {
		const target = item && item.wsEntry ? item.wsEntry.id : (item && item.wsRoot ? item.wsRoot : '');
		if (!target) {
			vscode.window.showInformationMessage(vscode.l10n.t('ws.remove.hint'));
			return;
		}
		const removed = await removeById(context, target);
		if (removed) {
			vscode.window.showInformationMessage(vscode.l10n.t('ws.remove.done', path.basename(target) || target));
			provider.bump();
		}
	});

	// 视图可见不再全量重扫:正常情况零扫描(fs.watch 已保证分组镜像磁盘);
	// 仅当某根监听建立失败/中断时,可见时兑底重扫该根
	treeView.onDidChangeVisibility(async (ev) => {
		if (ev && ev.visible && watchBroken.size > 0) {
			const reg = await loadRegistry(context);
			for (const r of reg.roots) {
				if (watchBroken.has(dedupeKey(r.id))) {
					try {
						await scanRootFolder(context, r.id);
					} catch {
						// 兑底失败下次可见再试
					}
					startRootWatcher(context, r.id); // 顺手重试建立监听
				}
			}
			provider.bump();
		}
	});
	// 激活即补一轮,让首次展开视图时数据就绪
	refreshWorkspaces(context, provider).catch((e) => console.error('[wpmanager] initial refresh failed:', e));

	// 右键分组根/未归类:显示/隐藏「已忽略工作区」节点(默认隐藏;两条命令按 contextValue 切换文案,commandPalette 屏蔽)
	const makeIgnoredToggleCmd = (show) => vscode.commands.registerCommand(show ? 'wpmanager.showIgnoredWorkspaces' : 'wpmanager.hideIgnoredWorkspaces', async (item) => {
		if (item && (item.wsRoot || item.wsSection === 'ungrouped')) {
			await setShowIgnored(context, item, show);
			provider.bump();
		}
	});
	const showIgnoredCmd = makeIgnoredToggleCmd(true);
	const hideIgnoredCmd = makeIgnoredToggleCmd(false);
	context.subscriptions.push(generateCmd, newProjectCmd, copyPathCmd, editImgCmd, openEntryCmd, selectEntryCmd, setIgnoredCmd, setPinnedCmd, setAliasCmd, addFileCmd, addFolderCmd, removeCmd, showIgnoredCmd, hideIgnoredCmd, treeView, provider);
	__test.active = { provider, treeView };
}

function deactivate() {}

// __test:测试钩子(纯函数与数据层),生产路径不使用;active 由 activate() 注入
const __test = {
	dedupeKey, loadRegistry,
	addWorkspaceFile, addProjectFolder, scanRootFolder, removeById, refreshWorkspaces, stopAllWatchers
};
module.exports = { activate, deactivate, __test };
