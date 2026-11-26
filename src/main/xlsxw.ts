import zlib from 'zlib'

// 轻量 Excel（.xlsx）写入器：支持加粗 / 字号 / 颜色 / 底色 / 边框 / 换行 / 数字格式、
// 合并单元格、列宽、行高、冻结窗格、自动筛选、打印设置（横向、按列宽缩放、每页重复表头）。
// SheetJS 社区版写不出样式，所以导出给人看的表格用这里。只依赖 Node 自带的 zlib。

export interface Style {
  bold?: boolean
  size?: number
  color?: string // 字体颜色，RRGGBB
  fill?: string // 底色，RRGGBB
  border?: boolean // 细边框
  wrap?: boolean
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'center'
  numFmt?: string // 如 '#,##0.00'、'0.0%'
  italic?: boolean
}

export type Cell = string | number | null | undefined | { v: string | number | null | undefined; s?: Style }

export interface Sheet {
  name: string
  rows: Cell[][]
  /** 列宽（字符数） */
  cols?: number[]
  /** 行高（磅），下标同 rows；不填时按换行内容估算 */
  heights?: (number | undefined)[]
  /** 合并区域，0 起的 [首行, 首列, 末行, 末列] */
  merges?: [number, number, number, number][]
  /** 冻结：前 rows 行、前 cols 列 */
  freeze?: { rows: number; cols?: number }
  /** 自动筛选区域：表头所在行（0 起）、首列、末列、末行 */
  filter?: { row: number; c1: number; c2: number; lastRow: number }
  /** 打印时每页重复的表头行（0 起） */
  printTitleRow?: number
  /** 整列默认样式（数据行里没给样式的单元格用它） */
  colStyles?: (Style | undefined)[]
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 里不允许的控制字符
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

export const colName = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const ref = (r: number, c: number) => colName(c) + (r + 1)

/** 估算一段文字在 Excel 里的显示宽度（字符数）：中文等全角字符算 2 个 */
export const textWidth = (s: string) => {
  let w = 0
  for (const ch of s) w += /[ᄀ-￿]/.test(ch) && !/[‐-‧·]/.test(ch) ? 2 : 1
  return w
}

class Styles {
  fonts: string[] = ['<font><sz val="10"/><name val="Microsoft YaHei"/><family val="2"/></font>']
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>']
  numFmts: string[] = []
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  private cache = new Map<string, number>()

  private idx(list: string[], xml: string) {
    const i = list.indexOf(xml)
    if (i >= 0) return i
    list.push(xml)
    return list.length - 1
  }

