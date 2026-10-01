/**
 * 🚀 SEDS Pakistan - Premium Mission Workflow PDF Export (PRO MAX)
 * Operational Directive Design System with:
 * - Scannable QR Traceability
 * - Strategic Command Briefing Section
 * - Vector-drawn Professional Icons
 * - Hierarchical Personnel & Resource Matrix
 */

import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';

export interface WorkflowPDFStep {
  title: string;
  description?: string;
  role?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeWhatsapp?: string;
  status?: string;
  individualDeadline?: string;
  sequenceIndex?: number;
  assigneeId?: string;
  assigneePhoto?: string;
  points?: number;
  penaltyPoints?: number;
  workflowBonusPoints?: number;
  guidance?: string;
  stepInstructions?: string;
  complexity?: 1 | 2 | 3 | 4 | 5; // New
  domain?: string; // New: Avionics, Propulsion, etc.
  resources?: Array<{ title: string; url: string; type: string }>; // New
}

export interface WorkflowPDFData {
  id: string;
  title: string;
  progressPercentage: number;
  totalSteps: number;
  completedSteps: number;
  isCompleted: boolean;
  chapterName?: string; 
  createdAt?: string;
  description?: string; // Strategic Intent
  commanderStatement?: string; // High-level directive
  participants?: string[];
  steps: WorkflowPDFStep[];
}

const THEME = {
  paperWhite: [252, 252, 250] as [number, number, number],
  cardHeader: [241, 245, 249] as [number, number, number], 
  deepCharcoal: [15, 23, 42] as [number, number, number],   
  burntOrange: [180, 60, 20] as [number, number, number],   
  pakistanGreen: [1, 65, 28] as [number, number, number],
  goldAccent: [184, 134, 11] as [number, number, number],   
  grayBorder: [215, 220, 225] as [number, number, number],  
  grayLight: [248, 250, 252] as [number, number, number],   
  textMuted: [71, 85, 105] as [number, number, number],     
  shadow: [232, 233, 238] as [number, number, number],
  linkBlue: [0, 80, 160] as [number, number, number]
};

const getStatusColor = (status?: string): [number, number, number] => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'approved') return THEME.pakistanGreen;
  if (s === 'overdue') return [190, 18, 60];
  if (s === 'in-progress') return [202, 138, 4];
  if (s === 'submitted-for-review') return [2, 132, 199];
  return [100, 116, 139];
};

const getStatusLabel = (status?: string): string => {
  const s = String(status || '').toLowerCase();
  if (s === 'submitted-for-review') return 'REVIEW';
  if (s === 'in-progress') return 'ACTIVE';
  return s.toUpperCase() || 'PENDING';
};

const drawPhoneIcon = (doc: jsPDF, x: number, y: number, color: [number, number, number]) => {
    doc.saveGraphicsState();
    doc.setDrawColor(...color);
    doc.setLineWidth(0.3);
    doc.line(x, y + 2, x + 1, y);
    doc.line(x + 1, y, x + 2.5, y + 1.5);
    doc.line(x + 2.5, y + 1.5, x + 1.5, y + 2.5);
    doc.restoreGraphicsState();
};

const drawMailIcon = (doc: jsPDF, x: number, y: number, color: [number, number, number]) => {
    doc.saveGraphicsState();
    doc.setDrawColor(...color);
    doc.setLineWidth(0.25);
    doc.rect(x, y, 3.5, 2.5, 'S');
    doc.line(x, y, x + 1.75, y + 1.5);
    doc.line(x + 1.75, y + 1.5, x + 3.5, y);
    doc.restoreGraphicsState();
};

const drawCircularAvatar = (doc: jsPDF, imgB64: string, x: number, y: number, size: number) => {
  if (!imgB64) return;
  try {
    doc.saveGraphicsState();
    const radius = size / 2;
    const centerX = x + radius;
    const centerY = y + radius;
    doc.circle(centerX, centerY, radius, 'S'); 
    doc.clip();
    doc.addImage(imgB64, 'JPEG', x, y, size, size);
    doc.restoreGraphicsState();
    doc.setDrawColor(...THEME.grayBorder);
    doc.setLineWidth(0.2);
    doc.circle(centerX, centerY, radius, 'S');
  } catch (e) {
    try { doc.restoreGraphicsState(); } catch {}
  }
};

