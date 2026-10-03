import * as XLSX from 'xlsx';
import type { Student } from '../../types';

const fieldMap: Record<string, string[]> = {
  name: ['fullName', 'Name', 'Student Name', 'Student', 'Full Name'],
  studentId: ['studentId', 'Student ID', 'StudentID', 'ID', 'Code'],
  email: ['email', 'SDU Email', 'Email', 'Student Email'],
  desiredSkills: ['desiredSkillsAndTechnologies', 'Desired Skills & Technologies', 'Desired Skills', 'Skills & Technologies'],
  topicsForExpertConsultation: ['topicsForExpertConsultation', 'Topics for Expert Consultation', 'Topics for Expert Consultation (if any)', 'Topics'],
  projectOverview: ['projectOverview', 'Project Overview', 'Project Description', 'Overview'],
  mentorshipSupportNeeds: ['mentorshipSupportNeeds', 'Mentorship Support Needs', 'Support Needs', 'Needs'],
};

function readCell(row: Record<string, unknown>, candidates: string[]) {
  for (const candidate of candidates) {
    const value = row[candidate];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

export function parseStudentsExcel(buffer: Buffer): Student[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error('Excel file is empty or missing a worksheet.');
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

  if (!rows.length) {
    throw new Error('No student rows were found in the Excel file.');
  }

  const seenStudentIds = new Set<string>();

  return rows.map((row, rowIndex) => {
    const studentId = readCell(row, fieldMap.studentId);
    if (!studentId) {
      throw new Error(`Student row ${rowIndex + 2} is missing student ID.`);
    }

    const normalizedStudentId = studentId.toLocaleLowerCase('en-US');
    if (seenStudentIds.has(normalizedStudentId)) {
      throw new Error(`Duplicate student ID "${studentId}" found in the Excel file.`);
    }
    seenStudentIds.add(normalizedStudentId);

    return {
      id: studentId,
      name: readCell(row, fieldMap.name) || `Student ${rowIndex + 1}`,
      studentId,
      email: readCell(row, fieldMap.email) || undefined,
      desiredSkills: readCell(row, fieldMap.desiredSkills),
      topicsForExpertConsultation: readCell(row, fieldMap.topicsForExpertConsultation),
      projectOverview: readCell(row, fieldMap.projectOverview),
      mentorshipSupportNeeds: readCell(row, fieldMap.mentorshipSupportNeeds),
      mentorId: null,
    };
  });
}
