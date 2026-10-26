// 冒烟测试:mock 掉 'vscode' 模块,直接调用命令 handler
// 运行:node test/smoke.js
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const log = [];
const handlers = {};
const mockGlobalState = {
	data: {},
	get(key) { return this.data[key]; },
	async update(key, value) { this.data[key] = value; log.push(`state:${key}=${value}`); }
};
const mockConfig = {};
let mockClip = '';
let copyPathResult = '';
let currentPick = null;
let mockTreeView = null;
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); } };

const mockVscode = {
	commands: {
		registerCommand: (id, fn) => {
			assert.ok(['wpmanager.generate', 'wpmanager.newproject', 'wpmanager.copycurrentpath', 'wpmanager.editimginPS', 'wpmanager._openEntry', 'wpmanager._selectEntry', 'wpmanager._setIgnored', 'wpmanager._setPinned', 'wpmanager._setAlias', 'wpmanager.addWorkspaceFile', 'wpmanager.addProjectFolder', 'wpmanager.removeWorkspaceEntry', 'wpmanager.showIgnoredWorkspaces', 'wpmanager.hideIgnoredWorkspaces'].includes(id), '未知命令: ' + id);
			handlers[id] = fn;
			return { dispose() {} };
		},
		executeCommand: async (cmd, ...args) => {
			log.push(`exec:${cmd}`);
			if (cmd === 'copyFilePath') { mockClip = copyPathResult; }
			if (cmd === 'vscode.openFolder') {
				// 记录完整参数,便于断言 uri 与 newWindow
				log[log.length - 1] = `exec:${cmd}:${args[0] && args[0].fsPath}:${args[1] === true}`;
			}
		}
	},
	l10n: {
		t: (key, ...args) => {
			let s = key;
			args.forEach((a, i) => { s = s.replace(`{${i}}`, String(a)); });
			return s;
		}
	},
	ThemeIcon: class { constructor(id) { this.id = id; } },
	TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	MarkdownString: class { constructor(value, supportIcons) { this.value = value || ''; this.supportThemeIcons = !!supportIcons; } appendMarkdown(t) { this.value += t; return this; } },
	EventEmitter: class {
		constructor() { this._cbs = []; }
		get event() { return (cb) => { this._cbs.push(cb); return { dispose() {} }; }; }
		fire(v) { this._cbs.slice().forEach((cb) => cb(v)); }
		dispose() {}
	},
	Uri: {
		joinPath: (base, name) => ({ scheme: 'file', fsPath: path.join(base.fsPath, name) }),
		file: (p) => ({ scheme: 'file', fsPath: p })
	},
	workspace: {
		workspaceFolders: null, // 每个用例单独设置
		getConfiguration: (section) => ({ get: (key) => mockConfig[section + '.' + key] }),
		fs: {
			stat: async (uri) => {
				if (fs.existsSync(uri.fsPath)) { return {}; }
				const e = new Error('FileNotFound'); e.code = 'FileNotFound'; throw e;
			},
			writeFile: async (uri, content) => {
				fs.writeFileSync(uri.fsPath, Buffer.from(content));
				log.push(`write:${uri.fsPath}`);
			},
			createDirectory: async (uri) => {
				fs.mkdirSync(uri.fsPath, { recursive: true });
				log.push(`mkdir:${uri.fsPath}`);
			}
		}
	},
	window: {
		showErrorMessage: (m) => { log.push(`error:${m}`); },
		showWarningMessage: async () => undefined,
		showQuickPick: async (items, opts) => { log.push(`pick:${opts && opts.placeHolder}`); return undefined; },
		showInputBox: async (opts) => { log.push(`input:${opts && opts.placeHolder}`); return undefined; },
		showOpenDialog: async (opts) => { log.push(`opendialog:${opts && opts.title}`); return undefined; },
		createQuickPick: () => {
			const listeners = {};
			const pick = {
				title: '', placeholder: '', value: '', items: [], selectedItems: [],
				matchOnDescription: false, matchOnDetail: false, ignoreFocusOut: false,
				validationMessage: undefined, shown: false,
				onDidAccept: (cb) => { listeners.accept = cb; return { dispose() {} }; },
				onDidTriggerItemButton: (cb) => { listeners.button = cb; return { dispose() {} }; },
				onDidHide: (cb) => { listeners.hide = cb; return { dispose() {} }; },
				onDidChangeValue: (cb) => { listeners.value = cb; return { dispose() {} }; },
				show: () => { pick.shown = true; currentPick = pick; log.push('qpick:show'); },
				hide: () => { pick.shown = false; log.push('qpick:hide'); if (listeners.hide) { listeners.hide(); } },
				_triggerAccept: () => { if (listeners.accept) { listeners.accept(); } },
				_triggerButton: (e) => { if (listeners.button) { listeners.button(e); } },
				_triggerHide: () => { if (listeners.hide) { listeners.hide(); } }
			};
			return pick;
		},
		createTreeView: (id, opts) => {
			const listeners = {};
			const tv = {
				treeDataProvider: opts.treeDataProvider,
				onDidChangeVisibility: (cb) => { listeners.vis = cb; return { dispose() {} }; },
				_triggerVisible: () => { if (listeners.vis) { listeners.vis({ visible: true }); } },
				dispose() {}
			};
			mockTreeView = tv;
			return tv;
		},
		showInformationMessage: async (m) => { log.push(`info:${m}`); return undefined; },
		activeTextEditor: null
	},
	env: {
		clipboard: {
			readText: async () => mockClip,
			writeText: async (text) => { log.push(`clip:${text}`); mockClip = text; }
		}
	}
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') { return mockVscode; }
	if (request === 'child_process') {
		return {
			spawn: (cmd, args) => { log.push(`spawn:${cmd}:${args.join(' ')}`); return { on() {}, unref() {} }; }
		};
	}
	return origLoad.call(this, request, ...rest);
};

