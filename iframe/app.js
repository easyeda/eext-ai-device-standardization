/* eslint-disable no-template-curly-in-string */
/**
 * AI器件标准化 - iframe 业务逻辑
 *
 * 运行于 EasyEDA Pro iframe 环境中，可直接调用 eda API。
 * 数据来源：主进程存入 sys_Storage 的原理图器件数据，或用户上传的 BOM 文件。
 */
/* global eda, JSZip */
(function () {
	// 提前定义，防止 onclick 在 init() 完成前触发时报错
	window.__app = window.__app || {};
	const PLUGIN_TAG = '[BomSmartMatch]';

	// ============ 状态管理 ============
	let bomData = []; // 分组后的 BOM 数据
	let matchResults = {}; // 匹配结果缓存 { groupKey: { bestMatch, candidates, matchScore } }
	let bindStatus = {}; // 绑定状态 { designator: { bound, deviceInfo } }
	let currentDetailKey = ''; // 当前详情面板展示的分组 key
	let selectedCandidateIdx = {}; // { groupKey: number } 当前选中的候选索引
	const selectedDesignators = new Set();
	let bomColumns = []; // BOM 原始列名

	let matchColumns = []; // 匹配依据列（多选）
	const matchTarget = 'device'; // 匹配目标：'device'=器件库, 'symbol'=符号库, 'footprint'=封装库
	let libraryList = []; // 库列表 [{name, uuid}]
	let specialLibraries = []; // 特殊库 [{name, uuid}]（收藏/个人/工程/系统）
	let selectedLibraryUuid = ''; // 选中的库 UUID（空=全部库）
	const expandedDesignatorSets = new Set();
	const designatorToPrimitiveId = {}; // 位号 → primitiveId 映射（用于绑定）
	const searchCache = {}; // 搜索结果缓存 { keyword: results }
	let currentEditingKey = ''; // 当前编辑的分组 key
	const aiSettings = { enabled: false, apiUrl: '', apiKey: '', model: 'gpt-4o-mini', batchSend: false, contextSize: 128 }; // AI 设置（contextSize 单位: K tokens）
	// 绑定选项（三个复选框）
	let bindOptions = {
		keepDesignatorId: true, // 保留位号和唯一ID
		keepSymbol: true, // 保留当前符号
		keepFootprint: false, // 保留当前封装
	};
	// 绑定检测逻辑：'fp'=检查EasyEDA封装, 'lcsc'=检查LCSC, 'fp_or_lcsc'=封装或LCSC, 'any'=有器件即可
	let bindDetectMode = 'fp_or_lcsc';
	let fallbackFootprintEnabled = false; // 匹配不到器件时降级匹配封装
	let footprintColumn = ''; // 封装列（从 bomColumns 中选择）

	// ============ 主题管理 ============
	let themePreference = 'auto'; // 'auto' | 'dark' | 'light'
	let lastSystemTheme = 'light';

	// ============ 表格列配置 ============
	const tableColumns = [
		{ key: 'checkbox', label: '', visible: true, fixed: true, width: 55, sortable: false },
		{ key: 'designator', label: '位号', visible: true, fixed: false, width: 150, sortable: true },
		{ key: 'mpn', label: '型号', visible: true, fixed: false, width: 180, sortable: true },
		{ key: 'qty', label: '数量', visible: true, fixed: false, width: 60, sortable: true },
		{ key: 'footprint', label: '封装', visible: true, fixed: false, width: 140, sortable: true },
		{ key: 'matchResult', label: '匹配结果', visible: true, fixed: false, width: 200, sortable: false },
		{ key: 'matchScore', label: '匹配度', visible: true, fixed: false, width: 100, sortable: true },
		{ key: 'bindStatus', label: '绑定', visible: true, fixed: false, width: 80, sortable: true },
		{ key: 'boundPackage', label: '绑定封装', visible: true, fixed: false, width: 130, sortable: true },
		{ key: 'boundSymbol', label: '绑定符号', visible: true, fixed: false, width: 130, sortable: true },
		{ key: 'actions', label: '操作', visible: true, fixed: true, width: 200, sortable: false },
	];
	const sortState = { key: '', direction: '' }; // direction: 'asc' | 'desc' | ''
	let columnResizeState = { active: false, colKey: '', startX: 0, startWidth: 0 };

	// ============ DOM 引用 ============
	const $ = s => document.querySelector(s);
	let modeCards, toolbar, tableContainer, tableBody, emptyState;
	let detailPanel, panelEmpty, panelContent;
	let searchInput, btnBatchBind, btnExport;
	let toastContainer, modalContainer, tableWrapper, statusText;

	// ============ 工具函数 ============

	function show(el) {
		if (el)
			el.classList.remove('hidden');
	}
	function hide(el) {
		if (el)
			el.classList.add('hidden');
	}

	/** i18n 辅助函数：包装 eda.sys_I18n.text()，并手动替换 ${1} ${2} 等占位符 */
	function i18n(tag, ...args) {
		try {
			// eda.sys_I18n.text(tag, namespace?, language?, ...args)
			// 必须显式传 undefined 给 namespace/language，否则 args 会被误认为 namespace
			let result = eda.sys_I18n.text(tag, undefined, undefined, ...args) || tag;
			// 手动替换 ${1} ${2} ... 占位符（兜底：eda.sys_I18n.text 可能不替换）
			if (args.length) {
				for (let i = 0; i < args.length; i++) {
					result = result.replace(new RegExp(`\\$\\{${i + 1}\\}`, 'g'), args[i]);
				}
			}
			return result;
		}
		catch {
			let result = tag;
			if (args.length) {
				for (let i = 0; i < args.length; i++) {
					result = result.replace(new RegExp(`\\$\\{${i + 1}\\}`, 'g'), args[i]);
				}
			}
			return result;
		}
	}

	/** 将 HTML 中 data-i18n / data-i18n-placeholder 属性的元素翻译为当前语言 */
	function applyI18n() {
		document.querySelectorAll('[data-i18n]').forEach((el) => {
			const key = el.getAttribute('data-i18n');
			if (key) {
				const translated = i18n(key);
				// 保留 emoji 前缀（如 🗑、📥、🔄 等）
				const original = el.textContent;
				const emojiMatch = original.match(/^(\p{Extended_Pictographic}️?\s*)/u);
				if (emojiMatch) {
					el.textContent = emojiMatch[1] + translated;
				}
				else {
					el.textContent = translated;
				}
			}
		});
		document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
			const key = el.getAttribute('data-i18n-placeholder');
			if (key) {
				const translated = i18n(key);
				const original = el.getAttribute('placeholder') || '';
				const emojiMatch = original.match(/^(\p{Extended_Pictographic}️?\s*)/u);
				if (emojiMatch) {
					el.setAttribute('placeholder', emojiMatch[1] + translated);
				}
				else {
					el.setAttribute('placeholder', translated);
				}
			}
		});
		// 翻译 <title>
		const titleEl = document.querySelector('title[data-i18n]');
		if (titleEl) {
			document.title = i18n(titleEl.getAttribute('data-i18n'));
		}
	}

	// ============ 主题管理 ============

	/** 初始化主题：加载偏好、获取系统主题、启动轮询 */
	async function initTheme() {
		try {
			const saved = await eda.sys_Storage.getExtensionUserConfig('themePreference');
			if (saved)
				themePreference = saved;
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to load theme preference:', err);
		}
		try {
			lastSystemTheme = await eda.sys_Window.getCurrentTheme();
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to get system theme:', err);
		}
		applyTheme();
		// 轮询系统主题（仅 auto 模式）
		try {
			eda.sys_Timer.setIntervalTimer('theme-poll', 3000, async () => {
				if (themePreference !== 'auto')
					return;
				try {
					const t = await eda.sys_Window.getCurrentTheme();
					if (t !== lastSystemTheme) {
						lastSystemTheme = t;
						applyTheme();
					}
				}
				catch (err) {
					console.warn(PLUGIN_TAG, 'Theme poll failed:', err);
				}
			});
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to start theme poll timer:', err);
		}
	}

	/** 应用主题到 DOM */
	function applyTheme() {
		const theme = themePreference === 'auto' ? lastSystemTheme : themePreference;
		document.documentElement.dataset.theme = theme;
		const btn = document.getElementById('btnTheme');
		if (btn)
			btn.textContent = theme === 'dark' ? '☀️' : '🌙';
	}

	/** 切换主题偏好 */
	// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-vars
	async function toggleTheme() {
		if (themePreference === 'auto') {
			// 当前跟随系统 → 手动切到相反主题
			themePreference = lastSystemTheme === 'dark' ? 'light' : 'dark';
		}
		else {
			// 当前手动 → 恢复跟随系统
			themePreference = 'auto';
			try {
				lastSystemTheme = await eda.sys_Window.getCurrentTheme();
			}
			catch (err) {
				console.warn(PLUGIN_TAG, 'Failed to get system theme on toggle:', err);
			}
		}
		try {
			await eda.sys_Storage.setExtensionUserConfig('themePreference', themePreference);
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to save theme preference:', err);
		}
		applyTheme();
	}

	// ============ 表格列配置 ============

	/** 加载列配置 */
	async function loadColumnConfig() {
		try {
			const saved = await eda.sys_Storage.getExtensionUserConfig('tableColumnConfig');
			if (saved) {
				const parsed = JSON.parse(saved);
				if (Array.isArray(parsed)) {
					// 恢复自定义列
					const savedCustom = parsed.filter(c => c.key.startsWith('custom_'));
					for (const sc of savedCustom) {
						if (!tableColumns.find(c => c.key === sc.key)) {
							// 在 actions 列之前插入
							const actionsIdx = tableColumns.findIndex(c => c.key === 'actions');
							tableColumns.splice(actionsIdx, 0, {
								key: sc.key,
								label: sc.label,
								visible: sc.visible !== undefined ? sc.visible : true,
								fixed: false,
								width: sc.width || 120,
								sortable: true,
							});
						}
					}

					// 恢复列顺序和配置
					const reordered = [];
					for (const savedCol of parsed) {
						const col = tableColumns.find(c => c.key === savedCol.key);
						if (col) {
							col.visible = savedCol.visible !== undefined ? savedCol.visible : col.visible;
							col.width = savedCol.width || col.width;
							reordered.push(col);
						}
					}
					// 添加新列（不在保存配置中的）
					for (const col of tableColumns) {
						if (!reordered.find(c => c.key === col.key)) {
							reordered.push(col);
						}
					}
					tableColumns.length = 0;
					tableColumns.push(...reordered);
				}
			}
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to load column config:', err);
		}
	}

	/** 保存列配置 */
	async function saveColumnConfig() {
		try {
			await eda.sys_Storage.setExtensionUserConfig('tableColumnConfig', JSON.stringify(tableColumns));
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to save column config:', err);
		}
	}

	/** 动态渲染表头 */
	function renderTableHead() {
		const thead = document.getElementById('tableHead');
		if (!thead)
			return;
		const visibleCols = tableColumns.filter(c => c.visible);
		let html = '<tr>';
		for (const col of visibleCols) {
			const style = `width:${col.width}px;min-width:${col.width}px;`;
			const sortClass = sortState.key === col.key ? ' sort-active' : '';
			if (col.key === 'checkbox') {
				html += `<th style="${style}"><span class="th-columns-btn" onclick="window.__app.openColumnConfigModal()" title="${i18n('列设置')}">⚙</span> <input type="checkbox" id="selectAllCheckbox" title="${i18n('全选')}" onchange="window.__app.toggleSelectAll()"></th>`;
			}
			else {
				const sortIndicator = col.sortable ? `<span class="sort-indicator">${sortState.key === col.key ? (sortState.direction === 'asc' ? '▲' : '▼') : '▲'}</span>` : '';
				const onclick = col.sortable ? `onclick="window.__app.toggleColumnSort('${col.key}')"` : '';
				const resizeHandle = !col.fixed ? `<span class="col-resize-handle" data-col="${col.key}"></span>` : '';
				const draggable = !col.fixed ? 'draggable="true"' : '';
				const dragEvents = !col.fixed ? `ondragstart="window.__app.onColumnDragStart(event,'${col.key}')" ondragover="window.__app.onColumnDragOver(event)" ondragenter="window.__app.onColumnDragEnter(event,'${col.key}')" ondragleave="window.__app.onColumnDragLeave(event)" ondrop="window.__app.onColumnDrop(event,'${col.key}')" ondragend="window.__app.onColumnDragEnd(event)"` : '';
				html += `<th style="${style}" class="${sortClass}" ${onclick} ${draggable} ${dragEvents} data-col="${col.key}" data-i18n="${col.label}">${i18n(col.label)}${sortIndicator}${resizeHandle}</th>`;
			}
		}
		html += '</tr>';
		thead.innerHTML = html;
		// 绑定列宽拖拽事件
		initColumnResize();
	}

	/** 初始化列宽拖拽 */
	function initColumnResize() {
		document.querySelectorAll('.col-resize-handle').forEach((handle) => {
			handle.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const colKey = handle.dataset.col;
				const col = tableColumns.find(c => c.key === colKey);
				if (!col)
					return;
				columnResizeState = { active: true, colKey, startX: e.clientX, startWidth: col.width };
				handle.classList.add('active');
				document.addEventListener('mousemove', onColumnResizeMove);
				document.addEventListener('mouseup', onColumnResizeEnd);
			});
		});
	}

	function onColumnResizeMove(e) {
		if (!columnResizeState.active)
			return;
		const diff = e.clientX - columnResizeState.startX;
		const newWidth = Math.max(40, columnResizeState.startWidth + diff);
		const col = tableColumns.find(c => c.key === columnResizeState.colKey);
		if (col) {
			col.width = newWidth;
			// 更新对应列的 th 宽度
			const ths = document.querySelectorAll('#tableHead th');
			const visibleCols = tableColumns.filter(c => c.visible);
			const idx = visibleCols.findIndex(c => c.key === columnResizeState.colKey);
			if (idx >= 0 && ths[idx]) {
				ths[idx].style.width = `${newWidth}px`;
				ths[idx].style.minWidth = `${newWidth}px`;
			}
		}
	}

	function onColumnResizeEnd() {
		columnResizeState.active = false;
		document.querySelectorAll('.col-resize-handle').forEach(h => h.classList.remove('active'));
		document.removeEventListener('mousemove', onColumnResizeMove);
		document.removeEventListener('mouseup', onColumnResizeEnd);
		saveColumnConfig();
	}

	// ============ 表头拖拽排序 ============
	let dragSourceColKey = '';

	function onColumnDragStart(e, key) {
		dragSourceColKey = key;
		e.dataTransfer.effectAllowed = 'move';
		e.target.classList.add('dragging');
	}

	function onColumnDragOver(e) {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
	}

	function onColumnDragEnter(e, key) {
		e.preventDefault();
		if (key === dragSourceColKey)
			return;
		const th = e.target.closest('th');
		if (th)
			th.classList.add('drag-over');
	}

	function onColumnDragLeave(e) {
		const th = e.target.closest('th');
		if (th)
			th.classList.remove('drag-over');
	}

	function onColumnDrop(e, targetKey) {
		e.preventDefault();
		const th = e.target.closest('th');
		if (th)
			th.classList.remove('drag-over');
		if (!dragSourceColKey || dragSourceColKey === targetKey)
			return;
		if (dragSourceColKey === 'checkbox' || targetKey === 'checkbox')
			return;
		if (dragSourceColKey === 'actions' || targetKey === 'actions')
			return;

		const srcIdx = tableColumns.findIndex(c => c.key === dragSourceColKey);
		const tgtIdx = tableColumns.findIndex(c => c.key === targetKey);
		if (srcIdx < 0 || tgtIdx < 0)
			return;

		// 移动列位置
		const [moved] = tableColumns.splice(srcIdx, 1);
		tableColumns.splice(tgtIdx, 0, moved);
		saveColumnConfig();
		renderTableHead();
		renderTable(searchInput.value);
	}

	function onColumnDragEnd(e) {
		e.target.classList.remove('dragging');
		document.querySelectorAll('th.drag-over').forEach(th => th.classList.remove('drag-over'));
		dragSourceColKey = '';
	}

	/** 切换列排序 */
	function toggleColumnSort(key) {
		if (sortState.key === key) {
			// 循环：asc → desc → 取消
			if (sortState.direction === 'asc') {
				sortState.direction = 'desc';
			}
			else if (sortState.direction === 'desc') {
				sortState.key = '';
				sortState.direction = '';
			}
		}
		else {
			sortState.key = key;
			sortState.direction = 'asc';
		}
		renderTableHead();
		renderTable(searchInput.value);
	}

	/** 对数据排序 */
	function sortData(data) {
		if (!sortState.key || !sortState.direction)
			return data;
		const dir = sortState.direction === 'asc' ? 1 : -1;
		return [...data].sort((a, b) => {
			const k = sortState.key;
			let va, vb;
			if (k === 'designator') {
				va = a.designatorStr || '';
				vb = b.designatorStr || '';
			}
			else if (k === 'mpn') {
				va = a.mpn || '';
				vb = b.mpn || '';
			}
			else if (k === 'qty') {
				return (a.qty - b.qty) * dir;
			}
			else if (k === 'footprint') {
				va = a.pkg || '';
				vb = b.pkg || '';
			}
			else if (k === 'matchScore') {
				const ka = a.designatorList.join(',');
				const kb = b.designatorList.join(',');
				const mra = matchResults[ka] || {};
				const mrb = matchResults[kb] || {};
				const sa = mra.bestMatch ? calcMatchScore(a, mra.bestMatch) : (mra.matchScore || 0);
				const sb = mrb.bestMatch ? calcMatchScore(b, mrb.bestMatch) : (mrb.matchScore || 0);
				return (sa - sb) * dir;
			}
			else if (k === 'bindStatus') {
				const ab = a.designatorList.every(d => bindStatus[d]?.bound) ? 1 : 0;
				const bb = b.designatorList.every(d => bindStatus[d]?.bound) ? 1 : 0;
				return (ab - bb) * dir;
			}
			else if (k === 'boundPackage') {
				va = a.designatorList.map(d => bindStatus[d]?.deviceInfo?.package || '').find(Boolean) || '';
				vb = b.designatorList.map(d => bindStatus[d]?.deviceInfo?.package || '').find(Boolean) || '';
			}
			else if (k === 'boundSymbol') {
				va = a.designatorList.map(d => bindStatus[d]?.deviceInfo?.name || '').find(Boolean) || '';
				vb = b.designatorList.map(d => bindStatus[d]?.deviceInfo?.name || '').find(Boolean) || '';
			}
			else if (k.startsWith('custom_')) {
				// 自定义列排序：从 _raw 中读取
				const rawKey = k.slice(7);
				va = a._raw?.[rawKey] || a[rawKey] || '';
				vb = b._raw?.[rawKey] || b[rawKey] || '';
			}
			else {
				return 0;
			}
			// 字符串比较（支持数字混合排序）
			return va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' }) * dir;
		});
	}

	/** 打开列配置弹窗 */
	function openColumnConfigModal() {
		// 可排序的非固定列（内置 + 自定义）
		const sortableCols = tableColumns.filter(col => !col.fixed);
		const sortableHtml = sortableCols
			.map((col, idx) => {
				const isCustom = col.key.startsWith('custom_');
				const removeBtn = isCustom ? `<button class="btn-icon" style="margin-left:auto;font-size:12px;color:var(--danger);" onclick="event.stopPropagation();window.__app.removeCustomColumn('${col.key}')" title="${i18n('移除')}">✕</button>` : '';
				return `<div class="col-item" draggable="true" data-key="${col.key}" data-idx="${idx}">
					<span class="col-drag-handle">⠿</span>
					<input type="checkbox" ${col.visible ? 'checked' : ''} onclick="event.stopPropagation()" onchange="window.__app.toggleColumn('${col.key}', this.checked)">
					<span>${col.label}</span>
					${removeBtn}
				</div>`;
			})
			.join('');

		// 可添加的 BOM 列
		const existingKeys = new Set(tableColumns.map(c => c.key));
		const availableCols = bomColumns.filter(h => !existingKeys.has(`custom_${h}`));
		const addHtml = availableCols.length > 0
			? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
				<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${i18n('添加BOM数据列')}</div>
				<div style="display:flex;flex-wrap:wrap;gap:6px;">
					${availableCols.map(h => `<button class="btn btn-outline btn-xs" onclick="window.__app.addCustomColumn('${h}')">+ ${h}</button>`).join('')}
				</div>
			</div>`
			: '';

		modalContainer.innerHTML = `<div class="modal-overlay">
			<div class="modal" style="width:400px;">
				<div class="modal-header">
					<h3>${i18n('列设置')}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">${i18n('拖拽列名可调整顺序')}</div>
					<div id="colSortList">${sortableHtml}</div>
					${addHtml}
					<div style="margin-top:16px;text-align:right;">
						<button class="btn btn-primary btn-sm" onclick="this.closest('.modal-overlay').remove()">${i18n('完成')}</button>
					</div>
				</div>
			</div>
		</div>`;

		// 初始化拖拽排序
		initColumnDragSort();
	}

	/** 列设置弹窗内的拖拽排序 */
	function initColumnDragSort() {
		const list = document.getElementById('colSortList');
		if (!list)
			return;
		let dragItem = null;

		list.querySelectorAll('.col-item').forEach((item) => {
			item.addEventListener('dragstart', (e) => {
				dragItem = item;
				item.classList.add('col-dragging');
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', item.dataset.key);
			});

			item.addEventListener('dragend', () => {
				if (dragItem)
					dragItem.classList.remove('col-dragging');
				dragItem = null;
				list.querySelectorAll('.col-drag-over').forEach(el => el.classList.remove('col-drag-over'));
			});

			item.addEventListener('dragover', (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				if (item !== dragItem) {
					item.classList.add('col-drag-over');
				}
			});

			item.addEventListener('dragleave', () => {
				item.classList.remove('col-drag-over');
			});

			item.addEventListener('drop', (e) => {
				e.preventDefault();
				item.classList.remove('col-drag-over');
				if (!dragItem || item === dragItem)
					return;

				const fromKey = dragItem.dataset.key;
				const toKey = item.dataset.key;
				const fromIdx = tableColumns.findIndex(c => c.key === fromKey);
				const toIdx = tableColumns.findIndex(c => c.key === toKey);
				if (fromIdx < 0 || toIdx < 0)
					return;

				// 移动位置
				const [moved] = tableColumns.splice(fromIdx, 1);
				tableColumns.splice(toIdx, 0, moved);

				// 刷新弹窗和表格
				saveColumnConfig();
				openColumnConfigModal();
				renderTableHead();
				renderTable(searchInput.value);
			});
		});
	}

	/** 切换列可见性 */
	function toggleColumn(key, visible) {
		const col = tableColumns.find(c => c.key === key);
		if (col) {
			col.visible = visible;
			saveColumnConfig();
			renderTableHead();
			renderTable(searchInput.value);
		}
	}

	/** 添加自定义 BOM 数据列 */
	function addCustomColumn(header) {
		const key = `custom_${header}`;
		if (tableColumns.find(c => c.key === key))
			return;
		// 在 actions 列之前插入
		const actionsIdx = tableColumns.findIndex(c => c.key === 'actions');
		tableColumns.splice(actionsIdx, 0, {
			key,
			label: header,
			visible: true,
			fixed: false,
			width: 120,
			sortable: true,
		});
		saveColumnConfig();
		renderTableHead();
		renderTable(searchInput.value);
		openColumnConfigModal(); // 刷新弹窗
	}

	/** 移除自定义列 */
	function removeCustomColumn(key) {
		const idx = tableColumns.findIndex(c => c.key === key);
		if (idx >= 0) {
			tableColumns.splice(idx, 1);
			saveColumnConfig();
			renderTableHead();
			renderTable(searchInput.value);
			openColumnConfigModal(); // 刷新弹窗
		}
	}

	// ============ 库列表管理 ============

	/** 加载库列表并填充下拉框 */
	async function loadLibraryList() {
		// 获取特殊库 UUID
		try {
			specialLibraries = [
				{ name: i18n('收藏库'), uuid: await eda.lib_LibrariesList.getFavoriteLibraryUuid() || '' },
				{ name: i18n('个人库'), uuid: await eda.lib_LibrariesList.getPersonalLibraryUuid() || '' },
				{ name: i18n('工程库'), uuid: await eda.lib_LibrariesList.getProjectLibraryUuid() || '' },
				{ name: i18n('系统库'), uuid: await eda.lib_LibrariesList.getSystemLibraryUuid() || '' },
			].filter(l => l.uuid);
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to get special libraries:', err);
		}
		// 获取全部库列表
		try {
			const libs = await eda.lib_LibrariesList.getAllLibrariesList();
			if (Array.isArray(libs)) {
				libraryList = libs.map(l => ({ name: l.name || l.friendlyName || '', uuid: l.uuid || '' })).filter(l => l.uuid);
			}
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'Failed to load library list:', err);
		}
		renderLibrarySelect();
	}

	/** 渲染库选择下拉框 */
	function renderLibrarySelect() {
		const select = document.getElementById('librarySelect');
		if (!select)
			return;
		let html = `<option value="">${i18n('全部库')}</option>`;
		// 特殊库（分组）
		if (specialLibraries.length) {
			html += `<optgroup label="${i18n('快捷库')}">`;
			for (const lib of specialLibraries) {
				html += `<option value="${lib.uuid}" ${selectedLibraryUuid === lib.uuid ? 'selected' : ''}>${lib.name}</option>`;
			}
			html += `</optgroup>`;
		}
		// 全部库列表（分组）
		if (libraryList.length) {
			html += `<optgroup label="${i18n('全部库列表')}">`;
			for (const lib of libraryList) {
				html += `<option value="${lib.uuid}" ${selectedLibraryUuid === lib.uuid ? 'selected' : ''}>${lib.name}</option>`;
			}
			html += `</optgroup>`;
		}
		select.innerHTML = html;
	}

	/** 切换选中库 */
	function onLibraryChange(uuid) {
		selectedLibraryUuid = uuid;
	}

	function showToast(msg, type = 'info') {
		const t = document.createElement('div');
		t.className = `toast ${type}`;
		t.textContent = msg;
		toastContainer.appendChild(t);
		setTimeout(() => t.remove(), 2800);
	}

	// ============ BOM 列映射（适配多格式表头） ============

	const COLUMN_ALIASES = {
		designator: ['designator', 'refdes', 'reference designator', '参考编号', '位号', 'designators', 'part reference'],
		value: ['name', 'value', 'part number', i18n('元件名称'), 'marking code', i18n('型号'), 'comment', 'device'],
		footprint: ['footprint', 'pcb decal', i18n('封装'), 'package'],
		quantity: ['quantity', 'qty', '数量', 'count'],
		manufacturer: ['manufacturer', 'manufacture', i18n('制造商'), 'brand', 'mfr'],
		description: ['description', 'desc', 'details', '说明', 'pcbfast remark', 'customer reply', 'remark'],
		mpn: ['mpn', 'manufacturer part', 'manufacturer part number', 'mfr part', 'mfr part number', 'details', 'supplier part', 'part number', '说明', 'marking code'],
		lcsc: ['lcsc', 'lcsc part', 'supplier part', '供应商编号', '立创编号', 'lcsc number', 'jlcpcb part'],
	};

	function normalizeHeader(h) {
		return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
	}

	function findColumn(headers, role) {
		const aliases = COLUMN_ALIASES[role];
		const normalized = headers.map(normalizeHeader);
		for (const alias of aliases) {
			const idx = normalized.indexOf(alias);
			if (idx !== -1)
				return headers[idx];
		}
		return null;
	}

	function buildColumnMap(headers) {
		const roles = Object.keys(COLUMN_ALIASES);
		const map = {};
		for (const role of roles)
			map[role] = findColumn(headers, role);
		return map;
	}

	/**
	 * 解析位号：支持逗号、`e` 分隔符、范围 `C5-7` / `R1-R10`、混合
	 * 适配 A104 光机板（C10eC14 / C2-4eC11）等格式
	 */
	function normalizeDesignators(raw) {
		if (!raw)
			return [];
		const tokens = String(raw)
			.split(/[,;，；]+|(?<=\d)E(?=[A-Z])/i)
			.map(t => t.trim())
			.filter(Boolean);

		const result = [];
		for (const token of tokens) {
			const rangeMatch = token.match(/^([A-Z]+)(\d+)\s*[-–—]\s*(\d+)$/i);
			if (rangeMatch) {
				const prefix = rangeMatch[1];
				const start = Number.parseInt(rangeMatch[2], 10);
				const end = Number.parseInt(rangeMatch[3], 10);
				if (end >= start && end - start < 500) {
					for (let i = start; i <= end; i++)
						result.push(`${prefix}${i}`);
					continue;
				}
			}
			result.push(token);
		}
		return result;
	}

	function parseQuantity(raw, fallback = 1) {
		if (!raw)
			return fallback;
		const n = Number.parseInt(String(raw).replace(/\D/g, ''), 10);
		return Number.isNaN(n) ? fallback : Math.max(1, n);
	}

	function extractLcsc(text) {
		if (!text)
			return '';
		const m = String(text).match(/C\d{3,}/i);
		return m ? m[0].toUpperCase() : '';
	}

	function designatorSort(a, b) {
		const ma = a.match(/^([A-Z]*)(\d+)$/i);
		const mb = b.match(/^([A-Z]*)(\d+)$/i);
		if (ma && mb) {
			if (ma[1] !== mb[1])
				return ma[1].localeCompare(mb[1]);
			return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
		}
		return a.localeCompare(b);
	}

	/** 判断是否分类段/标题行（无有效位号） */
	function isSectionRow(row, desigCol) {
		if (!desigCol)
			return false;
		const des = String(row[desigCol] ?? '').trim();
		if (!des)
			return true;
		return !/[A-Z]+\d+/i.test(des) && !/\d/.test(des);
	}

	/**
	 * 将原始行分组标准化。键值对完全一致的器件合并为一组。
	 * 输出字段兼容旧调用：mpn/pkg 作为 value/footprint 的别名。
	 */
	function groupBomItems(rows, headers) {
		if (!rows.length)
			return [];
		bomColumns = headers.filter(h => !String(h).startsWith('_'));

		const colMap = buildColumnMap(headers);
		const desigCol = colMap.designator;
		if (!desigCol) {
			console.warn(PLUGIN_TAG, 'No designator column found:', headers);
			return [];
		}

		const dataRows = rows.filter(row => !isSectionRow(row, desigCol));
		const groupMap = new Map();

		for (const row of dataRows) {
			const designators = normalizeDesignators(String(row[desigCol] ?? ''));
			if (!designators.length)
				continue;

			const keyObj = {};
			for (const [k, v] of Object.entries(row)) {
				if (k === desigCol || k.startsWith('_'))
					continue;
				keyObj[k] = String(v ?? '');
			}
			const groupKey = JSON.stringify(keyObj);

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					designators: new Set(),
					raw: { ...row },
					quantity: 0,
					primitiveIds: {},
				});
			}
			const g = groupMap.get(groupKey);
			for (const d of designators) {
				g.designators.add(d);
				if (row._primitiveId)
					g.primitiveIds[d] = row._primitiveId;
			}
			g.quantity += parseQuantity(colMap.quantity ? String(row[colMap.quantity] ?? '') : '');
		}

		return Array.from(groupMap.values()).map((g) => {
			const desList = Array.from(g.designators).sort(designatorSort);
			const value = colMap.value ? String(g.raw[colMap.value] ?? '').trim() : '';
			const footprint = colMap.footprint ? String(g.raw[colMap.footprint] ?? '').trim() : '';
			const manufacturer = colMap.manufacturer ? String(g.raw[colMap.manufacturer] ?? '').trim() : '';
			const description = colMap.description ? String(g.raw[colMap.description] ?? '').trim() : '';
			const mpn = colMap.mpn ? String(g.raw[colMap.mpn] ?? '').trim() : '';
			const lcsc = extractLcsc(colMap.lcsc ? String(g.raw[colMap.lcsc] ?? '').trim() : '');

			// 去除内部字段的 raw，供详情/导出
			const cleanRaw = {};
			for (const [k, v] of Object.entries(g.raw)) {
				if (!k.startsWith('_'))
					cleanRaw[k] = v;
			}

			return {
				designatorList: desList,
				designatorStr: desList.join(', '),
				value,
				footprint,
				pkg: footprint, // 兼容旧字段
				manufacturer,
				description,
				mpn,
				lcsc,
				qty: g.quantity || desList.length,
				_raw: cleanRaw,
				_primitiveIds: g.primitiveIds,
			};
		});
	}

	// ============ CSV / 编码处理 ============

	/** 根据 BOM 检测编码 */
	function detectEncoding(bytes) {
		if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
			return 'utf-16le';
		if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
			return 'utf-16be';
		return 'utf-8';
	}

	/** 解码字节数组，自动处理 UTF-16LE/BE/UTF-8（含 BOM） */
	function decodeBytes(data) {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		const encoding = detectEncoding(bytes);
		return new TextDecoder(encoding).decode(bytes);
	}

	function parseCsvLine(l) {
		const r = [];
		let c = '';
		let q = false;
		for (let i = 0; i < l.length; i++) {
			const ch = l[i];
			if (q) {
				if (ch === '"') {
					if (i + 1 < l.length && l[i + 1] === '"') {
						c += '"';
						i++;
					}
					else {
						q = false;
					}
				}
				else {
					c += ch;
				}
			}
			else {
				if (ch === '"') {
					q = true;
				}
				else if (ch === ',' || ch === '\t') {
					r.push(c.trim());
					c = '';
				}
				else {
					c += ch;
				}
			}
		}
		r.push(c.trim());
		return r;
	}

	/** 定位表头行（含 designator 类列），处理标题在表头上方的情况 */
	function findHeaderRow(rows) {
		for (let i = 0; i < Math.min(rows.length, 10); i++) {
			const normalized = rows[i].map(normalizeHeader);
			if (normalized.some(h => COLUMN_ALIASES.designator.includes(h)))
				return i;
		}
		return 0;
	}

	/** CSV 二维行 → { headers, data }，自动跳过标题行 */
	function rowsToObjects(rows) {
		if (!rows.length)
			return { headers: [], data: [] };
		const headerIdx = findHeaderRow(rows);
		const headers = rows[headerIdx];
		const data = [];
		for (let i = headerIdx + 1; i < rows.length; i++) {
			const cells = rows[i];
			if (!cells.length)
				continue;
			const obj = {};
			headers.forEach((h, idx) => {
				obj[h] = cells[idx] ?? '';
			});
			data.push(obj);
		}
		return { headers, data };
	}

	// ============ XLSX 解析（基于 JSZip） ============

	/** 列字母 → 0-based 索引（A=0, B=1, ..., Z=25, AA=26, ...） */
	function colLetterToIndex(ref) {
		const m = ref.match(/^([A-Z]+)/);
		if (!m)
			return 0;
		let n = 0;
		for (let i = 0; i < m[1].length; i++)
			n = n * 26 + (m[1].charCodeAt(i) - 64);
		return n - 1;
	}

	/**
	 * 用 JSZip 解析 XLSX 文件，返回二维字符串数组（保留列位置，空格填充）
	 * 替代 SheetJS，避免 COEP/CORS 限制
	 */
	async function parseXlsxWithJSZip(data) {
		const zip = await JSZip.loadAsync(data);

		// 读取共享字符串表
		let strings = [];
		const ssFile = zip.file('xl/sharedStrings.xml');
		if (ssFile) {
			const ssXml = await ssFile.async('string');
			const siMatches = ssXml.match(/<si>([\s\S]*?)<\/si>/g) || [];
			strings = siMatches.map((si) => {
				const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
				return tMatches.map(t => t.replace(/<[^>]+>/g, '').replace(/&#10;/g, ' ')).join('');
			});
		}

		// 读取第一个工作表
		const sheetFile = zip.file('xl/worksheets/sheet1.xml');
		if (!sheetFile)
			return [];

		const sheetXml = await sheetFile.async('string');
		const rowMatches = sheetXml.match(/<row[^>]*>([\s\S]*?)<\/row>/g) || [];

		return rowMatches.map((rowXml) => {
			const tmp = [];
			let maxIdx = -1;
			let pos = 0;

			// 逐个查找 <c 开头的单元格
			while (pos < rowXml.length) {
				const cStart = rowXml.indexOf('<c', pos);
				if (cStart === -1)
					break;

				const afterC = cStart + 2;
				const selfClose = rowXml.indexOf('/>', afterC);
				const openClose = rowXml.indexOf('>', afterC);
				if (openClose === -1)
					break;

				const isSelfClose = selfClose !== -1 && selfClose < openClose;
				const tagEnd = isSelfClose ? selfClose : openClose;
				const attrs = rowXml.substring(afterC, tagEnd);

				// 提取 r 属性
				const rIdx = attrs.indexOf(' r="');
				if (rIdx !== -1) {
					const rValStart = rIdx + 4;
					const rValEnd = attrs.indexOf('"', rValStart);
					const ref = attrs.substring(rValStart, rValEnd);
					const idx = colLetterToIndex(ref);

					// 提取 t 属性（s=共享字符串）
					let typeVal = '';
					const tIdx = attrs.indexOf(' t="');
					if (tIdx !== -1) {
						const tValStart = tIdx + 4;
						const tValEnd = attrs.indexOf('"', tValStart);
						typeVal = attrs.substring(tValStart, tValEnd);
					}

					// 提取值
					let val = '';
					if (!isSelfClose) {
						const contentStart = tagEnd + 1;
						const contentEnd = rowXml.indexOf('</c>', contentStart);
						if (contentEnd !== -1) {
							const inner = rowXml.substring(contentStart, contentEnd);
							const vOpen = inner.indexOf('<v>');
							const isTOpen = inner.indexOf('<t>');
							if (vOpen !== -1) {
								const vClose = inner.indexOf('</v>', vOpen);
								if (vClose !== -1)
									val = inner.substring(vOpen + 3, vClose).trim();
							}
							else if (isTOpen !== -1) {
								const isTClose = inner.indexOf('</t>', isTOpen);
								if (isTClose !== -1)
									val = inner.substring(isTOpen + 3, isTClose).trim();
							}
						}
					}

					// 共享字符串查找
					if (typeVal === 's' && val) {
						const strIdx = Number.parseInt(val, 10);
						if (!Number.isNaN(strIdx))
							val = strings[strIdx] ?? val;
					}

					tmp.push({ idx, val });
					if (idx > maxIdx)
						maxIdx = idx;
				}
				pos = tagEnd + (isSelfClose ? 2 : 1);
			}

			// 填充空单元格保持列对齐
			const cells = [];
			for (let i = 0; i <= maxIdx; i++) {
				const found = tmp.find(t => t.idx === i);
				cells.push(found ? found.val : '');
			}
			return cells;
		});
	}

	// ============ EDA API 封装 ============

	/**
	 * 标准化器件搜索结果：API 字段名 → 内部统一字段名
	 * lib_Device.search() 返回：name, footprintName, supplierId, manufacturer, manufacturerId, description
	 * 内部统一使用：name, package, lcsc, manufacturer, mpn, description
	 */
	function normalizeDevice(d) {
		if (!d)
			return null;
		return {
			name: d.name || '',
			package: d.footprintName || d.package || '',
			lcsc: d.supplierId || d.lcsc || '',
			manufacturer: d.manufacturer || '',
			mpn: d.manufacturerId || d.mpn || '',
			description: d.description || '',
			imageUrl: d.imageUuid || '',
			symbolUuid: d.symbolUuid || '',
			footprintUuid: d.footprintUuid || '',
			uuid: d.uuid || '',
			libraryUuid: d.libraryUuid || '',
			supplier: d.supplier || 'LCSC',
			otherProperty: d.otherProperty || null,
		};
	}

	// ============ 渲染图获取 ============

	const renderImageCache = {}; // { "symbol:uuid:lib": dataUrl, "footprint:uuid:lib": dataUrl }
	let systemLibraryUuid = ''; // 系统库 UUID（懒加载，LCSC 器件符号/封装渲染图所在库）

	/** 获取系统库 UUID（缓存） */
	async function getSystemLibraryUuid() {
		if (systemLibraryUuid)
			return systemLibraryUuid;
		try {
			systemLibraryUuid = (await eda.lib_LibrariesList.getSystemLibraryUuid()) || '';
		}
		catch (e) {
			console.warn(PLUGIN_TAG, 'getSystemLibraryUuid failed', e);
		}
		return systemLibraryUuid;
	}

	/** Blob → data URL（浏览器 FileReader） */
	function blobToDataUrl(blob) {
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * 按 (uuid, 库) 候选组合逐个尝试获取渲染图，命中即返回 data URL。
	 * 背景：原理图器件 getState_Symbol()/getState_Footprint() 的 uuid 为实例ID，
	 * libraryUuid 才是可渲染的定义ID；且 LCSC 器件的符号/封装渲染图在系统库。
	 * 因此对每个实体尝试多个 (uuid, libraryUuid) 组合，兼容搜索器件与已绑定器件。
	 */
	async function tryGetRenderImage(type, uuidCandidates, libCandidates) {
		for (const uuid of uuidCandidates) {
			if (!uuid)
				continue;
			for (const lib of libCandidates) {
				if (!lib)
					continue;
				const cacheKey = `${type}:${uuid}:${lib}`;
				if (renderImageCache[cacheKey])
					return renderImageCache[cacheKey];
				try {
					const param = type === 'symbol'
						? { symbolUuid: uuid, libraryUuid: lib }
						: { footprintUuid: uuid, libraryUuid: lib };
					const api = type === 'symbol' ? eda.lib_Symbol : eda.lib_Footprint;
					const blob = await api.getRenderImage(param);
					if (blob) {
						const dataUrl = await blobToDataUrl(blob);
						renderImageCache[cacheKey] = dataUrl;
						return dataUrl;
					}
				}
				catch {
					// 该组合无效，尝试下一个候选
				}
			}
		}
		return null;
	}

	/** 短UUID → 可渲染长UUID 缓存 { shortUuid: {uuid, libraryUuid} | null } */
	const renderableUuidCache = {};

	/**
	 * 对 Altium 导入器件的短UUID符号/封装，解析库中的可渲染长UUID。
	 * 通过 lib_Xxx.get(短UUID, "project") 直接获取名字+所在库（非搜索），
	 * 再 lib_Xxx.search(名字, 所在库) 拿到库中的长UUID正式版本。
	 * @returns {{ uuid: string, libraryUuid: string } | null} 可渲染的长UUID及库，或 null
	 */
	async function resolveRenderableUuid(type, shortUuid) {
		if (!shortUuid)
			return null;
		if (shortUuid in renderableUuidCache)
			return renderableUuidCache[shortUuid];
		try {
			const api = type === 'symbol' ? eda.lib_Symbol : eda.lib_Footprint;
			// 1. 用短UUID通过工程库直接 get（不是搜索），确认存在并拿到名字+所在库
			const item = await api.get(shortUuid, 'project');
			if (!item || !item.name || !item.libraryUuid) {
				renderableUuidCache[shortUuid] = null;
				return null;
			}
			// 2. 在该库里按精确名字搜索，拿到长UUID（库中正式版本，同名同库精确匹配）
			const results = await api.search(item.name, item.libraryUuid);
			if (!Array.isArray(results) || !results.length) {
				renderableUuidCache[shortUuid] = null;
				return null;
			}
			const hit = { uuid: results[0].uuid, libraryUuid: results[0].libraryUuid };
			renderableUuidCache[shortUuid] = hit;
			return hit;
		}
		catch {
			renderableUuidCache[shortUuid] = null;
			return null;
		}
	}

	/**
	 * 获取器件的符号渲染图和封装渲染图
	 * 分三层递进：
	 *   1. 直接候选（短UUID × 各库）—— LCSC 标准器件命中
	 *   2. 短UUID解析（get确认存在 + search取长UUID）—— Altium 导入器件命中
	 * 返回 { symbolUrl, footprintUrl }
	 */
	async function fetchRenderImages(device) {
		if (!device)
			return {};
		const hasSym = device.symbolUuid || device.symbolLibraryUuid;
		const hasFp = device.footprintUuid || device.footprintLibraryUuid;
		if (!hasSym && !hasFp)
			return {};

		const sysLib = await getSystemLibraryUuid();
		const dedupe = (arr) => {
			const out = [];
			for (const v of arr) {
				if (v && !out.includes(v))
					out.push(v);
			}
			return out;
		};

		const result = {};

		// 符号：优先用 libraryUuid 字段（已绑定器件的可渲染定义ID），库优先系统库
		if (hasSym) {
			const symUuids = dedupe([device.symbolLibraryUuid, device.symbolUuid]);
			const symLibs = dedupe([sysLib, device.symbolLibraryUuid, device.libraryUuid]);
			let url = await tryGetRenderImage('symbol', symUuids, symLibs);
			// 短UUID直接渲染失败时，解析库中的可渲染长UUID（Altium 导入器件）
			if (!url) {
				const resolved = await resolveRenderableUuid('symbol', device.symbolUuid || device.symbolLibraryUuid);
				if (resolved)
					url = await tryGetRenderImage('symbol', [resolved.uuid], [resolved.libraryUuid]);
			}
			if (url)
				result.symbolUrl = url;
		}

		// 封装：同上
		if (hasFp) {
			const fpUuids = dedupe([device.footprintLibraryUuid, device.footprintUuid]);
			const fpLibs = dedupe([sysLib, device.footprintLibraryUuid, device.libraryUuid]);
			let url = await tryGetRenderImage('footprint', fpUuids, fpLibs);
			// 短UUID直接渲染失败时，解析库中的可渲染长UUID（Altium 导入器件）
			if (!url) {
				const resolved = await resolveRenderableUuid('footprint', device.footprintUuid || device.footprintLibraryUuid);
				if (resolved)
					url = await tryGetRenderImage('footprint', [resolved.uuid], [resolved.libraryUuid]);
			}
			if (url)
				result.footprintUrl = url;
		}

		return result;
	}

	/**
	 * 搜索立创器件库
	 */
	async function searchDevice(keyword) {
		if (!keyword || !keyword.trim())
			return [];
		const kw = keyword.trim();
		const cacheKey = `${matchTarget}:${selectedLibraryUuid}:${kw}`;
		if (searchCache[cacheKey])
			return searchCache[cacheKey];

		const libUuid = selectedLibraryUuid || undefined;
		try {
			let results;
			if (matchTarget === 'symbol') {
				results = await eda.lib_Symbol.search(kw, libUuid);
			}
			else if (matchTarget === 'footprint') {
				results = await eda.lib_Footprint.search(kw, libUuid);
			}
			else {
				results = await eda.lib_Device.search(kw, libUuid);
			}
			const safe = (results || []).map(normalizeDevice).filter(Boolean);
			searchCache[cacheKey] = safe;
			return safe;
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'Search failed for', kw, 'target:', matchTarget, 'lib:', libUuid, err);
			return [];
		}
	}

	/**
	 * 通过 LCSC C 编号查询器件（经 bridge 验证：getByLcscIds 始终返回数组）
	 */
	async function getDeviceByLcsc(lcscId) {
		if (!lcscId || !lcscId.trim())
			return null;
		try {
			const results = await eda.lib_Device.getByLcscIds(lcscId.trim());
			if (Array.isArray(results) && results.length > 0)
				return normalizeDevice(results[0]);
			return null;
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'getByLcscIds failed for', lcscId, err);
			return null;
		}
	}

	// ============ AI 匹配 ============

	/** 加载 AI 设置 */
	async function loadAISettings() {
		try {
			const raw = await eda.sys_Storage.getExtensionUserConfig('aiSettings');
			if (raw) {
				const parsed = JSON.parse(raw);
				Object.assign(aiSettings, parsed);
				// 恢复绑定选项
				if (parsed.bindOptions) {
					bindOptions.keepDesignatorId = parsed.bindOptions.keepDesignatorId ?? true;
					bindOptions.keepSymbol = parsed.bindOptions.keepSymbol ?? true;
					bindOptions.keepFootprint = parsed.bindOptions.keepFootprint ?? false;
				}
				if (parsed.bindDetectMode) {
					bindDetectMode = parsed.bindDetectMode;
				}
				// 恢复降级匹配封装设置
				if (parsed.fallbackFootprintEnabled !== undefined)
					fallbackFootprintEnabled = parsed.fallbackFootprintEnabled;
				if (parsed.footprintColumn !== undefined)
					footprintColumn = parsed.footprintColumn;
			}
		}
		catch (e) {
			console.warn(PLUGIN_TAG, 'loadAISettings failed', e);
		}
		updateMatchButtonText();
	}

	/** 保存 AI 设置 */
	async function saveAISettings() {
		try {
			await eda.sys_Storage.setExtensionUserConfig('aiSettings', JSON.stringify(aiSettings));
		}
		catch (e) {
			console.warn(PLUGIN_TAG, 'saveAISettings failed', e);
		}
	}

	/** 打开 AI 设置弹窗 */
	function openSettingsModal() {
		modalContainer.innerHTML = `<div class="modal-overlay">
			<div class="modal" style="width:480px;">
				<div class="modal-header">
					<h3>${i18n('设置')}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					<h4 style="margin-bottom:10px;font-size:14px;">${i18n('AI 匹配设置')}</h4>
					<div style="margin-bottom:14px;">
						<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('API 地址（OpenAI 格式）')}</label>
						<input type="text" id="aiApiUrl" value="${aiSettings.apiUrl}" placeholder="https://api.openai.com/v1/chat/completions" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">
					</div>
					<div style="margin-bottom:14px;">
						<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('API Key')}</label>
						<input type="password" id="aiApiKey" value="${aiSettings.apiKey}" placeholder="sk-..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">
					</div>
					<div style="margin-bottom:14px;">
						<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('模型')}</label>
						<input type="text" id="aiModel" value="${aiSettings.model}" placeholder="gpt-4o-mini" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">
					</div>
					<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
						<input type="checkbox" id="aiEnabled" ${aiSettings.enabled ? 'checked' : ''}>
						<label style="font-size:13px;cursor:pointer;" onclick="document.getElementById('aiEnabled').click()">${i18n('启用 AI 匹配')}</label>
					</div>
					<div style="border-top:1px solid var(--border);margin:4px 0 14px;padding-top:14px;">
						<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
							<input type="checkbox" id="aiBatchSend" ${aiSettings.batchSend ? 'checked' : ''} onchange="document.getElementById('batchSizeRow').style.display=this.checked?'':'none'">
							<label style="font-size:13px;cursor:pointer;" onclick="document.getElementById('aiBatchSend').click()">${i18n('组合发送（多个器件合并为一次请求）')}</label>
						</div>
						<div id="batchSizeRow" style="margin-bottom:10px;${aiSettings.batchSend ? '' : 'display:none;'}">
							<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('模型最大上下文（K tokens）')}</label>
							<input type="number" id="aiContextSize" value="${aiSettings.contextSize}" min="4" max="10000" placeholder="128" style="width:120px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;">
						</div>
					</div>
					<div style="border-top:1px solid var(--border);margin:4px 0 14px;padding-top:14px;">
						<h4 style="margin-bottom:10px;font-size:14px;">${i18n('绑定功能设置')}</h4>
						<div style="display:flex;flex-direction:column;gap:8px;">
							<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border-light);border-radius:6px;cursor:pointer;">
								<input type="checkbox" id="optKeepDesignatorId" ${bindOptions.keepDesignatorId ? 'checked' : ''}>
								<div><div style="font-weight:500;font-size:13px;">${i18n('保留位号和唯一ID')}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${i18n('绑定后保持原始器件的位号和唯一标识')}</div></div>
							</label>
							<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border-light);border-radius:6px;cursor:pointer;">
								<input type="checkbox" id="optKeepSymbol" ${bindOptions.keepSymbol ? 'checked' : ''}>
								<div><div style="font-weight:500;font-size:13px;">${i18n('保留当前符号')}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${i18n('绑定时不替换器件的原理图符号')}</div></div>
							</label>
							<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border-light);border-radius:6px;cursor:pointer;">
								<input type="checkbox" id="optKeepFootprint" ${bindOptions.keepFootprint ? 'checked' : ''}>
								<div><div style="font-weight:500;font-size:13px;">${i18n('保留当前封装')}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${i18n('绑定时不替换器件的PCB封装')}</div></div>
							</label>
						</div>
					</div>
					<div style="border-top:1px solid var(--border);margin:4px 0 14px;padding-top:14px;">
						<h4 style="margin-bottom:10px;font-size:14px;">${i18n('绑定检测')}</h4>
						<div style="margin-bottom:8px;">
							<select id="bindDetectMode" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);">
								<option value="fp" ${bindDetectMode === 'fp' ? 'selected' : ''}>${i18n('检查 EasyEDA 封装')}</option>
								<option value="lcsc" ${bindDetectMode === 'lcsc' ? 'selected' : ''}>${i18n('检查 LCSC 编号')}</option>
								<option value="fp_or_lcsc" ${bindDetectMode === 'fp_or_lcsc' ? 'selected' : ''}>${i18n('检查封装或 LCSC')}</option>
								<option value="any" ${bindDetectMode === 'any' ? 'selected' : ''}>${i18n('有器件即可')}</option>
							</select>
						</div>
						<p style="font-size:11px;color:var(--text-muted);margin:0;">${i18n('选择判定器件为"已绑定"的条件')}</p>
					</div>
					<div style="border-top:1px solid var(--border);margin:4px 0 14px;padding-top:14px;">
						<h4 style="margin-bottom:10px;font-size:14px;">${i18n('主题设置')}</h4>
						<div style="margin-bottom:8px;">
							<select id="themeSelect" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);">
								<option value="auto" ${themePreference === 'auto' ? 'selected' : ''}>${i18n('跟随系统')}</option>
								<option value="light" ${themePreference === 'light' ? 'selected' : ''}>${i18n('浅色')}</option>
								<option value="dark" ${themePreference === 'dark' ? 'selected' : ''}>${i18n('深色')}</option>
							</select>
						</div>
					</div>
					<div style="border-top:1px solid var(--border);margin:4px 0 14px;padding-top:14px;">
						<h4 style="margin-bottom:10px;font-size:14px;">${i18n('降级匹配封装')}</h4>
						<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
							<input type="checkbox" id="fallbackFootprint" ${fallbackFootprintEnabled ? 'checked' : ''} onchange="document.getElementById('fpColRow').style.display=this.checked?'':'none'">
							<label style="font-size:13px;cursor:pointer;" onclick="document.getElementById('fallbackFootprint').click()">${i18n('匹配不到器件时，自动搜索封装库匹配封装')}</label>
						</div>
						<div id="fpColRow" style="margin-bottom:10px;${fallbackFootprintEnabled ? '' : 'display:none;'}">
							<label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('封装列（从 BOM 中选择封装对应的列）')}</label>
							<select id="footprintColumnSelect" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);">
								<option value="">${i18n('-- 自动检测 --')}</option>
								${bomColumns.map(col => `<option value="${col}" ${footprintColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
							</select>
						</div>
						<p style="font-size:11px;color:var(--text-muted);margin:0;">${i18n('开启后，标准匹配用封装列的值搜索封装库；AI 匹配会让 AI 推断封装名称后搜索。')}</p>
					</div>
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').remove()">${i18n('取消')}</button>
					<button class="btn btn-primary btn-sm" onclick="window.__app.saveAndCloseSettings()">${i18n('保存')}</button>
				</div>
			</div>
		</div>`;
	}

	/** 保存设置并关闭弹窗 */
	async function saveAndCloseSettings() {
		aiSettings.apiUrl = document.getElementById('aiApiUrl').value.trim();
		aiSettings.apiKey = document.getElementById('aiApiKey').value.trim();
		aiSettings.model = document.getElementById('aiModel').value.trim();
		aiSettings.enabled = document.getElementById('aiEnabled').checked;
		aiSettings.batchSend = document.getElementById('aiBatchSend').checked;
		const ctxVal = Number.parseInt(document.getElementById('aiContextSize')?.value || '128', 10);
		aiSettings.contextSize = Number.isNaN(ctxVal) || ctxVal < 4 ? 128 : ctxVal;
		// 读取绑定选项
		bindOptions.keepDesignatorId = document.getElementById('optKeepDesignatorId')?.checked ?? true;
		bindOptions.keepSymbol = document.getElementById('optKeepSymbol')?.checked ?? true;
		bindOptions.keepFootprint = document.getElementById('optKeepFootprint')?.checked ?? false;
		bindDetectMode = document.getElementById('bindDetectMode')?.value || 'fp_or_lcsc';
		aiSettings.bindOptions = { ...bindOptions };
		aiSettings.bindDetectMode = bindDetectMode;
		// 读取主题设置
		const newTheme = document.getElementById('themeSelect')?.value || 'auto';
		if (newTheme !== themePreference) {
			themePreference = newTheme;
			if (themePreference === 'auto') {
				try {
					lastSystemTheme = await eda.sys_Window.getCurrentTheme();
				}
				catch {}
			}
			applyTheme();
			try {
				await eda.sys_Storage.setExtensionUserConfig('themePreference', themePreference);
			}
			catch {}
		}
		// 读取降级匹配封装设置
		fallbackFootprintEnabled = document.getElementById('fallbackFootprint')?.checked || false;
		footprintColumn = document.getElementById('footprintColumnSelect')?.value || '';
		aiSettings.fallbackFootprintEnabled = fallbackFootprintEnabled;
		aiSettings.footprintColumn = footprintColumn;
		console.warn(PLUGIN_TAG, 'Settings saved, bindOptions:', JSON.stringify(bindOptions), 'fallbackFp:', fallbackFootprintEnabled, 'fpCol:', footprintColumn);
		await saveAISettings();
		document.querySelector('.modal-overlay')?.remove();
		updateMatchButtonText();
		// 重新检测绑定状态并刷新表格
		if (bomData.length) {
			await reDetectBindStatus();
			renderTable(searchInput.value);
		}
	}

	/** 更新匹配按钮文字（反映 AI 状态） */
	/** 重新检测所有器件的绑定状态（根据 bindDetectMode） */
	async function reDetectBindStatus() {
		try {
			const comps = await eda.sch_PrimitiveComponent.getAll('part', true);
			if (!comps)
				return;
			for (const comp of comps) {
				const designator = comp.getState_Designator();
				if (!designator)
					continue;
				const ci = comp.getState_Component();
				const fp = comp.getState_Footprint();
				const sym = comp.getState_Symbol();
				const other = comp.getState_OtherProperty();
				const hasDevice = !!ci?.uuid;
				const hasEasyedaFp = !!fp?.uuid;
				const hasLcsc = !!(other?.LCSC || other?.['Supplier Part'] || other?.['立创编号']);
				let isBound = false;
				if (bindDetectMode === 'fp')
					isBound = hasDevice && hasEasyedaFp;
				else if (bindDetectMode === 'lcsc')
					isBound = hasDevice && hasLcsc;
				else if (bindDetectMode === 'fp_or_lcsc')
					isBound = hasDevice && (hasEasyedaFp || hasLcsc);
				else isBound = hasDevice;

				if (isBound) {
					const existing = bindStatus[designator]?.deviceInfo || {};
					bindStatus[designator] = {
						bound: true,
						...bindStatus[designator],
						deviceInfo: {
							name: ci?.name || existing.name || '',
							package: fp?.name || other?.['Origin Footprint'] || existing.package || '',
							lcsc: other?.LCSC || other?.['Supplier Part'] || existing.lcsc || '',
							manufacturer: other?.Manufacturer || existing.manufacturer || '',
							libraryUuid: ci?.libraryUuid || existing.libraryUuid || '',
							uuid: ci?.uuid || existing.uuid || '',
							symbolUuid: sym?.uuid || existing.symbolUuid || '',
							symbolLibraryUuid: sym?.libraryUuid || existing.symbolLibraryUuid || '',
							footprintUuid: fp?.uuid || existing.footprintUuid || '',
							footprintLibraryUuid: fp?.libraryUuid || existing.footprintLibraryUuid || '',
						},
					};
				}
				else if (bindStatus[designator]?.bound) {
					// 不再满足绑定条件，清除
					delete bindStatus[designator];
				}
			}
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'reDetectBindStatus failed:', err);
		}
	}

	function updateMatchButtonText() {
		const btn = document.getElementById('btnMatch');
		if (btn) {
			btn.textContent = aiSettings.enabled ? i18n('🤖 AI 匹配') : i18n('🔄 匹配');
		}
	}

	/**
	 * 调用 AI API（OpenAI Chat Completions 格式）
	 * 使用 eda.sys_ClientUrl.request() 发送 HTTP 请求
	 */
	async function callAI(messages) {
		if (!aiSettings.apiUrl || !aiSettings.apiKey) {
			throw new Error(i18n('未配置 AI API 地址或 Key'));
		}
		const body = JSON.stringify({
			model: aiSettings.model,
			messages,
			temperature: 0.3,
		});
		// 输出发送给 AI 的内容
		const logMessages = messages.map(m => `【${m.role}】${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`).join('\n');
		console.warn(PLUGIN_TAG, '📤 发送 AI 请求:\n', `model: ${aiSettings.model}\n${logMessages}`);
		const response = await eda.sys_ClientUrl.request(
			aiSettings.apiUrl,
			'POST',
			body,
			{
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${aiSettings.apiKey}`,
				},
			},
		);
		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			console.error(PLUGIN_TAG, i18n('AI API 错误:'), response.status, errText);
			throw new Error(i18n('AI API 返回 ${1}: ${2}', response.status, errText.substring(0, 200)));
		}
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content || '';
		// 输出 AI 回复的内容
		console.warn(PLUGIN_TAG, '📥 AI 回复:', content.substring(0, 500) + (content.length > 500 ? '...' : ''));
		return content;
	}

	/**
	 * AI 匹配单个器件
	 * 1. 让 AI 生成搜索关键词
	 * 2. 用关键词搜索器件库
	 * 3. 让 AI 从结果中选出最佳匹配
	 */
	async function aiMatchSingle(g) {
		// 准备器件信息：遵循选中的封装列和匹配依据列
		const infoParts = [];
		// 封装列
		if (g.pkg) {
			infoParts.push(`Footprint: ${g.pkg}`);
		}
		// 匹配依据列
		for (const col of matchColumns) {
			const val = String(g._raw[col] || '').trim();
			if (val) {
				infoParts.push(`${col}: ${val}`);
			}
		}
		// 未选列时用默认字段
		if (!infoParts.length) {
			infoParts.push(`Value: ${g.value}`);
			infoParts.push(`Footprint: ${g.pkg}`);
			if (g.mpn) {
				infoParts.push(`MPN: ${g.mpn}`);
			}
		}
		const compInfo = infoParts.join(', ');

		// Step 1: 生成搜索关键词并搜索，支持 AI 重试
		let keyword = '';
		let results = [];
		const maxRetries = 3;
		const usedKeywords = [];

		// 辅助函数：清理 AI 返回的关键词（兼容 markdown 代码块）
		function cleanKeyword(resp) {
			let cleaned = resp;
			// 去除 markdown 代码块
			cleaned = cleaned.replace(/```json\s?/g, '').replace(/```\s?/g, '');
			// 尝试解析 JSON
			try {
				const parsed = JSON.parse(cleaned.trim());
				if (parsed.keyword) {
					return parsed.keyword.trim();
				}
				if (typeof parsed === 'string') {
					return parsed.trim();
				}
			}
			catch {
				// 非 JSON，按纯文本处理
			}
			return cleaned
				.replace(/^\s*[-•*]\s*/gm, '')
				.replace(/\*\*[^*]*\*\*/g, '')
				.split(/[\n\r]+/)
				.map(l => l.trim())
				.filter(l => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('💡'))
				.find(l => l.length > 1 && l.length < 50) || resp.trim().substring(0, 30);
		}

		// 辅助函数：搜索器件库（含降级策略）
		async function searchWithFallback(kw) {
			let r = await searchDevice(kw);
			if (!r.length && g.mpn && !usedKeywords.includes(g.mpn)) {
				r = await searchDevice(g.mpn);
			}
			if (!r.length && g.value) {
				const coreValue = g.value.replace(/\s*±?\d[\d.]*%\s*$/, '').trim();
				if (!usedKeywords.includes(coreValue)) {
					r = await searchDevice(coreValue);
				}
			}
			if (!r.length && g.value && g.pkg) {
				const coreValue = g.value.replace(/\s*±?\d[\d.]*%\s*$/, '').trim();
				r = await searchDevice(`${coreValue} ${g.pkg}`);
			}
			return r;
		}

		// 第一次搜索
		const firstKwResp = await callAI([
			{ role: 'system', content: '你是电子元器件选型专家。' },
			{ role: 'user', content: `根据器件信息生成一个最合适的立创商城搜索关键词。规则：1. 只返回JSON，不要任何解释。2. JSON格式：{"keyword":"搜索关键词"}。3. 英文型号优先。4. 如果有LCSC编号，优先使用。5. 关键词只能包含字母、数字、空格、连字符(-)和点号(.)，不要包含斜杠(/)等特殊符号。\n\n器件信息: ${compInfo}\n\n只返回JSON：` },
		]);
		keyword = cleanKeyword(firstKwResp);
		// 关键词格式校验：必须是合理长度的英文/数字关键词
		if (!keyword || keyword.length < 2 || keyword.length > 50) {
			// 格式不符，重试一次
			const retryResp = await callAI([
				{ role: 'system', content: '你是电子元器件选型专家。' },
				{ role: 'user', content: `上次生成格式不正确，请严格按照要求的JSON格式重新生成。JSON格式：{"keyword":"搜索关键词"}。只返回JSON，不要任何解释。\n\n器件信息: ${compInfo}\n\n只返回JSON：` },
			]);
			keyword = cleanKeyword(retryResp);
		}
		usedKeywords.push(keyword);
		results = await searchWithFallback(keyword);

		// 搜索无结果时，请求 AI 换关键词重试
		for (let emptyRetry = 0; emptyRetry < maxRetries && !results.length; emptyRetry++) {
			console.warn(PLUGIN_TAG, `关键词 "${keyword}" 搜索无结果，请求 AI 生成新关键词 (第 ${emptyRetry + 1} 次)`);
			const newKwResp = await callAI([
				{ role: 'system', content: '你是电子元器件选型专家。' },
				{ role: 'user', content: `之前的关键词在立创商城搜索不到结果，请换一个不同的关键词重试。规则：1. 只返回JSON，不要任何解释。2. JSON格式：{"keyword":"搜索关键词"}。3. 英文型号优先。4. 关键词只能包含字母、数字、空格、连字符(-)和点号(.)，不要包含斜杠(/)等特殊符号。5. 尝试用器件的核心型号（去掉封装后缀）搜索。6. 与之前的关键词不同。\n\n器件信息: ${compInfo}\n\n之前搜索过的关键词: ${usedKeywords.join(', ')}\n\n只返回JSON：` },
			]);
			keyword = cleanKeyword(newKwResp);
			if (!keyword || usedKeywords.includes(keyword))
				break;
			usedKeywords.push(keyword);
			results = await searchWithFallback(keyword);
		}

		// Step 2: 让 AI 判断匹配结果，若无匹配则重新搜索
		let aiIdx = 0;
		let aiReason = '';
		let finalResults = results;

		let aiNewKeyword = '';
		for (let retry = 0; retry < maxRetries && finalResults.length > 0; retry++) {
			aiNewKeyword = '';
			const topResults = finalResults.slice(0, 10).map((d, i) => ({
				idx: i,
				name: d.name,
				package: d.package,
				manufacturer: d.manufacturer,
				description: d.description,
			}));

			const matchResp = await callAI([
				{ role: 'system', content: '你是电子元器件选型专家。' },
				{ role: 'user', content: `从候选器件中选出与目标器件最匹配的一个。规则：1. 只返回JSON，不要任何文字、分析或解释。2. JSON格式：{"idx":数字,"reason":"一句话原因"}。3. 如果没有完全匹配的，选封装最接近的。4. 如果全部不匹配，返回 {"idx":-1,"reason":"无匹配"}\n\n目标器件: ${compInfo}\n\n候选器件:\n${JSON.stringify(topResults)}\n\n只返回JSON：` },
			]);

			// 解析 AI 响应
			try {
				const cleaned = matchResp.replace(/```json\s?/g, '').replace(/```\s?/g, '');
				// 检测空数组 []（无匹配）
				const arrayMatch = cleaned.match(/\[\s*\]/);
				if (arrayMatch) {
					aiIdx = -1;
				}
				else {
					// 提取 JSON 对象
					let jsonStr = '';
					let depth = 0;
					let start = -1;
					for (let ci = 0; ci < cleaned.length; ci++) {
						if (cleaned[ci] === '{') {
							if (depth === 0) {
								start = ci;
							}
							depth++;
						}
						else if (cleaned[ci] === '}') {
							depth--;
							if (depth === 0 && start !== -1) {
								jsonStr = cleaned.substring(start, ci + 1);
								break;
							}
						}
					}
					if (jsonStr) {
						const parsed = JSON.parse(jsonStr);
						// 检查必需字段是否存在
						const hasIdx = 'idx' in parsed || 'candidate' in parsed || 'match_idx' in parsed;
						if (!hasIdx) {
							// 格式不符，让 AI 重试
							console.warn(PLUGIN_TAG, 'AI 返回格式不符，要求重试');
							continue;
						}
						aiIdx = parsed.idx ?? parsed.candidate ?? parsed.match_idx ?? 0;
						aiReason = parsed.reason || '';
						// 检测 "无匹配" 模式
						const isNoMatch = parsed.result === 'none' || parsed.result === 'false'
							|| aiIdx === -1 || aiIdx === null
							|| aiReason.includes('无匹配') || aiReason.includes('不兼容')
							|| aiReason.includes('无法替代') || aiReason.includes('无合适');
						if (isNoMatch) {
							aiIdx = -1;
							// 从 AI 回复中提取新关键词
							aiNewKeyword = parsed.new_keyword || parsed.new_keyword_alt || parsed.alt_keyword || '';
						}
					}
				}
			}
			catch {
				console.warn(PLUGIN_TAG, 'AI response parse failed');
			}

			// AI 判断无匹配，用 AI 给出的新关键词重试
			if (aiIdx === -1) {
				// 如果 AI 没给新关键词，请求 AI 给出
				if (!aiNewKeyword) {
					const newKwResp = await callAI([
						{ role: 'system', content: '你是电子元器件选型专家。' },
						{ role: 'user', content: `之前的搜索i18n('未找到匹配器件')，请换一个不同的关键词。规则：1. 只返回JSON，不要任何解释。2. JSON格式：{"keyword":"搜索关键词"}。3. 英文型号优先。4. 如果有LCSC编号，优先使用。5. 不要返回标点符号或特殊字符。6. 与之前的关键词不同。\n\n器件信息: ${compInfo}\n\n之前搜索过的关键词: ${usedKeywords.join(', ')}\n\n只返回JSON：` },
					]);
					aiNewKeyword = cleanKeyword(newKwResp);
				}
				if (!aiNewKeyword || usedKeywords.includes(aiNewKeyword)) {
					break; // 无新关键词可试
				}
				console.warn(PLUGIN_TAG, `AI 判断无匹配（第 ${retry + 1} 次），新关键词: ${aiNewKeyword}`);
				usedKeywords.push(aiNewKeyword);
				finalResults = await searchWithFallback(aiNewKeyword);
				if (!finalResults.length) {
					break; // 无搜索结果
				}
				aiIdx = 0;
				aiReason = '';
				aiNewKeyword = '';
				continue; // 重新让 AI 判断
			}

			// AI 给出了有效匹配，跳出重试循环
			break;
		}

		if (!finalResults.length) {
			return { bestMatch: null, candidates: [], matchScore: 0, aiRecommended: false };
		}

		// 计算匹配度并排序
		const scored = finalResults.map(d => ({ device: d, score: calcMatchScore(g, d) })).sort((a, b) => b.score - a.score);

		// AI 判断无匹配时，降级为普通匹配（用 calcMatchScore 分数）
		if (aiIdx === -1) {
			const bestDevice = scored[0]?.device || null;
			return {
				bestMatch: bestDevice,
				candidates: scored,
				matchScore: scored[0]?.score || 0,
				aiRecommended: false,
				aiReason: i18n('AI 未找到匹配器件，已降级为普通匹配: ${1}', aiReason),
				aiKeyword: usedKeywords.join(' → '),
			};
		}

		// AI 给出有效匹配
		const bestDevice = finalResults[aiIdx] || scored[0]?.device || null;
		return {
			bestMatch: bestDevice,
			candidates: scored,
			matchScore: 100,
			aiRecommended: true,
			aiReason,
			aiKeyword: usedKeywords.join(' → '),
		};
	}

	/**
	 * AI 匹配全部器件
	 */
	async function aiMatchAll() {
		if (!aiSettings.enabled || !aiSettings.apiUrl || !aiSettings.apiKey) {
			showToast(i18n('请先配置 AI 设置'), 'error');
			openSettingsModal();
			return;
		}

		const total = bomData.length;
		if (!total)
			return;

		const progressBar = $('#progressBar');
		const progressFill = $('#progressFill');
		const progressText = $('#progressText');
		if (progressBar)
			show(progressBar);

		let completed = 0;
		const updateProgress = (msg) => {
			const pct = Math.round((completed / total) * 100);
			if (progressFill)
				progressFill.style.width = `${pct}%`;
			if (progressText)
				progressText.textContent = `${msg} ${completed}/${total} (${pct}%)`;
		};

		if (aiSettings.batchSend) {
			// ===== 组合发送模式 =====
			const charLimit = aiSettings.contextSize * 1024 * 3; // 1 token ≈ 3 字符

			// 为每个器件准备信息字符串并估算大小
			const items = bomData.map((g) => {
				const allFields = Object.entries(g._raw)
					.filter(([k, v]) => !k.startsWith('_') && v && String(v).trim())
					.map(([k, v]) => `${k}: ${v}`)
					.join(', ');
				return {
					g,
					key: g.designatorList.join(','),
					info: allFields || `Value: ${g.value}, Footprint: ${g.pkg}, MPN: ${g.mpn}`,
				};
			});

			// 按上下文大小打包
			const batches = [];
			let currentBatch = [];
			let currentSize = 0;
			const overhead = 500; // 预留 prompt 模板开销

			for (const item of items) {
				const itemSize = item.info.length + 50; // 额外开销（索引、分隔符等）
				if (currentSize + itemSize + overhead > charLimit && currentBatch.length > 0) {
					batches.push(currentBatch);
					currentBatch = [];
					currentSize = 0;
				}
				currentBatch.push(item);
				currentSize += itemSize;
			}
			if (currentBatch.length > 0)
				batches.push(currentBatch);

			// 逐批处理
			for (let bi = 0; bi < batches.length; bi++) {
				const batch = batches[bi];

				// Step 1: 批量生成搜索关键词
				const compList = batch.map((item, i) => `[${i}] ${item.info}`).join('\n');
				let keywords = [];
				try {
					const kwResp = await callAI([
						{ role: 'system', content: '你是电子元器件选型专家。' },
						{ role: 'user', content: `为每个器件生成一个立创商城搜索关键词。规则：1. 每个器件只返回一个关键词。2. 英文型号优先。3. 有LCSC编号优先使用。4. 只返回JSON数组，不要任何解释。格式：["keyword0","keyword1"]\n\n${batch.length} 个器件，请为每个生成一个搜索关键词：\n${compList}\n\n只返回JSON数组：` },
					]);
					const match = kwResp.match(/\[[\s\S]*\]/);
					if (match) {
						try {
							keywords = JSON.parse(match[0]);
						}
						catch {
							// 解析失败时逐行提取
							keywords = match[0].replace(/[[\]"]/g, '').split(',').map(s => s.trim());
						}
					}
					if (!keywords.length || keywords.length < batch.length) {
						// 补齐不足的关键词
						while (keywords.length < batch.length) keywords.push('');
					}
				}
				catch (err) {
					console.error(PLUGIN_TAG, 'Batch keyword generation failed', err);
				}

				// Step 2: 批量搜索器件库
				const searchResults = [];
				for (let i = 0; i < batch.length; i++) {
					const kw = (keywords[i] || '').trim().replace(/["'\n]/g, '');
					const results = kw ? await searchDevice(kw) : [];
					searchResults.push(results.slice(0, 5));
				}

				// Step 3: 批量让 AI 选择最佳匹配
				const matchInput = batch.map((item, i) => {
					const candidates = searchResults[i].map((d, j) => `  [${j}] ${d.name} | ${d.package} | ${d.manufacturer} | ${d.description}`).join('\n');
					return `器件[${i}]: ${item.info}\n候选:\n${candidates}`;
				}).join('\n\n');

				try {
					const matchResp = await callAI([
						{ role: 'system', content: '你是电子元器件选型专家。' },
						{ role: 'user', content: `为每个器件从候选中选出最佳匹配。返回 JSON 数组，每个元素 {"idx": 器件序号, "candidate": 候选序号, "reason": "原因"}。\n\n请为以下 ${batch.length} 个器件选择最佳匹配：\n${matchInput}` },
					]);
					const match = matchResp.match(/\[[\s\S]*\]/);
					const aiResults = match ? JSON.parse(match[0]) : [];

					for (let i = 0; i < batch.length; i++) {
						const aiResult = aiResults.find(r => r.idx === i) || {};
						const cIdx = aiResult.candidate ?? 0;
						const dev = searchResults[i][cIdx] || searchResults[i][0];
						const scored = (searchResults[i] || []).map(d => ({ device: d, score: calcMatchScore(batch[i].g, d) }));
						matchResults[batch[i].key] = {
							bestMatch: dev || null,
							candidates: scored,
							matchScore: dev ? 100 : 0,
							aiRecommended: !!dev,
							aiReason: aiResult.reason || '',
							aiKeyword: keywords[i] || '',
						};
						// 降级匹配封装
						if (!dev && fallbackFootprintEnabled) {
							const fpRes = await findFootprintFallbackAI(batch[i].g);
							if (fpRes.bestMatch)
								matchResults[batch[i].key] = fpRes;
						}
						batch[i].g.designatorList.forEach((d) => {
							if (!(d in bindStatus))
								bindStatus[d] = { bound: false, deviceInfo: null };
						});
						completed++;
					}
				}
				catch (err) {
					console.error(PLUGIN_TAG, 'Batch match failed', err);
					for (let i = 0; i < batch.length; i++) {
						matchResults[batch[i].key] = { bestMatch: null, candidates: [], matchScore: 0 };
						// 降级匹配封装
						if (fallbackFootprintEnabled) {
							const fpRes = await findFootprintFallbackAI(batch[i].g);
							if (fpRes.bestMatch)
								matchResults[batch[i].key] = fpRes;
						}
						completed++;
					}
				}

				updateProgress(i18n('AI 批量匹配 (${1}/${2}批)', bi + 1, batches.length));
				renderTable(searchInput.value);
			}
		}
		else {
			// ===== 逐个匹配模式 =====
			for (const g of bomData) {
				const key = g.designatorList.join(',');
				try {
					matchResults[key] = await aiMatchSingle(g);
					// 降级匹配封装
					if (!matchResults[key].bestMatch && fallbackFootprintEnabled) {
						const fpRes = await findFootprintFallbackAI(g);
						if (fpRes.bestMatch)
							matchResults[key] = fpRes;
					}
					g.designatorList.forEach((d) => {
						if (!(d in bindStatus))
							bindStatus[d] = { bound: false, deviceInfo: null };
					});
				}
				catch (err) {
					console.error(PLUGIN_TAG, 'AI match failed for', key, err);
					matchResults[key] = { bestMatch: null, candidates: [], matchScore: 0 };
					// 降级匹配封装
					if (fallbackFootprintEnabled) {
						const fpRes = await findFootprintFallbackAI(g);
						if (fpRes.bestMatch)
							matchResults[key] = fpRes;
					}
				}
				completed++;
				updateProgress(i18n('AI 匹配中'));
				renderTable(searchInput.value);
			}
		}

		if (progressBar)
			hide(progressBar);
		renderTable();
		showToast(i18n('AI 匹配完成，共 ${1} 组', total), 'success');
	}

	/**
	 * 绑定器件到原理图图元
	 *
	 * 流程（经 bridge 实测验证）：
	 * 1. 保存器件所有原始参数
	 * 2. LIB_Device.modify() 修改库器件的封装
	 * 3. sch_PrimitiveComponent.delete() 删除旧图元
	 * 4. sch_PrimitiveComponent.create() 创建新图元（自动使用更新后的封装）
	 * 5. sch_PrimitiveComponent.modify() 恢复所有原始参数
	 */
	/**
	 * 绑定封装到原理图器件
	 *
	 * 流程：
	 * 1. 记录原始器件全部信息
	 * 2. LIB_Device.modify() 修改库器件封装
	 * 3. 删除旧器件
	 * 4. 创建新器件（使用更新后的库器件）
	 * 5. 恢复所有原始参数
	 */

	/**
	 * 解析器件所属库的真实 libraryUuid
	 *
	 * 背景：通过 Altium 等导入的器件，getState_Component().libraryUuid 常为空字符串；
	 * 而 sch_PrimitiveComponent.create({libraryUuid:'project'}) 在这些器件上会卡死/失败。
	 * 因此需要先在工程库中按名称搜索、按 uuid 匹配，拿到真实的 libraryUuid。
	 *
	 * @param {object} compInfo - getState_Component() 的返回值 {libraryUuid, uuid, name}
	 * @returns {Promise<string>} 真实库 UUID；实在无法解析时回退 'project'
	 */
	async function resolveDeviceLibrary(compInfo) {
		if (compInfo?.libraryUuid)
			return compInfo.libraryUuid;
		try {
			const found = await eda.lib_Device.search(compInfo?.name || '', 'project');
			const hit = (found || []).find(d => d.uuid === compInfo?.uuid);
			if (hit?.libraryUuid) {
				console.warn(PLUGIN_TAG, 'Resolved device library by search:', hit.libraryUuid);
				return hit.libraryUuid;
			}
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'resolveDeviceLibrary failed:', err);
		}
		console.warn(PLUGIN_TAG, 'Device library unresolved, fallback to project');
		return 'project';
	}

	async function bindComponent(primitiveId, deviceInfo) {
		console.warn(PLUGIN_TAG, 'bindComponent called, options:', JSON.stringify(bindOptions));
		if (!primitiveId) {
			console.warn(PLUGIN_TAG, 'No primitiveId, cannot bind');
			return false;
		}
		try {
			const comps = await eda.sch_PrimitiveComponent.getAll('part', true);
			const comp = comps.find(c => c.getState_PrimitiveId() === primitiveId);
			if (!comp) {
				console.warn(PLUGIN_TAG, 'Component not found:', primitiveId);
				return false;
			}

			const compInfo = comp.getState_Component();
			const fpInfo = comp.getState_Footprint();
			const saved = {
				designator: comp.getState_Designator(),
				name: comp.getState_Name(),
				uniqueId: comp.getState_UniqueId(),
				x: comp.getState_X(),
				y: comp.getState_Y(),
				rotation: comp.getState_Rotation(),
				mirror: comp.getState_Mirror(),
				addIntoBom: comp.getState_AddIntoBom(),
				addIntoPcb: comp.getState_AddIntoPcb(),
				manufacturer: comp.getState_Manufacturer(),
				manufacturerId: comp.getState_ManufacturerId(),
				supplier: comp.getState_Supplier(),
				supplierId: comp.getState_SupplierId(),
				otherProperty: comp.getState_OtherProperty(),
				libraryUuid: compInfo.libraryUuid,
				deviceUuid: compInfo.uuid,
				originalFootprint: fpInfo ? { uuid: fpInfo.uuid, libraryUuid: fpInfo.libraryUuid } : null,
			};

			const keepSymbol = bindOptions.keepSymbol;
			const keepFootprint = bindOptions.keepFootprint;

			// 合并 otherProperty（元数据总是更新）
			const mergedOther = { ...(saved.otherProperty || {}) };
			if (deviceInfo.name)
				mergedOther['LCSC Part Name'] = deviceInfo.name;
			if (deviceInfo.mpn)
				mergedOther['Manufacturer Part'] = deviceInfo.mpn;
			if (deviceInfo.manufacturer)
				mergedOther.Manufacturer = deviceInfo.manufacturer;
			if (deviceInfo.lcsc)
				mergedOther['Supplier Part'] = deviceInfo.lcsc;
			if (deviceInfo.package)
				mergedOther['Supplier Footprint'] = deviceInfo.package;
			if (deviceInfo.description)
				mergedOther.Description = deviceInfo.description;

			const modifyParams = {
				manufacturer: deviceInfo.manufacturer || saved.manufacturer || null,
				manufacturerId: deviceInfo.mpn || saved.manufacturerId || null,
				supplier: deviceInfo.supplier || saved.supplier || null,
				supplierId: deviceInfo.lcsc || saved.supplierId || null,
				otherProperty: mergedOther,
			};
			if (bindOptions.keepDesignatorId) {
				modifyParams.designator = saved.designator;
				modifyParams.name = saved.name;
				modifyParams.uniqueId = saved.uniqueId;
			}

			// 场景 A：符号和封装都保留 → 仅更新元数据，不重建器件
			if (keepSymbol && keepFootprint) {
				await eda.sch_PrimitiveComponent.modify(primitiveId, modifyParams);
				return { saved, newPrimitiveId: primitiveId };
			}

			// 场景 B/C/D：需要换符号或封装 —— 通过修改当前 device 的关联再重建来刷新
			// sch_PrimitiveComponent.modify() 无法替换 symbol/footprint 引用，只能改显示字段
			let targetFootprint = null;
			if (!keepFootprint) {
				if (deviceInfo.footprintUuid && deviceInfo.libraryUuid) {
					targetFootprint = { uuid: deviceInfo.footprintUuid, libraryUuid: deviceInfo.libraryUuid };
				}
				else if (deviceInfo.package || deviceInfo.name) {
					try {
						const fpSearch = await eda.lib_Footprint.search(deviceInfo.package || deviceInfo.name);
						if (fpSearch[0])
							targetFootprint = { uuid: fpSearch[0].uuid, libraryUuid: fpSearch[0].libraryUuid };
					}
					catch (e) {
						console.error(PLUGIN_TAG, 'lib_Footprint.search failed', e);
					}
				}
				if (!targetFootprint) {
					showToast(i18n('未找到目标封装'), 'error');
					return false;
				}
			}

			let targetSymbol = null;
			if (!keepSymbol) {
				if (deviceInfo.symbolUuid && deviceInfo.libraryUuid) {
					targetSymbol = { uuid: deviceInfo.symbolUuid, libraryUuid: deviceInfo.libraryUuid };
				}
				else {
					showToast(i18n('未找到目标符号'), 'error');
					return false;
				}
			}

			const association = {};
			if (targetFootprint)
				association.footprint = targetFootprint;
			if (targetSymbol)
				association.symbol = targetSymbol;

			const realLib = await resolveDeviceLibrary(compInfo);
			const modOk = await eda.lib_Device.modify(compInfo.uuid, realLib, undefined, undefined, association);
			if (!modOk) {
				showToast(i18n('修改器件封装/符号失败'), 'error');
				return false;
			}

			// 用同一 device uuid 重建 → 未修改的一侧（符号或封装）保持不变
			await eda.sch_PrimitiveComponent.delete(primitiveId);
			const created = await eda.sch_PrimitiveComponent.create(
				{ libraryUuid: realLib, uuid: compInfo.uuid },
				saved.x,
				saved.y,
				'',
				saved.rotation,
				saved.mirror,
				saved.addIntoBom,
				saved.addIntoPcb,
			);
			if (!created) {
				showToast(i18n('重建器件失败'), 'error');
				return false;
			}

			await eda.sch_PrimitiveComponent.modify(created.primitiveId, modifyParams);
			return { saved, newPrimitiveId: created.primitiveId };
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'Bind component failed', err);
			return false;
		}
	}

	/**
	 * 执行原理图 DRC 检查
	 */
	async function runDrcCheck() {
		try {
			const errors = await eda.sch_Drc.check(true, false, true);
			return Array.isArray(errors) ? errors : [];
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'DRC check failed', err);
			return null;
		}
	}

	// ============ 匹配逻辑 ============

	/**
	 * 计算单个器件的匹配度
	 * 基于选定的多选匹配列计算分数
	 */
	/** BOM 列名 → 器件字段映射 */
	function bomColToDeviceField(col, device) {
		const c = col.toLowerCase();
		// 型号/名称/MPN
		if (['mpn', '型号', 'name', 'value', '元件名称', 'comment', 'part number', 'marking code', 'manufacturer part', 'manufacturer part number', 'mfr part', 'mfr part number'].some(k => c.includes(k) || c === k)) {
			return String(device.name || '').trim().toLowerCase();
		}
		// 封装
		if (['footprint', '封装', 'package', 'pcb decal'].some(k => c.includes(k) || c === k)) {
			return String(device.package || '').trim().toLowerCase();
		}
		// LCSC / 立创编号 / 供应商编号
		if (['lcsc', '立创编号', '供应商编号', 'supplier part', 'supplier'].some(k => c.includes(k) || c === k)) {
			return String(device.lcsc || '').trim().toLowerCase();
		}
		// 制造商
		if (['manufacturer', '制造商', 'brand', 'mfr'].some(k => c.includes(k) || c === k) && !c.includes('part')) {
			return String(device.manufacturer || '').trim().toLowerCase();
		}
		// 描述
		if (['description', '描述', '说明', 'desc', 'details', 'remark'].some(k => c.includes(k) || c === k)) {
			return String(device.description || '').trim().toLowerCase();
		}
		// 默认：尝试匹配 name
		return String(device.name || '').trim().toLowerCase();
	}

	function calcMatchScore(g, device) {
		// 有选中列时，按选中列计算（只比对勾选列对应的器件字段）
		if (matchColumns.length) {
			let matchedCols = 0;
			let totalCols = 0;
			for (const col of matchColumns) {
				const bomVal = extractCoreValue(String(g._raw[col] || '')).trim().toLowerCase();
				if (!bomVal)
					continue;
				totalCols++;
				const devVal = bomColToDeviceField(col, device);
				if (!devVal)
					continue;
				// 完全匹配得 1 分，包含匹配得 0.5 分
				if (devVal === bomVal) {
					matchedCols += 1;
				}
				else if (devVal.includes(bomVal) || bomVal.includes(devVal)) {
					matchedCols += 0.5;
				}
			}
			if (totalCols > 0) {
				return Math.round((matchedCols / totalCols) * 100);
			}
		}

		// 无选中列时，按默认逻辑：MPN/值完全匹配=100，包含=85，否则=60
		const target = (g.mpn || g.value || '').toUpperCase();
		const devName = (device.name || '').toUpperCase();
		if (!target)
			return 60;
		if (devName === target)
			return 100;
		if (devName.includes(target) || target.includes(devName))
			return 85;
		return 60;
	}

	/**
	 * 提取核心值（去除容差、精度等后缀）
	 * "1K 5%" → "1K"
	 * "0.1uF 10%" → "0.1uF"
	 * "330R" → "330R"
	 */
	function extractCoreValue(val) {
		if (!val)
			return '';
		// 去除容差后缀（如 5%, 10%, ±1%）
		return val.replace(/\s*±?\d+(?:\.\d*)?%\s*$/, '').trim();
	}

	/**
	 * 封装降级匹配（标准路径）：用封装列的值搜索 lib_Footprint
	 */
	async function findFootprintFallback(g) {
		let keyword = '';
		if (footprintColumn)
			keyword = String(g._raw[footprintColumn] || '').trim();
		if (!keyword)
			keyword = String(g.pkg || '').trim();
		if (!keyword)
			return { bestMatch: null, candidates: [], matchScore: 0 };

		try {
			const fpResults = await eda.lib_Footprint.search(keyword);
			if (!fpResults || !fpResults.length)
				return { bestMatch: null, candidates: [], matchScore: 0 };

			const fp = fpResults[0];
			const deviceInfo = {
				name: fp.name,
				package: fp.name,
				lcsc: '',
				manufacturer: '',
				description: fp.description || '',
			};
			return {
				bestMatch: deviceInfo,
				candidates: fpResults.map(f => ({ device: { name: f.name, package: f.name }, score: 100 })),
				matchScore: 100,
				footprintOnly: true,
			};
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'Footprint fallback failed', err);
			return { bestMatch: null, candidates: [], matchScore: 0 };
		}
	}

	/**
	 * 封装降级匹配（AI 路径）：让 AI 根据匹配依据列推断封装关键词，搜索 lib_Footprint
	 */
	async function findFootprintFallbackAI(g) {
		// 构建器件信息
		const infoParts = [];
		if (g.pkg)
			infoParts.push(`Footprint: ${g.pkg}`);
		for (const col of matchColumns) {
			const val = String(g._raw[col] || '').trim();
			if (val)
				infoParts.push(`${col}: ${val}`);
		}
		if (!infoParts.length) {
			infoParts.push(`Value: ${g.value}`);
			if (g.mpn)
				infoParts.push(`MPN: ${g.mpn}`);
		}
		const compInfo = infoParts.join(', ');

		// 让 AI 推断封装关键词
		let keyword = '';
		try {
			const resp = await callAI([
				{ role: 'system', content: '你是电子元器件选型专家。' },
				{ role: 'user', content: `器件找不到匹配的库器件，请根据器件信息推断出最可能的封装名称用于搜索封装库。规则：1. 只返回JSON，不要任何解释。2. JSON格式：{"keyword":"封装搜索关键词"}。3. 返回标准封装名称（如 SOIC-8, QFN-32, 0805, SOT-23 等）。4. 根据器件类型和参数推断封装。\n\n器件信息: ${compInfo}\n\n只返回JSON：` },
			]);
			const cleaned = resp.replace(/```json\s?/g, '').replace(/```\s?/g, '').trim();
			try {
				const parsed = JSON.parse(cleaned);
				keyword = parsed.keyword || (typeof parsed === 'string' ? parsed : '');
			}
			catch {
				keyword = cleaned.replace(/["']/g, '').substring(0, 50);
			}
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'AI footprint keyword generation failed', err);
		}

		// AI 无结果时回退到标准路径
		if (!keyword)
			return findFootprintFallback(g);

		try {
			const fpResults = await eda.lib_Footprint.search(keyword);
			if (!fpResults || !fpResults.length)
				return findFootprintFallback(g);

			const fp = fpResults[0];
			const deviceInfo = {
				name: fp.name,
				package: fp.name,
				lcsc: '',
				manufacturer: '',
				description: fp.description || '',
			};
			return {
				bestMatch: deviceInfo,
				candidates: fpResults.map(f => ({ device: { name: f.name, package: f.name }, score: 100 })),
				matchScore: 100,
				footprintOnly: true,
				aiKeyword: keyword,
			};
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'AI footprint fallback search failed', err);
			return findFootprintFallback(g);
		}
	}

	/**
	 * 对单个 BOM 分组执行匹配
	 * 使用选定的多选匹配列作为搜索关键词
	 */
	async function findMatches(g) {
		// 构建搜索关键词：组合所有选中列的值
		let keyword = '';
		if (matchColumns.length) {
			keyword = matchColumns
				.map(c => String(g._raw[c] || '').trim())
				.filter(Boolean)
				.join(' ');
		}
		keyword = keyword || g.mpn || g.value || g.pkg || '';

		if (!keyword) {
			return { bestMatch: null, candidates: [], matchScore: 0 };
		}

		// 提取核心值（去除容差后缀）
		const coreKeyword = extractCoreValue(keyword);

		// 搜索器件库：先用核心值搜索，再用完整值搜索
		let results = await searchDevice(coreKeyword);
		if (!results.length && coreKeyword !== keyword) {
			results = await searchDevice(keyword);
		}
		// 若无结果且有 MPN，再用 MPN 搜索
		if (!results.length && g.mpn && keyword !== g.mpn) {
			results = await searchDevice(g.mpn);
		}

		if (!results.length) {
			return { bestMatch: null, candidates: [], matchScore: 0 };
		}

		// 计算每个结果的匹配度
		const scored = results.map(d => ({
			device: d,
			score: calcMatchScore(g, d),
		})).sort((a, b) => b.score - a.score);

		const best = scored[0];
		return {
			bestMatch: best.device,
			candidates: scored, // 返回所有候选，按匹配度排序
			matchScore: best.score,
		};
	}

	/**
	 * 对全部 BOM 执行匹配（并行处理，每批 5 个）
	 */
	async function matchAll() {
		// AI 启用时走 AI 匹配
		if (aiSettings.enabled && aiSettings.apiUrl && aiSettings.apiKey) {
			await aiMatchAll();
			return;
		}

		const total = bomData.length;
		if (!total)
			return;

		// 显示进度条
		const progressBar = $('#progressBar');
		const progressFill = $('#progressFill');
		const progressText = $('#progressText');
		if (progressBar)
			show(progressBar);

		let completed = 0;
		const batchSize = 5;

		// 分批并行处理
		for (let i = 0; i < total; i += batchSize) {
			const batch = bomData.slice(i, i + batchSize);
			const promises = batch.map(async (g) => {
				const key = g.designatorList.join(',');
				matchResults[key] = await findMatches(g);
				// 降级匹配封装
				if (!matchResults[key].bestMatch && fallbackFootprintEnabled) {
					const fpResult = await findFootprintFallback(g);
					if (fpResult.bestMatch)
						matchResults[key] = fpResult;
				}
				// 初始化绑定状态
				g.designatorList.forEach((d) => {
					if (!(d in bindStatus))
						bindStatus[d] = { bound: false, deviceInfo: null };
				});
				completed++;

				// 更新进度
				const pct = Math.round((completed / total) * 100);
				if (progressFill)
					progressFill.style.width = `${pct}%`;
				if (progressText)
					progressText.textContent = i18n('匹配中 ${1}/${2} (${3}%)', completed, total, pct);
			});

			await Promise.all(promises);
		}

		// 隐藏进度条
		if (progressBar)
			hide(progressBar);
		renderTable();
		showToast(i18n('匹配完成，共 ${1} 组', total), 'success');
	}

	// ============ SVG 生成（封装预览 + 原理图符号） ============

	function genPkgSVG(p, w = 80, h = 50) {
		const P = (p || '').toUpperCase();
		if (P.includes('0603') && !P.includes('100'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.12}" y="${h * 0.25}" width="${w * 0.22}" height="${h * 0.5}" fill="#cbd5e1"/><rect x="${w * 0.38}" y="${h * 0.15}" width="${w * 0.28}" height="${h * 0.7}" rx="3" fill="#475569"/><rect x="${w * 0.70}" y="${h * 0.25}" width="${w * 0.22}" height="${h * 0.5}" fill="#cbd5e1"/></svg>`;
		if (P.includes('0805'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.10}" y="${h * 0.22}" width="${w * 0.24}" height="${h * 0.56}" fill="#cbd5e1"/><rect x="${w * 0.36}" y="${h * 0.10}" width="${w * 0.30}" height="${h * 0.80}" rx="3" fill="#475569"/><rect x="${w * 0.68}" y="${h * 0.22}" width="${w * 0.24}" height="${h * 0.56}" fill="#cbd5e1"/></svg>`;
		if (P.includes('SOT-23') && !P.includes('SOT-223'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.20}" y="${h * 0.10}" width="${w * 0.60}" height="${h * 0.55}" rx="4" fill="#334155"/><rect x="${w * 0.20}" y="${h * 0.60}" width="${w * 0.12}" height="${h * 0.35}" fill="#cbd5e1"/><rect x="${w * 0.44}" y="${h * 0.60}" width="${w * 0.12}" height="${h * 0.35}" fill="#cbd5e1"/><rect x="${w * 0.68}" y="${h * 0.60}" width="${w * 0.12}" height="${h * 0.35}" fill="#cbd5e1"/></svg>`;
		if (P.includes('SOT-223'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.10}" y="${h * 0.05}" width="${w * 0.80}" height="${h * 0.55}" rx="4" fill="#334155"/><rect x="${w * 0.12}" y="${h * 0.55}" width="${w * 0.18}" height="${h * 0.40}" fill="#cbd5e1"/><rect x="${w * 0.41}" y="${h * 0.55}" width="${w * 0.18}" height="${h * 0.40}" fill="#cbd5e1"/><rect x="${w * 0.70}" y="${h * 0.55}" width="${w * 0.18}" height="${h * 0.40}" fill="#cbd5e1"/></svg>`;
		if (P.includes('SOP-8'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.08}" y="${h * 0.15}" width="${w * 0.84}" height="${h * 0.60}" rx="3" fill="#334155"/>${Array.from({ length: 4 }, (_, i) => `<rect x="${w * 0.02}" y="${h * (0.22 + i * 0.15)}" width="${w * 0.12}" height="${h * 0.08}" rx="1" fill="#cbd5e1"/><rect x="${w * 0.86}" y="${h * (0.22 + i * 0.15)}" width="${w * 0.12}" height="${h * 0.08}" rx="1" fill="#cbd5e1"/>`).join('')}</svg>`;
		if (P.includes('LQFP'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.12}" y="${h * 0.08}" width="${w * 0.76}" height="${h * 0.84}" rx="2" fill="#334155"/><circle cx="${w * 0.16}" cy="${h * 0.16}" r="${w * 0.03}" fill="#fbbf24"/></svg>`;
		if (P.includes('SMA'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.08}" y="${h * 0.22}" width="${w * 0.28}" height="${h * 0.56}" fill="#cbd5e1"/><rect x="${w * 0.36}" y="${h * 0.12}" width="${w * 0.30}" height="${h * 0.76}" rx="3" fill="#475569"/><rect x="${w * 0.66}" y="${h * 0.22}" width="${w * 0.28}" height="${h * 0.56}" fill="#cbd5e1"/></svg>`;
		if (P.includes('SOD'))
			return `<svg width="${w}" height="${h}"><rect x="${w * 0.08}" y="${h * 0.25}" width="${w * 0.30}" height="${h * 0.50}" fill="#cbd5e1"/><rect x="${w * 0.38}" y="${h * 0.18}" width="${w * 0.28}" height="${h * 0.64}" rx="3" fill="#475569"/><rect x="${w * 0.66}" y="${h * 0.25}" width="${w * 0.30}" height="${h * 0.50}" fill="#cbd5e1"/></svg>`;
		return `<svg width="${w}" height="${h}"><rect x="${w * 0.1}" y="${h * 0.15}" width="${w * 0.8}" height="${h * 0.7}" rx="4" fill="#e2e8f0"/><text x="${w * 0.5}" y="${h * 0.55}" text-anchor="middle" font-size="10">${P.substring(0, 8)}</text></svg>`;
	}

	function genSymSVG(name, w = 70, h = 50) {
		const n = (name || '').toLowerCase();
		let s = '';
		if (n.includes('res') || n.includes(i18n('电阻')))
			s = `<polyline points="${w * 0.1},${h * 0.5} ${w * 0.25},${h * 0.2} ${w * 0.45},${h * 0.5} ${w * 0.65},${h * 0.8} ${w * 0.9},${h * 0.5}" fill="none" stroke="#2563eb" stroke-width="2"/>`;
		else if (n.includes('cap') || n.includes(i18n('电容')))
			s = `<line x1="${w * 0.4}" y1="${h * 0.2}" x2="${w * 0.4}" y2="${h * 0.8}" stroke="#2563eb" stroke-width="2"/><line x1="${w * 0.6}" y1="${h * 0.2}" x2="${w * 0.6}" y2="${h * 0.8}" stroke="#2563eb" stroke-width="2"/>`;
		else if (n.includes('dio') || n.includes('led') || n.includes(i18n('二极管')))
			s = `<polygon points="${w * 0.3},${h * 0.2} ${w * 0.7},${h * 0.5} ${w * 0.3},${h * 0.8}" fill="none" stroke="#2563eb" stroke-width="2"/><line x1="${w * 0.7}" y1="${h * 0.2}" x2="${w * 0.7}" y2="${h * 0.8}" stroke="#2563eb" stroke-width="2"/>`;
		else if (n.includes('trans') || n.includes('mos') || n.includes(i18n('三极管')))
			s = `<circle cx="${w * 0.5}" cy="${h * 0.5}" r="${w * 0.2}" fill="none" stroke="#2563eb" stroke-width="2"/><line x1="${w * 0.3}" y1="${h * 0.2}" x2="${w * 0.5}" y2="${h * 0.3}" stroke="#2563eb" stroke-width="2"/><line x1="${w * 0.5}" y1="${h * 0.7}" x2="${w * 0.7}" y2="${h * 0.8}" stroke="#2563eb" stroke-width="2"/>`;
		else s = `<rect x="${w * 0.15}" y="${h * 0.15}" width="${w * 0.7}" height="${h * 0.7}" rx="4" fill="none" stroke="#2563eb" stroke-width="2"/><text x="${w * 0.5}" y="${h * 0.55}" text-anchor="middle" font-size="8" fill="#2563eb">IC</text>`;
		return `<svg width="${w}" height="${h}">${s}</svg>`;
	}

	// ============ 表格渲染 ============

	/**
	 * 获取 BOM 组的状态：bound / pending / unmatched
	 */
	function getGroupStatus(g) {
		const k = g.designatorList.join(',');
		const allBound = g.designatorList.every(d => bindStatus[d]?.bound);
		if (allBound)
			return 'bound';
		const mr = matchResults[k];
		if (mr?.bestMatch)
			return 'pending';
		return 'unmatched';
	}

	/**
	 * 按状态过滤表格
	 */
	function filterByStatus() {
		renderTable(searchInput.value);
	}

	function renderTable(filterText = '') {
		const f = filterText.toLowerCase();
		const showBound = document.getElementById('filterBound')?.checked ?? true;
		const showPending = document.getElementById('filterPending')?.checked ?? true;
		const showUnmatched = document.getElementById('filterUnmatched')?.checked ?? true;

		// 动态渲染表头
		renderTableHead();

		const filtered = bomData.filter((g) => {
			// 文本过滤（位号、型号、封装、值）
			if (f) {
				const matchDesignator = g.designatorStr.toLowerCase().includes(f);
				const matchMpn = (g.mpn || '').toLowerCase().includes(f);
				const matchPkg = (g.pkg || '').toLowerCase().includes(f);
				const matchValue = (g.value || '').toLowerCase().includes(f);
				if (!matchDesignator && !matchMpn && !matchPkg && !matchValue) {
					return false;
				}
			}
			// 状态过滤
			const status = getGroupStatus(g);
			if (status === 'bound' && !showBound)
				return false;
			if (status === 'pending' && !showPending)
				return false;
			if (status === 'unmatched' && !showUnmatched)
				return false;
			return true;
		});

		// 排序
		const sorted = sortData(filtered);

		if (!sorted.length) {
			tableBody.innerHTML = '';
			show(emptyState);
			return;
		}

		const visibleCols = tableColumns.filter(c => c.visible);

		tableBody.innerHTML = sorted
			.map((g) => {
				const k = g.designatorList.join(',');
				const mr = matchResults[k] || {};
				const best = mr.bestMatch;
				const score = best ? calcMatchScore(g, best) : (mr.matchScore || 0);
				const allBound = g.designatorList.every(d => bindStatus[d]?.bound);
				const anySelected = g.designatorList.some(d => selectedDesignators.has(d));
				const expanded = expandedDesignatorSets.has(k);

				// 按可见列生成单元格
				let cells = '';
				for (const col of visibleCols) {
					if (col.key === 'checkbox') {
						cells += `<td onclick="event.stopPropagation();window.__app.toggleGroupSelect('${k}')"><span class="checkbox-custom ${anySelected ? 'checked' : ''}"></span></td>`;
					}
					else if (col.key === 'designator') {
						let dd = g.designatorStr;
						if (g.designatorList.length > 3 && !expanded) {
							dd = `${g.designatorList.slice(0, 3).join(', ')} ... <span class="designator-toggle" onclick="window.__app.toggleDesignatorExpand('${k}');event.stopPropagation();">(${i18n('共${1}个', g.designatorList.length)})</span>`;
						}
						cells += `<td class="cell-designator">${dd}</td>`;
					}
					else if (col.key === 'mpn') {
						cells += `<td>${g.mpn || '-'}</td>`;
					}
					else if (col.key === 'qty') {
						cells += `<td style="text-align:center;">${g.qty}</td>`;
					}
					else if (col.key === 'footprint') {
						cells += `<td>${g.pkg || '-'}</td>`;
					}
					else if (col.key === 'matchResult') {
						let mb = `<span class="badge badge-neutral">${i18n('未匹配')}</span>`;
						if (best && mr.footprintOnly)
							mb = `<span class="badge badge-info">📦 ${best.name}</span>`;
						else if (best && score >= 95)
							mb = `<span class="badge badge-success">✅ ${best.name} (${best.package || '-'})</span>`;
						else if (best && score >= 60)
							mb = `<span class="badge badge-warning">⚠️ ${best.name} (${best.package || '-'})</span>`;
						else if (best)
							mb = `<span class="badge badge-neutral">${best.name} (${best.package || '-'})</span>`;
						cells += `<td>${mb}</td>`;
					}
					else if (col.key === 'matchScore') {
						cells += `<td style="font-weight:700;">${score}%${mr?.aiRecommended ? ' <span class="badge badge-success">🤖 AI</span>' : ''}</td>`;
					}
					else if (col.key === 'bindStatus') {
						cells += `<td>${allBound ? `<span class="badge badge-success">${i18n('已绑定')}</span>` : `<span class="badge badge-neutral">${i18n('未绑定')}</span>`}</td>`;
					}
					else if (col.key === 'boundPackage') {
						const boundPkg = g.designatorList.map(d => bindStatus[d]?.deviceInfo?.package || '').find(Boolean) || '';
						cells += `<td style="font-size:12px;color:${boundPkg ? 'var(--text)' : 'var(--text-muted)'};">${boundPkg || '-'}</td>`;
					}
					else if (col.key === 'boundSymbol') {
						const boundSym = g.designatorList.map(d => bindStatus[d]?.deviceInfo?.name || '').find(Boolean) || '';
						cells += `<td style="font-size:12px;color:${boundSym ? 'var(--text)' : 'var(--text-muted)'};">${boundSym || '-'}</td>`;
					}
					else if (col.key.startsWith('custom_')) {
						// 自定义 BOM 数据列：从 _raw 中读取
						const rawKey = col.key.slice(7); // 去掉 'custom_' 前缀
						const val = g._raw?.[rawKey] || g[rawKey] || '-';
						cells += `<td title="${val}">${val}</td>`;
					}
					else if (col.key === 'actions') {
						cells += `<td onclick="event.stopPropagation();">`;
						if (best) {
							// 已匹配：详情 + 解绑
							cells += `<button class="btn btn-outline btn-xs" onclick="window.__app.viewDetail('${k}')">${i18n('详情')}</button>`;
							cells += `<button class="btn btn-outline btn-xs" onclick="window.__app.unbindGroup('${k}')">${i18n('解绑')}</button>`;
						}
						else {
							// 未匹配：手动
							cells += `<button class="btn btn-outline btn-xs" onclick="window.__app.manualMatch('${k}')">${i18n('手动')}</button>`;
						}
						cells += `</td>`;
					}
				}

				return `<tr class="${anySelected ? 'selected' : ''}" data-key="${k}" onclick="window.__app.onGroupClick(event,'${k}')">${cells}</tr>`;
			})
			.join('');

		updStats();
		btnBatchBind.disabled = ![...selectedDesignators].some(d => !bindStatus[d]?.bound);
		btnExport.disabled = !Object.values(bindStatus).some(b => b.bound);

		hide(emptyState);
	}

	function updStats() {
		let b = 0;
		let p = 0;
		let u = 0;
		bomData.forEach((g) => {
			if (g.designatorList.some(d => bindStatus[d]?.bound))
				b++;
			else if (matchResults[g.designatorList.join(',')]?.bestMatch)
				p++;
			else u++;
		});
		$('#statBound').textContent = b;
		$('#statPending').textContent = p;
		$('#statUnmatched').textContent = u;
		$('#statTotal').textContent = bomData.length;
	}

	/**
	 * 更新封装列下拉菜单（单选）
	 */
	function updateFootprintColSelect() {
		const select = document.getElementById('footprintColSelect');
		if (!select)
			return;

		const prev = select.value;
		select.innerHTML = '<option value="">--</option>';

		for (const col of bomColumns) {
			const option = document.createElement('option');
			option.value = col;
			option.textContent = col;
			if (col === prev)
				option.selected = true;
			select.appendChild(option);
		}

		// 自动选择封装列
		if (!prev) {
			const fpKeywords = ['footprint', 'pcb decal', i18n('封装'), 'package', 'supplier footprint'];
			for (const col of bomColumns) {
				if (fpKeywords.some(k => col.toLowerCase().includes(k))) {
					select.value = col;
					break;
				}
			}
		}
	}

	/**
	 * 打开匹配依据列弹窗（复选框）
	 */
	function openMatchColumnsModal() {
		let bodyHtml = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${i18n('勾选的列将作为搜索关键词组合')}</p>`;

		for (const col of bomColumns) {
			const checked = matchColumns.includes(col) ? 'checked' : '';
			bodyHtml += `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;margin:4px 0;border:1px solid var(--border-light);border-radius:6px;cursor:pointer;">
				<input type="checkbox" value="${col}" ${checked} onchange="window.__app.onMatchColChange()">
				<span>${col}</span>
			</label>`;
		}

		modalContainer.innerHTML = `<div class="modal-overlay" id="matchColsOverlay">
			<div class="modal" style="width:400px;">
				<div class="modal-header">
					<h3>${i18n('选择匹配依据列')}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					${bodyHtml}
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline btn-sm" onclick="window.__app.clearMatchColumns()">${i18n('清空')}</button>
					<button class="btn btn-primary btn-sm" onclick="document.getElementById('matchColsOverlay').remove()">${i18n('确定')}</button>
				</div>
			</div>
		</div>`;
	}

	/** 保存匹配依据列设置 */
	/** 匹配依据列复选框变化 */
	function onMatchColChange() {
		const checkboxes = document.querySelectorAll('#matchColsOverlay input[type="checkbox"]:checked');
		matchColumns = [...checkboxes].map(cb => cb.value);
		renderMatchTags();
	}

	/** 清空匹配依据列 */
	function clearMatchColumns() {
		matchColumns = [];
		document.querySelectorAll('#matchColsOverlay input[type="checkbox"]').forEach(cb => cb.checked = false);
		renderMatchTags();
	}

	/** 渲染匹配依据列标签 */
	function renderMatchTags() {
		const tagsEl = document.getElementById('matchColumnsTags');
		if (!tagsEl)
			return;
		tagsEl.innerHTML = matchColumns.map(c =>
			`<span class="tag">${c}<span onclick="window.__app.removeMatchColumn('${c}')" style="cursor:pointer;">×</span></span>`,
		).join('');
	}

	/** 移除单个匹配依据列 */
	function removeMatchColumn(col) {
		matchColumns = matchColumns.filter(c => c !== col);
		renderMatchTags();
	}

	/**
	 * 更新匹配列（兼容旧调用）
	 */
	function updateMatchColumns() {
		updateFootprintColSelect();
		renderMatchTags();
	}

	// ============ 详情面板 ============

	async function viewDetail(k) {
		currentDetailKey = k;
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;
		const mr = matchResults[k];
		const best = mr?.bestMatch;
		const allBound = g.designatorList.some(d => bindStatus[d]?.bound);
		const boundDevice = allBound ? bindStatus[g.designatorList[0]]?.deviceInfo : null;

		detailPanel.classList.remove('collapsed');
		hide(panelEmpty);
		show(panelContent);

		let h = `<div class="panel-header-fixed">
			<div style="display:flex;justify-content:space-between;align-items:center;">
				<b>📋 ${g.designatorStr}</b>
				<button onclick="window.__app.closeDetail()" class="btn-icon">✕</button>
			</div>
		</div>`;

		// 只显示封装列和匹配依据列
		const displayCols = [];
		for (const col of matchColumns) {
			if (!displayCols.includes(col))
				displayCols.push(col);
		}

		if (displayCols.length) {
			h += `<div style="margin-bottom:12px;"><b>${i18n('匹配依据数据')}</b></div>`;
			for (const col of displayCols) {
				const val = g._raw[col] || '';
				h += `<div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:var(--text-muted);">${col}</span><span>${val || '-'}</span></div>`;
			}
		}

		// 图片样式
		const imgStyle = 'max-width:100%;max-height:100%;object-fit:contain;cursor:pointer;border-radius:4px;';
		const cellStyle = 'flex:1;text-align:center;min-width:0;';
		const imgBoxStyle = 'height:80px;display:flex;align-items:center;justify-content:center;background:var(--surface-alt);border-radius:6px;padding:4px;cursor:pointer;transition:border-color 0.2s;border:1px solid var(--border-light);';

		// 当前绑定器件（始终展示封装和符号）
		if (boundDevice) {
			h += `<div style="margin-top:16px;display:flex;align-items:center;gap:8px;"><b>${i18n('当前绑定器件')}</b><button class="btn-icon" title="${i18n('重新加载图片')}" onclick="window.__app.reloadRenderImages('bound')" style="font-size:14px;opacity:0.6;">🔄</button></div>`;
			h += `<div style="display:flex;gap:8px;margin:8px 0;">`;
			h += `<div style="${cellStyle}"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${i18n('封装')}</div><div id="fpRenderBound" style="${imgBoxStyle}" onclick="window.__app.previewRender('fpBound')">${genPkgSVG(boundDevice.package || '', 80, 50)}</div></div>`;
			h += `<div style="${cellStyle}"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${i18n('符号')}</div><div id="symRenderBound" style="${imgBoxStyle}" onclick="window.__app.previewRender('symBound')">${genSymSVG(boundDevice.name || '', 70, 50)}</div></div>`;
			h += `</div>`;
			h += `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-muted);">${i18n('型号')}</span><span>${boundDevice.name || '-'}</span></div>`;
			h += `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-muted);">${i18n('封装')}</span><span>${boundDevice.package || '-'}</span></div>`;
			h += `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-muted);">LCSC</span><span>${boundDevice.lcsc || '-'}</span></div>`;
		}

		// 最佳匹配器件
		if (best) {
			const aiTag = mr?.aiRecommended ? i18n(' 🤖 AI推荐') : '';
			h += `<div style="margin-top:16px;display:flex;align-items:center;gap:8px;"><b>${i18n('最佳匹配器件')}${aiTag}</b><button class="btn-icon" title="${i18n('重新加载图片')}" onclick="window.__app.reloadRenderImages('best')" style="font-size:14px;opacity:0.6;">🔄</button></div>`;
			if (mr?.aiReason) {
				h += `<div style="padding:10px 12px;background:var(--bg-success);border:1px solid var(--bg-success-border);border-radius:8px;margin:8px 0;font-size:12px;color:var(--text-success);">
					<b>${i18n('🤖 AI 分析：')}</b>${mr.aiReason}
				</div>`;
			}
			h += `<div style="display:flex;gap:8px;margin:8px 0;">`;
			if (best.imageUrl) {
				h += `<div style="${cellStyle}"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${i18n('产品图')}</div><div style="${imgBoxStyle}" onclick="window.__app.previewImage('${best.imageUrl}','${i18n('产品图')}')"><img src="${best.imageUrl}" style="${imgStyle}" onerror="this.parentElement.innerHTML='<span style=\\'color:var(--text-muted);font-size:11px\\'>${i18n('无图片')}</span>'"></div></div>`;
			}
			h += `<div style="${cellStyle}"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${i18n('封装')}</div><div id="fpRender" style="${imgBoxStyle}" onclick="window.__app.previewRender('fp')">${genPkgSVG(best.package || best.pkg || '', 80, 50)}</div></div>`;
			h += `<div style="${cellStyle}"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${i18n('符号')}</div><div id="symRender" style="${imgBoxStyle}" onclick="window.__app.previewRender('sym')">${genSymSVG(best.name || best.mpn || '', 70, 50)}</div></div>`;
			h += `</div>`;
			const valKeywords = ['value', 'name', i18n('元件名称'), 'marking code', i18n('型号'), 'comment'];
			let bomValue = '';
			for (const col of matchColumns) {
				if (valKeywords.some(k => col.toLowerCase().includes(k))) {
					bomValue = String(g._raw[col] || '');
					if (bomValue)
						break;
				}
			}
			if (!bomValue)
				bomValue = g.value || '';
			const fields = [
				['Value', bomValue || '-'],
				[i18n('型号'), best.name || best.mpn],
				[i18n('封装'), best.package || best.pkg],
				[i18n('制造商'), best.manufacturer || '-'],
				['LCSC', best.lcsc || '-'],
				[i18n('描述'), best.description || '-'],
			];
			h += fields.map(([key, val]) => `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-muted);">${key}</span><span>${val || '-'}</span></div>`).join('');
			h += `<button class="btn btn-success" style="width:100%;margin-top:12px;" onclick="window.__app.bindGroup('${k}')">${i18n('绑定该器件')}</button>`;
		}

		if (!boundDevice && !best) {
			h += `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('暂无匹配器件')}</div>`;
		}

		// 人工搜索按钮
		h += `<button class="btn btn-outline" style="width:100%;margin-top:8px;" onclick="window.__app.manualMatch('${k}')">${i18n('人工搜索')}</button>`;

		if (boundDevice) {
			h += `<button class="btn btn-outline" style="width:100%;margin-top:8px;color:var(--danger);" onclick="window.__app.unbindGroup('${k}')">${i18n('解除绑定')}</button>`;
		}

		// 更多匹配结果（包含最佳匹配）
		const candidates = mr?.candidates || [];
		if (candidates.length > 0) {
			const currentIdx = selectedCandidateIdx[k] ?? 0;
			h += `<div style="margin-top:16px;"><b>${i18n('更多匹配结果')}</b></div>`;
			h += `<div style="max-height:300px;overflow-y:auto;">`;
			candidates.slice(0, 20).forEach((c, idx) => {
				const dev = c.device;
				const score = c.score;
				const isSelected = idx === currentIdx;
				const isBest = idx === 0;
				const scoreClass = score >= 95 ? 'badge-success' : score >= 60 ? 'badge-warning' : 'badge-neutral';
				h += `<div class="candidate-item" onclick="window.__app.selectCandidate('${k}', ${idx})" style="display:flex;align-items:center;gap:12px;padding:8px 12px;${isSelected ? 'border:2px solid var(--primary);' : ''}">
					<span class="badge ${scoreClass}" style="min-width:50px;text-align:center;">${score}%</span>
					<div style="flex:1;min-width:0;">
						<div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${dev.name || '-'} ${isBest ? `<span class="badge badge-success">${i18n('最佳')}</span>` : ''}</div>
						<div style="font-size:11px;color:var(--text-muted);">${dev.package || '-'} | ${dev.manufacturer || '-'}</div>
					</div>
					<button class="btn btn-outline btn-xs">${i18n('选择')}</button>
				</div>`;
			});
			h += `</div>`;
		}

		// 通过封装库匹配按钮
		h += `<button class="btn btn-outline" style="width:100%;margin-top:12px;" onclick="window.__app.matchFootprintOnly('${k}')">${i18n('通过封装库匹配')}</button>`;

		panelContent.innerHTML = h;

		// 异步获取渲染图（符号/封装）
		if (best && (best.symbolUuid || best.symbolLibraryUuid || best.footprintUuid || best.footprintLibraryUuid)) {
			fetchRenderImages(best).then((imgs) => {
				const fpEl = document.getElementById('fpRender');
				const symEl = document.getElementById('symRender');
				if (imgs.footprintUrl && fpEl) {
					fpEl.innerHTML = `<img src="${imgs.footprintUrl}" style="max-width:120px;max-height:80px;object-fit:contain;">`;
				}
				if (imgs.symbolUrl && symEl) {
					symEl.innerHTML = `<img src="${imgs.symbolUrl}" style="max-width:120px;max-height:80px;object-fit:contain;">`;
				}
			}).catch(() => {});
		}

		// 异步获取当前绑定器件的渲染图
		if (boundDevice && (boundDevice.symbolUuid || boundDevice.symbolLibraryUuid || boundDevice.footprintUuid || boundDevice.footprintLibraryUuid)) {
			fetchRenderImages(boundDevice).then((imgs) => {
				const fpEl = document.getElementById('fpRenderBound');
				const symEl = document.getElementById('symRenderBound');
				if (imgs.footprintUrl && fpEl) {
					fpEl.innerHTML = `<img src="${imgs.footprintUrl}" style="max-width:120px;max-height:80px;object-fit:contain;">`;
				}
				if (imgs.symbolUrl && symEl) {
					symEl.innerHTML = `<img src="${imgs.symbolUrl}" style="max-width:120px;max-height:80px;object-fit:contain;">`;
				}
			}).catch(() => {});
		}
	}

	function closeDetail() {
		detailPanel.classList.add('collapsed');
		hide(panelContent);
		show(panelEmpty);
	}

	/** 重新加载渲染图（清除缓存并刷新详情面板） */
	function reloadRenderImages(type) {
		if (!currentDetailKey)
			return;
		// 清除 renderImageCache 中的相关条目
		const g = bomData.find(x => x.designatorList.join(',') === currentDetailKey);
		if (!g)
			return;
		const mr = matchResults[currentDetailKey];
		const best = mr?.bestMatch;
		const allBound = g.designatorList.some(d => bindStatus[d]?.bound);
		const boundDevice = allBound ? bindStatus[g.designatorList[0]]?.deviceInfo : null;

		const devices = [];
		if (type === 'bound' && boundDevice) {
			devices.push(boundDevice);
		}
		else if (type === 'best' && best) {
			devices.push(best);
		}
		else {
			if (boundDevice)
				devices.push(boundDevice);
			if (best)
				devices.push(best);
		}

		for (const dev of devices) {
			const ids = [dev.symbolUuid, dev.symbolLibraryUuid, dev.footprintUuid, dev.footprintLibraryUuid].filter(Boolean);
			for (const key of Object.keys(renderImageCache)) {
				if (ids.some(id => key.includes(id)))
					delete renderImageCache[key];
			}
		}
		viewDetail(currentDetailKey);
	}

	/** 点击放大预览图片 */
	function previewImage(url, title) {
		if (!url)
			return;
		openPreviewModal(`<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;" onerror="this.parentElement.innerHTML='<span style=\\'color:var(--text-muted)\\'>${i18n('无图片')}</span>'">`, title || i18n('产品图'));
	}

	function previewRender(type) {
		const idMap = { fp: 'fpRender', sym: 'symRender', fpBound: 'fpRenderBound', symBound: 'symRenderBound' };
		const container = document.getElementById(idMap[type]);
		if (!container)
			return;
		const svg = container.querySelector('svg');
		if (!svg) {
			// 没有 SVG，尝试用整个内容预览
			if (container.innerHTML.trim()) {
				openPreviewModal(container.innerHTML, type === 'fp' ? i18n('封装') : i18n('符号'));
			}
			return;
		}
		const svgClone = svg.cloneNode(true);
		// 放大尺寸
		const origW = Number.parseFloat(svg.getAttribute('width')) || 80;
		const origH = Number.parseFloat(svg.getAttribute('height')) || 50;
		const scale = 4;
		svgClone.setAttribute('width', origW * scale);
		svgClone.setAttribute('height', origH * scale);
		svgClone.style.width = `${origW * scale}px`;
		svgClone.style.height = `${origH * scale}px`;
		const title = type === 'fp' ? i18n('封装') : i18n('符号');
		openPreviewModal(svgClone.outerHTML, title);
	}

	/** 统一预览弹窗（支持滚轮缩放 + 拖拽平移） */
	function openPreviewModal(innerHtml, title) {
		modalContainer.innerHTML = `<div class="preview-overlay" id="previewOverlay">
			<div class="preview-toolbar">
				<span class="preview-title">${title}</span>
				<span class="preview-hint">${i18n('滚轮缩放 · 拖拽平移')}</span>
				<button class="btn-icon" style="color:#fff;font-size:18px;" onclick="document.getElementById('previewOverlay').remove()">✕</button>
			</div>
			<div class="preview-viewport" id="previewViewport">
				<div class="preview-content" id="previewContent">${innerHtml}</div>
			</div>
		</div>`;
		initPreviewInteraction();
	}

	/** 初始化预览交互（滚轮缩放，以鼠标位置为中心） */
	function initPreviewInteraction() {
		const viewport = document.getElementById('previewViewport');
		const content = document.getElementById('previewContent');
		if (!viewport || !content)
			return;

		let scale = 1;
		let originX = 50; // 百分比
		let originY = 50;

		function updateTransform() {
			content.style.transformOrigin = `${originX}% ${originY}%`;
			content.style.transform = `scale(${scale})`;
		}

		// 滚轮缩放（以鼠标位置为中心）
		viewport.addEventListener('wheel', (e) => {
			e.preventDefault();
			const rect = viewport.getBoundingClientRect();
			// 鼠标在视口中的百分比位置
			originX = ((e.clientX - rect.left) / rect.width) * 100;
			originY = ((e.clientY - rect.top) / rect.height) * 100;
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			scale = Math.max(0.1, Math.min(20, scale * delta));
			updateTransform();
		}, { passive: false });

		// 双击重置
		viewport.addEventListener('dblclick', () => {
			scale = 1;
			originX = 50;
			originY = 50;
			updateTransform();
		});
	}

	// ============ 绑定操作 ============

	/** 从更多匹配结果中选择一个候选器件 */
	function selectCandidate(k, idx) {
		const mr = matchResults[k];
		if (!mr?.candidates?.[idx])
			return;
		const selected = mr.candidates[idx];
		// 更新最佳匹配
		mr.bestMatch = selected.device;
		mr.matchScore = selected.score;
		// 记录选中的候选索引
		selectedCandidateIdx[k] = idx;
		// 刷新详情面板
		viewDetail(k);
		// 刷新表格
		renderTable(searchInput.value);
		showToast(i18n('已选择 ${1}（匹配度 ${2}%）', selected.device.name, selected.score), 'info');
	}

	/**
	 * 通过封装库匹配
	 * 弹出搜索框弹窗，用户输入关键词搜索封装
	 */
	async function matchFootprintOnly(k) {
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;

		// 获取默认搜索关键词
		let defaultKeyword = '';
		const mr = matchResults[k];
		if (mr?.bestMatch?.name) {
			defaultKeyword = mr.bestMatch.name;
		}
		if (!defaultKeyword) {
			defaultKeyword = String(g.pkg || '').trim();
		}

		// 显示搜索框弹窗
		modalContainer.innerHTML = `<div class="modal-overlay" id="fpMatchOverlay">
			<div class="modal" style="width:700px;">
				<div class="modal-header">
					<h3>${i18n('🔍 封装库匹配 - ${1}', g.designatorStr)}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					<div style="display:flex;gap:8px;margin-bottom:16px;">
						<input type="text" id="fpSearchInput" class="search-input" placeholder="${i18n('输入封装关键词搜索...')}" style="flex:1;" value="${defaultKeyword}">
						<button class="btn btn-primary btn-sm" onclick="window.__app.doFootprintSearch('${k}')">${i18n('搜索')}</button>
					</div>
					<div id="fpSearchResults">
						<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('输入关键词搜索封装库')}</div>
					</div>
				</div>
			</div>
		</div>`;

		// 自动搜索
		if (defaultKeyword) {
			doFootprintSearch(k);
		}
	}

	/**
	 * 执行封装搜索
	 */
	async function doFootprintSearch(k) {
		const keyword = document.getElementById('fpSearchInput')?.value?.trim();
		if (!keyword) {
			showToast(i18n('请输入封装关键词'), 'error');
			return;
		}

		const resultsDiv = document.getElementById('fpSearchResults');
		if (!resultsDiv)
			return;

		resultsDiv.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('搜索中...')}</div>`;

		try {
			const fpResults = await eda.lib_Footprint.search(keyword);
			if (!fpResults || !fpResults.length) {
				resultsDiv.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('未找到匹配的封装')}</div>`;
				return;
			}

			// 构建封装列表（带渲染图）
			const fpList = [];
			for (let i = 0; i < Math.min(10, fpResults.length); i++) {
				const fp = fpResults[i];
				let renderUrl = '';
				try {
					const blob = await eda.lib_Footprint.getRenderImage({
						footprintUuid: fp.uuid,
						libraryUuid: fp.libraryUuid,
					});
					if (blob) {
						renderUrl = await blobToDataUrl(blob);
					}
				}
				catch {
					// 忽略渲染图获取失败
				}
				fpList.push({
					name: fp.name,
					uuid: fp.uuid,
					libraryUuid: fp.libraryUuid,
					description: fp.description || '',
					renderUrl,
				});
			}

			// 显示结果
			let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${i18n('找到 ${1} 个匹配封装', fpResults.length)}</div>`;
			fpList.forEach((fp, idx) => {
				const isBest = idx === 0;
				html += `<div class="candidate-item" onclick="window.__app.selectFootprint('${k}', ${idx})" style="display:flex;align-items:center;gap:16px;padding:12px;${isBest ? 'border:2px solid var(--primary);' : ''}">
					<div style="min-width:100px;text-align:center;">
						${fp.renderUrl ? `<img src="${fp.renderUrl}" style="max-width:90px;max-height:60px;object-fit:contain;">` : `<div style="width:90px;height:60px;background:var(--bg-image);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;">${i18n('无预览')}</div>`}
					</div>
					<div style="flex:1;min-width:0;">
						<div style="font-weight:500;font-size:14px;">${fp.name}</div>
						<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${fp.description || '-'}</div>
					</div>
					${isBest ? `<span class="badge badge-success">${i18n('最佳')}</span>` : ''}
					<button class="btn btn-success btn-xs">${i18n('绑定')}</button>
				</div>`;
			});

			resultsDiv.innerHTML = html;
			window.__fpMatchResults = fpList;
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'Footprint search failed', err);
			resultsDiv.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">${i18n('搜索失败')}</div>`;
		}
	}

	/** 从封装匹配结果中选择一个封装 */
	function selectFootprint(k, idx) {
		const fp = window.__fpMatchResults?.[idx];
		if (!fp)
			return;
		document.getElementById('fpMatchOverlay')?.remove();
		// 构建设备信息并直接绑定
		const deviceInfo = {
			name: fp.name,
			package: fp.name,
			lcsc: '',
			manufacturer: '',
			description: fp.description || '',
		};
		bindGroup(k, deviceInfo);
	}

	async function bindGroup(k, deviceInfoOverride) {
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;
		const mr = matchResults[k];
		const device = deviceInfoOverride || mr?.bestMatch;
		if (!device) {
			showToast(i18n('无可用匹配器件'), 'error');
			return;
		}

		showToast(i18n('正在绑定 ${1}...', g.designatorStr), 'info');

		// 封装降级结果：只有封装数据，强制保留符号
		const origBindOptions = { ...bindOptions };
		if (mr?.footprintOnly) {
			bindOptions = { ...bindOptions, keepSymbol: true, keepFootprint: false };
		}

		// 显示进度条
		const progressBar = $('#progressBar');
		const progressFill = $('#progressFill');
		const progressText = $('#progressText');
		if (progressBar)
			show(progressBar);

		let successCount = 0;
		const total = g.designatorList.length;
		for (let i = 0; i < total; i++) {
			const d = g.designatorList[i];
			// 更新进度
			const pct = Math.round((i / total) * 100);
			if (progressFill)
				progressFill.style.width = `${pct}%`;
			if (progressText)
				progressText.textContent = i18n('绑定中 ${1}/${2}', i + 1, total);

			const primitiveId = g._primitiveIds[d] || designatorToPrimitiveId[d];
			if (!primitiveId) {
				console.warn(PLUGIN_TAG, 'No primitiveId for', d);
				continue;
			}
			const result = await bindComponent(primitiveId, device);
			if (result) {
				// 保存绑定信息和原始器件信息（用于解绑时还原）
				bindStatus[d] = {
					bound: true,
					deviceInfo: { ...device },
					originalInfo: result.saved,
					newPrimitiveId: result.newPrimitiveId,
				};
				successCount++;
			}
		}

		// 完成进度
		if (progressFill)
			progressFill.style.width = '100%';
		if (progressText)
			progressText.textContent = i18n('绑定完成');
		setTimeout(() => {
			if (progressBar)
				hide(progressBar);
		}, 1500);

		if (successCount > 0) {
			renderTable(searchInput.value);
			viewDetail(k);
			showToast(i18n('✅ 已绑定 ${1}/${2} 个器件', successCount, g.designatorList.length), 'success');
		}
		else {
			showToast(i18n('绑定失败，请查看控制台日志'), 'error');
		}

		bindOptions = origBindOptions;
	}

	async function unbindGroup(k) {
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;

		showToast(i18n('正在还原器件...'), 'info');

		// 显示进度条
		const progressBar = $('#progressBar');
		const progressFill = $('#progressFill');
		const progressText = $('#progressText');
		if (progressBar)
			show(progressBar);

		let restoreCount = 0;
		const total = g.designatorList.length;
		for (let i = 0; i < total; i++) {
			const d = g.designatorList[i];
			// 更新进度
			const pct = Math.round((i / total) * 100);
			if (progressFill)
				progressFill.style.width = `${pct}%`;
			if (progressText)
				progressText.textContent = i18n('解绑中 ${1}/${2}', i + 1, total);
			const status = bindStatus[d];
			if (!status?.bound || !status.originalInfo) {
				bindStatus[d] = { bound: false, deviceInfo: null };
				continue;
			}

			const saved = status.originalInfo;
			const currentPid = status.newPrimitiveId;

			try {
				// 删除绑定后的器件
				if (currentPid) {
					await eda.sch_PrimitiveComponent.delete(currentPid);
				}

				// 解析器件真实所属库
				const deviceLib = await resolveDeviceLibrary({ libraryUuid: saved.libraryUuid, uuid: saved.deviceUuid, name: saved.name });
				// 还原工程库中器件的原始封装
				if (saved.originalFootprint) {
					await eda.lib_Device.modify(saved.deviceUuid, deviceLib, undefined, undefined, {
						footprint: saved.originalFootprint,
					});
				}

				// 搜索原始设备获取正确的 UUID（导入器件需在工程库中搜索并按 uuid 匹配）
				let originalDevice = (await eda.lib_Device.search(saved.name, 'project')).find(d => d.uuid === saved.deviceUuid);
				if (!originalDevice)
					originalDevice = (await eda.lib_Device.search(saved.name))[0];
				if (!originalDevice) {
					console.warn(PLUGIN_TAG, 'Original device not found, saved.name:', saved.name);
					bindStatus[d] = { bound: false, deviceInfo: null };
					continue;
				}

				// 还原原始器件（使用搜索到的库器件）
				const restoredComp = await eda.sch_PrimitiveComponent.create(
					{ libraryUuid: originalDevice.libraryUuid, uuid: originalDevice.uuid },
					saved.x,
					saved.y,
					'',
					saved.rotation,
					saved.mirror,
				);
				if (restoredComp) {
					// 恢复所有原始参数
					await eda.sch_PrimitiveComponent.modify(restoredComp.primitiveId, {
						designator: saved.designator || null,
						name: saved.name || null,
						uniqueId: saved.uniqueId || null,
						addIntoBom: saved.addIntoBom,
						addIntoPcb: saved.addIntoPcb,
						manufacturer: saved.manufacturer || null,
						manufacturerId: saved.manufacturerId || null,
						supplier: saved.supplier || null,
						supplierId: saved.supplierId || null,
						otherProperty: saved.otherProperty || undefined,
					});
					restoreCount++;
				}
			}
			catch (err) {
				console.error(PLUGIN_TAG, 'Restore component failed for', d, err);
			}

			bindStatus[d] = { bound: false, deviceInfo: null };
		}

		// 完成进度
		if (progressFill)
			progressFill.style.width = '100%';
		if (progressText)
			progressText.textContent = i18n('解绑完成');
		setTimeout(() => {
			if (progressBar)
				hide(progressBar);
		}, 1500);

		renderTable(searchInput.value);
		if (!detailPanel.classList.contains('collapsed'))
			viewDetail(k);
		showToast(i18n('已还原 ${1} 个器件', restoreCount), 'info');
	}

	async function batchBind() {
		const toBind = [...selectedDesignators].filter(d => !bindStatus[d]?.bound);
		if (!toBind.length) {
			showToast(i18n('没有待绑定的选中器件'), 'error');
			return;
		}

		showToast(i18n('正在批量绑定 ${1} 个器件...', toBind.length), 'info');

		// 显示进度条
		const progressBar = $('#progressBar');
		const progressFill = $('#progressFill');
		const progressText = $('#progressText');
		if (progressBar)
			show(progressBar);

		let count = 0;
		const total = toBind.length;
		for (let i = 0; i < total; i++) {
			const d = toBind[i];
			// 更新进度
			const pct = Math.round((i / total) * 100);
			if (progressFill)
				progressFill.style.width = `${pct}%`;
			if (progressText)
				progressText.textContent = i18n('批量绑定 ${1}/${2}', i + 1, total);

			const g = bomData.find(x => x.designatorList.includes(d));
			if (!g)
				continue;
			const mr = matchResults[g.designatorList.join(',')];
			if (!mr?.bestMatch)
				continue;
			const primitiveId = g._primitiveIds[d] || designatorToPrimitiveId[d];
			if (!primitiveId)
				continue;
			const result = await bindComponent(primitiveId, mr.bestMatch);
			if (result) {
				bindStatus[d] = {
					bound: true,
					deviceInfo: { ...mr.bestMatch },
					originalInfo: result.saved,
					newPrimitiveId: result.newPrimitiveId,
				};
				count++;
			}
		}

		// 完成进度
		if (progressFill)
			progressFill.style.width = '100%';
		if (progressText)
			progressText.textContent = i18n('批量绑定完成');
		setTimeout(() => {
			if (progressBar)
				hide(progressBar);
		}, 1500);

		renderTable(searchInput.value);
		showToast(i18n('✅ 批量绑定完成 ${1}/${2}', count, toBind.length), 'success');
	}

	// ============ 手动匹配 / 编辑 ============

	function manualMatch(k) {
		currentEditingKey = k;
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;
		const keyword = g.mpn || g.pkg || '';

		modalContainer.innerHTML = `<div class="modal-overlay" id="manualOverlay">
			<div class="modal" style="width:700px;">
				<div class="modal-header">
					<h3>${i18n('🔍 人工搜索器件 - ${1}', g.designatorStr)}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					<div class="pkg-search-row" style="margin-bottom:12px;">
						<input type="text" class="search-input" id="manualSearch" value="${keyword}" placeholder="${i18n('输入型号/关键词搜索...')}" style="width:100%;">
						<button class="btn btn-primary btn-sm" onclick="window.__app.doManualSearch()">${i18n('搜索')}</button>
					</div>
					<div id="manualList">
						<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('输入关键词搜索器件库')}</div>
					</div>
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').remove()">${i18n('关闭')}</button>
				</div>
			</div>
		</div>`;

		// 自动搜索
		if (keyword)
			doManualSearch();
	}

	async function doManualSearch() {
		const keyword = document.getElementById('manualSearch').value.trim();
		const list = document.getElementById('manualList');
		if (!keyword) {
			list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('请输入关键词')}</div>`;
			return;
		}
		list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('搜索中...')}</div>`;

		const results = await searchDevice(keyword);
		if (!results.length) {
			list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${i18n('未找到匹配器件')}</div>`;
			return;
		}

		// 先显示基础信息，异步加载图片
		const sliced = results.slice(0, 20);
		let html = '';
		for (let i = 0; i < sliced.length; i++) {
			const d = sliced[i];
			const imgHtml = d.imageUrl
				? `<img src="${d.imageUrl}" style="max-width:70px;max-height:50px;object-fit:contain;" onerror="this.style.display='none'">`
				: `<div style="width:70px;height:50px;background:var(--bg-image);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:10px;">${i18n('无图片')}</div>`;
			const descText = d.description ? `${d.description.substring(0, 50)}...` : '-';
			html += `<div class="candidate-item" onclick="window.__app.selectManualDevice(${i})" data-idx="${i}" style="display:flex;align-items:center;gap:12px;padding:12px;">
					<div class="manual-device-img" id="manualImg${i}" style="min-width:80px;text-align:center;">${imgHtml}</div>
					<div class="manual-fp-render" id="manualFp${i}" style="min-width:60px;text-align:center;">${genPkgSVG(d.package, 50, 35)}</div>
					<div class="manual-sym-render" id="manualSym${i}" style="min-width:50px;text-align:center;">${genSymSVG(d.name, 45, 30)}</div>
					<div style="flex:1;min-width:0;">
						<div style="font-weight:600;font-size:13px;">${d.name || '-'}</div>
						<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${i18n('封装: ${1} | 制造商: ${2}', d.package || '-', d.manufacturer || '-')}</div>
						<div style="font-size:11px;color:var(--text-muted);">LCSC: ${d.lcsc || '-'} | ${descText}</div>
					</div>
					<button class="btn btn-success btn-xs">${i18n('选择')}</button>
				</div>`;
		}
		list.innerHTML = html;

		// 暂存搜索结果供选择使用
		window.__manualResults = results;

		// 异步加载渲染图
		for (let i = 0; i < Math.min(20, results.length); i++) {
			const d = results[i];
			if (d.uuid && d.libraryUuid) {
				fetchRenderImages(d).then((imgs) => {
					const fpEl = document.getElementById(`manualFp${i}`);
					const symEl = document.getElementById(`manualSym${i}`);
					if (imgs.footprintUrl && fpEl) {
						fpEl.innerHTML = `<img src="${imgs.footprintUrl}" style="max-width:50px;max-height:35px;object-fit:contain;">`;
					}
					if (imgs.symbolUrl && symEl) {
						symEl.innerHTML = `<img src="${imgs.symbolUrl}" style="max-width:45px;max-height:30px;object-fit:contain;">`;
					}
				}).catch(() => {});
			}
		}
	}

	function selectManualDevice(idx) {
		const device = window.__manualResults[idx];
		if (!device)
			return;
		document.getElementById('manualOverlay')?.remove();
		// 更新最佳匹配并绑定
		const k = currentEditingKey;
		const mr = matchResults[k];
		if (mr) {
			mr.bestMatch = device;
			mr.matchScore = 100;
		}
		bindGroup(k, device);
	}

	function editOrBind(k) {
		currentEditingKey = k;
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;
		const mr = matchResults[k];
		const allBound = g.designatorList.some(d => bindStatus[d]?.bound);
		const dev = allBound ? bindStatus[g.designatorList[0]]?.deviceInfo : mr?.bestMatch || {};

		const deviceFields = {
			name: dev?.name || dev?.mpn || '',
			package: dev?.package || dev?.pkg || '',
			lcsc: dev?.lcsc || '',
			mfr: dev?.mfr || dev?.manufacturer || '',
			desc: dev?.desc || dev?.description || '',
		};

		modalContainer.innerHTML = `<div class="modal-overlay" id="editOverlay">
			<div class="modal" style="width:620px;">
				<div class="modal-header">
					<h3>${i18n('编辑器件参数 - ${1}', g.designatorStr)}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					${dev?.imageUrl ? `<div style="text-align:center;padding:8px;background:var(--bg-image);border-radius:8px;margin-bottom:12px;"><img src="${dev.imageUrl}" style="max-width:180px;max-height:120px;object-fit:contain;" onerror="this.style.display='none'"></div>` : ''}
					<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
						<div>
							<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('型号/名称')}</label>
							<input id="emn" value="${deviceFields.name}" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;">
						</div>
						<div>
							<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('封装')}</label>
							<input id="ep" value="${deviceFields.package}" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;">
						</div>
						<div>
							<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('LCSC编号')}</label>
							<div style="display:flex;gap:4px;">
								<input id="elc" value="${deviceFields.lcsc}" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;">
								<button class="btn btn-outline btn-sm" onclick="window.__app.loadByLcsc()" title="${i18n('通过C编号检索器件')}">🔍</button>
							</div>
						</div>
						<div>
							<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('制造商')}</label>
							<input id="emf" value="${deviceFields.mfr}" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;">
						</div>
						<div style="grid-column:1/3;">
							<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px;">${i18n('描述')}</label>
							<input id="ed" value="${deviceFields.desc}" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;">
						</div>
					</div>
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">${i18n('取消')}</button>
					<button class="btn btn-primary" id="sbtn">${i18n('保存并绑定')}</button>
				</div>
			</div>
		</div>`;

		document.getElementById('sbtn').onclick = () => {
			const nd = {
				name: document.getElementById('emn').value,
				package: document.getElementById('ep').value,
				lcsc: document.getElementById('elc').value,
				mfr: document.getElementById('emf').value,
				desc: document.getElementById('ed').value,
			};
			document.getElementById('editOverlay').remove();
			bindGroup(k, nd);
		};
	}

	async function loadByLcsc() {
		const lcsc = document.getElementById('elc').value.trim();
		if (!lcsc) {
			showToast(i18n('请输入LCSC编号'), 'error');
			return;
		}
		const device = await getDeviceByLcsc(lcsc);
		if (!device) {
			showToast(i18n('未找到对应C编号的器件'), 'error');
			return;
		}
		document.getElementById('emn').value = device.name || '';
		document.getElementById('ep').value = device.package || '';
		document.getElementById('emf').value = device.mfr || device.manufacturer || '';
		document.getElementById('ed').value = device.desc || device.description || '';
		showToast(i18n('已从LCSC加载器件参数'), 'success');
	}

	// ============ DRC 检查 ============

	async function runDRC() {
		showToast(i18n('正在执行DRC检查...'), 'info');
		const errors = await runDrcCheck();
		if (errors === null) {
			showToast(i18n('DRC检查执行失败'), 'error');
			return;
		}

		if (!errors.length) {
			showToast(i18n('✅ DRC检查通过，无错误'), 'success');
			return;
		}

		modalContainer.innerHTML = `<div class="modal-overlay">
			<div class="modal">
				<div class="modal-header">
					<h3>⚠️ ${i18n('DRC检查结果（${1} 项）', errors.length)}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					${errors
		.map(
			(e, i) => `<div style="background:var(--bg-warning);padding:10px 12px;margin:6px 0;border-radius:6px;font-size:12px;">
								<b>#${i + 1}</b> ${typeof e === 'string' ? e : JSON.stringify(e)}
							</div>`,
		)
		.join('')}
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').remove()">${i18n('关闭')}</button>
				</div>
			</div>
		</div>`;
	}

	// ============ 多列匹配选择 ============

	// ============ 选择操作 ============

	function toggleGroupSelect(k) {
		const g = bomData.find(x => x.designatorList.join(',') === k);
		if (!g)
			return;
		const allSelected = g.designatorList.every(d => selectedDesignators.has(d));
		g.designatorList.forEach((d) => {
			if (allSelected)
				selectedDesignators.delete(d);
			else selectedDesignators.add(d);
		});
		renderTable(searchInput.value);
	}

	function toggleSelectAll() {
		const all = bomData.flatMap(g => g.designatorList);
		if (all.length && all.every(d => selectedDesignators.has(d))) {
			all.forEach(d => selectedDesignators.delete(d));
		}
		else {
			all.forEach(d => selectedDesignators.add(d));
		}
		// 同步表头复选框状态
		const headerCb = document.getElementById('selectAllCheckbox');
		if (headerCb) {
			headerCb.checked = all.length > 0 && all.every(d => selectedDesignators.has(d));
		}
		renderTable(searchInput.value);
	}

	function toggleDesignatorExpand(k) {
		if (expandedDesignatorSets.has(k))
			expandedDesignatorSets.delete(k);
		else expandedDesignatorSets.add(k);
		renderTable(searchInput.value);
	}

	function onGroupClick(e, k) {
		if (!e.target.closest('button') && !e.target.closest('.checkbox-custom')) {
			viewDetail(k);
		}
	}

	// ============ 缩放 ============

	function updateZoom() {
		const v = document.getElementById('zoomSlider').value;
		document.getElementById('zoomValue').textContent = `${v}%`;
		const scale = v / 100;
		tableWrapper.style.transform = `scale(${scale})`;
		tableWrapper.style.width = `${100 / scale}%`;
	}

	// ============ 导出 ============

	function exportResult() {
		const boundDesignators = Object.keys(bindStatus).filter(d => bindStatus[d]?.bound);
		if (!boundDesignators.length) {
			showToast(i18n('没有已绑定的器件'), 'error');
			return;
		}

		const deviceKeys = ['name', 'package', 'lcsc', 'mfr', 'desc'];
		const allCols = [i18n('设计位号'), ...bomColumns, ...deviceKeys.map(k => `绑定-${k}`)];
		const defaultSelected = [i18n('设计位号'), ...bomColumns.filter(c => !c.startsWith('_')), `绑定-name`, `绑定-package`, `绑定-lcsc`];

		modalContainer.innerHTML = `<div class="modal-overlay">
			<div class="modal" style="width:650px;">
				<div class="modal-header">
					<h3>${i18n('自定义导出列')}</h3>
					<button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
				</div>
				<div class="modal-body">
					<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
						${allCols
		.map(
			c => `<label style="padding:6px 8px;font-size:13px;"><input type="checkbox" value="${c}" ${defaultSelected.includes(c) ? 'checked' : ''}> ${c}</label>`,
		)
		.join('')}
					</div>
				</div>
				<div class="modal-footer">
					<button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">${i18n('取消')}</button>
					<button class="btn btn-primary" id="deb">${i18n('导出')}</button>
				</div>
			</div>
		</div>`;

		document.getElementById('deb').onclick = () => {
			const selectedCols = [...document.querySelectorAll('#modalContainer input:checked')].map(cb => cb.value);
			if (!selectedCols.length) {
				showToast(i18n('请至少选一列'), 'error');
				return;
			}

			const rows = boundDesignators.map((des) => {
				const g = bomData.find(x => x.designatorList.includes(des));
				const raw = g ? g._raw : {};
				const dv = bindStatus[des]?.deviceInfo || {};
				const row = {};
				selectedCols.forEach((c) => {
					if (c === i18n('设计位号'))
						row[c] = des;
					else if (c.startsWith(i18n('绑定-')))
						row[c] = dv[c.substring(3)] ?? '';
					else row[c] = raw[c] ?? '';
				});
				return row;
			});

			// 导出为 CSV（iframe 内无需第三方库）
			const headers = selectedCols;
			const csvLines = [headers.join(',')];
			rows.forEach((r) => {
				csvLines.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
			});
			const csv = String.fromCharCode(0xFEFF) + csvLines.join('\n');
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = i18n('BOM绑定结果.csv');
			a.click();
			URL.revokeObjectURL(url);

			document.querySelector('.modal-overlay').remove();
			showToast(i18n('导出成功'), 'success');
		};
	}

	// ============ 文件上传 ============

	async function processFile(file) {
		try {
			const ext = (file.name || '').split('.').pop().toLowerCase();
			if (!['csv', 'xlsx', 'xls'].includes(ext)) {
				showToast(i18n('不支持的文件格式'), 'error');
				return;
			}

			let headers;
			let dataRows;
			if (ext === 'csv') {
				// 读取字节并自动检测编码（处理 UTF-16LE 等）
				const buf = await file.arrayBuffer();
				const text = decodeBytes(buf);
				const lines = text.split(/\r?\n/).filter(l => l.trim());
				if (lines.length < 2)
					throw new Error('CSV empty');
				const rows2d = lines.map(parseCsvLine);
				const obj = rowsToObjects(rows2d);
				headers = obj.headers;
				dataRows = obj.data;
			}
			else {
				if (typeof JSZip === 'undefined') {
					showToast(i18n('XLSX解析库未加载，请使用CSV格式'), 'error');
					return;
				}
				const data = await file.arrayBuffer();
				const rows2d = await parseXlsxWithJSZip(data);
				const obj = rowsToObjects(rows2d);
				headers = obj.headers;
				dataRows = obj.data;
			}

			if (!dataRows || !dataRows.length)
				throw new Error('BOM empty');

			bomData = groupBomItems(dataRows, headers);
			matchResults = {};
			bindStatus = {};
			selectedDesignators.clear();
			expandedDesignatorSets.clear();
			selectedCandidateIdx = {};

			// 关联原理图器件：按位号匹配 primitiveId（用于绑定）
			await fetchSchematicPrimitiveIds();

			showUI();
			showToast(i18n('已加载 ${1} 组器件，点击匹配按钮开始匹配', bomData.length), 'info');
		}
		catch (e) {
			console.error(PLUGIN_TAG, 'Process file failed', e);
			showToast(i18n('处理失败: ${1}', e.message), 'error');
		}
	}

	function handleFileSelect(e) {
		if (e.target.files[0])
			processFile(e.target.files[0]);
		e.target.value = '';
	}

	function handleDragOver(e) {
		e.preventDefault();
		document.getElementById('uploadZone').classList.add('drag-over');
	}

	function handleDragLeave() {
		document.getElementById('uploadZone').classList.remove('drag-over');
	}

	function handleDrop(e) {
		e.preventDefault();
		document.getElementById('uploadZone').classList.remove('drag-over');
		if (e.dataTransfer.files[0])
			processFile(e.dataTransfer.files[0]);
	}

	// ============ UI 切换 ============

	function showUI() {
		hide(modeCards);
		show(toolbar);
		show(tableContainer);
		closeDetail();
		// 填充匹配列下拉菜单
		updateMatchColumns();
		// 渲染表格
		renderTable();
	}

	function clearAll() {
		bomData = [];
		matchResults = {};
		bindStatus = {};
		selectedDesignators.clear();
		expandedDesignatorSets.clear();
		searchInput.value = '';
		show(modeCards);
		hide(toolbar);
		hide(tableContainer);
		closeDetail();
	}

	/** 切换到模式选择页面 */
	function switchToUpload() {
		show(modeCards);
		hide(toolbar);
		hide(tableContainer);
		closeDetail();
	}

	// ============ 初始化 ============

	async function init() {
		// 绑定 DOM
		modeCards = $('#modeCards');
		toolbar = $('#toolbar');
		tableContainer = $('#tableContainer');
		tableBody = $('#tableBody');
		emptyState = $('#emptyState');
		detailPanel = $('#detailPanel');
		panelEmpty = $('#panelEmpty');
		panelContent = $('#panelContent');
		searchInput = $('#searchInput');
		btnBatchBind = $('#btnBatchBind');
		btnExport = $('#btnExport');
		toastContainer = $('#toastContainer');
		modalContainer = $('#modalContainer');
		tableWrapper = $('#tableWrapper');
		statusText = $('#statusText');

		// 翻译 HTML 中 data-i18n 属性标记的静态文本
		applyI18n();

		// 暴露给 HTML onclick 调用
		window.__app = {
			viewDetail,
			closeDetail,
			previewImage,
			previewRender,
			editOrBind,
			manualMatch,
			bindGroup,
			unbindGroup,
			filterByStatus,
			batchBind,
			runDRC,
			toggleGroupSelect,
			toggleSelectAll,
			toggleDesignatorExpand,
			onGroupClick,
			updateMatchColumns,
			updateZoom,
			filterTable: () => renderTable(searchInput.value),
			doManualSearch,
			selectManualDevice,
			loadByLcsc,
			handleFileSelect,
			handleDragOver,
			handleDragLeave,
			handleDrop,
			clearAll,
			switchToUpload,
			startFromSchematic,
			matchAll,
			aiMatchAll,
			openSettingsModal,
			saveAndCloseSettings,
			selectCandidate,
			matchFootprintOnly,
			doFootprintSearch,
			selectFootprint,
			openMatchColumnsModal,
			onMatchColChange,
			clearMatchColumns,
			removeMatchColumn,
			exportResult,
			openColumnConfigModal,
			toggleColumn,
			onLibraryChange,
			toggleColumnSort,
			onColumnDragStart,
			onColumnDragOver,
			onColumnDragEnter,
			onColumnDragLeave,
			onColumnDrop,
			onColumnDragEnd,
			addCustomColumn,
			removeCustomColumn,
			reloadRenderImages,
		};
		window.editOrBind = editOrBind;
		window.manualMatch = manualMatch;

		// 初始 UI 状态：显示模式选择卡片
		show(modeCards);
		hide(toolbar);
		hide(tableContainer);
		detailPanel.classList.add('collapsed');
		document.getElementById('zoomSlider').addEventListener('input', updateZoom);
		updateZoom();

		// 初始化主题
		await initTheme();

		// 加载列配置
		await loadColumnConfig();

		// 加载库列表
		await loadLibraryList();

		// 加载 AI 设置
		await loadAISettings();
	}

	/** 从原理图读取器件数据并显示 */
	/**
	 * 从当前原理图直接读取器件（实时读取，不依赖 sys_Storage）
	 */
	async function startFromSchematic() {
		try {
			showToast(i18n('正在读取原理图器件...'), 'info');
			statusText.innerHTML = `<span class="status-dot connected"></span>${i18n('正在读取原理图器件...')}`;

			// 读取器件（根据"获取全部图页器件"开关决定）
			const getAllPages = document.getElementById('getAllPages')?.checked ?? false;
			const components = await eda.sch_PrimitiveComponent.getAll('part', getAllPages);
			if (!components || components.length === 0) {
				showToast(i18n('当前原理图中没有器件'), 'error');
				statusText.innerHTML = `<span class="status-dot disconnected"></span>${i18n('无器件数据')}`;
				return;
			}

			statusText.innerHTML = `<span class="status-dot connected"></span> ${i18n('正在处理 ${1} 个器件', components.length)}...`;

			// 提取器件数据
			const rows = [];
			const preBindStatus = {}; // 记录已绑定的器件
			for (const comp of components) {
				const designator = comp.getState_Designator() ?? '';
				const primitiveId = comp.getState_PrimitiveId() ?? '';
				if (!designator.trim() && !primitiveId)
					continue;

				const componentInfo = comp.getState_Component();
				const footprintInfo = comp.getState_Footprint();
				const other = comp.getState_OtherProperty();

				const effectiveDesig = (designator.trim() && !designator.includes('?'))
					? designator
					: `[${primitiveId}]`;

				const row = {
					'Designator': effectiveDesig,
					'MPN': componentInfo?.name ?? '',
					'Value': other?.Value ?? '',
					'Footprint': footprintInfo?.name ?? '',
					'Manufacturer': other?.Manufacturer ?? '',
					'Description': other?.Description ?? other?.['LCSC Part Name'] ?? '',
					'Supplier': other?.Supplier ?? '',
					'Supplier Part': other?.['Supplier Part'] ?? '',
					'_primitiveId': primitiveId,
				};

				// 将 otherProperty 所有字段加入行
				if (other) {
					for (const [k, v] of Object.entries(other)) {
						if (v && !row[k]) {
							row[k] = String(v);
						}
					}
				}

				// 检测器件是否已绑定（根据用户配置的检测逻辑）
				const hasDevice = !!componentInfo?.uuid;
				const hasEasyedaFp = !!footprintInfo?.uuid;
				const hasLcsc = !!(other?.LCSC || other?.['Supplier Part'] || other?.['立创编号']);
				let isBound = false;
				if (bindDetectMode === 'fp') {
					isBound = hasDevice && hasEasyedaFp;
				}
				else if (bindDetectMode === 'lcsc') {
					isBound = hasDevice && hasLcsc;
				}
				else if (bindDetectMode === 'fp_or_lcsc') {
					isBound = hasDevice && (hasEasyedaFp || hasLcsc);
				}
				else {
					isBound = hasDevice;
				}

				if (isBound) {
					const desigs = normalizeDesignators(effectiveDesig);
					const devName = componentInfo.name || '';
					const fpName = footprintInfo?.name || other?.['Origin Footprint'] || '';
					const lcscPart = other?.LCSC || other?.['Supplier Part'] || other?.['立创编号'] || '';
					const mfr = other?.Manufacturer || '';
					const symbolInfo = comp.getState_Symbol();
					for (const d of desigs) {
						preBindStatus[d] = {
							bound: true,
							deviceInfo: {
								name: devName,
								package: fpName,
								lcsc: lcscPart,
								manufacturer: mfr,
								libraryUuid: componentInfo.libraryUuid || '',
								uuid: componentInfo.uuid,
								symbolUuid: symbolInfo?.uuid || '',
								symbolLibraryUuid: symbolInfo?.libraryUuid || '',
								footprintUuid: footprintInfo?.uuid || '',
								footprintLibraryUuid: footprintInfo?.libraryUuid || '',
							},
						};
					}
				}

				rows.push(row);
			}

			// 清空所有状态
			bomData = [];
			matchResults = {};
			bindStatus = {};
			selectedDesignators.clear();
			expandedDesignatorSets.clear();
			selectedCandidateIdx = {};
			Object.keys(designatorToPrimitiveId).forEach(k => delete designatorToPrimitiveId[k]);
			Object.keys(searchCache).forEach(k => delete searchCache[k]);

			// 恢复已绑定状态
			Object.assign(bindStatus, preBindStatus);

			// 分组
			const headers = Object.keys(rows[0] || {});
			bomData = groupBomItems(rows, headers);

			// 构建 位号 → primitiveId 映射
			for (const row of rows) {
				const desigs = normalizeDesignators(String(row.Designator || ''));
				desigs.forEach((d) => {
					if (row._primitiveId)
						designatorToPrimitiveId[d] = row._primitiveId;
				});
			}

			const count = bomData.length;
			const totalCount = bomData.reduce((n, g) => n + g.designatorList.length, 0);
			statusText.innerHTML = `<span class="status-dot connected"></span> ${i18n('数据来源：原理图器件（${1} 组，${2} 个）', count, totalCount)}`;
			showUI();
			showToast(i18n('已加载 ${1} 组器件，点击匹配按钮开始匹配', count), 'info');
		}
		catch (err) {
			console.error(PLUGIN_TAG, 'startFromSchematic failed', err);
			showToast(i18n('读取原理图器件失败'), 'error');
			statusText.innerHTML = `<span class="status-dot disconnected"></span>${i18n('读取失败')}`;
		}
	}

	/**
	 * 从原理图获取所有器件的 位号→primitiveId 映射
	 * 用于 BOM 上传后关联原理图器件（绑定依赖 primitiveId）
	 */
	async function fetchSchematicPrimitiveIds() {
		try {
			const comps = await eda.sch_PrimitiveComponent.getAll('part', true);
			if (!comps || !comps.length)
				return;

			// 构建两种映射：
			// 1. designator → primitiveId（有位号的器件）
			// 2. primitiveId → primitiveId（无位号器件，designator 格式为 [primitiveId]）
			const desigMap = {};
			const pidMap = {};
			for (const c of comps) {
				const d = c.getState_Designator();
				const pid = c.getState_PrimitiveId();
				if (d && !d.includes('?'))
					desigMap[d] = pid;
				if (pid)
					pidMap[pid] = pid;
			}

			// 将 primitiveId 写入 bomData 的 _primitiveIds
			for (const g of bomData) {
				for (const d of g.designatorList) {
					// 有位号：按位号查找
					if (desigMap[d]) {
						g._primitiveIds[d] = desigMap[d];
						designatorToPrimitiveId[d] = desigMap[d];
					}
					// 无位号（格式为 [primitiveId]）：直接用 primitiveId
					else if (d.startsWith('[') && d.endsWith(']')) {
						const pid = d.slice(1, -1);
						if (pidMap[pid]) {
							g._primitiveIds[d] = pid;
							designatorToPrimitiveId[d] = pid;
						}
					}
				}
			}

			const matched = bomData.reduce((n, g) => n + Object.keys(g._primitiveIds).length, 0);
			const total = bomData.reduce((n, g) => n + g.designatorList.length, 0);
			showToast(i18n('已关联原理图器件：${1}/${2} 个匹配', matched, total), 'info');
		}
		catch (err) {
			console.warn(PLUGIN_TAG, 'fetchSchematicPrimitiveIds failed', err);
		}
	}

	// DOM 就绪后初始化
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	}
	else {
		init();
	}
})();
