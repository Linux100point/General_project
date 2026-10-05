import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { MatchingSession } from '../../types';

export type ExportFormat = 'excel' | 'pdf';

export type ExportMetadata = {
  fileName: string;
  contentType: string;
};

export interface ExportService {
  exportFinalMatching(session: MatchingSession, format: ExportFormat): Promise<Buffer>;
}

export function getExportMetadata(format: ExportFormat): ExportMetadata {
  return format === 'excel'
    ? {
      fileName: 'matching-export.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
    : {
      fileName: 'matching-export.pdf',
      contentType: 'application/pdf',
    };
}

function getAssignmentRows(session: MatchingSession) {
  return session.finalAssignments.map((assignment) => {
    const mentor = session.mentors.find((item) => item.id === assignment.mentorId);
    const student = session.students.find((item) => item.id === assignment.studentId);
    const recommendation = session.currentRecommendations
      .filter((item) => item.mentorId === assignment.mentorId && item.studentId === assignment.studentId)
      .sort((left, right) => right.score - left.score)[0];

    return {
      mentorId: assignment.mentorId,
      mentorName: mentor?.name ?? assignment.mentorId,
      studentId: assignment.studentId,
      studentName: student?.name ?? assignment.studentId,
      score: recommendation?.score ?? '',
      reason: recommendation?.reason ?? '',
      assignedAt: assignment.assignedAt ?? '',
    };
  });
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

export class BasicExportService implements ExportService {
  async exportFinalMatching(session: MatchingSession, format: ExportFormat): Promise<Buffer> {
    const rows = getAssignmentRows(session);
    if (format === 'excel') {
      const headers = ['Mentor ID', 'Mentor', 'Student ID', 'Student', 'Score', 'Reason', 'Assigned At'];
      const sheet = XLSX.utils.aoa_to_sheet([
        headers,
        ...rows.map((row) => [row.mentorId, row.mentorName, row.studentId, row.studentName, row.score, row.reason, row.assignedAt]),
      ]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, 'Final Assignments');
      return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    }

    const document = await PDFDocument.create();
    const regularFont = await document.embedFont(StandardFonts.Helvetica);
    const boldFont = await document.embedFont(StandardFonts.HelveticaBold);
    const margin = 48;
    const pageWidth = 612;
    const pageHeight = 792;
    const bodySize = 10;
    const lineHeight = 14;
    let page = document.addPage([pageWidth, pageHeight]);
    let cursorY = pageHeight - margin;

    const drawLine = (text: string, options: { bold?: boolean; size?: number; indent?: number } = {}) => {
      const size = options.size ?? bodySize;
      const font = options.bold ? boldFont : regularFont;
      const safeText = text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
      const availableWidth = pageWidth - (margin * 2) - (options.indent ?? 0);

      for (const line of wrapText(safeText, font, size, availableWidth)) {
        if (cursorY < margin) {
          page = document.addPage([pageWidth, pageHeight]);
          cursorY = pageHeight - margin;
        }
        page.drawText(line, { x: margin + (options.indent ?? 0), y: cursorY, size, font });
        cursorY -= options.size ? size + 6 : lineHeight;
      }
    };

    drawLine('Final Mentor Matching Assignments', { bold: true, size: 18 });
    drawLine(`Generated: ${new Date().toISOString()}`);
    drawLine('');

    if (!rows.length) {
      drawLine('No final assignments are available.');
    }

    rows.forEach((row, index) => {
      drawLine(`${index + 1}. ${row.mentorName} (${row.mentorId})`, { bold: true });
      drawLine(`Assigned student: ${row.studentName} (${row.studentId})`, { indent: 12 });
      drawLine(`Score: ${typeof row.score === 'number' ? `${row.score}%` : 'Not available'}`, { indent: 12 });
      if (row.reason) drawLine(`Reason: ${row.reason}`, { indent: 12 });
      drawLine(`Assigned at: ${row.assignedAt || 'Not available'}`, { indent: 12 });
      drawLine('');
    });

    return Buffer.from(await document.save());
  }
}
