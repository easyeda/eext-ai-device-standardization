/**
 * BOM 解析服务
 *
 * 适配三种真实 BOM 格式：
 *  1. EasyEDA 导出 CSV（UTF-16LE）：ID, Name, Designator, Footprint, Quantity, Supplier Part
 *  2. A104 光机驱动板 XLSX（中文表头）：项目,元件名称,value,PCB DECAL,参考编号,数量,制造商,说明
 *     —— 位号用 `e` 分隔，支持范围 `C5-7`
 *  3. Detail BOM Power Supply XLSX（英文 + 分类段）：item,Marking code,Part number,Designator,Qty,Footprint,Manufacture,Details
 *     —— 首行有标题、含分类段行（Resistors/Capacitors）
 *
 * 纯逻辑模块，不依赖 EDA API，可在主进程和测试中复用。
 */

/** 解析后的标准化 BOM 器件项 */
export interface BomItem {
	/** 主位号（分组中第一个） */
	designator: string;
	/** 该组全部位号（去重排序） */
	designators: string[];
	/** 位号展示串 */
	designatorStr: string;
	/** 值（如 0R / 0.1u / STM32F103） */
	value: string;
	/** 封装（如 C0603 / 1206） */
	footprint: string;
	/** 数量 */
	quantity: number;
	/** 制造商 */
	manufacturer: string;
	/** 描述 */
	description: string;
	/** 制造商型号（MPN） */
	mpn: string;
	/** 立创 LCSC 编号（如 C8734） */
	lcsc: string;
	/** 原始行的全部键值对（供详情/导出使用） */
	raw: Record<string, string>;
	/** 位号 → 原理图图元 ID 映射（仅原理图来源时存在，用于绑定） */
	primitiveIds?: Record<string, string>;
}

/** BOM 列角色 */
export type BomColumnRole
	= | 'designator'
		| 'value'
		| 'footprint'
		| 'quantity'
		| 'manufacturer'
		| 'description'
		| 'mpn'
		| 'lcsc';

/** 各角色的别名表（小写、去空格匹配） */
const COLUMN_ALIASES: Record<BomColumnRole, string[]> = {
	designator: ['designator', 'refdes', 'reference designator', '参考编号', '位号', 'designators', 'part reference'],
	value: ['name', 'value', 'part number', '元件名称', 'marking code', '型号', 'comment', 'device'],
	footprint: ['footprint', 'pcb decal', '封装', 'package'],
	quantity: ['quantity', 'qty', '数量', 'count'],
	manufacturer: ['manufacturer', 'manufacture', '制造商', 'brand', 'mfr'],
	description: ['description', 'desc', 'details', '说明', 'pcbfast remark', 'customer reply', 'remark'],
	mpn: ['mpn', 'manufacturer part', 'manufacturer part number', 'mfr part', 'mfr part number', 'details', 'supplier part', 'part number', '说明', 'marking code'],
	lcsc: ['lcsc', 'lcsc part', 'supplier part', '供应商编号', '立创编号', 'lcsc number', 'jlcpcb part'],
};