export async function exportWorkflowAsPDF(workflow: WorkflowPDFData, logoB64?: string) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    putOnlyUsedFonts: true
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://v0-seds-pakistan.vercel.app';
  const workflowUrl = `${baseUrl}/admin/workflows?workflowId=${workflow.id}`;

  const drawBackground = () => {
    doc.setFillColor(...THEME.paperWhite);
    doc.rect(0, 0, pageWidth, pageHeight, 'F');
  };

  // ── COVER PAGE ─────────────────────────────────────────────────────────────
  drawBackground();
  doc.setDrawColor(...THEME.deepCharcoal);
  doc.setLineWidth(0.2);
  doc.rect(8, 8, pageWidth - 16, pageHeight - 16); 
  doc.setLineWidth(1.5);
  doc.rect(12, 12, pageWidth - 24, pageHeight - 24); 

  let curY = 55;
  if (logoB64) {
    try {
      const imgProps = doc.getImageProperties(logoB64);
      const targetW = 90;
      doc.addImage(logoB64, 'PNG', (pageWidth - targetW) / 2, curY, targetW, targetW / (imgProps.width / imgProps.height));
      curY += (targetW / (imgProps.width / imgProps.height)) + 15;
    } catch (e) { curY += 25; }
  } else {
    doc.setTextColor(...THEME.deepCharcoal);
    doc.setFontSize(42); doc.setFont('helvetica', 'bold');
    doc.text('SEDS PAKISTAN', pageWidth / 2, curY, { align: 'center' });
    curY += 18;
  }

  doc.setTextColor(...THEME.burntOrange);
  doc.setFontSize(15); doc.setFont('times', 'italic');
  doc.text('A Flagship Space Exploration Initiative', pageWidth / 2, curY, { align: 'center' });
  curY += 12;

  if (workflow.chapterName) {
    doc.setTextColor(...THEME.pakistanGreen);
    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text(workflow.chapterName.toUpperCase(), pageWidth / 2, curY, { align: 'center' });
    curY += 18;
  } else { curY += 15; }

  doc.setTextColor(...THEME.deepCharcoal);
  doc.setFontSize(30); doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(workflow.title.toUpperCase(), 160);
  doc.text(titleLines, pageWidth / 2, curY, { align: 'center' });
  curY += (titleLines.length * 11) + 25;

  const statW = (pageWidth - 40) / 4;
  let statX = 20;
  const drawStat = (label: string, value: string, color: [number, number, number]) => {
    doc.setFillColor(...color);
    doc.rect(statX, curY, statW - 3, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    let valFontSize = 13;
    const maxW = statW - 9;
    doc.setFontSize(valFontSize);
    let displayValue = value;
    if (label.toLowerCase().includes('id') && value.length > 20) displayValue = value.substring(0, 15) + '...';
    while (doc.getTextWidth(displayValue) > maxW && valFontSize > 6) { valFontSize -= 0.5; doc.setFontSize(valFontSize); }
    doc.text(displayValue, statX + (statW - 3) / 2, curY + 11, { align: 'center' });
    doc.setFontSize(7);
    doc.text(label.toUpperCase(), statX + (statW - 3) / 2, curY + 21, { align: 'center' });
    statX += statW;
  };

  drawStat('Workflow ID', workflow.id.toUpperCase(), THEME.deepCharcoal);
  drawStat('Issue Date', new Date().toLocaleDateString(), THEME.deepCharcoal);
  drawStat('Steps', `${workflow.completedSteps} / ${workflow.totalSteps}`, THEME.deepCharcoal);
  drawStat('Progress', `${workflow.progressPercentage}%`, workflow.progressPercentage >= 100 ? THEME.pakistanGreen : [1, 45, 20]);

  // PRO MAX: Cover QR Integration
  try {
    const qrDataUrl = await QRCode.toDataURL(workflowUrl, { margin: 1, scale: 4 });
    const qrSize = 35;
    const qrX = (pageWidth - qrSize) / 2;
    const qrY = pageHeight - qrSize - 45;
    doc.addImage(qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);
    doc.setTextColor(...THEME.textMuted);
    doc.setFontSize(8);
    doc.text('SCAN TO VIEW LIVE MISSION STATUS', pageWidth / 2, qrY + qrSize + 4, { align: 'center' });
  } catch (e) {
    console.error('QR Generate failed:', e);
  }

  curY = pageHeight - 35;
  doc.setFillColor(...THEME.burntOrange);
  doc.rect(20, curY, pageWidth - 40, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9); doc.setFont('helvetica', 'bold');
  doc.text('MISSION CONTROL DIRECTIVE:', 25, curY + 8);
  doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
  const directiveText = "This document is a static briefing. Scannable QR codes link to real-time verification logs. Personnel must utilize their interactive Unified Member Profile on the SEDS Platform to finalize assigned mission objectives.";
  doc.text(doc.splitTextToSize(directiveText, pageWidth - 55), 25, curY + 13.5);

  // ── STRATEGIC BRIEFING PAGE ───────────────────────────────────────────────
  doc.addPage();
  drawBackground();
  
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(24); doc.setFont('helvetica', 'bold');
  doc.text('STRATEGIC COMMAND BRIEFING', 20, 25);
  doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1); doc.line(20, 28, pageWidth - 20, 28);
  
  let briefY = 45;
  
  // Mission Intent
  doc.setTextColor(...THEME.burntOrange); doc.setFontSize(10); doc.text('OPERATIONAL INTENT', 20, briefY);
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11.5); doc.setFont('helvetica', 'normal');
  const intentLines = doc.splitTextToSize(workflow.description || "The primary objective of this mission is to advance SEDS Pakistan's core objectives through coordinated technical execution and multi-disciplinary collaboration.", pageWidth - 40);
  doc.text(intentLines, 20, briefY + 8);
  briefY += (intentLines.length * 6) + 20;

  // Commander statement (Callout box)
  doc.setFillColor(248, 250, 255);
  doc.roundedRect(20, briefY, pageWidth - 40, 35, 2, 2, 'F');
  doc.setDrawColor(...THEME.linkBlue); doc.setLineWidth(1.5); doc.line(20, briefY, 20, briefY + 35);
  
  doc.setTextColor(...THEME.linkBlue); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('COMMANDER\'S DIRECTIVE', 26, briefY + 8);
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11); doc.setFont('times', 'italic');
  const statement = workflow.commanderStatement || "Precision in execution is the only pathway to success. Every assigned task is a critical component of the national initiative. Move fast, document evidence, and maintain 100% accountability.";
  doc.text(doc.splitTextToSize(statement, pageWidth - 60), 26, briefY + 16);
  briefY += 50;

  // Resource & Asset Matrix
  doc.setTextColor(...THEME.burntOrange); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('MISSION ASSET INVENTORY', 20, briefY);
  
  const matrixY = briefY + 5;
  const colW = (pageWidth - 40) / 3;
  
  const drawMatrixBox = (x: number, title: string, subtitle: string) => {
    doc.setFillColor(...THEME.cardHeader);
    doc.roundedRect(x, matrixY, colW - 4, 25, 2, 2, 'F');
    doc.setDrawColor(...THEME.grayBorder); doc.setLineWidth(0.1); doc.roundedRect(x, matrixY, colW - 4, 25, 2, 2, 'S');
    doc.setTextColor(...THEME.pakistanGreen); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    doc.text(title, x + (colW - 4) / 2, matrixY + 10, { align: 'center' });
    doc.setTextColor(...THEME.textMuted); doc.setFontSize(7); doc.setFont('helvetica', 'normal');
    doc.text(subtitle, x + (colW - 4) / 2, matrixY + 17, { align: 'center' });
  };

  drawMatrixBox(20, 'REPOSITORY', 'Code & Technical CAD');
  drawMatrixBox(20 + colW, 'DOCUMENTATION', 'Project Whitepapers');
  drawMatrixBox(20 + colW * 2, 'BRIEFINGS', 'Mission Recordings');

  const margins = { top: 25, right: 20, bottom: 25, left: 20 };
  const contentWidth = pageWidth - margins.left - margins.right;

  // ── WORKFLOW STEPS ──────────────────────────────────────────────────────────
  curY = pageHeight; 
  
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const safeDesc = step.description || '';
    const safeGuidance = step.guidance || '';
    const safeInstructions = step.stepInstructions || '';

    const badgeWidth = 35;
    const titleAvailableWidth = contentWidth - 40 - badgeWidth; 
    
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15.5);
    const splitTitle = doc.splitTextToSize(step.title, titleAvailableWidth);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11.5);
    const splitDesc = safeDesc ? doc.splitTextToSize(safeDesc, contentWidth - 25) : [];
    doc.setFontSize(10.5);
    const splitGuidance = safeGuidance ? doc.splitTextToSize(safeGuidance, contentWidth - 45) : [];
    const splitInstructions = safeInstructions ? doc.splitTextToSize(safeInstructions, contentWidth - 50) : [];
    
    // Prediction including asset links
    let stepHeight = 35 + (splitTitle.length * 7); 
    if (step.points || step.penaltyPoints || step.workflowBonusPoints) stepHeight += 12;
    stepHeight += (splitDesc.length * 5.2) + 8;
    if (splitGuidance.length > 0) stepHeight += (splitGuidance.length * 5.2) + 12;
    if (splitInstructions.length > 0) stepHeight += (splitInstructions.length * 5.2) + 12;
    
    const hasAssets = (step.resources && step.resources.length > 0);
    stepHeight += 55; // Core personnel footer
    if (hasAssets) stepHeight += 15;

    if (curY + stepHeight > pageHeight - margins.bottom - 10) {
      doc.addPage(); drawBackground();
      doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(22); doc.setFont('helvetica', 'bold');
      doc.text('MISSION EXECUTION PLAN', margins.left, margins.top);
      const lineY = margins.top + 8;
      doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1.2); doc.line(margins.left, lineY, pageWidth - margins.right, lineY);
      doc.setLineWidth(4); doc.line(margins.left, lineY, margins.left + 55, lineY);
      curY = margins.top + 22;
    }

    const x = margins.left;
    const sColor = getStatusColor(step.status);
    const startY = curY;

    doc.setFillColor(...THEME.shadow);
    doc.roundedRect(x + 0.8, startY + 0.8, contentWidth, stepHeight - 12, 3, 3, 'F');
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, startY, contentWidth, stepHeight - 12, 3, 3, 'F');

    const headerH = 15 + (splitTitle.length * 6.5);
    doc.setFillColor(...THEME.cardHeader);
    doc.roundedRect(x, startY, contentWidth, headerH, 3, 3, 'F');
    doc.rect(x, startY + headerH - 3, contentWidth, 3, 'F');

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(28); doc.setFont('helvetica', 'bold');
    doc.text(String((step.sequenceIndex ?? i) + 1).padStart(2, '0'), x + 8, startY + 18);
    
    // Domain Badge
    if (step.domain) {
        doc.setFillColor(...THEME.pakistanGreen);
        doc.roundedRect(x + 7, startY + 22, 18, 4, 1, 1, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(5); doc.text(step.domain.toUpperCase(), x + 16, startY + 24.8, { align: 'center' });
    }

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text(splitTitle, x + 25, startY + 14);
    
    doc.setFillColor(...sColor);
    doc.roundedRect(x + contentWidth - 30, startY + 4, 25, 7.5, 3.75, 3.75, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(7.5);
    doc.text(getStatusLabel(step.status), x + contentWidth - 17.5, startY + 9, { align: 'center' });

    let innerY = startY + headerH + 8;

    // Badges & Complexity (Only show if they exist/are meaningful)
    if ((step.points && step.points > 0) || step.complexity) {
      let badgeX = x + 25;
      if (step.points && step.points > 0) {
        doc.setFillColor(...THEME.pakistanGreen); doc.roundedRect(badgeX, innerY - 4.5, 30, 6.5, 3, 3, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(7); doc.text(`AWARD: ${step.points} PTS`, badgeX + 15, innerY - 0.2, { align: 'center' });
        badgeX += 33;
      }
      if (step.complexity) {
        doc.setTextColor(...THEME.burntOrange); doc.setFontSize(7); doc.setFont('helvetica', 'bold');
        doc.text('COMPLEXITY: ' + '★'.repeat(step.complexity), badgeX, innerY);
      }
      innerY += 12;
    }

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    if (splitDesc.length > 0) { doc.text(splitDesc, x + 10, innerY); innerY += (splitDesc.length * 5.2) + 8; }

    if (splitGuidance.length > 0) {
      const gH = (splitGuidance.length * 5.2) + 6;
      doc.setFillColor(236, 252, 230); doc.rect(x + 10, innerY - 4, contentWidth - 20, gH, 'F');
      doc.setFillColor(...THEME.pakistanGreen); doc.rect(x + 10, innerY - 4, 1.5, gH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...THEME.pakistanGreen);
      doc.text('Guidance:', x + 15, innerY); doc.setFont('helvetica', 'normal'); doc.setTextColor(...THEME.deepCharcoal);
      doc.text(splitGuidance, x + 35, innerY); innerY += gH + 6;
    }

    // Asset Links Row (PRO MAX)
    if (hasAssets) {
        doc.setTextColor(...THEME.burntOrange); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
        doc.text('MISSION ASSETS:', x + 10, innerY);
        let assetX = x + 40;
        step.resources?.forEach(r => {
            doc.setTextColor(...THEME.linkBlue); doc.setFontSize(8.5); doc.text(`[${r.title.toUpperCase()}]`, assetX, innerY);
            doc.link(assetX, innerY - 3, doc.getTextWidth(`[${r.title.toUpperCase()}]`), 5, { url: r.url });
            assetX += doc.getTextWidth(`[${r.title.toUpperCase()}]`) + 5;
        });
        innerY += 10;
    }

    innerY += 4;
    doc.setDrawColor(...THEME.grayBorder); doc.setLineWidth(0.2); doc.line(x + 10, innerY, x + contentWidth - 10, innerY);
    innerY += 12;

    // Personnel Logic
    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(8.2); doc.setFont('helvetica', 'bold');
    doc.text('PERSONNEL ASSIGNED', x + 10, innerY);
    doc.text('MISSION DEADLINE', x + contentWidth - 10, innerY, { align: 'right' });

    const avatarSize = 14;
    const nameX = x + (step.assigneePhoto ? 28 : 10);
    const nameStr = (step.assigneeName && !step.assigneeName.includes('@')) ? step.assigneeName : 'Pending Assignment';

    doc.setFontSize(11.5); doc.setTextColor(...THEME.deepCharcoal);
    doc.text(nameStr, nameX, innerY + 9);
    
    const roleStr = step.role || (nameStr !== 'Pending Assignment' ? 'GENERAL MEMBER' : '');
    if (roleStr) {
      doc.setTextColor(...THEME.pakistanGreen); doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      doc.text(roleStr.toUpperCase(), nameX, innerY + 14);
    }

    if (step.assigneeWhatsapp || step.assigneeEmail) {
      let contactX = nameX;
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      if (step.assigneeWhatsapp) {
        drawPhoneIcon(doc, contactX, innerY + 18, THEME.pakistanGreen);
        doc.setTextColor(...THEME.pakistanGreen);
        const wa = step.assigneeWhatsapp.startsWith('+') ? step.assigneeWhatsapp : `+${step.assigneeWhatsapp}`;
        doc.text(wa, contactX + 4.5, innerY + 20.5);
        doc.link(contactX, innerY + 17, 30, 5, { url: `https://wa.me/${wa.replace(/\+/g, '')}` });
        contactX += doc.getTextWidth(wa) + 12;
      }
      if (step.assigneeEmail) {
        drawMailIcon(doc, contactX, innerY + 18, THEME.linkBlue);
        doc.setTextColor(...THEME.linkBlue);
        doc.text(step.assigneeEmail, contactX + 5, innerY + 20.5);
        doc.link(contactX, innerY + 17, 45, 5, { url: `mailto:${step.assigneeEmail}` });
      }
    }
    
    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11.5); doc.setFont('helvetica', 'bold');
    const dlStr = step.individualDeadline ? `T-MINUS: ${new Date(step.individualDeadline).toLocaleDateString()}` : 'TBD';
    doc.text(dlStr, x + contentWidth - 10, innerY + 9, { align: 'right' });

    if (step.assigneePhoto) drawCircularAvatar(doc, step.assigneePhoto, x + 10, innerY + 4, avatarSize);

    curY = startY + stepHeight + 15;
  }

  // Footer Global
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(...THEME.pakistanGreen); doc.rect(0, pageHeight - 10, pageWidth / 2, 10, 'F');
    doc.setFillColor(...THEME.deepCharcoal); doc.rect(pageWidth / 2, pageHeight - 10, pageWidth / 2, 10, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    const footerText = workflow.chapterName ? `SEDS PAKISTAN • MISSION: ${workflow.chapterName.toUpperCase()}` : 'SEDS PAKISTAN • NATIONAL INITIATIVE';
    doc.text(footerText, 10, pageHeight - 4);
    doc.setTextColor(...THEME.goldAccent); doc.text(`PAGE ${String(p).padStart(2, '0')} // ${String(totalPages).padStart(2, '0')}`, pageWidth - 10, pageHeight - 4, { align: 'right' });
  }

  doc.save(`SEDS_Directive_${workflow.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.pdf`);
}
