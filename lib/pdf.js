'use strict';
const PDFDocument = require('pdfkit');

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
  const v = Math.round(+n || 0);
  return '$' + v.toLocaleString('en-US');
}

function markupFactor(e) {
  return (1 + (+e.oh_rate || 0))
       * (1 + (+e.contingency_rate || 0))
       * (1 + (+e.profit_rate || 0))
       * (1 + (+e.cgl_rate || 0));
}

function writeProposalToDoc(doc, bundle) {
  const { estimate: e, computed: c, extras = [], standardExclusions = [], siteExclusions = [] } = bundle;
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
  const proposalDate = e.submitted_at
    ? new Date(e.submitted_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' })
    : (e.bid_date || '');
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(proposalDate, col2V, metaY + rowH * 2, { lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('BID #:', L, metaY + rowH * 3, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(e.bid_number || '', valX, metaY + rowH * 3, { lineBreak: false });

  doc.y = metaY + rowH * 3 + 22;

  // SCOPE OF WORK
  sectionHeader('SCOPE OF WORK');
  const scopeText = (e.proposal_scope || e.scope || '').trim();
  if (scopeText) {
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(scopeText, L, doc.y, { width: W, lineGap: 2, paragraphGap: 4 });
    doc.moveDown(0.5);
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text('Provide all labor, materials, equipment, and supervision necessary to purchase materials, process, and fabricate structural steel in accordance with the supplied drawings and specifications.', L, doc.y, { width: W, lineGap: 2 });
    doc.moveDown(0.5);
  }
  doc.moveDown(0.8);

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

  const coreItems = [
    { desc: lineDesc(1), amt: c.materialPrice * mf },
    { desc: lineDesc(2), amt: (c.fabHours + c.paint + c.consumables + c.handling) * mf },
    { desc: lineDesc(3), amt: ((+e.struct_detailing || 0) + (+e.misc_detailing || 0) + (+e.pe_stamp || 0)) * mf },
    { desc: lineDesc(4), amt: (+e.freight || 0) * mf },
    { desc: lineDesc(5), amt: (c.erectionLabor + (+e.erection_equip || 0)) * mf },
    { desc: lineDesc(6), amt: c.galv * mf },
    { desc: lineDesc(7), amt: c.processingLabor * mf }
  ];
  if ((+e.sub_joist_deck || 0) > 0) coreItems.push({ desc: 'Joist and Deck - by Subcontractor', amt: (+e.sub_joist_deck || 0) * mf });
  if ((+e.sub_erection  || 0) > 0) coreItems.push({ desc: 'Erection - by Subcontractor',         amt: (+e.sub_erection  || 0) * mf });
  extras.forEach(x => coreItems.push({ desc: x.description || 'Additional item', amt: (+x.qty || 0) * (+x.rate || 0) * mf }));

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
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text(fmt(c.totalBid), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 16;

  // Sales tax row
  ry = doc.y;
  const taxPct = ((+e.sales_tax_rate || 0) * 100).toFixed(0);
  const taxMode = e.tax_mode || 'total';
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text('Sales Tax (' + taxPct + '%)', descColX + 4, ry, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(BLUE).text(taxPct + '%', descColX + 180, ry, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(fmt(c.tax ? c.tax.amount : 0), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 16;

  // Double rule before total
  doc.moveTo(tL, doc.y).lineTo(R, doc.y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
  doc.y += 2;
  doc.moveTo(tL, doc.y).lineTo(R, doc.y).strokeColor('#1a1a1a').lineWidth(0.5).stroke();
  doc.y += 5;

  // TOTAL row
  ry = doc.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text('TOTAL  -  FURNISH + INSTALL', descColX + 4, ry, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a').text(fmt(c.totalFurnishInstall), amtColX, ry, { width: amtColW - 4, align: 'right', lineBreak: false });
  doc.y = ry + 22;

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
  doc.moveDown(1.5);

  // SIGNATURE BLOCK
  const sigY = Math.min(doc.y + 10, 680);
  const sigCol1 = L;
  const sigCol2 = 310;

  const submittedBy = (e.proposal_submitted_by || e.prepared_by || '').trim();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Submitted by:  ' + (submittedBy ? submittedBy : ''), sigCol1, sigY);
  doc.moveDown(1.2);

  const sigLineY = doc.y;
  doc.moveTo(sigCol1, sigLineY).lineTo(sigCol1 + 240, sigLineY)
     .strokeColor('#333').lineWidth(0.5).stroke();
  doc.moveTo(sigCol2 + 10, sigLineY).lineTo(sigCol2 + 10 + 120, sigLineY)
     .strokeColor('#333').lineWidth(0.5).stroke();

  const labelY = sigLineY + 4;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Accepted by:', sigCol1, labelY, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Date:', sigCol2 + 10, labelY, { lineBreak: false });

  doc.y = labelY + 18;
  // Name/Title line
  doc.moveTo(sigCol1, doc.y).lineTo(sigCol1 + 240, doc.y)
     .strokeColor('#333').lineWidth(0.5).stroke();
  doc.y += 4;
  doc.font('Helvetica').fontSize(9).fillColor(GRAY)
     .text('Name/Title:', sigCol1, doc.y);

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
    'attachment; filename="Proposal_' + (e.bid_number || e.id) + '.pdf"');
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