/** 规范化表头：小写 + 去首尾空格 + 压缩中间空格 */
function normalizeHeader(h: string): string {
	return String(h ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/** 在表头中按角色查找列名（返回原始列名） */
export function findColumn(headers: string[], role: BomColumnRole): string | null {
	const aliases = COLUMN_ALIASES[role];
	const normalized = headers.map(normalizeHeader);
	for (const alias of aliases) {
		const idx = normalized.indexOf(alias);
		if (idx !== -1)
			return headers[idx];
	}
	return null;
}

/** 构建列角色 → 原始列名 的映射 */
export function buildColumnMap(headers: string[]): Record<BomColumnRole, string | null> {
	const roles: BomColumnRole[] = ['designator', 'value', 'footprint', 'quantity', 'manufacturer', 'description', 'mpn', 'lcsc'];
	const map = {} as Record<BomColumnRole, string | null>;
	for (const role of roles) map[role] = findColumn(headers, role);
	return map;
}

/**
 * 解析位号字符串，支持多种分隔符与范围：
 *  - 逗号：`C1,C2,C3`
 *  - `e`/`E`：`C10eC14`（A104 格式的分隔符）
 *  - 范围：`C5-7` → C5,C6,C7；`R1-R10` → R1..R10
 *  - 混合：`C2-4eC11`，`C1eC8-9eC12-13`
 */
export function normalizeDesignators(raw: string): string[] {
	if (!raw)
		return [];
	// 按逗号/分号分割；e/E 仅在「数字e字母」时作为分隔符（A104 的 C10eC14），避免破坏 LED1/RE1
	const tokens = String(raw)
		.split(/[,;，；]+|(?<=\d)E(?=[A-Z])/i)
		.map(t => t.trim())
		.filter(Boolean);

	const result: string[] = [];
	for (const token of tokens) {
		// 范围：字母前缀 + 数字 - 数字
		const rangeMatch = token.match(/^([A-Z]+)(\d+)\s*[-–—]\s*(\d+)$/i);
		if (rangeMatch) {
			const prefix = rangeMatch[1];
			const start = Number.parseInt(rangeMatch[2], 10);
			const end = Number.parseInt(rangeMatch[3], 10);
			if (end >= start && end - start < 500) {
				// 防止误匹配，限制范围长度
				for (let i = start; i <= end; i++) result.push(`${prefix}${i}`);
				continue;
			}
		}
		// 也处理无前缀范围 "5-9"（少见）
		const bareRange = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
		if (bareRange) {
			const start = Number.parseInt(bareRange[1], 10);
			const end = Number.parseInt(bareRange[2], 10);
			if (end >= start && end - start < 500) {
				for (let i = start; i <= end; i++) result.push(String(i));
				continue;
			}
		}
		result.push(token);
	}
	return result;
}

/** 解析数量，容错 */
function parseQuantity(raw: string, fallback = 1): number {
	if (!raw)
		return fallback;
	const n = Number.parseInt(String(raw).replace(/\D/g, ''), 10);
	return Number.isNaN(n) ? fallback : Math.max(1, n);
}

/** 判断一行是否为分类段/标题（非数据行）：无位号或位号不像位号 */
function isSectionOrHeaderRow(row: Record<string, string>, designatorCol: string | null): boolean {
	if (!designatorCol)
		return false;
	const des = String(row[designatorCol] ?? '').trim();
	if (!des)
		return true;
	// 位号应含字母+数字模式（R1, C10, U7, LED1）；纯文字如 "Resistors" 视为分类段
	return !/[A-Z]+\d+/i.test(des) && !/\d/.test(des);
}

/**
 * 将原始行（对象数组）分组并标准化为 BomItem[]
 * 键值对完全一致的器件合并为一组，位号收敛。
 */
export function groupBomItems(
	rows: Array<Record<string, string>>,
	headers: string[],
	matchColumns?: string[],
): BomItem[] {
	if (!rows.length)
		return [];

	const colMap = buildColumnMap(headers);
	const desigCol = colMap.designator;
	const valueCol = colMap.value;
	const fpCol = colMap.footprint;
	const qtyCol = colMap.quantity;
	const mfrCol = colMap.manufacturer;
	const descCol = colMap.description;

	if (!desigCol) {
		console.warn('[BomService]', 'No designator column found in headers:', headers);
		return [];
	}

	// 过滤分类段/标题行
	const dataRows = rows.filter(row => !isSectionOrHeaderRow(row, desigCol));

	// 分组键：除位号、数量外的所有原始字段一致
	const groupMap = new Map<string, {
		designators: Set<string>;
		raw: Record<string, string>;
		quantity: number;
		primitiveIds: Record<string, string>;
	}>();

	for (const row of dataRows) {
		const designators = normalizeDesignators(String(row[desigCol] ?? ''));
		if (!designators.length)
			continue;

		// 分组键：所有非位号/非内部字段
		const keyObj: Record<string, string> = {};
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
		const g = groupMap.get(groupKey)!;
		for (const d of designators) {
			g.designators.add(d);
			// 透传 primitiveId（原理图来源时挂在行上）
			const pid = row._primitiveId;
			if (pid)
				g.primitiveIds[d] = pid;
		}
		g.quantity += parseQuantity(qtyCol ? String(row[qtyCol] ?? '') : '');
	}

	const items: BomItem[] = [];
	for (const g of groupMap.values()) {
		const desList = Array.from(g.designators).sort(designatorSort);
		const value = valueCol ? String(g.raw[valueCol] ?? '').trim() : '';
		const footprint = fpCol ? String(g.raw[fpCol] ?? '').trim() : '';
		const manufacturer = mfrCol ? String(g.raw[mfrCol] ?? '').trim() : '';
		const description = descCol ? String(g.raw[descCol] ?? '').trim() : '';
		const mpn = colMap.mpn ? String(g.raw[colMap.mpn] ?? '').trim() : '';
		const lcsc = extractLcsc(colMap.lcsc ? String(g.raw[colMap.lcsc] ?? '').trim() : '');

		items.push({
			designator: desList[0],
			designators: desList,
			designatorStr: desList.join(', '),
			value,
			footprint,
			quantity: g.quantity || desList.length,
			manufacturer,
			description,
			mpn,
			lcsc,
			raw: stripInternal(g.raw),
			primitiveIds: Object.keys(g.primitiveIds).length ? g.primitiveIds : undefined,
		});
	}

	// 若指定了匹配列，挂载便于上层使用（不影响分组）
	void matchColumns;
	return items;
}

/** 按自然序排序位号：R2 < R10 < R100 */
function designatorSort(a: string, b: string): number {
	const ma = a.match(/^([A-Z]*)(\d+)$/i);
	const mb = b.match(/^([A-Z]*)(\d+)$/i);
	if (ma && mb) {
		if (ma[1] !== mb[1])
			return ma[1].localeCompare(mb[1]);
		return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
	}
	return a.localeCompare(b);
}

/** 从文本中提取 LCSC 编号（C + 数字） */
export function extractLcsc(text: string): string {
	if (!text)
		return '';
	const m = String(text).match(/C\d{3,}/i);
	return m ? m[0].toUpperCase() : '';
}

/** 去除内部字段（_primitiveId 等） */
function stripInternal(raw: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!k.startsWith('_'))
			out[k] = v;
	}
	return out;
}

