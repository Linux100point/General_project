export type UserRole = 'ADMIN' | 'STUDENT' | 'MENTOR';

export type RecommendationCategory = 'selected' | 'alternative';

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  studentId?: string | null;
}

export interface UploadedFileRecord {
  id: string;
  originalName: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  kind: 'mentor-cv' | 'students-excel' | 'exports';
}

export interface Student {
  id: string;
  name: string;
  studentId?: string;
  email?: string;
  desiredSkills: string;
  topicsForExpertConsultation: string;
  projectOverview: string;
  mentorshipSupportNeeds: string;
  mentorId?: string | null;
}

export interface Mentor {
  id: string;
  name: string;
  cvFileIds: string[];
  summary?: string;
}

export interface MentorProfile {
  mentorId: string;
  name: string;
  summary: string;
  skills: string[];
  technologies: string[];
  domains: string[];
  experience: string[];
  projectTypes: string[];
  expertiseTopics: string[];
  evidence: string[];
}

export interface Recommendation {
  id: string;
  mentorId: string;
  studentId: string;
  score: number;
  reason: string;
  category: RecommendationCategory;
  source: 'ai' | 'manual';
  assignedToMentorId?: string | null;
}

export interface FinalMentorAssignment {
  id: string;
  mentorId: string;
  studentId: string;
  assignedAt: string;
}

export interface MatchingSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'final';
  uploadedMentorFiles: UploadedFileRecord[];
  uploadedStudentFile?: UploadedFileRecord;
  students: Student[];
  mentors: Mentor[];
  originalRecommendations: Recommendation[];
  currentRecommendations: Recommendation[];
  finalAssignments: FinalMentorAssignment[];
}

export interface MatchRequestInput {
  mentors: Mentor[];
  students: Student[];
  mentorProfiles?: MentorProfile[];
}

export interface AIRecommendationPayload {
  mentorId: string;
  studentId: string;
  score: number;
  reason: string;
  category: RecommendationCategory;
  assignedToMentorId?: string | null;
}

export interface AIProvider {
  generateRecommendations(input: MatchRequestInput): Promise<AIRecommendationPayload[]>;
}

export interface MatchingService {
  run(input: MatchRequestInput): Promise<MatchingSession>;
}

export interface ExportPayload {
  format: 'excel' | 'pdf';
  fileName: string;
  contentType: string;
  buffer: Buffer;
}
