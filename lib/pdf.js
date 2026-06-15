'use strict';
const PDFDocument = require('pdfkit');
const { buildProposalView } = require('./proposal_lines');

const COMPANY = {
  name: 'R&R Fabrication',
  tagline: 'Steel Fabrication + Erection',
  address: 'Prince Frederick, MD',
  phone: '301-855-9111',
  email: 'office@rrfabrication.org'
};

// Colors matching Thomas Somerville reference doc
const NAVY    = '#0d1b35';
const BLUE    = '#2463a6';
const ORANGE  = '#c25a00';
const GRAY    = '#555555';
const LTGRAY  = '#dddddd';
const WHITE   = '#ffffff';

const DEFAULT_TERMS = [
  'Proposal valid 30 days. Pricing subject to material market at time of order.',
  'Payment: Net 30 from invoice date. Retainage per contract terms.',
  'Lead time: 4-6 weeks from approved shop drawings to delivery.',
  'Assumes standard M-F daytime access (7am-5pm). OT/weekend work priced separately.'
];

function fmt(n) {
  const v = +n || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function markupFactor(e) {
  return (1 + (+e.oh_rate || 0))
       * (1 + (+e.contingency_rate || 0))
       * (1 + (+e.profit_rate || 0))
       * (1 + (+e.cgl_rate || 0));
}

function writeProposalToDoc(doc, bundle) {
  const { estimate: e, computed: c, extras = [], standardExclusions = [], siteExclusions = [], shapes = [], plates = [], misc = [] } = bundle;
  const pc = bundle.processComputed || {};
  const isPO = e.job_type === 'process_only';
  const mf = markupFactor(e);
  const L = 50;   // left margin
  const R = 562;  // right edge
  const W = R - L; // usable width

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function sectionHeader(text) {
    doc.moveDown(0.8);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(text, L, y);
    const lineY = doc.y + 1;
    doc.moveTo(L, lineY).lineTo(R, lineY).strokeColor(NAVY).lineWidth(1.2).stroke();
    doc.y = lineY + 8;
  }

  // Draw a simple bordered table of text rows.
  // subheader: optional centered bold underlined heading above rows
  function drawTable(rows, subheader) {
    const rowH = 16;
    const cellPad = 4;
    if (subheader) {
      const hY = doc.y;
      // border top
      doc.moveTo(L, hY).lineTo(R, hY).strokeColor('#333').lineWidth(0.5).stroke();
      const textY = hY + 3;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a')
         .text(subheader, L, textY, { width: W, align: 'center' });
      // underline the text
      const tw = doc.widthOfString(subheader);
      const cx = L + W / 2 - tw / 2;
      const ulY = textY + 10;
      doc.moveTo(cx, ulY).lineTo(cx + tw, ulY).strokeColor('#1a1a1a').lineWidth(0.5).stroke();
      doc.y = textY + rowH;
    }
    for (const row of rows) {
      const ry = doc.y;
      doc.moveTo(L, ry).lineTo(R, ry).strokeColor('#333').lineWidth(0.3).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
         .text(row, L + cellPad, ry + 3, { width: W - cellPad * 2, lineGap: 0 });
      doc.y = ry + rowH;
    }
    // bottom border
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#333').lineWidth(0.5).stroke();
    // left and right borders
    const tableTop = subheader ? doc.y - rows.length * rowH - rowH : doc.y - rows.length * rowH;
    doc.moveTo(L, tableTop).lineTo(L, doc.y).strokeColor('#333').lineWidth(0.5).stroke();
    doc.moveTo(R, tableTop).lineTo(R, doc.y).strokeColor('#333').lineWidth(0.5).stroke();
    doc.y += 4;
  }

  // -----------------------------------------------------------------------
  // PAGE 1
  // -----------------------------------------------------------------------

  // Company header
  doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text(COMPANY.name, L, doc.y);
  doc.font('Helvetica').fontSize(10).fillColor(BLUE).text(COMPANY.tagline);
  doc.moveDown(0.8);

  // PROPOSAL title
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('PROPOSAL');
  doc.moveDown(0.8);

  // Metadata: TO / PROJECT / DATE / BID#
  const metaY = doc.y;
  const labW = 70;
  const valX = L + labW;
  const col2L = 310;
  const col2V = col2L + 55;
  const rowH = 18;

  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('TO:', L, metaY, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(e.proposal_to || e.client_gc || '', valX, metaY, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('PROJECT:', L, metaY + rowH, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(e.project_name || '', valX, metaY + rowH, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('DATE:', L, metaY + rowH * 2, { lineBreak: false });
  const parseDate = (dateStr) => {
    if (!dateStr) return '';
    let d;
    if (dateStr.includes('T')) {
      // ISO format with time: "2026-06-02T14:52:11.946Z" or "2026-06-02T14:52:11"
      d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
    } else {
      // Date only: "2026-06-02" - add time component for parsing
      d = new Date(dateStr + 'T00:00:00Z');
    }
    if (isNaN(d)) return '';
    const mm = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    const yyyy = d.getUTCFullYear();
    return `${mm}/${dd}/${yyyy}`;
  };
  const proposalDate = parseDate(e.proposal_date || e.submitted_at || e.created_at);
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(proposalDate, valX, metaY + rowH * 2, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('BID #:', L, metaY + rowH * 3, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(e.bid_number || '', valX, metaY + rowH * 3, { lineBreak: false });

  doc.y = metaY + rowH * 3 + 22;

  // SCOPE OF WORK (proposal_scope, falling back to scope) + drawing numbers
  const scopeText = (e.proposal_scope || e.scope || '').trim();
  const drawings = (e.drawing_numbers || '').trim();
  if (scopeText || drawings) {
    sectionHeader('SCOPE OF WORK');
    if (scopeText) {
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a').text(scopeText, L, doc.y, { width: W, lineGap: 2 });
    }
    if (drawings) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a').text('Drawings: ', L, doc.y, { continued: true });
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a').text(drawings);
    }
  }

  // PRICING section header
  sectionHeader('PRICING');

  // Pricing table columns
  const tL = L;
  const itemColW = 36;
  const amtColW  = 90;
  const descColX = tL + itemColW;
  const amtColX  = R - amtColW;
  const descColW = amtColX - descColX - 8;

  // Table header row (dark navy bg)
  const thH = 18;
  const thY = doc.y;
  doc.rect(tL, thY, W, thH).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
  doc.text('Item', tL + 4, thY + 5, { width: itemColW - 4, align: 'center', lineBreak: false });
  doc.text('Description', descColX + 4, thY + 5, { width: descColW, lineBreak: false });
  doc.text('Amount', amtColX, thY + 5, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = thY + thH;

  // Build line items
  const defaultLineDescs = [
    'Structural steel material - furnished',
    'Shop fabrication and finishes',
    'Detailing and PE-stamped shop drawings',
    'Freight to jobsite',
    'Field erection, equipment, and rigging',
    'Finishes',
    'Processing labor'
  ];
  function lineDesc(n) {
    return (e['proposal_line_' + n + '_desc'] || '').trim() || defaultLineDescs[n - 1];
  }

  // Shared assembler: applies per-line hide state and manual lines on top of the
  // locked calc totals. Hidden lines are dropped from the printed list; the
  // subtotal/tax/total come from the view (identical to calc when nothing is
  // hidden or added). lineDesc/coreItems above stay for any other callers.
  void lineDesc;
  const view = buildProposalView(bundle);
  const coreItems = view.lines.filter(l => !l.hidden).map(l => ({ desc: l.desc, amt: l.amount }));

  coreItems.forEach((item, idx) => {
    const ry = doc.y;
    const rowHt = 16;
    // alternating very light row bg
    if (idx % 2 === 1) doc.rect(tL, ry, W, rowHt).fill('#f7f7f7');
    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');
    doc.text(String(idx + 1), tL + 4, ry + 4, { width: itemColW - 4, align: 'center', lineBreak: false });
    doc.text(item.desc, descColX + 4, ry + 4, { width: descColW, lineBreak: false });
    doc.text(fmt(item.amt), amtColX, ry + 4, { width: amtColW - 4, align: 'right', lineBreak: false });
    // row bottom border
    doc.moveTo(tL, ry + rowHt).lineTo(R, ry + rowHt).strokeColor(LTGRAY).lineWidth(0.3).stroke();
    doc.y = ry + rowHt;
  });

  // Subtotal / Tax / Total
  doc.moveDown(0.3);
  doc.moveTo(amtColX - 20, doc.y).lineTo(R, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.3);

  // SUBTOTAL row
  let ry = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('SUBTOTAL', descColX + 4, ry, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text(fmt(view.subtotal), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 16;

  // Sales tax row
  ry = doc.y;
  const taxPct = isPO ? ((+e.po_tax_pct || 0) * 100).toFixed(0) : ((+e.sales_tax_rate || 0) * 100).toFixed(0);
  const taxMode = e.tax_mode || 'total';
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text('Sales Tax (' + taxPct + '%)', descColX + 4, ry, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(fmt(view.tax), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 16;

  // Double rule before total
  doc.moveTo(tL, doc.y).lineTo(R, doc.y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
  doc.y += 2;
  doc.moveTo(tL, doc.y).lineTo(R, doc.y).strokeColor('#1a1a1a').lineWidth(0.5).stroke();
  doc.y += 5;

  // TOTAL row
  ry = doc.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text(isPO ? 'TOTAL' : 'TOTAL  -  FURNISH + INSTALL', descColX + 4, ry, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text(fmt(view.total), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 22;

  // -----------------------------------------------------------------------
  // ADD ALTERNATES (priced separately; summary ADD price plus itemized lines)
  // -----------------------------------------------------------------------
  const alternates = (bundle.alternates || []).filter(ab => {
    if (!ab || !ab.estimate) return false;
    const aIsPO = ab.estimate.job_type === 'process_only';
    const addPrice = aIsPO ? ((ab.processComputed || {}).quoted || 0) : ((ab.computed || {}).totalFurnishInstall || 0);
    return Math.round(addPrice) > 0;
  });
  if (alternates.length) {
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    doc.moveDown(0.6);
    if (doc.y > bottomLimit() - 90) { doc.addPage(); doc.y = doc.page.margins.top; }
    sectionHeader('ADD ALTERNATES');
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
       .text('Priced separately from the base bid above. Each may be added if accepted.', tL, doc.y, { width: W, lineBreak: false });
    doc.y += 14;

    alternates.forEach((ab, ai) => {
      const ae = ab.estimate;
      const ac = ab.computed || {};
      const apc = ab.processComputed || {};
      const aIsPO = ae.job_type === 'process_only';
      const amf = markupFactor(ae);
      const aExtras = ab.extras || [];
      const addPrice = aIsPO ? (apc.quoted || 0) : (ac.totalFurnishInstall || 0);
      const label = (ae.alt_label || '').trim() || ('Alternate ' + (ai + 1));

      // Editable per-alternate line descriptions (same fields/pattern as the base
      // bid). Blank falls back to the standard label, so existing alternates with
      // no saved description render exactly as before.
      const altDefaultDescs = [
        'Structural steel material - furnished',
        'Shop fabrication and finishes',
        'Detailing and PE-stamped shop drawings',
        'Freight to jobsite',
        'Field erection, equipment, and rigging',
        'Galvanizing',
        'Processing labor'
      ];
      const altLineDesc = (n) => (ae['proposal_line_' + n + '_desc'] || '').trim() || altDefaultDescs[n - 1];

      if (doc.y > bottomLimit() - 80) { doc.addPage(); doc.y = doc.page.margins.top; }

      // Summary header bar with the ADD price
      const hy = doc.y;
      doc.rect(tL, hy, W, 18).fill('#eef1f5');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
         .text('Add Alternate ' + (ai + 1) + ':  ' + label, descColX + 4, hy + 5, { width: descColW, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
         .text('ADD ' + fmt(addPrice), amtColX - 40, hy + 5, { width: amtColW - 4 + 40, align: 'right', lineBreak: false });
      doc.y = hy + 20;

      // Itemized breakdown, same construction as the base bid lines
      let altItems;
      if (aIsPO) {
        const aPoDesc = (ae.proposal_line_1_desc || '').trim() || 'Process & fabrication per scope';
        altItems = [{ desc: aPoDesc, amt: (apc.quoted || 0) - (apc.taxAmt || 0) }];
      } else {
        altItems = [
          { desc: altLineDesc(1), amt: ac.materialPrice * amf },
          { desc: altLineDesc(2), amt: ((ac.fabHours || 0) + (ac.paint || 0) + (ac.consumables || 0) + (ac.handling || 0)) * amf },
          { desc: altLineDesc(3), amt: (((+ae.struct_detailing||0)*(+ae.struct_detailing_qty||1)) + ((+ae.misc_detailing||0)*(+ae.misc_detailing_qty||1)) + ((+ae.pe_stamp||0)*(+ae.pe_stamp_qty||1))) * amf },
          { desc: altLineDesc(4), amt: (+ae.freight || 0) * (+ae.freight_qty || 1) * amf },
          { desc: altLineDesc(5), amt: ((ac.erectionLabor || 0) + (+ae.erection_equip || 0) * (+ae.erection_equip_qty || 1)) * amf },
          { desc: altLineDesc(6), amt: (ac.galv || 0) * amf },
          { desc: altLineDesc(7), amt: (ac.processingLabor || 0) * amf }
        ];
        if ((+ae.sub_joist_deck || 0) > 0) altItems.push({ desc: 'Joist and Deck - by Subcontractor', amt: (+ae.sub_joist_deck||0)*(+ae.sub_joist_deck_qty||1)*amf });
        if ((+ae.sub_erection || 0) > 0) altItems.push({ desc: 'Erection - by Subcontractor', amt: (+ae.sub_erection||0)*(+ae.sub_erection_qty||1)*amf });
        aExtras.forEach(x => altItems.push({ desc: x.description || 'Additional item', amt: (+x.qty||0)*(+x.rate||0)*amf }));
      }
      altItems = altItems.filter(it => Math.round(it.amt) !== 0);
      const aTax = aIsPO ? (apc.taxAmt || 0) : (ac.tax ? ac.tax.amount : 0);
      if (Math.round(aTax) !== 0) altItems.push({ desc: 'Sales tax', amt: aTax });

      altItems.forEach(item => {
        if (doc.y > bottomLimit() - 18) { doc.addPage(); doc.y = doc.page.margins.top; }
        const ry2 = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor('#555555')
           .text(item.desc, descColX + 14, ry2 + 2, { width: descColW - 14, lineBreak: false });
        doc.font('Helvetica').fontSize(8.5).fillColor('#555555')
           .text(fmt(item.amt), amtColX, ry2 + 2, { width: amtColW - 4, align: 'right', lineBreak: false });
        doc.y = ry2 + 12;
      });
      doc.y += 8;
    });
  }

  // -----------------------------------------------------------------------
  // PAGE 2
  // -----------------------------------------------------------------------
  doc.addPage();

  // Page 2 mini header
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(COMPANY.name, L, doc.y);
  doc.font('Helvetica').fontSize(8).fillColor(GRAY)
     .text(COMPANY.tagline + '   ' + COMPANY.phone, L, doc.y);
  doc.moveTo(L, doc.y + 3).lineTo(R, doc.y + 3).strokeColor(NAVY).lineWidth(0.8).stroke();
  doc.y += 12;

  // EXCLUSIONS
  sectionHeader('EXCLUSIONS');

  // Site Specific
  const siteRows = siteExclusions.length > 0
    ? siteExclusions.map(x => x.text || '')
    : ['None noted.'];
  drawTable(siteRows, 'Site Specific Exclusions');
  doc.moveDown(0.5);

  // Standard
  const stdRows = standardExclusions.filter(x => x.active !== 0).map(x => x.text || '');
  if (stdRows.length > 0) {
    drawTable(stdRows, 'Standard Exclusions');
  }

  // TERMS + CONDITIONS
  sectionHeader('TERMS + CONDITIONS');
  const termsText = (e.proposal_terms || '').trim();
  if (termsText) {
    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a').text(termsText, L, doc.y, { width: W, lineGap: 2 });
  } else {
    for (const term of DEFAULT_TERMS) {
      const ty = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
         .text(' - ' + term, L + 8, ty, { width: W - 8, lineGap: 1 });
      doc.moveDown(0.2);
    }
  }

  // OPEN RFIs
  doc.moveDown(0.5);
  const rfiY = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(ORANGE).text('OPEN RFIs (may affect final price)', L, rfiY);
  doc.moveTo(L, doc.y + 1).lineTo(R, doc.y + 1).strokeColor(ORANGE).lineWidth(0.8).stroke();
  doc.y += 8;
  doc.font('Helvetica').fontSize(9).fillColor(GRAY)
     .text('No open RFIs at time of proposal.', L, doc.y);
  doc.moveDown(0.8);

  // SIGNATURE BLOCK — needs ~90pt; add page if tight
  const SIG_HEIGHT = 90;
  const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;
  if (doc.y + SIG_HEIGHT > PAGE_BOTTOM) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(COMPANY.name, L, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text(COMPANY.tagline + '   ' + COMPANY.phone, L, doc.y);
    doc.moveTo(L, doc.y + 3).lineTo(R, doc.y + 3).strokeColor(NAVY).lineWidth(0.8).stroke();
    doc.y += 18;
  }

  const sigCol1 = L;
  const sigCol2 = 320;
  const submittedBy = (e.proposal_submitted_by || e.prepared_by || '').trim();

  // "Submitted by:  [Name]"
  const sbY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
     .text('Submitted by:', sigCol1, sbY, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('  ' + (submittedBy || ''), sigCol1 + 80, sbY, { lineBreak: false });

  // Accepted by / Date row
  const accY = sbY + 44;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Accepted by:', sigCol1, accY, { lineBreak: false });
  doc.moveTo(sigCol1 + 82, accY + 12).lineTo(sigCol1 + 260, accY + 12)
     .strokeColor('#333').lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Date:', sigCol2, accY, { lineBreak: false });
  doc.moveTo(sigCol2 + 38, accY + 12).lineTo(sigCol2 + 150, accY + 12)
     .strokeColor('#333').lineWidth(0.5).stroke();

  // Name/Title row
  const ntY = accY + 22;
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
     .text('Name/Title:', sigCol1, ntY, { lineBreak: false });
  doc.moveTo(sigCol1 + 70, ntY + 12).lineTo(sigCol1 + 260, ntY + 12)
     .strokeColor('#333').lineWidth(0.5).stroke();


  // -----------------------------------------------------------------------
  // PROJECT SCOPE PAGES (auto-generated from takeoff data)
  // -----------------------------------------------------------------------
  const hasShapes = (shapes || []).some(r => r.section_name);
  const hasPlates = (plates || []).some(r => r.thickness && +r.qty > 0);
  const hasMisc   = (misc   || []).some(r => r.description);

  if (hasShapes || hasPlates || hasMisc) {
    // Save scope text for insertion after page header
    const scopeText = (e.proposal_scope || e.scope || '').trim();
    let scopePageHeaderCalled = false;

    const SECTION_LABELS = {
      W: 'W Beams & Columns', WT: 'WT Shapes', HSS: 'HSS Tube',
      C: 'C Channels', MC: 'MC Channels', L: 'L Angles',
      S: 'S Beams', PIPE: 'Pipes'
    };
    const SECTION_ORDER = ['W','WT','HSS','C','MC','L','S','PIPE'];

    const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;

    function scopePageHeader() {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(COMPANY.name, L, doc.y);
      doc.font('Helvetica').fontSize(8).fillColor(GRAY)
         .text(COMPANY.tagline + '   ' + COMPANY.phone, L, doc.y);
      doc.moveTo(L, doc.y + 3).lineTo(R, doc.y + 3).strokeColor(NAVY).lineWidth(0.8).stroke();
      doc.y += 14;
      doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('PROJECT SCOPE', L, doc.y);
      doc.moveDown(0.8);
    }

    function ensureRoom(needed) {
      if (doc.y + needed > PAGE_BOTTOM) scopePageHeader();
    }

    function drawScopeRow(cols, widths, opts) {
      opts = opts || {};
      const rowH = 15;
      const ry = doc.y;
      if (opts.bg) doc.rect(L, ry, W, rowH).fill(opts.bg);
      let x = L;
      cols.forEach((text, i) => {
        const align = opts.alignRight && i === cols.length - 1 ? 'right' : 'left';
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(opts.hdr ? 8.5 : 8)
           .fillColor(opts.bg === NAVY ? WHITE : '#1a1a1a')
           .text(String(text || ''), x + 3, ry + 4, { width: widths[i] - 6, align, lineBreak: false });
        x += widths[i];
      });
      doc.moveTo(L, ry + rowH).lineTo(R, ry + rowH).strokeColor('#ccc').lineWidth(0.3).stroke();
      doc.y = ry + rowH;
    }

    function sectionBanner(label) {
      ensureRoom(30);
      const by = doc.y;
      doc.rect(L, by, W, 16).fill('#e8ecf2');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
         .text(label, L + 5, by + 4, { lineBreak: false });
      doc.y = by + 16;
    }

    // ---- SHAPES ----
    if (hasShapes) {
      scopePageHeader();
      scopePageHeaderCalled = true;

      const SW = [180, 120, 262]; // widths: section, type, description
      drawScopeRow(['Section','Type','Description'], SW,
        { bg: NAVY, bold: true, hdr: true, alignRight: false });

      for (const sec of SECTION_ORDER) {
        const secShapes = (shapes || []).filter(r =>
          r.section_name && (r.section_type === sec ||
          (!r.section_type && r.section_name.toUpperCase().startsWith(sec)))
        );
        if (!secShapes.length) continue;
        sectionBanner(SECTION_LABELS[sec] || sec);
        for (const r of secShapes) {
          ensureRoom(15);
          drawScopeRow([
            r.section_name || '',
            SECTION_LABELS[sec] || sec,
            r.section_name || ''
          ], SW, { alignRight: false });
        }
      }
    }

    // ---- PLATES ----
    if (hasPlates) {
      const platesToShow = (plates || []).filter(r => r.thickness && +r.qty > 0);
      if (platesToShow.length) {
        if (!scopePageHeaderCalled) {
          scopePageHeader();
          scopePageHeaderCalled = true;
        }
        const PW = [180, 120, 262];
        drawScopeRow(['Section','Type','Description'], PW,
          { bg: NAVY, bold: true, hdr: true });
        sectionBanner('Plates');
        for (const r of platesToShow) {
          ensureRoom(15);
          const w = +r.width_in || 0, l = +r.length_in || 0;
          drawScopeRow([
            'PLATE',
            'PLATE',
            (r.thickness ? r.thickness + '"' : '') + (w && l ? ' ' + w + ' × ' + l : '')
          ], PW);
        }
      }
    }

    // ---- MISC METALS ----
    if (hasMisc) {
      const miscToShow = (misc || []).filter(r => r.description);
      if (miscToShow.length) {
        if (!scopePageHeaderCalled) {
          scopePageHeader();
          scopePageHeaderCalled = true;
        }
        const MW = [180, 120, 262];
        drawScopeRow(['Section','Type','Description'], MW,
          { bg: NAVY, bold: true, hdr: true });
        sectionBanner('Misc Metals');
        for (const r of miscToShow) {
          ensureRoom(15);
          drawScopeRow([
            'MISC',
            'MISC',
            r.description || ''
          ], MW);
        }
      }
    }
  }

  doc.end();
}

function generateProposal(res, bundle) {
  const { estimate: e } = bundle;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: 'Proposal ' + (e.bid_number || e.id),
    Author: COMPANY.name,
    Subject: e.project_name || 'R&R Bid Proposal'
  }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + (e.project_name || e.bid_number || e.id).replace(/[^a-zA-Z0-9_\-. ]/g, '').trim() + '.pdf"');
  doc.pipe(res);
  writeProposalToDoc(doc, bundle);
}

function generateProposalBuffer(bundle) {
  return new Promise((resolve, reject) => {
    try {
      const { estimate: e } = bundle;
      const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
        Title: 'Proposal ' + (e.bid_number || e.id),
        Author: COMPANY.name,
        Subject: e.project_name || 'R&R Bid Proposal'
      }});
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      writeProposalToDoc(doc, bundle);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateProposal, generateProposalBuffer };