// ============ 文件解码（编码自动检测） ============

export type FileEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** 根据 BOM 检测文本编码 */
export function detectEncoding(bytes: Uint8Array): FileEncoding {
	if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
		return 'utf-16le';
	if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
		return 'utf-16be';
	if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
		return 'utf-8';
	return 'utf-8';
}

/** 解码 ArrayBuffer/Uint8Array 为字符串，自动处理 UTF-16LE/BE/UTF-8 */
export function decodeBytes(data: ArrayBuffer | Uint8Array): string {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const encoding = detectEncoding(bytes);
	// 统一用 TextDecoder 解码（浏览器/EDA 环境均支持）
	const decoder = new TextDecoder(encoding === 'utf-8' ? 'utf-8' : encoding);
	return decoder.decode(bytes);
}

// ============ CSV 解析（支持引号转义） ============

/** 解析单行 CSV（支持双引号包裹与转义） */
export function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				}
				else {
					inQuotes = false;
				}
			}
			else {
				cur += ch;
			}
		}
		else {
			if (ch === '"') {
				inQuotes = true;
			}
			else if (ch === ',' || ch === '\t') {
				result.push(cur.trim());
				cur = '';
			}
			else {
				cur += ch;
			}
		}
	}
	result.push(cur.trim());
	return result;
}

/**
 * 解析 CSV 文本为行（二维数组）
 * 自动处理编码（调用方应先用 decodeBytes 解码）。
 */
export function parseCsvText(text: string): string[][] {
	const lines = text.split(/\r?\n/).filter(l => l.trim());
	return lines.map(parseCsvLine);
}

/**
 * 在二维数组中定位表头行（含 designator 类列的行），返回其索引。
 * 用于处理标题行在表头上方的情况（如 Power Supply 格式）。
 */
export function findHeaderRow(rows: string[][]): number {
	for (let i = 0; i < Math.min(rows.length, 10); i++) {
		const normalized = rows[i].map(normalizeHeader);
		const hasDesignator = normalized.some(h =>
			COLUMN_ALIASES.designator.includes(h),
		);
		if (hasDesignator)
			return i;
	}
	// 回退：第一行
	return 0;
}

/**
 * 将 CSV 二维行转为对象数组 + 表头，自动跳过标题行。
 */
export function csvToRows(rows: string[][]): { headers: string[]; data: Array<Record<string, string>> } {
	if (!rows.length)
		return { headers: [], data: [] };
	const headerIdx = findHeaderRow(rows);
	const headers = rows[headerIdx];
	const data: Array<Record<string, string>> = [];
	for (let i = headerIdx + 1; i < rows.length; i++) {
		const cells = rows[i];
		if (!cells.length)
			continue;
		const obj: Record<string, string> = {};
		headers.forEach((h, idx) => {
			obj[h] = cells[idx] ?? '';
		});
		data.push(obj);
	}
	return { headers, data };
}

