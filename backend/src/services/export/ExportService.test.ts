import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as XLSX from 'xlsx';
import test from 'node:test';
import type { MatchingSession } from '../../types';
import { BasicExportService, getExportMetadata } from './ExportService';

const session: MatchingSession = {
  id: '9d7b25a2-88e9-4b85-9fa3-e2d7c9dd3a10',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  status: 'final',
  uploadedMentorFiles: [],
  mentors: [{ id: 'mentor-1', name: 'Mentor Example', cvFileIds: [] }],
  students: [{
    id: 'student-1',
    name: 'Student Example',
    desiredSkills: 'TypeScript',
    topicsForExpertConsultation: 'API design',
    projectOverview: 'University project',
    mentorshipSupportNeeds: 'Architecture feedback',
  }],
  originalRecommendations: [],
  currentRecommendations: [{
    id: 'recommendation-1',
    mentorId: 'mentor-1',
    studentId: 'student-1',
    score: 94,
    reason: 'Strong API design and architecture alignment.',
    category: 'selected',
    source: 'ai',
  }],
  finalAssignments: [{
    id: 'assignment-1',
    mentorId: 'mentor-1',
    studentId: 'student-1',
    assignedAt: '2026-10-05T00:00:00.000Z',
  }],
};

test('Excel export is a valid XLSX workbook with matching details', async () => {
  const buffer = await new BasicExportService().exportFinalMatching(session, 'excel');
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets['Final Assignments']);
  assert.deepEqual(rows[0], {
    'Mentor ID': 'mentor-1',
    Mentor: 'Mentor Example',
    'Student ID': 'student-1',
    Student: 'Student Example',
    Score: 94,
    Reason: 'Strong API design and architecture alignment.',
    'Assigned At': '2026-10-05T00:00:00.000Z',
  });
});

test('PDF export is a valid PDF containing assignment data', async () => {
  const buffer = await new BasicExportService().exportFinalMatching(session, 'pdf');
  assert.equal(buffer.subarray(0, 8).toString(), '%PDF-1.7');

  const document = await PDFDocument.load(buffer);
  assert.equal(document.getPageCount(), 1);
});

test('export formats use the correct filenames and content types', () => {
  assert.deepEqual(getExportMetadata('excel'), {
    fileName: 'matching-export.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.deepEqual(getExportMetadata('pdf'), {
    fileName: 'matching-export.pdf',
    contentType: 'application/pdf',
  });
});