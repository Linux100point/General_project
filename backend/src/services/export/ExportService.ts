import type { MatchingSession } from '../../types';

export interface ExportService {
  exportFinalMatching(session: MatchingSession, format: 'excel' | 'pdf'): Promise<Buffer>;
}

export class BasicExportService implements ExportService {
  async exportFinalMatching(session: MatchingSession, format: 'excel' | 'pdf'): Promise<Buffer> {
    const rows = session.finalAssignments.map((assignment) => ({
      mentorId: assignment.mentorId,
      studentId: assignment.studentId,
      assignedAt: assignment.assignedAt,
    }));

    const content = format === 'excel'
      ? ['mentorId,studentId,assignedAt', ...rows.map((row) => `${row.mentorId},${row.studentId},${row.assignedAt}`)].join('\n')
      : `Final matching export\n${JSON.stringify(rows, null, 2)}`;

    return Buffer.from(content, 'utf-8');
  }
}
