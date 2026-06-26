[简体中文](./README.md) | [English](#) | [繁體中文](./README.zh-Hant.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

# AI Device Standardization

EasyEDA Pro Extension Plugin — Automatically match component footprints from BOM files, with AI-powered smart matching and one-click binding.

## Features

### Smart Matching
- **Standard Matching**: Combine keywords from user-selected match columns to search the EasyEDA device library
- **AI Matching**: Connect to OpenAI-compatible APIs to auto-generate search keywords, filter candidate devices, and recommend the best match
- **Batch AI**: Merge multiple devices into a single AI request, automatically batched by context size
- **Match Score Calculation**: Per-column comparison based on multi-select match columns, supporting exact and partial matches
![alt text](images/image1.png)

### Binding Modes
- **Replace Device**: Delete the old device and recreate it with the matched library device
- **Replace Footprint Only**: Keep the original symbol unchanged, only modify the device's footprint association
- **Replace Symbol Only**: Keep the original footprint unchanged, only modify the device's symbol association
- **Replace Data**: Modify device attributes (name, manufacturer, etc.) without changing footprint or symbol
![alt text](images/image2.png)

### Manual Matching
- For devices that cannot be auto-matched, manually enter keywords to search the device library
- Search results display device details, symbol diagrams, and footprint previews
- Supports manual footprint library matching with independent search and preview

| Device Library Search | Footprint Library Search |
| --- | --- |
| ![alt text](images/image3.png) | ![alt text](images/image4.png) |

## Usage

1. In the schematic editor, click **AI Device Standardization → Open** in the menu bar
2. Select "Match via Schematic" to auto-read components, or "Match via BOM" to import an external BOM file
3. Click "🔧 Match Columns" to select the BOM data columns used for matching
4. Click "⚙️ Settings" to configure AI matching, binding mode, fallback footprint matching, etc.
5. Click "🔄 Match" to execute matching
6. Review match results, click "Bind" or "Batch Bind" to complete footprint binding
7. To restore, click "Unbind" to recover the original device
