'use strict';
const PDFDocument = require('pdfkit');

const COMPANY = {
  name: 'R&R FABRICATION',
  tagline: 'Steel Fabrication + Erection',
  address: 'Prince Frederick, MD',
  phone: '301-855-9111',
  email: 'office@rrfabrication.org'
};

function fmt(n) {
  const v = Math.round(+n || 0);
  return '$' + v.toLocaleString('en-US');
}

function markupFactor(e) {
  return (1 + (+e.oh_rate || 0)) * (1 + (+e.contingency_rate || 0)) * (1 + (+e.profit_rate || 0)) * (1 + (+e.cgl_rate || 0));
}

// Build the proposal PDF onto the given doc, then end it.
function writeProposalToDoc(doc, bundle) {
  const { estimate: e, computed: c } = bundle;

  // Header
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a1a').text(COMPANY.name, { align: 'left' });
  doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${COMPANY.tagline}  ${COMPANY.address}  ${COMPANY.phone}`);
  doc.moveDown(1.5);

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a1a').text('PROPOSAL', { characterSpacing: 2 });
  doc.moveDown(0.8);

  // Meta grid
  const metaY = doc.y;
  function metaRow(label, value, x, y) {
    doc.font('Helvetica').fontSize(9).fillColor('#777').text(label, x, y);
    doc.font('Helvetica').fontSize(11).fillColor('#1a1a1a').text(value || '', x + 60, y);
  }
  metaRow('TO:', e.proposal_to || e.client_gc || '', 50, metaY);
  metaRow('BID #:', e.bid_number || '', 320, metaY);
  metaRow('PROJECT:', e.project_name || '', 50, metaY + 18);
  metaRow('DATE:', e.bid_date || '', 320, metaY + 18);
  doc.y = metaY + 50;

  function sectionHeader(text) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#777').text(text.toUpperCase(), { characterSpacing: 1 });
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor('#ddd').lineWidth(1).stroke();
    doc.moveDown(0.5);
  }

  sectionHeader('Scope of Work');
  doc.font('Helvetica').fontSize(11).fillColor('#1a1a1a').text(e.proposal_scope || e.scope || '', { paragraphGap: 4, lineGap: 2 });

  sectionHeader('Pricing');
  const defaultLineDescs = [
    'Structural steel material - furnished',
    'Shop fabrication and finishes',
    'Detailing and PE-stamped shop drawings',
    'Freight to jobsite',
    'Field erection, equipment, rigging',
    'Finishes',
    'Processing labor'
  ];
  function lineDesc(n) {
    const override = (e[`proposal_line_${n}_desc`] || '').trim();
    return override || defaultLineDescs[n - 1];
  }
  const lineItems = [
    ['1', lineDesc(1), c.materialPrice * markupFactor(e)],
    ['2', lineDesc(2), (c.fabHours + c.paint + c.consumables + c.handling) * markupFactor(e)],
    ['3', lineDesc(3), (e.struct_detailing + e.misc_detailing + e.pe_stamp) * markupFactor(e)],
    ['4', lineDesc(4), e.freight * markupFactor(e)],
    ['5', lineDesc(5), (c.erectionLabor + e.erection_equip) * markupFactor(e)],
    ['6', lineDesc(6), c.galv * markupFactor(e)],
    ['7', lineDesc(7), c.processingLabor * markupFactor(e)]
  ];

  const colX = { num: 50, desc: 80, amt: 470 };
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#777');
  doc.text('#', colX.num, doc.y);
  doc.text('DESCRIPTION', colX.desc, doc.y - 12);
  doc.text('AMOUNT', colX.amt, doc.y - 12, { width: 92, align: 'right' });
  doc.moveTo(50, doc.y + 4).lineTo(562, doc.y + 4).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica').fontSize(11).fillColor('#1a1a1a');
  for (const [n, label, amount] of lineItems) {
    const y = doc.y;
    doc.text(n, colX.num, y);
    doc.text(label, colX.desc, y);
    doc.font('Helvetica').text(fmt(amount), colX.amt, y, { width: 92, align: 'right' });
    doc.moveTo(50, doc.y + 4).lineTo(562, doc.y + 4).strokeColor('#eee').lineWidth(0.3).stroke();
    doc.moveDown(0.5);
  }

  doc.moveDown(0.3);
  doc.moveTo(380, doc.y).lineTo(562, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('SUBTOTAL', colX.desc, doc.y);
  doc.text(fmt(c.totalBid), colX.amt, doc.y - 13, { width: 92, align: 'right' });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(11);
  doc.text(`Sales Tax (${((e.sales_tax_rate || 0) * 100).toFixed(1)}%)`, colX.desc, doc.y);
  doc.text(fmt(c.tax.amount), colX.amt, doc.y - 13, { width: 92, align: 'right' });
  doc.moveDown(0.3);
  doc.moveTo(380, doc.y).lineTo(562, doc.y).strokeColor('#1a1a1a').lineWidth(1).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('TOTAL  -  FURNISH + INSTALL', colX.desc, doc.y);
  doc.text(fmt(c.totalFurnishInstall), colX.amt, doc.y - 15, { width: 92, align: 'right' });

  if (e.proposal_exclusions) {
    sectionHeader('Exclusions');
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(e.proposal_exclusions, { paragraphGap: 2, lineGap: 1 });
  }

  if (e.proposal_terms) {
    sectionHeader('Terms + Conditions');
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(e.proposal_terms, { paragraphGap: 2, lineGap: 2 });
  }

  doc.moveDown(2);
  const sigY = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('Submitted by:', 50, sigY);
  doc.font('Helvetica').fontSize(11).text(e.proposal_submitted_by || e.prepared_by || '', 50, sigY + 30);
  doc.moveTo(50, sigY + 28).lineTo(280, sigY + 28).strokeColor('#333').lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(9).fillColor('#777').text('R&R Fabrication', 50, sigY + 46);

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text('Accepted by:', 320, sigY);
  doc.moveTo(320, sigY + 28).lineTo(562, sigY + 28).strokeColor('#333').lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(9).fillColor('#777').text('Name / Title / Date', 320, sigY + 46);

  doc.end();
}

// Streams a PDF proposal to res
function generateProposal(res, bundle) {
  const { estimate: e } = bundle;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: `Proposal ${e.bid_number || e.id}`,
    Author: COMPANY.name,
    Subject: e.project_name || 'R&R Bid Proposal'
  }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Proposal_${e.bid_number || e.id}.pdf"`);
  doc.pipe(res);
  writeProposalToDoc(doc, bundle);
}

// Builds the same PDF in-memory and resolves with a Buffer.
function generateProposalBuffer(bundle) {
  return new Promise((resolve, reject) => {
    try {
      const { estimate: e } = bundle;
      const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
        Title: `Proposal ${e.bid_number || e.id}`,
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
