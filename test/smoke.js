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
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); } };

const mockVscode = {
	commands: {
		registerCommand: (id, fn) => {
			assert.ok(['wpmanager.generate', 'wpmanager.newproject', 'wpmanager.copycurrentpath', 'wpmanager.editimginPS'].includes(id), '未知命令: ' + id);
			handlers[id] = fn;
			return { dispose() {} };
		},
		executeCommand: async (cmd) => { log.push(`exec:${cmd}`); if (cmd === 'copyFilePath') { mockClip = copyPathResult; } }
	},
	l10n: {
		t: (key, ...args) => {
			let s = key;
			args.forEach((a, i) => { s = s.replace(`{${i}}`, String(a)); });
			return s;
		}
	},
	ThemeIcon: class { constructor(id) { this.id = id; } },
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
	assert(log.includes('exec:vscode.openFolder'), '生成后应自动调用打开工作区');

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
	assert(log.includes('exec:vscode.openFolder'), '应自动打开新项目工作区');
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
	console.log('OK: 24 个用例全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
