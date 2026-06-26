/**
 * AI器件标准化 - 入口文件
 *
 * 主进程：读取原理图器件数据，分组标准化，打开 iframe 匹配界面
 */

const PLUGIN_TAG = '[BomSmartMatch]';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

/**
 * 打开 BOM 智能封装匹配界面
 * 仅在原理图编辑器中可用
 */
export async function openBomMatcher(): Promise<void> {
	try {
		// Step 1: 确认当前文档为原理图
		const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!docInfo || docInfo.documentType !== 1) {
			console.warn(PLUGIN_TAG, 'Not a schematic page, documentType:', docInfo?.documentType);
			await eda.sys_Dialog.showInformationMessage(
				eda.sys_I18n.text('请先打开原理图页面再使用本插件'),
			);
			return;
		}

		// Step 2: 获取所有图页的器件（componentType: "part" 过滤真实器件）
		const components = await eda.sch_PrimitiveComponent.getAll('part', true);
		if (!components || components.length === 0) {
			console.warn(PLUGIN_TAG, 'No components found in schematic');
			await eda.sys_Dialog.showInformationMessage(
				eda.sys_I18n.text('当前原理图中没有找到器件'),
			);
			return;
		}

		// Step 3: 提取器件数据
		// 有位号的器件：用 Designator 作为主键
		// 无位号/含"?"的器件：用 _primitiveId 作为主键（保留所有器件）
		const rows: Array<Record<string, string>> = [];
		for (const comp of components) {
			const designator = comp.getState_Designator() ?? '';
			const primitiveId = comp.getState_PrimitiveId() ?? '';

			// 跳过完全无标识的图元（如 logo）
			if (!designator.trim() && !primitiveId)
				continue;

			const componentInfo = comp.getState_Component();
			const footprintInfo = comp.getState_Footprint();
			const other = comp.getState_OtherProperty();

			// 无位号或含"?"的器件，用 primitiveId 作为位号标识
			const effectiveDesig = (designator.trim() && !designator.includes('?'))
				? designator
				: `[${primitiveId}]`;

			// 基础字段
			const row: Record<string, string> = {
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

			// 将 otherProperty 所有字段加入行（供匹配列选择）
			if (other) {
				for (const [k, v] of Object.entries(other)) {
					if (v && !row[k]) {
						row[k] = String(v);
					}
				}
			}

			rows.push(row);
		}

		// Step 4: 存入 sys_Storage 供 iframe 读取（原始行数据，iframe 负责分组）
		await eda.sys_Storage.setExtensionUserConfig('bomSourceData', JSON.stringify(rows));
		await eda.sys_Storage.setExtensionUserConfig('bomSourceType', 'schematic');

		// Step 5: 打开 iframe 窗口
		await eda.sys_IFrame.openIFrame('/iframe/index.html', 1200, 800, 'bom-smart-match', {
			title: eda.sys_I18n.text('AI器件标准化'),
			maximizeButton: true,
			minimizeButton: true,
		});

		console.warn(PLUGIN_TAG, `Opened BOM matcher with ${rows.length} components`);
	}
	catch (err) {
		console.error(PLUGIN_TAG, 'Failed to open BOM matcher:', err);
		await eda.sys_Dialog.showInformationMessage(
			eda.sys_I18n.text('打开BOM匹配工具失败，请查看控制台日志'),
		);
	}
}
