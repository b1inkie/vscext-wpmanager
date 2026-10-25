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

	context.subscriptions.push(generateCmd, newProjectCmd, copyPathCmd, editImgCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