process.chdir(path.join(__dirname, '..'));
const ext = require('../extension.js');
ext.activate({ subscriptions: [], globalState: mockGlobalState });
assert.strictEqual(typeof handlers['wpmanager.generate'], 'function', 'generate 命令应已注册');
assert.strictEqual(typeof handlers['wpmanager.newproject'], 'function', 'newproject 命令应已注册');
assert.strictEqual(typeof handlers['wpmanager.copycurrentpath'], 'function', 'copycurrentpath 命令应已注册');
assert.strictEqual(typeof handlers['wpmanager.editimginPS'], 'function', 'editimginPS 命令应已注册');
const handler = handlers['wpmanager.generate'];

(async () => {
	// 用例 1:没有打开文件夹 → 报错
	mockVscode.workspace.workspaceFolders = null;
	await handler();
	assert(log.some((l) => l.startsWith('error:')), '应弹出错误消息');

	// 用例 2:正常生成
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo_proj-'));
	mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
	await handler();

	const expected = path.join(root, `${path.basename(root)}.code-workspace`);
	assert(log.includes(`write:${expected}`), `应写入 ${expected}`);
	assert(fs.existsSync(expected), '文件应存在');

	const text = fs.readFileSync(expected, 'utf8');
	const parsed = JSON.parse(text); // 必须是合法 JSON(不能有尾逗号)
	assert.deepStrictEqual(Object.keys(parsed), ['folders', 'settings']);
	assert.strictEqual(parsed.folders[0].path, '.');
	assert.deepStrictEqual(parsed.settings, {
		'editor.tabSize': 4,
		'workbench.editor.showTabs': 'none',
		'explorer.openEditors.sortOrder': 'alphabetical',
		'workbench.colorTheme': 'Monokai',
		'editor.emptySelectionClipboard': false,
		'editor.formatOnPaste': true
	});
	assert(text.includes('\t'), '应使用 tab 缩进');
	assert(log.some((l) => l.startsWith('exec:vscode.openFolder')), '生成后应自动调用打开工作区');

	// 用例 3:文件已存在且用户选择不覆盖 → 不再写入
	log.length = 0;
	mockVscode.window.showWarningMessage = async () => undefined; // 用户点掉弹窗
	await handler();
	assert(!log.some((l) => l.startsWith('write:')), '不应覆盖');

	// 用例 4:多根工作区 → 弹出选择器,写入用户选中的第二个文件夹
	log.length = 0;
	const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'second_proj-'));
	mockVscode.workspace.workspaceFolders = [
		{ name: 'first', uri: { fsPath: root } },
		{ name: 'second', uri: { fsPath: root2 } }
	];
	mockVscode.window.showQuickPick = async (items) => { log.push('pick:override'); return items[1]; }; // 选第二个
	await handler();
	assert(log.some((l) => l.startsWith('pick:')), '应弹出文件夹选择器');
	const expected2 = path.join(root2, `${path.basename(root2)}.code-workspace`);
	assert(log.includes(`write:${expected2}`), `应写入第二个文件夹 ${expected2}`);
	assert(fs.existsSync(path.join(root, `${path.basename(root)}.code-workspace`)), '第一个文件夹不应新增文件(用例2已有文件应保留)');

	// 用例 5:stat 因非"不存在"原因失败(如权限) → 仍走覆盖确认,用户拒绝则不写入
	log.length = 0;
	const statOrig = mockVscode.workspace.fs.stat;
	mockVscode.workspace.fs.stat = async () => { const e = new Error('EACCES: permission denied'); e.code = 'Unknown'; throw e; };
	mockVscode.window.showWarningMessage = async (msg) => { log.push(`warn:${msg}`); return undefined; };
	await handler();
	assert(log.some((l) => l.startsWith('warn:')), 'stat 异常时应弹覆盖确认');
	assert(!log.some((l) => l.startsWith('write:')), '用户拒绝后不应写入');
	mockVscode.workspace.fs.stat = statOrig;

	// 用例 6:newproject → 空历史时只有浏览行;ESC 取消不进入 step2
	log.length = 0;
	const np = handlers['wpmanager.newproject'];
	const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
	delete mockGlobalState.data['wpmanager.projectDirHistory'];
	let npPromise = np();
	await flush();
	assert(currentPick, 'step1 应弹出目录选择 QuickPick');
	assert(currentPick.items.length === 1 && currentPick.items[0].browse === true, '空历史时只有浏览行');
	currentPick._triggerHide();
	await npPromise;
	assert(!log.some((l) => l.startsWith('input:')), '取消后不应再问项目名');

	// 用例 7:输入路径回车 → 记录历史 → step2 输入项目名 → 建目录+workspace+自动打开
	log.length = 0;
	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dirA-'));
	npPromise = np();
	await flush();
	currentPick.value = dirA;
	currentPick.selectedItems = [currentPick.items[0]]; // 浏览行被过滤后被动高亮(复现 bug 场景)
	currentPick._triggerAccept();
	mockVscode.window.showInputBox = async (opts) => { log.push(`input:${opts && opts.placeHolder}`); return 'my_app'; };
	await npPromise;
	const projDir = path.join(dirA, 'my_app');
	assert(log.includes(`mkdir:${projDir}`), `应创建项目文件夹 ${projDir}`);
	assert(log.includes(`write:${path.join(projDir, 'my_app.code-workspace')}`), '应生成 my_app.code-workspace');
	assert(log.some((l) => l.startsWith('exec:vscode.openFolder')), '应自动打开新项目工作区');
	assert(mockGlobalState.data['wpmanager.projectDirHistory'][0].dir === dirA, '选定目录应记入历史并置顶');

	// 用例 8:浏览选择目录(第二行) → 同样进入 step2 创建
	log.length = 0;
	const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dirB-'));
	mockVscode.window.showOpenDialog = async () => [{ fsPath: dirB }];
	npPromise = np();
	await flush();
	const browseItem = currentPick.items[0];
	assert(browseItem.browse === true, '第一项应是浏览');
	currentPick.selectedItems = [browseItem];
	currentPick._triggerAccept();
	await npPromise;
	assert(log.includes(`mkdir:${path.join(dirB, 'my_app')}`), '应通过浏览目录创建项目');
	assert(mockGlobalState.data['wpmanager.projectDirHistory'][0].dir === dirB, '浏览目录应记入历史置顶');

	// 用例 8b:浏览取消 → 弹窗重新显示,ESC 后流程取消且不问项目名(对话框期间 onDidHide 被抑制)
	log.length = 0;
	mockVscode.window.showOpenDialog = async () => undefined; // 用户取消对话框
	npPromise = np();
	await flush();
	currentPick.selectedItems = [currentPick.items[0]];
	currentPick._triggerAccept();
	await flush();
	assert(currentPick.shown === true, '取消浏览后弹窗应重新显示');
	assert(!log.some((l) => l.startsWith('input:')), '取消浏览不应进入 step2');
	currentPick._triggerHide();
	await npPromise;

	// 用例 9:选中历史目录 → 项目建在该目录,且历史置顶、其他条目备用名保留
	log.length = 0;
	const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'dirC-'));
	mockGlobalState.data['wpmanager.projectDirHistory'] = [
		{ dir: dirA, alias: '老目录' },
		{ dir: dirC, alias: '' }
	];
	npPromise = np();
	await flush();
	const itemC = currentPick.items.find((it) => it.dir === dirC);
	assert(itemC, '历史目录应显示');
	assert(itemC.buttons.length === 2 && itemC.buttons[0].iconPath.id === 'edit' && itemC.buttons[1].iconPath.id === 'trash', '按钮必须是 {iconPath:ThemeIcon} 形状(裸 ThemeIcon 会导致空白行)');
	currentPick.selectedItems = [itemC];
	currentPick._triggerAccept();
	await npPromise;
	assert(log.includes(`mkdir:${path.join(dirC, 'my_app')}`), '应建在选中的历史目录');
	const hist9 = mockGlobalState.data['wpmanager.projectDirHistory'];
	assert(hist9[0].dir === dirC && hist9.some((h) => h.dir === dirA && h.alias === '老目录'), '历史应置顶且保留其他条目备用名');

	// 用例 10:删除历史(trash 行内按钮)
	log.length = 0;
	npPromise = np();
	await flush();
	const itemA = currentPick.items.find((it) => it.dir === dirA);
	currentPick._triggerButton({ item: itemA, button: { iconPath: { id: 'trash' } } }); // 模拟真实序列化回传形状
	await flush();
	assert(!mockGlobalState.data['wpmanager.projectDirHistory'].some((h) => h.dir === dirA), 'trash 应删除该历史');
	assert(!currentPick.items.some((it) => it.dir === dirA), '列表应刷新');
	currentPick._triggerHide();
	await npPromise;

	// 用例 11:设置备用名(edit 行内按钮)
	log.length = 0;
	npPromise = np();
	await flush();
	const itemC2 = currentPick.items.find((it) => it.dir === dirC);
	mockVscode.window.showInputBox = async (opts) => { log.push(`alias:${opts && opts.title}`); return '我的项目盘'; };
	currentPick._triggerButton({ item: itemC2, button: { iconPath: { id: 'edit' } } });
	await flush();
	const entry11 = mockGlobalState.data['wpmanager.projectDirHistory'].find((h) => h.dir === dirC);
	assert(entry11 && entry11.alias === '我的项目盘', 'edit 应保存备用名');
	assert(currentPick.items.find((it) => it.dir === dirC).label.includes('我的项目盘'), '列表应显示备用名');
	mockVscode.window.showInputBox = async (opts) => { log.push(`input:${opts && opts.placeHolder}`); return undefined; };
	currentPick._triggerHide();
	await npPromise;

	// 用例 12:输入的路径不存在 → validationMessage 提示且不关弹窗、不创建
	log.length = 0;
	npPromise = np();
	await flush();
	currentPick.value = 'Z:\\不存在的目录\\nope';
	currentPick.selectedItems = [currentPick.items[0]]; // 同上:浏览行高亮但输入的是无效路径
	currentPick._triggerAccept();
	await flush();
	assert(currentPick.validationMessage, '路径无效应显示 validationMessage');
	assert(!log.some((l) => l.startsWith('mkdir:')), '不应创建任何东西');
	currentPick._triggerHide();
	await npPromise;

	// 用例 13:同名项目已存在 → 报错不覆盖;非法项目名 → 报错不创建
	log.length = 0;
	mockGlobalState.data['wpmanager.projectDirHistory'] = [{ dir: dirA, alias: '' }];
	npPromise = np();
	await flush();
	currentPick.selectedItems = [currentPick.items[1]];
	currentPick._triggerAccept();
	mockVscode.window.showInputBox = async () => 'my_app'; // dirA/my_app 已存在(用例 7)
	await npPromise;
	assert(log.some((l) => l.startsWith('error:')), '同名项目应报错');
	assert(!log.some((l) => l.startsWith('write:')), '不应覆盖已有项目');

	log.length = 0;
	npPromise = np();
	await flush();
	currentPick.selectedItems = [currentPick.items[1]];
	currentPick._triggerAccept();
	mockVscode.window.showInputBox = async () => 'bad:name';
	await npPromise;
	assert(log.some((l) => l.startsWith('error:')), '非法项目名应报错');
	assert(!log.some((l) => l.startsWith('mkdir:')), '不应创建文件夹');

	fs.rmSync(dirA, { recursive: true, force: true });
	fs.rmSync(dirB, { recursive: true, force: true });
	fs.rmSync(dirC, { recursive: true, force: true });
	// 用例 14:copycurrentpath → 无打开文件时报错
	log.length = 0;
	const cp = handlers['wpmanager.copycurrentpath'];
	mockVscode.window.activeTextEditor = null;
	await cp();
	assert(log.some((l) => l.startsWith('error:')), '无打开文件应报错');
	assert(!log.some((l) => l.startsWith('clip:')), '不应写剪贴板');

	// 用例 15:copycurrentpath → 未保存的 untitled 文档报错
	log.length = 0;
	mockVscode.window.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: '' } } };
	await cp();
	assert(log.some((l) => l.startsWith('error:')), 'untitled 文档应报错');
	assert(!log.some((l) => l.startsWith('clip:')), '不应写剪贴板');

	// 用例 16:copycurrentpath → 正常复制当前文件绝对路径
	log.length = 0;
	const filePath = path.join(root, 'some', 'file.txt');
	mockVscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: filePath } } };
	await cp();
	assert(log.includes(`clip:${filePath}`), `应复制绝对路径 ${filePath}`);
	assert(log.some((l) => l.startsWith('info:')), '应提示已复制');

	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(root2, { recursive: true, force: true });
	fs.rmSync(projectsRoot, { recursive: true, force: true });

	// 用例 17:editimginPS → 未配置 PS 路径 → 提示去设置,按钮直达设置项
	log.length = 0;
	const ep = handlers['wpmanager.editimginPS'];
	mockVscode.window.showWarningMessage = async (m, ...btns) => { log.push(`warn:${m}`); return btns[0]; };
	await ep();
	assert(log.some((l) => l.startsWith('warn:')), '未配置 PS 路径应提示去设置');
	assert(log.includes('exec:workbench.action.openSettings'), '应打开设置页');

	// 用例 18:已配置 PS 路径但没有打开图片 → 报错
	log.length = 0;
	const psDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mock-'));
	const fakePs = path.join(psDir, 'Photoshop.exe');
	fs.writeFileSync(fakePs, '');
	mockConfig['wpmanager.photoshopPath'] = fakePs;
	mockVscode.window.activeTextEditor = null;
	await ep();
	assert(log.some((l) => l.startsWith('error:')), '没有打开图片应报错');
	assert(!log.some((l) => l.startsWith('spawn:')), '不应拉起 PS');

	// 用例 19:正常发送图片到 PS(右键菜单传入 resource)
	log.length = 0;
	const imgPath = path.join(psDir, 'cover.png');
	fs.writeFileSync(imgPath, 'png');
	await ep({ scheme: 'file', fsPath: imgPath });
	assert(log.includes(`spawn:${fakePs}:${imgPath}`), '应把图片路径传给 Photoshop');
	assert(log.some((l) => l.startsWith('info:')), '应提示已发送');

	// 用例 20:非图片文件 → 报错且不拉起 PS
	log.length = 0;
	await ep({ scheme: 'file', fsPath: path.join(psDir, 'notes.txt') });
	assert(log.some((l) => l.startsWith('error:')), '非图片文件应报错');
	assert(!log.some((l) => l.startsWith('spawn:')), '不应拉起 PS');

	// 用例 21:PS 路径配置了但文件不存在 → 报错引导改设置
	log.length = 0;
	mockConfig['wpmanager.photoshopPath'] = path.join(psDir, 'missing.exe');
	await ep({ scheme: 'file', fsPath: imgPath });
	assert(log.some((l) => l.startsWith('error:')), 'PS 路径无效应报错');
	assert(!log.some((l) => l.startsWith('spawn:')), '不应拉起 PS');

	// 用例 22:资源管理器选中但未打开的图片 → 通过 copyFilePath + 剪贴板往返解析
	log.length = 0;
	mockConfig['wpmanager.photoshopPath'] = fakePs;
	const selImg = path.join(psDir, 'sel.png');
	fs.writeFileSync(selImg, 'png');
	const prevClip = 'user clipboard text';
	mockClip = prevClip;
	copyPathResult = selImg;
	await ep();
	assert(log.includes(`spawn:${fakePs}:${selImg}`), '应解析出资源管理器选中图片并拉起 PS');
	assert(mockClip === prevClip, '应恢复用户剪贴板');

	// 用例 23:copyFilePath 未改写剪贴板(没解析到文件) → 报错且不拉起 PS
	log.length = 0;
	mockClip = 'x.png';
	copyPathResult = 'x.png';
	await ep();
	assert(log.some((l) => l.startsWith('error:')), '未解析到图片应报错');
	assert(!log.some((l) => l.startsWith('spawn:')), '不应拉起 PS');
	fs.rmSync(psDir, { recursive: true, force: true });

	// ==================== P1:工作区切换中心(手动分组版) ====================
	// 用例 24:视图创建 + 命令注册 + 空注册表空态 + 空态不写盘
	log.length = 0;
	delete mockGlobalState.data['wpmanager.workspaceRegistry'];
	mockVscode.workspace.workspaceFile = undefined;
	mockVscode.workspace.workspaceFolders = null;
	mockConfig['wpmanager.scanMaxDepth'] = 3;
	delete mockConfig['wpmanager.scanExcludeNames'];
	mockVscode.window.showWarningMessage = async (m) => { log.push(`warn:${m}`); return undefined; };
	await flush(); // 等激活时发起的初始 refresh 收尾
	assert(mockTreeView, 'activate 应创建工作区树视图');
	assert(mockTreeView.treeDataProvider, '树视图应持有 provider');
	const provider = ext.__test.active.provider;
	assert(typeof handlers['wpmanager._openEntry'] === 'function', '内部打开命令应已注册');
	assert(typeof handlers['wpmanager.addWorkspaceFile'] === 'function', '添加文件命令应已注册');
	assert(typeof handlers['wpmanager.addProjectFolder'] === 'function', '添加文件夹命令应已注册');
	assert(typeof handlers['wpmanager.removeWorkspaceEntry'] === 'function', '移除命令应已注册');
	const roots0 = await provider.getChildren();
	assert(roots0.length === 1 && roots0[0].contextValue === 'empty', '空注册表应显示空态节点');
	assert(!mockGlobalState.data['wpmanager.workspaceRegistry'], '空状态下不应写入注册表');

	// 用例 25:路径去重键(Windows 大小写不敏感)
	if (process.platform === 'win32') {
		assert.strictEqual(ext.__test.dedupeKey('D:\\A\\B\\c'), 'd:\\a\\b\\c', 'win32 比较键应小写');
	}

	// 用例 26:添加单个 .code-workspace → 未归类;重复去重;非法扩展报错
	const ctx = { globalState: mockGlobalState };
	const loneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslone-'));
	const loneWs = path.join(loneDir, 'lone.code-workspace');
	fs.writeFileSync(loneWs, '{}');
	const loneTxt = path.join(loneDir, 'notes.txt');
	fs.writeFileSync(loneTxt, 'x');
	mockVscode.window.showOpenDialog = async () => [{ scheme: 'file', fsPath: loneWs }];
	await handlers['wpmanager.addWorkspaceFile']();
	let regData = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(regData && regData.version === 3 && regData.roots.length === 0 && regData.entries.length === 1, '应写入 v3 结构且无分组根');
	assert(regData.entries[0].root === '' && regData.entries[0].id === path.normalize(loneWs), '单文件应落未归类(root="")');
	await handlers['wpmanager.addWorkspaceFile']();
	assert(mockGlobalState.data['wpmanager.workspaceRegistry'].entries.length === 1, '重复添加应去重');
	log.length = 0;
	mockVscode.window.showOpenDialog = async () => [{ scheme: 'file', fsPath: loneTxt }];
	await handlers['wpmanager.addWorkspaceFile']();
	assert(log.some((l) => l.startsWith('error:')), '非 .code-workspace 应报错');
	assert(mockGlobalState.data['wpmanager.workspaceRegistry'].entries.length === 1, '非法文件不应入库');

	// 用例 27:添加多项目文件夹 → 分组根 + 扫描子文件夹(排除名 + 深度上限 + 幂等)
	const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscan-'));
	fs.mkdirSync(path.join(scanRoot, 'a', 'b', 'c'), { recursive: true });
	fs.mkdirSync(path.join(scanRoot, 'node_modules'), { recursive: true });
	fs.writeFileSync(path.join(scanRoot, 'one.code-workspace'), '{}');
	fs.writeFileSync(path.join(scanRoot, 'a', 'two.code-workspace'), '{}');
	fs.writeFileSync(path.join(scanRoot, 'a', 'b', 'three.code-workspace'), '{}');
	fs.writeFileSync(path.join(scanRoot, 'a', 'b', 'c', 'four.code-workspace'), '{}');
	fs.writeFileSync(path.join(scanRoot, 'node_modules', 'five.code-workspace'), '{}');
	mockVscode.window.showOpenDialog = async () => [{ scheme: 'file', fsPath: scanRoot }];
	await handlers['wpmanager.addProjectFolder']();
	regData = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(regData.roots.length === 1 && regData.roots[0].id === path.normalize(scanRoot), '应登记分组根');
	assert(regData.entries.length === 4, '未归类 1 + 扫描 3(four 超深、five 被排除)');
	assert(regData.entries.filter((e) => e.root === path.normalize(scanRoot)).length === 3, '扫描条目应归属分组根');
	await handlers['wpmanager.addProjectFolder']();
	assert(mockGlobalState.data['wpmanager.workspaceRegistry'].roots.length === 1, '重复添加文件夹应去重');
	assert(mockGlobalState.data['wpmanager.workspaceRegistry'].entries.length === 4, '重复扫描应幂等');

	// 用例 28:扫描不抢其他分组的条目
	const sixWs = path.join(scanRoot, 'six.code-workspace');
	fs.writeFileSync(sixWs, '{}');
	assert(await ext.__test.addWorkspaceFile(ctx, sixWs) === 'added', '应先手动加入未归类');
	assert(await ext.__test.scanRootFolder(ctx, scanRoot) === 0, '已在未归类的文件扫描时不应重复入库');
	const sixEntry = mockGlobalState.data['wpmanager.workspaceRegistry'].entries.find((e) => e.id === path.normalize(sixWs));
	assert(sixEntry && sixEntry.root === '', '未归类条目不应被扫描抢走');

	// 用例 29:移除——单条删除;分组根级联删除整个分组(不动磁盘文件)
	assert(await ext.__test.removeById(ctx, loneWs) === true, '应删除单条');
	assert(!mockGlobalState.data['wpmanager.workspaceRegistry'].entries.some((e) => e.id === path.normalize(loneWs)), '单条应已移除');
	assert(await ext.__test.removeById(ctx, scanRoot) === true, '应删除分组');
	regData = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(regData.roots.length === 0, '分组根应已移除');
	assert(regData.entries.length === 1 && regData.entries[0].id === path.normalize(sixWs), '分组条目应级联移除,未归类条目保留');
	assert(fs.existsSync(path.join(scanRoot, 'one.code-workspace')), '移除不应动磁盘文件');

	// 用例 30:树结构——分组根(按添加序)+ 未归类 + 组内按名称排序 + id 唯一
	fs.writeFileSync(loneWs, '{}'); // 重建文件供后续用例
	mockVscode.window.showOpenDialog = async () => [{ scheme: 'file', fsPath: loneWs }];
	await handlers['wpmanager.addWorkspaceFile']();
	mockVscode.window.showOpenDialog = async () => [{ scheme: 'file', fsPath: scanRoot }];
	await handlers['wpmanager.addProjectFolder']();
	const groups = await provider.getChildren();
	const rootGroup = groups.find((g) => g.wsRoot === path.normalize(scanRoot));
	const ungrouped = groups.find((g) => g.wsSection === 'ungrouped');
	assert(rootGroup && rootGroup.label === path.basename(scanRoot) && rootGroup.description === path.dirname(scanRoot), '分组根 label=文件夹名 description=父目录');
	assert(rootGroup.iconPath.id === 'folder-library' && rootGroup.wsRoot === path.normalize(scanRoot), '分组根图标与 wsRoot');
	assert(ungrouped && ungrouped.label === 'ws.group.ungrouped' && ungrouped.iconPath.id === 'archive', '未归类分组(内置)');
	const rootItems = await provider.getChildren(rootGroup);
	assert(rootItems.length === 3 && rootItems[0].label === 'one.code-workspace' && rootItems[1].label === 'three.code-workspace' && rootItems[2].label === 'two.code-workspace', '组内按名称排序(one/three/two)');
	const ungroupedItems = await provider.getChildren(ungrouped);
	assert(ungroupedItems.length === 2 && ungroupedItems[0].label === 'lone.code-workspace' && ungroupedItems[1].label === 'six.code-workspace', '未归类组应含 lone/six(按名称排序)');
	const allIds = groups.map((g) => g.id).concat(rootItems.map((i) => i.id)).concat(ungroupedItems.map((i) => i.id));
	assert(new Set(allIds).size === allIds.length, 'TreeItem id 必须唯一');
	const oneItem = rootItems[0];
	assert(oneItem.description === path.dirname(oneItem.wsEntry.id), '常规行 description=父目录');
	assert(oneItem.contextValue === 'entry' && oneItem.iconPath.id === 'window', '常规行 contextValue 与图标(window)');
	assert(oneItem.command && oneItem.command.command === 'wpmanager._selectEntry', '单击绑定选中命令(不直接切换)');
	assert(oneItem.checkboxState === undefined, '已无收藏 checkbox');

	// 用例 31:失效标记(stat 失败 → stale)+ 失效条目单击只提示不切换
	fs.rmSync(path.join(scanRoot, 'a', 'b', 'three.code-workspace'), { force: true });
	const rootItems2 = await provider.getChildren(rootGroup);
	const staleItem = rootItems2.find((i) => i.wsEntry.id.endsWith('three.code-workspace'));
	assert(staleItem && staleItem.wsEntry.stale === true, '文件删除后应标记 stale');
	assert(staleItem.iconPath.id === 'circle-slash' && staleItem.description === 'ws.stale', '失效行图标与说明');
	assert(staleItem.contextValue.includes('stale'), '失效行 contextValue 带 stale');
	log.length = 0;
	await handlers['wpmanager._openEntry'](staleItem.wsEntry, false);
	assert(log.some((l) => l.startsWith('warn:')), '失效条目单击应提示');
	assert(!log.some((l) => l.startsWith('exec:vscode.openFolder')), '失效条目不应切换');

	// 用例 32:刷新镜像磁盘——分组内消失的条目被清理,未归类条目不清理
	fs.rmSync(loneWs, { force: true });
	await ext.__test.refreshWorkspaces(ctx, provider);
	regData = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(!regData.entries.some((e) => e.id.endsWith('three.code-workspace')), '分组内消失的文件应被清理');
	assert(regData.entries.some((e) => e.id === path.normalize(loneWs)), '未归类条目即使文件消失也不清理(仅标失效)');

	// 用例 33:单击切换 → 先写注册表再 openFolder(uri, false),打开计数+1
	log.length = 0;
	await handlers['wpmanager._openEntry'](oneItem.wsEntry, false);
	const stateIdx = log.findIndex((l) => l.startsWith('state:wpmanager.workspaceRegistry='));
	const execIdx = log.findIndex((l) => l.startsWith('exec:vscode.openFolder:'));
	assert(stateIdx >= 0 && execIdx > stateIdx, '必须先写打开记录再切换(同窗切换会重载窗口)');
	assert(log.includes(`exec:vscode.openFolder:${oneItem.wsEntry.id}:false`), '同窗切换 newWindow=false');
	const after33 = mockGlobalState.data['wpmanager.workspaceRegistry'].entries.find((e) => e.id === oneItem.wsEntry.id);
	assert(after33.openCount === 1 && after33.lastOpenedAt > 0, '打开记录应写入');

	// 用例 34:当前工作区标记(图标 folder-active + contextValue current)
	mockVscode.workspace.workspaceFile = { scheme: 'file', fsPath: oneItem.wsEntry.id };
	const rootItems3 = await provider.getChildren(rootGroup);
	const oneItem2 = rootItems3.find((i) => i.wsEntry.id === oneItem.wsEntry.id);
	assert(oneItem2.iconPath.id === 'folder-active' && oneItem2.contextValue.includes('current'), '当前条目应高亮标记');

	// 用例 35:视图可见不再全量重扫(fs.watch 事件驱动);磁盘变化由防抖后的单根扫描合入
	fs.writeFileSync(path.join(scanRoot, 'seven.code-workspace'), '{}');
	mockTreeView._triggerVisible();
	await flush();
	assert(!mockGlobalState.data['wpmanager.workspaceRegistry'].entries.some((e) => e.id.endsWith('seven.code-workspace')), '监听健康时视图可见不应触发全量重扫');
	assert(await ext.__test.scanRootFolder(ctx, scanRoot) === 1, 'watch 防抖后的单根扫描应合入新文件');

	// 用例 36:单击条目 → 变为可展开父节点,操作行作为其子级(真实缩进分层);再次单击收起;换选迁移
	log.length = 0;
	await handlers['wpmanager._selectEntry'](oneItem.wsEntry);
	let rootItems4 = await provider.getChildren(rootGroup);
	const selRow = rootItems4.find((i) => i.wsEntry && i.wsEntry.id === oneItem.wsEntry.id);
	assert(selRow && selRow.collapsibleState === mockVscode.TreeItemCollapsibleState.Expanded, '选中条目应变为 Expanded 父节点');
	assert(selRow.id.includes('::sel'), '选中态使用独立 id(避开折叠状态持久化)');
	assert(selRow.wsActions === true, '选中条目应携带 wsActions 标记');
	const actions = await provider.getChildren(selRow);
	assert(actions.length === 5, '操作行=切换/打开/置顶/备用名/忽略');
	assert(actions[0].command.command === 'wpmanager._openEntry' && actions[0].command.arguments[1] === false, '第一项=切换到该工作区(本窗口)');
	assert(actions[1].command.command === 'wpmanager._openEntry' && actions[1].command.arguments[1] === true, '第二项=打开工作区(新窗口)');
	assert(actions[2].command.command === 'wpmanager._setPinned' && actions[3].command.command === 'wpmanager._setAlias' && actions[4].command.command === 'wpmanager._setIgnored', '后三项=置顶→备用名→忽略');
	assert(actions.every((i) => i.contextValue === 'action' && i.iconPath && i.iconPath.id), '操作行均带图标(iconPath 呈现)');
	await handlers['wpmanager._selectEntry'](oneItem.wsEntry); // 再点收起
	rootItems4 = await provider.getChildren(rootGroup);
	const row4 = rootItems4.find((i) => i.wsEntry && i.wsEntry.id === oneItem.wsEntry.id);
	assert(row4 && row4.collapsibleState === mockVscode.TreeItemCollapsibleState.None && !row4.wsActions, '再次单击应收起(变回叶子)');
	const twoRow = rootItems4.find((i) => i.wsEntry && i.wsEntry.id.endsWith('two.code-workspace'));
	await handlers['wpmanager._selectEntry'](twoRow.wsEntry);
	rootItems4 = await provider.getChildren(rootGroup);
	const selRow2 = rootItems4.find((i) => i.wsEntry && i.wsEntry.id.endsWith('two.code-workspace'));
	assert(selRow2 && selRow2.id.includes('::sel'), '换选应迁移到新条目');
	assert(!rootItems4.some((i) => i.wsEntry && i.wsEntry.id === oneItem.wsEntry.id && i.id.includes('::sel')), '旧条目应退出选中态');

	// 用例 37:忽略 → 收进分组顶部「已忽略工作区」;忽略会清置顶;取消忽略恢复
	const ignoreAct = (await provider.getChildren(selRow2)).find((i) => i.command.command === 'wpmanager._setIgnored');
	await handlers['wpmanager._setIgnored'](...ignoreAct.command.arguments); // 忽略 two
	let groups2 = await provider.getChildren();
	const rootGroup2 = groups2.find((g) => g.wsRoot === path.normalize(scanRoot));
	assert(rootGroup2.contextValue.includes('ign-hidden') && !rootGroup2.contextValue.includes('ign-shown'), '已忽略节点默认隐藏(contextValue 标记)');
	let rootRows = await provider.getChildren(rootGroup2);
	assert(!rootRows.some((i) => i.contextValue === 'ignored'), '默认不渲染已忽略节点');
	await handlers['wpmanager.showIgnoredWorkspaces'](rootGroup2); // 右键:显示已忽略项目
	groups2 = await provider.getChildren();
	const rootGroup2b = groups2.find((g) => g.wsRoot === path.normalize(scanRoot));
	assert(rootGroup2b.contextValue.includes('ign-shown'), '显示开关应切换 contextValue');
	rootRows = await provider.getChildren(rootGroup2b);
	const ignoredNode = rootRows.find((i) => i.contextValue === 'ignored');
	assert(ignoredNode && ignoredNode.label === 'ws.group.ignored' && ignoredNode.iconPath.id === 'eye-closed' && rootRows[0] === ignoredNode, '开启后分组顶部出现「已忽略工作区」节点');
	let ignoredChildren = await provider.getChildren(ignoredNode);
	assert(ignoredChildren.length === 1 && ignoredChildren[0].label === 'two.code-workspace', '被忽略条目应收进已忽略节点');
	// 置顶后忽略:置顶被清除
	const sevenEntry = mockGlobalState.data['wpmanager.workspaceRegistry'].entries.find((e) => e.id.endsWith('seven.code-workspace'));
	await handlers['wpmanager._setPinned'](sevenEntry, true);
	await handlers['wpmanager._setIgnored'](sevenEntry, true);
	const sevenAfter = mockGlobalState.data['wpmanager.workspaceRegistry'].entries.find((e) => e.id.endsWith('seven.code-workspace'));
	assert(sevenAfter.ignored === true && sevenAfter.pinned === false, '忽略应同时清置顶');
	// 被忽略条目也能展开操作行 → 取消忽略
	ignoredChildren = await provider.getChildren(ignoredNode);
	const twoIgnoredRow = ignoredChildren.find((i) => i.wsEntry && i.wsEntry.id.endsWith('two.code-workspace'));
	await handlers['wpmanager._selectEntry'](twoIgnoredRow.wsEntry);
	ignoredChildren = await provider.getChildren(ignoredNode);
	const twoSelectedRow = ignoredChildren.find((i) => i.wsEntry && i.wsEntry.id.endsWith('two.code-workspace'));
	assert(twoSelectedRow && twoSelectedRow.wsActions === true, '被忽略条目选中后同样变为可展开父节点');
	const unignoreAct = (await provider.getChildren(twoSelectedRow)).find((i) => i.command.command === 'wpmanager._setIgnored');
	assert(unignoreAct && unignoreAct.label === 'ws.act.unignore' && unignoreAct.iconPath.id === 'eye', '被忽略条目子级操作行应为取消忽略(iconPath 呈现图标)');
	await handlers['wpmanager._setIgnored'](...unignoreAct.command.arguments);
	rootRows = await provider.getChildren(rootGroup2);
	assert(rootRows.some((i) => i.wsEntry && i.wsEntry.id.endsWith('two.code-workspace')), '取消忽略应回到普通列表');

	// 用例 38:置顶 → 组内排序最前 + pinned 图标;取消置顶恢复(用 two:one 是当前工作区,当前图标优先级更高)
	await handlers['wpmanager._setPinned'](twoRow.wsEntry, true);
	let rootRows3 = await provider.getChildren(rootGroup2);
	const normalRows = rootRows3.filter((i) => i.contextValue && i.contextValue.startsWith('entry'));
	assert(normalRows[0].label === 'two.code-workspace' && normalRows[0].iconPath.id === 'pinned', '置顶条目排最前且用 pinned 图标(label 不再拼 $(codicon))');
	await handlers['wpmanager._setPinned'](twoRow.wsEntry, false);
	rootRows3 = await provider.getChildren(rootGroup2);
	assert(rootRows3.find((i) => i.wsEntry && i.wsEntry.id === twoRow.wsEntry.id).iconPath.id === 'window', '取消置顶恢复 window 图标');

	// 用例 39:忽略条目在镜像磁盘刷新中存活
	await handlers['wpmanager._setIgnored'](twoRow.wsEntry, true);
	await handlers['wpmanager._setIgnored']({ id: sixWs }, true);
	await ext.__test.refreshWorkspaces(ctx, provider);
	const regAfter39 = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(regAfter39.entries.find((e) => e.id.endsWith('two.code-workspace')).ignored === true, '分组内被忽略条目重扫后应保留忽略状态');
	assert(regAfter39.entries.find((e) => e.id === path.normalize(sixWs)).ignored === true, '未归类被忽略条目重扫后应保留');
	groups2 = await provider.getChildren();
	const ungroupedGroup2 = groups2.find((g) => g.wsSection === 'ungrouped');
	assert(ungroupedGroup2.contextValue.includes('ign-hidden'), '未归类组默认也隐藏已忽略节点');
	await handlers['wpmanager.showIgnoredWorkspaces'](ungroupedGroup2);
	assert((await provider.getChildren(ungroupedGroup2)).some((i) => i.contextValue === 'ignored'), '未归类组开启后也显示已忽略节点');

	// 用例 41:已忽略节点显示状态持久化(roots[].showIgnored / ungroupedShowIgnored)+ 隐藏往返
	const regMeta = mockGlobalState.data['wpmanager.workspaceRegistry'];
	assert(regMeta.roots.find((r) => r.id === path.normalize(scanRoot)).showIgnored === true, '分组根的显示开关应持久化');
	assert(regMeta.ungroupedShowIgnored === true, '未归类的显示开关应持久化');
	await handlers['wpmanager.hideIgnoredWorkspaces'](groups2.find((g) => g.wsRoot === path.normalize(scanRoot)));
	assert(mockGlobalState.data['wpmanager.workspaceRegistry'].roots.find((r) => r.id === path.normalize(scanRoot)).showIgnored === false, '隐藏应写回 false');
	const rootGroup3 = (await provider.getChildren()).find((g) => g.wsRoot === path.normalize(scanRoot));
	assert(rootGroup3.contextValue.includes('ign-hidden') && !rootGroup3.contextValue.includes('ign-shown'), '隐藏后 contextValue 切回');
	assert(!(await provider.getChildren(rootGroup3)).some((i) => i.contextValue === 'ignored'), '隐藏后已忽略节点不再渲染');

	// 用例 40:添加备用名 → 写入工作区文件 vscext_wpmanager.wpnickname 并作为显示名;清空恢复;坏 JSON 拒写
	mockVscode.window.showInputBox = async () => '备用一号';
	await handlers['wpmanager._setAlias'](oneItem.wsEntry);
	const oneFile = JSON.parse(fs.readFileSync(oneItem.wsEntry.id, 'utf8'));
	assert(oneFile.vscext_wpmanager && oneFile.vscext_wpmanager.wpnickname === '备用一号', '备用名应写入工作区文件 vscext_wpmanager.wpnickname');
	let rootRows5 = await provider.getChildren(rootGroup2);
	assert(rootRows5.find((i) => i.wsEntry && i.wsEntry.id === oneItem.wsEntry.id).label === '备用一号', '文件内昵称应作为显示名');
	mockVscode.window.showInputBox = async () => '';
	await handlers['wpmanager._setAlias'](oneItem.wsEntry);
	const oneFile2 = JSON.parse(fs.readFileSync(oneItem.wsEntry.id, 'utf8'));
	assert(oneFile2.vscext_wpmanager.wpnickname === '', '清空应写入空昵称');
	rootRows5 = await provider.getChildren(rootGroup2);
	assert(rootRows5.find((i) => i.wsEntry && i.wsEntry.id === oneItem.wsEntry.id).label === 'one.code-workspace', '清空后恢复默认名');
	// 非 JSON 工作区文件 → 报错且绝不改写原文件
	const badWs = path.join(scanRoot, 'bad.code-workspace');
	fs.writeFileSync(badWs, '{ // 带注释的坏 JSON');
	assert(await ext.__test.addWorkspaceFile(ctx, badWs) === 'added', '坏 JSON 文件也应能先入列表');
	log.length = 0;
	mockVscode.window.showInputBox = async () => '不该写入';
	await handlers['wpmanager._setAlias']({ id: badWs });
	assert(log.some((l) => l.startsWith('error:')), '非 JSON 文件应报错');
	assert(fs.readFileSync(badWs, 'utf8') === '{ // 带注释的坏 JSON', '坏文件不应被改写');

	// 清理 P1 临时目录(先停磁盘监听,Windows 下不关 watch 删目录会 EBUSY)
	ext.__test.stopAllWatchers();
	fs.rmSync(scanRoot, { recursive: true, force: true });
	fs.rmSync(loneDir, { recursive: true, force: true });
	console.log('OK: 42 个用例全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
