import type { FinalMentorAssignment, MatchingSession, Recommendation, Student } from '../../types';

export function enforceFinalAssignmentConstraint(assignments: FinalMentorAssignment[]) {
  const seen = new Map<string, string>();

  for (const assignment of assignments) {
    if (seen.has(assignment.studentId)) {
      throw new Error(`Student ${assignment.studentId} cannot be assigned to more than one mentor as a final assignment.`);
    }
    seen.set(assignment.studentId, assignment.mentorId);
  }

  return assignments;
}

export function buildUnassignedStudents(session: MatchingSession): Student[] {
  const assignedStudentIds = new Set(session.finalAssignments.map((assignment) => assignment.studentId));

  return session.students.filter((student) => !assignedStudentIds.has(student.id));
}

export function findAlternativeAssignments(recommendations: Recommendation[], studentId: string) {
  return recommendations.filter((recommendation) => recommendation.studentId === studentId && recommendation.category === 'alternative');
}