/**
 * 统一入口：从 CSV 文件字节解析为 BomItem[]
 */
export function parseBomFromCsvBytes(data: ArrayBuffer | Uint8Array): BomItem[] {
	const text = decodeBytes(data);
	const rows = parseCsvText(text);
	const { headers, data: dataRows } = csvToRows(rows);
	return groupBomItems(dataRows, headers);
}

/**
 * 统一入口：从 XLSX sheet 行（由 SheetJS 解析）转为 BomItem[]
 * sheetRows 为 XLSX.utils.sheet_to_json 的结果（对象数组）或二维数组。
 */
export function parseBomFromSheetRows(sheetRows: Array<Record<string, unknown>> | string[][]): BomItem[] {
	if (!sheetRows.length)
		return [];

	// 二维数组形式：转为对象
	if (Array.isArray(sheetRows[0])) {
		const rows2d = sheetRows as string[][];
		const { headers, data } = csvToRows(rows2d);
		return groupBomItems(data, headers);
	}

	// 对象数组形式（SheetJS sheet_to_json）：表头取自首对象 key
	const objRows = sheetRows as Array<Record<string, unknown>>;
	const headers = Object.keys(objRows[0]);
	// SheetJS 对象数组会跳过空值导致列错位，改用二维数组逻辑更稳；
	// 但这里仍尝试用对象 key 对齐
	const data = objRows.map((row) => {
		const obj: Record<string, string> = {};
		for (const k of headers) obj[k] = String(row[k] ?? '');
		return obj;
	});
	return groupBomItems(data, headers);
}

// ============ XLSX 解析（基于 JSZip） ============

/**
 * 从列字母（A/B/.../Z/AA/AB/...）转为 0-based 索引
 */
