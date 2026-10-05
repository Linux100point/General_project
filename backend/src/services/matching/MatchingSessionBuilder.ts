import { randomUUID } from 'node:crypto';
import type { AIRecommendationPayload, MatchRequestInput, MatchingSession, Recommendation } from '../../types';

export function buildMatchingSession(input: MatchRequestInput, recommendations: AIRecommendationPayload[]): MatchingSession {
  const normalized: Recommendation[] = recommendations.map((item, index) => ({
    id: `rec-${index + 1}`,
    mentorId: item.mentorId,
    studentId: item.studentId,
    score: item.score,
    reason: item.reason,
    category: item.category,
    source: 'ai',
    assignedToMentorId: item.assignedToMentorId,
  }));

  const date = new Date().toISOString();
  const assignmentByStudent = new Map<string, { mentorId: string; studentId: string; assignedAt: string }>();
  [...normalized]
    .filter((item) => item.category === 'selected')
    .sort((left, right) => right.score - left.score)
    .forEach((item) => {
      if (!assignmentByStudent.has(item.studentId)) {
        assignmentByStudent.set(item.studentId, {
          mentorId: item.mentorId,
          studentId: item.studentId,
          assignedAt: date,
        });
      }
    });

  return {
    id: randomUUID(),
    createdAt: date,
    updatedAt: date,
    status: 'draft',
    uploadedMentorFiles: [],
    uploadedStudentFile: undefined,
    students: input.students,
    mentors: input.mentors,
    originalRecommendations: normalized,
    currentRecommendations: normalized,
    finalAssignments: Array.from(assignmentByStudent.values()).map((assignment, index) => ({
      id: `assignment-${index + 1}`,
      ...assignment,
    })),
  };
}