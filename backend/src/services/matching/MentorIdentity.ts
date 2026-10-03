import { createHash } from 'node:crypto';
import path from 'node:path';

export function normalizeMentorNameFromFileName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).trim().replace(/\s+/g, ' ');
}

export function createMentorIdFromFileName(fileName: string): string {
  const normalizedName = normalizeMentorNameFromFileName(fileName).toLocaleLowerCase('en-US');
  if (!normalizedName) {
    throw new Error('Mentor CV filename must contain a name.');
  }

  const suffix = createHash('sha256').update(normalizedName).digest('hex').slice(0, 16);
  return `mentor-${suffix}`;
}