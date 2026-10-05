import type { MatchingSession, Mentor, UploadedFileRecord } from '../../types';

export type UploadedMentorIdentity = Pick<Mentor, 'id' | 'name'>;

export function resolveMentorCvFile(session: MatchingSession, mentor: Mentor): UploadedFileRecord | undefined {
  const cvFileId = mentor.cvFileIds.at(-1);
  return session.uploadedMentorFiles.find((file) => file.id === cvFileId && file.kind === 'mentor-cv');
}

export function reconcileMentorCvSession(session: MatchingSession): MatchingSession {
  const mentorFilesById = new Map(
    session.uploadedMentorFiles
      .filter((file) => file.kind === 'mentor-cv')
      .map((file) => [file.id, file]),
  );
  const mentors = session.mentors.flatMap((mentor) => {
    const cvFileIds = mentor.cvFileIds.filter((fileId) => mentorFilesById.has(fileId));
    return cvFileIds.length ? [{ ...mentor, cvFileIds }] : [];
  });
  const referencedFileIds = new Set(mentors.flatMap((mentor) => mentor.cvFileIds));
  const uploadedMentorFiles = session.uploadedMentorFiles.filter((file) => file.kind !== 'mentor-cv' || referencedFileIds.has(file.id));

  const unchanged = mentors.length === session.mentors.length
    && uploadedMentorFiles.length === session.uploadedMentorFiles.length
    && mentors.every((mentor, index) => mentor.cvFileIds.length === session.mentors[index].cvFileIds.length);
  return unchanged ? session : { ...session, mentors, uploadedMentorFiles };
}

export function applyUploadedMentorCvFiles(
  session: MatchingSession,
  files: UploadedFileRecord[],
  identities: UploadedMentorIdentity[],
): MatchingSession {
  const reconciled = reconcileMentorCvSession(session);
  const mentors = [...reconciled.mentors];

  for (const [index, file] of files.entries()) {
    const identity = identities[index];
    const mentor = { id: identity.id, name: identity.name, cvFileIds: [file.id] };
    const existingMentorIndex = mentors.findIndex((current) => current.id === identity.id);
    if (existingMentorIndex >= 0) {
      mentors[existingMentorIndex] = mentor;
    } else {
      mentors.push(mentor);
    }
  }

  return reconcileMentorCvSession({
    ...reconciled,
    mentors,
    uploadedMentorFiles: [...reconciled.uploadedMentorFiles, ...files],
  });
}
