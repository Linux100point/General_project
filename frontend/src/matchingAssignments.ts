export type MatchingAssignment = {
  mentorId: string;
  studentId: string;
  id?: string;
  assignedAt?: string;
};

export type AssignmentStudent = {
  id: string;
  studentId?: string;
  name?: string;
};

function findStudentByReference(students: AssignmentStudent[], studentReference: string) {
  return students.find((student) => student.id === studentReference)
    ?? students.find((student) => student.studentId === studentReference);
}

export function getCanonicalStudentId(students: AssignmentStudent[], studentReference: string): string | undefined {
  return findStudentByReference(students, studentReference)?.id;
}

export function getUnassignedStudents<T extends AssignmentStudent>(
  students: T[],
  assignments: MatchingAssignment[],
  mentorIds: string[],
): T[] {
  const assignedStudentIds = new Set(
    getUniqueAssignments(assignments, students, mentorIds).map((assignment) => assignment.studentId),
  );
  return students.filter((student) => !assignedStudentIds.has(student.id));
}

export function getStudentDisplayName(students: AssignmentStudent[], studentId: string): string {
  const student = findStudentByReference(students, studentId);
  if (!student) return studentId;

  const name = student.name?.trim();
  if (!name || /^Student(?:\s+\d+)?$/i.test(name)) {
    return student.studentId || student.id;
  }
  return name;
}

export function getAlternativeStudentName(students: AssignmentStudent[], studentId: string): string | undefined {
  const student = findStudentByReference(students, studentId);
  const name = student?.name?.trim();
  if (!name || /^Student(?:\s+\d+)?$/i.test(name)) return undefined;
  return name;
}

export function getUniqueAssignments<T extends MatchingAssignment>(
  assignments: T[],
  students: AssignmentStudent[],
  mentorIds: string[],
): T[] {
  const assignedStudentIds = new Set<string>();
  const validMentorIds = new Set(mentorIds);

  return assignments.flatMap((assignment) => {
    const canonicalStudentId = getCanonicalStudentId(students, assignment.studentId);
    if (!canonicalStudentId || !validMentorIds.has(assignment.mentorId)) return [];

    if (assignedStudentIds.has(canonicalStudentId)) return [];
    assignedStudentIds.add(canonicalStudentId);
    return [{ ...assignment, studentId: canonicalStudentId }];
  });
}

export function assignStudentToMentor(
  assignments: MatchingAssignment[],
  studentId: string,
  mentorId: string,
): MatchingAssignment[] {
  const existingAssignment = assignments.find((assignment) => assignment.studentId === studentId);
  if (existingAssignment?.mentorId === mentorId
    && assignments.filter((assignment) => assignment.studentId === studentId).length === 1) {
    return assignments;
  }

  return [
    ...assignments.filter((assignment) => assignment.studentId !== studentId),
    { ...existingAssignment, mentorId, studentId },
  ];
}

export function removeStudentAssignment(
  assignments: MatchingAssignment[],
  studentId: string,
): MatchingAssignment[] {
  return assignments.filter((assignment) => assignment.studentId !== studentId);
}

export function reorderMentorAssignment(
  assignments: MatchingAssignment[],
  mentorId: string,
  studentId: string,
  direction: 'up' | 'down',
): MatchingAssignment[] {
  const mentorAssignments = assignments.filter((assignment) => assignment.mentorId === mentorId);
  const index = mentorAssignments.findIndex((assignment) => assignment.studentId === studentId);
  if (index === -1) return assignments;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= mentorAssignments.length) return assignments;

  const reorderedMentorAssignments = [...mentorAssignments];
  const [movedAssignment] = reorderedMentorAssignments.splice(index, 1);
  reorderedMentorAssignments.splice(targetIndex, 0, movedAssignment);

  let mentorIndex = 0;
  return assignments.map((assignment) => (
    assignment.mentorId === mentorId
      ? reorderedMentorAssignments[mentorIndex++]
      : assignment
  ));
}
