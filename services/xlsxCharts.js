// ============================================================================
// Graphiques Excel NATIFS dans un classeur produit par SheetJS (2026-10-13).
//
// SheetJS (édition communautaire) n'écrit ni graphiques ni images. Plutôt que d'ajouter une
// bibliothèque, on ouvre le .xlsx (une archive zip, via adm-zip déjà présent) et on y dépose les
// parties DrawingML d'un graphique à colonnes empilées : chartN.xml, un drawing qui les ancre sur
// la feuille, les relations et les types de contenu. Le graphique est RELIÉ aux cellules (Excel
// le recalcule et on peut le modifier) et porte aussi un cache des valeurs, pour les lecteurs qui
// ne recalculent pas (aperçu, Google Sheets, LibreOffice).
//
// Pur : buffer en entrée, buffer en sortie. Validé en ouvrant le résultat dans le vrai Excel.
// ============================================================================

const AdmZip = require('adm-zip');

const x = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const ref = (sheet, c, r1, r2) => `'${String(sheet).replace(/'/g, "''")}'!$${colName(c)}$${r1 + 1}${r2 != null ? `:$${colName(c)}$${r2 + 1}` : ''}`;

// spec : { title, sheet, dataSheet?, headerRow, firstRow, lastRow, catCol, series:[{ col, name, color, values:[] }],
//          categories:[], anchor:{ col, row, cols, rows } }   (indices 0-based)
function chartXml(spec) {
  const { sheet, headerRow, firstRow, lastRow, catCol } = spec;
  const n = spec.categories.length;
  const catCache = `<c:strCache><c:ptCount val="${n}"/>${spec.categories.map((v, i) => `<c:pt idx="${i}"><c:v>${x(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const ser = spec.series.map((s, i) => `
      <c:ser>
        <c:idx val="${i}"/><c:order val="${i}"/>
        <c:tx><c:strRef><c:f>${ref(sheet, s.col, headerRow)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${x(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="${s.color.replace('#', '')}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr>
        <c:invertIfNegative val="0"/>
        <c:cat><c:strRef><c:f>${ref(sheet, catCol, firstRow, lastRow)}</c:f>${catCache}</c:strRef></c:cat>
        <c:val><c:numRef><c:f>${ref(sheet, s.col, firstRow, lastRow)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${s.values.map((v, k) => `<c:pt idx="${k}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>
      </c:ser>`).join('');
  const txt = (sz, color, bold) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="fr-CA"/></a:p></c:txPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:roundedCorners val="0"/>
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="fr-CA" sz="1300" b="1"><a:solidFill><a:srgbClr val="1C2434"/></a:solidFill></a:rPr><a:t>${x(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>${ser}
        <c:gapWidth val="${n > 30 ? 30 : 70}"/><c:overlap val="100"/>
        <c:axId val="500001"/><c:axId val="500002"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="500001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>
        <c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>
        <c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr>
        ${txt(900, '64748B')}
        <c:crossAx val="500002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="500002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>
        <c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill><a:prstDash val="dash"/></a:ln></c:spPr></c:majorGridlines>
        <c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>
        <c:spPr><a:ln><a:noFill/></a:ln></c:spPr>
        ${txt(900, '64748B')}
        <c:crossAx val="500001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>
      </c:valAx>
      <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
    </c:plotArea>
    <c:legend><c:legendPos val="t"/><c:overlay val="0"/>${txt(900, '1C2434')}</c:legend>
    <c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>
  </c:chart>
  <c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>
</c:chartSpace>`;
}

function anchorXml(a, rId, id, name) {
  return `<xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${a.col + a.cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row + a.rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${x(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/></a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;
}

// Ajoute des graphiques à UNE feuille (nommée) d'un classeur SheetJS. Rend un nouveau buffer.
function addColumnCharts(buffer, sheetName, specs) {
  if (!specs.length) return buffer;
  const zip = new AdmZip(buffer);
  const read = (p) => { const e = zip.getEntry(p); return e ? zip.readAsText(e) : null; };
  const write = (p, s) => { if (zip.getEntry(p)) zip.updateFile(p, Buffer.from(s, 'utf8')); else zip.addFile(p, Buffer.from(s, 'utf8')); };

  // La feuille : workbook.xml donne son r:id, workbook.xml.rels donne son fichier.
  const wbXml = read('xl/workbook.xml');
  const relsXml = read('xl/_rels/workbook.xml.rels');
  const esc = sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;');
  const sm = new RegExp(`<sheet [^>]*name="${esc}"[^>]*r:id="([^"]+)"`).exec(wbXml)
    || new RegExp(`<sheet [^>]*r:id="([^"]+)"[^>]*name="${esc}"`).exec(wbXml);
  if (!sm) throw new Error(`xlsxCharts: sheet not found: ${sheetName}`);
  const rm = new RegExp(`<Relationship [^>]*Id="${sm[1]}"[^>]*Target="([^"]+)"`).exec(relsXml)
    || new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${sm[1]}"`).exec(relsXml);
  const sheetPath = `xl/${rm[1].replace(/^\/?xl\//, '')}`;
  const sheetFile = sheetPath.split('/').pop();

  // Numéros libres pour les nouvelles parties (un classeur SheetJS n'en a pas, mais on reste prudent).
  const used = (re) => zip.getEntries().map((e) => re.exec(e.entryName)).filter(Boolean).map((m) => Number(m[1]));
  const nextChart = Math.max(0, ...used(/^xl\/charts\/chart(\d+)\.xml$/)) + 1;
  const drawingNo = Math.max(0, ...used(/^xl\/drawings\/drawing(\d+)\.xml$/)) + 1;

  const anchors = [];
  const drawingRels = [];
  specs.forEach((spec, i) => {
    const no = nextChart + i;
    // `dataSheet` : le graphique peut lire ses chiffres sur une AUTRE feuille que celle où il est posé.
    write(`xl/charts/chart${no}.xml`, chartXml({ ...spec, sheet: spec.dataSheet || sheetName }));
    drawingRels.push(`<Relationship Id="rIdC${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${no}.xml"/>`);
    anchors.push(anchorXml(spec.anchor, `rIdC${i + 1}`, i + 2, spec.title));
  });
  write(`xl/drawings/drawing${drawingNo}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${anchors.join('\n  ')}
</xdr:wsDr>`);
  write(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>`);

  // La feuille pointe vers son drawing. <drawing> doit suivre pageMargins/pageSetup/headerFooter
  // et précéder legacyDrawing/tableParts/extLst : SheetJS n'écrit rien de ces derniers, donc
  // juste avant </worksheet> est la bonne place.
  const sheetRelsPath = `xl/worksheets/_rels/${sheetFile}.rels`;
  let sheetRels = read(sheetRelsPath)
    || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  sheetRels = sheetRels.replace('</Relationships>',
    `<Relationship Id="rIdDrw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`);
  write(sheetRelsPath, sheetRels);
  let sheetXml = read(sheetPath);
  if (!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  sheetXml = sheetXml.replace('</worksheet>', '<drawing r:id="rIdDrw1"/></worksheet>');
  write(sheetPath, sheetXml);

  // Types de contenu.
  let ct = read('[Content_Types].xml');
  const overrides = [
    `<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    ...specs.map((_, i) => `<Override PartName="/xl/charts/chart${nextChart + i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`),
  ].join('');
  ct = ct.replace('</Types>', `${overrides}</Types>`);
  write('[Content_Types].xml', ct);

  return zip.toBuffer();
}

module.exports = { addColumnCharts, chartXml, colName };