  id(s?: Style) {
    if (!s) return 0
    const key = JSON.stringify(s)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const font = this.idx(
      this.fonts,
      `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="${s.size || 10}"/>${s.color ? `<color rgb="FF${s.color}"/>` : ''}<name val="Microsoft YaHei"/><family val="2"/></font>`
    )
    const fill = s.fill ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0
    const side = '<{x} style="thin"><color rgb="FFD0D5DD"/></{x}>'
    const border = s.border ? this.idx(this.borders, `<border>${['left', 'right', 'top', 'bottom'].map((x) => side.replace(/\{x\}/g, x)).join('')}<diagonal/></border>`) : 0
    let fmt = 0
    if (s.numFmt) {
      const builtin: Record<string, number> = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 }
      if (builtin[s.numFmt]) fmt = builtin[s.numFmt]
      else {
        let i = this.numFmts.indexOf(s.numFmt)
        if (i < 0) i = this.numFmts.push(s.numFmt) - 1
        fmt = 164 + i
      }
    }
    const align =
      s.wrap || s.align || s.valign
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''} vertical="${s.valign || 'center'}"${s.wrap ? ' wrapText="1"' : ''}/>`
        : '<alignment vertical="center"/>'
    const xf = `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`
    const id = this.idx(this.xfs, xf)
    this.cache.set(key, id)
    return id
  }

  xml() {
    const nf = this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : ''
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      nf +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
  }
}

/** 按列宽估算换行后要几行，给出行高（最多 8 行，再多就在单元格里滚动查看） */
function guessHeight(row: Cell[], cols: number[], colStyles: (Style | undefined)[]) {
  let lines = 1
  row.forEach((c, i) => {
    const v = c && typeof c === 'object' ? c.v : c
    const s = c && typeof c === 'object' ? c.s : colStyles[i]
    if (v === null || v === undefined || typeof v === 'number') return
    const w = Math.max(4, (cols[i] || 10) - 1)
    const n = String(v)
      .split('\n')
      .reduce((sum, part) => sum + Math.max(1, Math.ceil(textWidth(part) / w)), 0)
    if (s?.wrap || String(v).includes('\n')) lines = Math.max(lines, n)
  })
  return lines > 1 ? Math.min(lines, 8) * 14 + 4 : undefined
}

function sheetXml(sh: Sheet, st: Styles) {
  const cols = sh.cols || []
  const colStyles = sh.colStyles || []
  const lastCol = Math.max(0, ...sh.rows.map((r) => r.length - 1))
  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">')
  out.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>')
  out.push(`<dimension ref="A1:${ref(Math.max(0, sh.rows.length - 1), lastCol)}"/>`)
  const f = sh.freeze
  if (f && (f.rows || f.cols)) {
    const x = f.cols || 0
    const y = f.rows || 0
    const pane = x && y ? 'bottomRight' : y ? 'bottomLeft' : 'topRight'
    out.push(
      `<sheetViews><sheetView workbookViewId="0" zoomScale="100"><pane${x ? ` xSplit="${x}"` : ''}${y ? ` ySplit="${y}"` : ''} topLeftCell="${ref(y, x)}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${ref(y, x)}" sqref="${ref(y, x)}"/></sheetView></sheetViews>`
    )
  } else out.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>')
  out.push('<sheetFormatPr defaultRowHeight="16"/>')
  if (cols.length) out.push(`<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${(w || 10) + 0.7}" customWidth="1"/>`).join('')}</cols>`)
  out.push('<sheetData>')
  sh.rows.forEach((row, r) => {
    const ht = sh.heights?.[r] ?? guessHeight(row, cols, colStyles)
    const cells: string[] = []
    row.forEach((c, i) => {
      const v = c && typeof c === 'object' ? c.v : c
      const s = st.id(c && typeof c === 'object' && c.s ? c.s : colStyles[i])
      const sa = s ? ` s="${s}"` : ''
      if (v === null || v === undefined || v === '') {
        if (s) cells.push(`<c r="${ref(r, i)}"${sa}/>`)
      } else if (typeof v === 'number' && isFinite(v)) cells.push(`<c r="${ref(r, i)}"${sa}><v>${v}</v></c>`)
      else cells.push(`<c r="${ref(r, i)}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`)
    })
    out.push(`<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.join('')}</row>`)
  })
  out.push('</sheetData>')
  if (sh.filter && sh.filter.lastRow > sh.filter.row) out.push(`<autoFilter ref="${ref(sh.filter.row, sh.filter.c1)}:${ref(sh.filter.lastRow, sh.filter.c2)}"/>`)
  if (sh.merges?.length) out.push(`<mergeCells count="${sh.merges.length}">${sh.merges.map(([r1, c1, r2, c2]) => `<mergeCell ref="${ref(r1, c1)}:${ref(r2, c2)}"/>`).join('')}</mergeCells>`)
  out.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>')
  out.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>')
  out.push('<headerFooter><oddFooter>&amp;C第 &amp;P 页，共 &amp;N 页</oddFooter></headerFooter>')
  out.push('</worksheet>')
  return out.join('')
}

/** Excel 工作表名：不能超过 31 个字符，不能有 \ / ? * [ ] :，不能重名 */
function sheetNames(sheets: Sheet[]) {
  const used = new Set<string>()
  return sheets.map((s) => {
    const base = (s.name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet').trim()
    let n = base
    for (let i = 2; used.has(n.toLowerCase()); i++) n = base.slice(0, 28) + ' ' + i
    used.add(n.toLowerCase())
    return n
  })
}

export function buildXlsx(sheets: Sheet[], meta: { title?: string; author?: string } = {}): Buffer {
  const st = new Styles()
  const names = sheetNames(sheets)
  const sheetFiles = sheets.map((s) => sheetXml(s, st))
  const q = (n: string) => `'${n.replace(/'/g, "''")}'`
  const defined: string[] = []
  sheets.forEach((s, i) => {
    if (s.filter && s.filter.lastRow > s.filter.row)
      defined.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${q(names[i])}!$${colName(s.filter.c1)}$${s.filter.row + 1}:$${colName(s.filter.c2)}$${s.filter.lastRow + 1}</definedName>`)
    if (s.printTitleRow !== undefined) defined.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${q(names[i])}!$${s.printTitleRow + 1}:$${s.printTitleRow + 1}</definedName>`)
  })
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
    ],
    [
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title || '')}</dc:title><dc:creator>${esc(meta.author || '个人工作台')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' +
        (defined.length ? `<definedNames>${defined.join('')}</definedNames>` : '') +
        '</workbook>'
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ],
    ...sheetFiles.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x] as [string, string]),
    ['xl/styles.xml', st.xml()] // 最后生成：前面的工作表用到的样式都登记好了
  ]
  return zip(files.map(([n, s]) => [n, Buffer.from(s, 'utf8')]))
}

// ---------- 最小 zip（deflate） ----------
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Buffer) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(entries: [string, Buffer][]) {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const d = new Date()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = zlib.deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // 文件名 UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(time, 12)
    cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cenBuf, end])
}
