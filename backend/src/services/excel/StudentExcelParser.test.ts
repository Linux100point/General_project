import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseStudentsExcel } from './StudentExcelParser';

function makeWorkbookBuffer(rows: Array<Record<string, string | number>>): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Students');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('uses spreadsheet studentId as the stable student identifier', () => {
  const students = parseStudentsExcel(makeWorkbookBuffer([
    { 'Student ID': 'SDU-1002', 'Full Name': 'Student B' },
    { 'Student ID': 'SDU-1001', 'Full Name': 'Student A' },
  ]));

  assert.deepEqual(students.map((student) => student.id), ['SDU-1002', 'SDU-1001']);
  assert.deepEqual(students.map((student) => student.studentId), ['SDU-1002', 'SDU-1001']);
});

test('reads the documented camelCase student columns', () => {
  const [student] = parseStudentsExcel(makeWorkbookBuffer([{
    studentId: 'SDU-2001',
    fullName: 'Student Camel',
    email: 'camel@example.edu',
    desiredSkillsAndTechnologies: 'TypeScript, React',
    topicsForExpertConsultation: 'API design',
    projectOverview: 'Build a learning platform',
    mentorshipSupportNeeds: 'Architecture review',
  }]));

  assert.deepEqual(student, {
    id: 'SDU-2001',
    name: 'Student Camel',
    studentId: 'SDU-2001',
    email: 'camel@example.edu',
    desiredSkills: 'TypeScript, React',
    topicsForExpertConsultation: 'API design',
    projectOverview: 'Build a learning platform',
    mentorshipSupportNeeds: 'Architecture review',
    mentorId: null,
  });
});

test('rejects student rows without studentId', () => {
  assert.throws(
    () => parseStudentsExcel(makeWorkbookBuffer([{ 'Full Name': 'Student A' }])),
    /missing student ID/i,
  );
});

test('rejects duplicate studentId values', () => {
  assert.throws(
    () => parseStudentsExcel(makeWorkbookBuffer([
      { 'Student ID': 'SDU-1001', 'Full Name': 'Student A' },
      { 'Student ID': 'sdu-1001', 'Full Name': 'Student B' },
    ])),
    /duplicate student ID/i,
  );
});