function colLetterToIndex(ref: string): number {
	const m = ref.match(/^([A-Z]+)/);
	if (!m) {
		return 0;
	}
	let n = 0;
	for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/**
 * 解析 XLSX 文件字节为二维字符串数组（保留列位置，空格填充）
 *
 * 直接解析 XLSX（ZIP 格式）的 XML 内容，无需 SheetJS。
 * 支持合并单元格（标题行偏移）、空单元格对齐。
 *
 * @param data - XLSX 文件的 ArrayBuffer 或 Uint8Array
 * @param sheetIndex - 工作表索引（默认 0 = 第一个工作表）
 */
export async function parseXlsxToRows(data: ArrayBuffer | Uint8Array, sheetIndex = 0): Promise<string[][]> {
	// 动态导入 JSZip（兼容浏览器和 Node 环境）
	const JSZipModule = await import('jszip');
	const JSZip = JSZipModule.default || JSZipModule;
	const zip = await JSZip.loadAsync(data);

	// 读取共享字符串表
	const ssFile = zip.file('xl/sharedStrings.xml');
	let strings: string[] = [];
	if (ssFile) {
		const ssXml = await ssFile.async('string');
		strings = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
			return [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
				.map(x => x[1].replace(/&#10;/g, ' '))
				.join('');
		});
	}

	// 读取工作表
	const sheetNames = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'];
	const sheetFile = zip.file(sheetNames[sheetIndex] || sheetNames[0]);
	if (!sheetFile) {
		return [];
	}

	const sheetXml = await sheetFile.async('string');
	const rowXmls = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(m => m[1]);

	return rowXmls.map((row) => {
		const tmp: Array<{ idx: number; val: string }> = [];
		let maxIdx = -1;
		let pos = 0;

		// 逐个查找 <c 开头的单元格标签
		while (pos < row.length) {
			const cStart = row.indexOf('<c', pos);
			if (cStart === -1) {
				break;
			}

			// 找到标签结束：/> 或 >
			const afterC = cStart + 2;
			const selfClose = row.indexOf('/>', afterC);
			const openClose = row.indexOf('>', afterC);
			if (openClose === -1) {
				break;
			}

			const isSelfClose = selfClose !== -1 && selfClose < openClose;
			const tagEnd = isSelfClose ? selfClose : openClose;
			const attrs = row.substring(afterC, tagEnd);

			// 提取 r 属性
			const rIdx = attrs.indexOf(' r="');
			if (rIdx !== -1) {
				const rValStart = rIdx + 4;
				const rValEnd = attrs.indexOf('"', rValStart);
				const ref = attrs.substring(rValStart, rValEnd);
				const idx = colLetterToIndex(ref);

				// 提取 t 属性（类型：s=共享字符串）
				let typeVal = '';
				const tIdx = attrs.indexOf(' t="');
				if (tIdx !== -1) {
					const tValStart = tIdx + 4;
					const tValEnd = attrs.indexOf('"', tValStart);
					typeVal = attrs.substring(tValStart, tValEnd);
				}

				// 提取单元格值
				let val = '';
				if (!isSelfClose) {
					const contentStart = tagEnd + 1;
					const contentEnd = row.indexOf('</c>', contentStart);
					if (contentEnd !== -1) {
						const inner = row.substring(contentStart, contentEnd);
						// 提取 <v>...</v> 或 <is><t>...</t></is> 中的值
						const vOpen = inner.indexOf('<v>');
						const isTOpen = inner.indexOf('<t>');
						if (vOpen !== -1) {
							const vClose = inner.indexOf('</v>', vOpen);
							if (vClose !== -1) {
								val = inner.substring(vOpen + 3, vClose).trim();
							}
						}
						else if (isTOpen !== -1) {
							const isTClose = inner.indexOf('</t>', isTOpen);
							if (isTClose !== -1) {
								val = inner.substring(isTOpen + 3, isTClose).trim();
							}
						}
					}
				}

				// 共享字符串：用索引查找
				if (typeVal === 's' && val) {
					const strIdx = Number.parseInt(val, 10);
					if (!Number.isNaN(strIdx)) {
						val = strings[strIdx] ?? val;
					}
				}

				tmp.push({ idx, val });
				if (idx > maxIdx) {
					maxIdx = idx;
				}
			}

			pos = tagEnd + (isSelfClose ? 2 : 1);
		}

		// 填充空单元格，保持列对齐
		const cells: string[] = [];
		for (let i = 0; i <= maxIdx; i++) {
			const found = tmp.find(t => t.idx === i);
			cells.push(found ? found.val : '');
		}
		return cells;
	});
}

/**
 * 统一入口：从 XLSX 文件字节解析为 BomItem[]
 */
export async function parseBomFromXlsxBytes(data: ArrayBuffer | Uint8Array, sheetIndex = 0): Promise<BomItem[]> {
	const rows2d = await parseXlsxToRows(data, sheetIndex);
	const { headers, data: dataRows } = csvToRows(rows2d);
	return groupBomItems(dataRows, headers);
}

// ============ 统一文件解析入口 ============

export type BomFileType = 'csv' | 'xlsx' | 'xls' | 'unknown';

/**
 * 根据文件扩展名或 BOM 检测文件类型
 */
export function detectFileType(fileName: string, bytes?: Uint8Array): BomFileType {
	const ext = fileName.split('.').pop()?.toLowerCase();
	if (ext === 'csv' || ext === 'tsv')
		return 'csv';
	if (ext === 'xlsx')
		return 'xlsx';
	if (ext === 'xls')
		return 'xls';
	// 按内容检测：XLSX 是 ZIP（PK\x03\x04），XLS 是 OLE（\xD0\xCF\x11\xE0）
	if (bytes) {
		if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04)
			return 'xlsx';
		if (bytes.length >= 4 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0)
			return 'xls';
	}
	return 'unknown';
}

/**
 * 统一入口：自动识别文件格式并解析为 BomItem[]
 *
 * 支持格式：
 * - CSV / TSV（UTF-8、UTF-16LE、UTF-16BE，自动检测编码）
 * - XLSX（通过 JSZip 直接解析，无需 SheetJS）
 * - XLS（旧格式，需要 SheetJS 支持 —— 返回空数组并打印警告）
 *
 * @param data - 文件字节
 * @param fileName - 文件名（用于格式检测）
 */
export async function parseBomFromFile(data: ArrayBuffer | Uint8Array, fileName: string): Promise<BomItem[]> {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const fileType = detectFileType(fileName, bytes);

	switch (fileType) {
		case 'csv':
			return parseBomFromCsvBytes(bytes);
		case 'xlsx':
			return parseBomFromXlsxBytes(bytes);
		case 'xls':
			console.warn('[BomService]', 'XLS format requires SheetJS — use parseBomFromSheetRows() with SheetJS instead');
			return [];
		default:
			console.warn('[BomService]', 'Unsupported file format:', fileName);
			return [];
	}
}
