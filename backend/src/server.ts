import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { isSupabaseConfigured } from './auth';
import { getFrontendOrigin, getSupabaseInviteRedirectUrl, isProductionEnvironment } from './config/runtimeConfig';
import { supabaseAdmin } from './supabase';
import { requireAdmin, requireAuth } from './middleware/adminAuth';
import { LocalFileStorage, SupabaseFileStorage, createStorageProvider, createSupabaseStorageClient } from './services/storage/LocalFileStorage';
import { parseStudentsExcel } from './services/excel/StudentExcelParser';
import { MockAIProvider, MockMatchingService } from './services/matching/MockMatchingService';
import { createMentorIdFromFileName, normalizeMentorNameFromFileName } from './services/matching/MentorIdentity';
import { InMemoryMentorProfileCache, MentorCVExtractionService, OpenAIMentorProfileExtractor } from './services/matching/MentorCVExtractionService';
import { MatchingConfigurationError, OpenAIProvider } from './services/matching/OpenAIProvider';
import { MatchingInputError, OpenAIMatchingService } from './services/matching/OpenAIMatchingService';
import { BasicExportService } from './services/export/ExportService';
import { enforceFinalAssignmentConstraint, buildUnassignedStudents } from './services/matching/MatchingBusinessRules';
import { SupabaseMatchingSessionRepository, createDefaultMatchingSession } from './services/matching/MatchingSessionRepository';
import type { MatchingService, MatchingSession, Mentor, Student, UserRole } from './types';

type AuthenticatedRequest = express.Request & {
  user?: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    studentId?: string | null;
  };
};

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const uploadRoot = path.join(process.cwd(), 'uploads');
const storage = createStorageProvider() === 'supabase'
  ? new SupabaseFileStorage(createSupabaseStorageClient(supabaseAdmin))
  : new LocalFileStorage();
const exportService = new BasicExportService();
const sessionRepository = new SupabaseMatchingSessionRepository(supabaseAdmin ?? undefined);

fs.mkdirSync(uploadRoot, { recursive: true });
fs.mkdirSync(path.join(uploadRoot, 'temp-mentor'), { recursive: true });
fs.mkdirSync(path.join(uploadRoot, 'temp-student'), { recursive: true });

const mentorUpload = multer({
  dest: path.join(uploadRoot, 'temp-mentor'),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only PDF files are allowed for mentor CV uploads.'));
  },
});

const studentUpload = multer({
  dest: path.join(uploadRoot, 'temp-student'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const isXlsx = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.originalname.toLowerCase().endsWith('.xlsx');
    if (isXlsx) {
      cb(null, true);
      return;
    }

    cb(new Error('Only .xlsx files are allowed for student data upload.'));
  },
});

const buildDemoMentors = (): Mentor[] => [
  { id: 'mentor-1', name: 'Mentor A', cvFileIds: [] },
  { id: 'mentor-2', name: 'Mentor B', cvFileIds: [] },
  { id: 'mentor-3', name: 'Mentor C', cvFileIds: [] },
];

const buildDemoStudents = (): Student[] => [
  {
    id: 'student-1',
    name: 'Student A',
    studentId: 'SDU-1001',
    email: 'a@student.sdu.edu',
    desiredSkills: 'React, TypeScript, backend APIs',
    topicsForExpertConsultation: 'AI-assisted tooling, mentorship workflows',
    projectOverview: 'Build a university project dashboard with automated matching.',
    mentorshipSupportNeeds: 'Need guidance on architecture and implementation planning.',
    mentorId: null,
  },
  {
    id: 'student-2',
    name: 'Student B',
    studentId: 'SDU-1002',
    email: 'b@student.sdu.edu',
    desiredSkills: 'Node.js, Express, PostgreSQL',
    topicsForExpertConsultation: 'API design and database modeling',
    projectOverview: 'Create a backend service for educational workflows.',
    mentorshipSupportNeeds: 'Help with scale and testing strategy.',
    mentorId: null,
  },
  {
    id: 'student-3',
    name: 'Student C',
    studentId: 'SDU-1003',
    email: 'c@student.sdu.edu',
    desiredSkills: 'Python, data analysis, machine learning',
    topicsForExpertConsultation: 'Recommendation systems and evaluation',
    projectOverview: 'Develop a machine learning prototype for mentorship matching.',
    mentorshipSupportNeeds: 'Need structured feedback on model validation.',
    mentorId: null,
  },
  {
    id: 'student-4',
    name: 'Student D',
    studentId: 'SDU-1004',
    email: 'd@student.sdu.edu',
    desiredSkills: 'UX research, product thinking',
    topicsForExpertConsultation: 'User flows and prototype testing',
    projectOverview: 'Design the student onboarding experience for a platform.',
    mentorshipSupportNeeds: 'Need ideas for usability improvements.',
    mentorId: null,
  },
  {
    id: 'student-5',
    name: 'Student E',
    studentId: 'SDU-1005',
    email: 'e@student.sdu.edu',
    desiredSkills: 'Data pipelines, analytics',
    topicsForExpertConsultation: 'Automation and reporting',
    projectOverview: 'Build dashboards for internal academic analytics.',
    mentorshipSupportNeeds: 'Support with ETL architecture.',
    mentorId: null,
  },
];

function createSeedSession(): MatchingSession {
  return {
    id: 'session-demo',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    uploadedMentorFiles: [],
    mentors: buildDemoMentors(),
    students: buildDemoStudents(),
    originalRecommendations: [],
    currentRecommendations: [],
    finalAssignments: [],
  };
}

function createMatchingServiceForSession(session: MatchingSession): MatchingService {
  const providerName = (process.env.MATCHING_PROVIDER || 'mock').trim().toLowerCase();
  if (providerName === 'mock') {
    return new MockMatchingService(new MockAIProvider());
  }
  if (providerName !== 'openai') {
    throw new Error('MATCHING_PROVIDER must be either "mock" or "openai".');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const openAIClient = apiKey ? new OpenAI({ apiKey }) : null;
  const model = process.env.OPENAI_MATCHING_MODEL || 'gpt-6-astra';
  const extractionService = new MentorCVExtractionService(
    new OpenAIMentorProfileExtractor(openAIClient, model),
    new InMemoryMentorProfileCache(),
  );
  const provider = new OpenAIProvider(openAIClient, model);

  return new OpenAIMatchingService(provider, extractionService, async (mentor) => {
    const cvFileId = mentor.cvFileIds.at(-1);
    const cvFile = session.uploadedMentorFiles.find((file) => file.id === cvFileId);
    if (!cvFile) {
      throw new Error(`No stored CV file found for mentor "${mentor.id}".`);
    }
    return storage.readFile(cvFile);
  });
}

async function removeTemporaryUploads(files: Express.Multer.File[] | undefined): Promise<void> {
  if (!files?.length) {
    return;
  }

  await Promise.all(files.map((file) => fs.promises.unlink(file.path).catch(() => undefined)));
}

async function getSessionForAdmin(adminUserId: string): Promise<MatchingSession> {
  const loadedSession = await sessionRepository.loadCurrentSession(adminUserId);
  if (loadedSession.students.length || loadedSession.mentors.length || loadedSession.currentRecommendations.length) {
    return loadedSession;
  }

  const seededSession = createSeedSession();
  return sessionRepository.saveCurrentSession(adminUserId, seededSession);
}

const configuredFrontendOrigin = getFrontendOrigin();
const allowedOrigins = new Set<string>([configuredFrontendOrigin]);
if (!isProductionEnvironment()) {
  allowedOrigins.add('http://localhost:5173');
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS.'));
  },
  credentials: true,
}));

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  return res.json({ user });
});

app.get('/api/supabase-status', (_req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
  });
});

app.post('/api/admin/users/invite', requireAdmin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : '';
  const role = req.body?.role as UserRole | undefined;
  const studentId = typeof req.body?.student_id === 'string' ? req.body.student_id.trim() : '';

  if (!/^\S+@\S+\.\S+$/.test(email) || !fullName || !role || !['ADMIN', 'STUDENT', 'MENTOR'].includes(role)) {
    return res.status(400).json({ error: 'Provide a valid email, full_name, and one of the supported roles.' });
  }

  if (role !== 'STUDENT' && studentId) {
    return res.status(400).json({ error: 'student_id is only valid for STUDENT accounts.' });
  }

  const adminClient = supabaseAdmin;
  if (!adminClient) {
    return res.status(503).json({ error: 'Supabase server administration is not configured.' });
  }

  try {
    const redirectTo = getSupabaseInviteRedirectUrl();
    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      ...(redirectTo ? { redirectTo } : {}),
    });

    if (inviteError || !inviteData.user) {
      return res.status(inviteError?.code === 'email_exists' ? 409 : 400).json({
        error: inviteError?.message || 'Unable to invite this user.',
      });
    }

    const profile = {
      user_id: inviteData.user.id,
      email: inviteData.user.email ?? email,
      full_name: fullName,
      role,
      student_id: role === 'STUDENT' ? studentId || null : null,
    };
    const { error: profileError } = await adminClient.from('user_profiles').insert(profile);

    if (profileError) {
      await adminClient.auth.admin.deleteUser(inviteData.user.id);
      return res.status(500).json({ error: 'The invitation could not be provisioned with an application profile.' });
    }

    return res.status(201).json({ success: true, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase invitation service is unavailable.';
    if (message.includes('SUPABASE_INVITE_REDIRECT_URL')) {
      return res.status(500).json({ error: message });
    }
    return res.status(503).json({ error: 'Supabase invitation service is unavailable.' });
  }
});

app.get('/api/admin/matching/session', requireAdmin, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  res.json({ session });
});

app.post('/api/admin/matching/upload-mentor-cvs', requireAdmin, mentorUpload.array('files', 5), async (req, res) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const importedSession = await getSessionForAdmin(user!.id);
    const uploadedFiles = req.files as Express.Multer.File[];

    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'At least one PDF file is required.' });
    }

    const fileIdentities = uploadedFiles.map((file) => ({
      file,
      id: createMentorIdFromFileName(file.originalname),
      name: normalizeMentorNameFromFileName(file.originalname),
    }));

    if (new Set(fileIdentities.map((identity) => identity.id)).size !== fileIdentities.length) {
      await removeTemporaryUploads(uploadedFiles);
      return res.status(400).json({ error: 'Mentor CV filenames must identify distinct mentors.' });
    }

    const existingMentorIds = new Set(importedSession.uploadedMentorFiles.length ? importedSession.mentors.map((mentor) => mentor.id) : []);
    const incomingMentorIds = new Set(fileIdentities.map((identity) => identity.id));
    const newMentorCount = [...incomingMentorIds].filter((mentorId) => !existingMentorIds.has(mentorId)).length;
    if (existingMentorIds.size + newMentorCount > 5) {
      await removeTemporaryUploads(uploadedFiles);
      return res.status(400).json({ error: 'A matching session supports at most five mentors.' });
    }

    const savedFiles = await Promise.all(uploadedFiles.map((file) => storage.save(file, 'mentor-cv')));

    if (!importedSession.uploadedMentorFiles.length) {
      importedSession.mentors = [];
    }

    importedSession.uploadedMentorFiles.push(...savedFiles);

    for (const [index, file] of savedFiles.entries()) {
      const identity = fileIdentities[index];
      const existingMentorIndex = importedSession.mentors.findIndex((mentor) => mentor.id === identity.id);
      const mentor = { id: identity.id, name: identity.name, cvFileIds: [file.id] };
      if (existingMentorIndex >= 0) {
        importedSession.mentors[existingMentorIndex] = mentor;
      } else {
        importedSession.mentors.push(mentor);
      }
    }

    importedSession.updatedAt = new Date().toISOString();
    const savedSession = await sessionRepository.saveCurrentSession(user!.id, importedSession);
    return res.json({ success: true, session: savedSession });
  } catch (error) {
    await removeTemporaryUploads(req.files as Express.Multer.File[] | undefined);
    const message = error instanceof Error ? error.message : 'Unable to upload mentor CV files.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/admin/matching/upload-students-excel', requireAdmin, studentUpload.single('file'), async (req, res) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Student XLSX file is required.' });
    }

    const session = await getSessionForAdmin(user!.id);
    const savedFile = await storage.save(file, 'students-excel');
    const studentBuffer = await storage.readFile(savedFile);
    const parsedStudents = parseStudentsExcel(studentBuffer);

    const nextSession: MatchingSession = {
      ...session,
      students: parsedStudents,
      uploadedStudentFile: savedFile,
      updatedAt: new Date().toISOString(),
    };

    const savedSession = await sessionRepository.saveCurrentSession(user!.id, nextSession);
    return res.json({ success: true, session: savedSession });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to parse student Excel file.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/admin/matching/run', requireAdmin, async (req, res) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const session = await getSessionForAdmin(user!.id);
    if (!session.students.length) {
      return res.status(400).json({ error: 'Student Excel file must be uploaded before running matching.' });
    }

    if (!session.mentors.length) {
      return res.status(400).json({ error: 'At least one mentor CV must be uploaded before running matching.' });
    }

    const service = createMatchingServiceForSession(session);
    const result = await service.run({ mentors: session.mentors, students: session.students });

    const nextSession: MatchingSession = {
      ...session,
      ...result,
      uploadedMentorFiles: session.uploadedMentorFiles,
      uploadedStudentFile: session.uploadedStudentFile,
      students: session.students,
      mentors: session.mentors,
      status: 'draft',
      updatedAt: new Date().toISOString(),
    };

    nextSession.finalAssignments = enforceFinalAssignmentConstraint(nextSession.finalAssignments);

    const savedSession = await sessionRepository.saveCurrentSession(user!.id, nextSession);
    return res.json({ success: true, session: savedSession });
  } catch (error) {
    if (error instanceof MatchingConfigurationError) {
      return res.status(503).json({ error: 'AI matching is selected but OPENAI_API_KEY is not configured on the backend.' });
    }
    if (error instanceof MatchingInputError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Matching run failed.', { errorName: error instanceof Error ? error.name : 'UnknownError' });
    return res.status(500).json({ error: 'Unable to run matching. Check uploaded files and matching configuration.' });
  }
});

app.post('/api/admin/matching/save', requireAdmin, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  const currentAssignments = req.body?.finalAssignments ?? session.finalAssignments;

  const nextSession: MatchingSession = {
    ...session,
    finalAssignments: enforceFinalAssignmentConstraint(currentAssignments),
    status: 'final',
    updatedAt: new Date().toISOString(),
  };

  const savedSession = await sessionRepository.saveCurrentSession(user!.id, nextSession);
  return res.json({ success: true, session: savedSession });
});

app.post('/api/admin/matching/reset', requireAdmin, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  const restored: MatchingSession = {
    ...session,
    currentRecommendations: session.originalRecommendations,
    finalAssignments: enforceFinalAssignmentConstraint(
      session.originalRecommendations
        .filter((item) => item.category === 'selected')
        .slice(0, 3)
        .map((item, index) => ({
          id: `assignment-restored-${index + 1}`,
          mentorId: item.mentorId,
          studentId: item.studentId,
          assignedAt: new Date().toISOString(),
        })),
    ),
    status: 'draft',
    updatedAt: new Date().toISOString(),
  };

  const savedSession = await sessionRepository.saveCurrentSession(user!.id, restored);
  return res.json({ success: true, session: savedSession });
});

app.get('/api/admin/matching/export', requireAdmin, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  const format = (req.query.format as 'excel' | 'pdf') || 'excel';
  const fileBuffer = await exportService.exportFinalMatching(session, format);
  const exportRecord = await storage.saveBuffer(fileBuffer, `matching-export.${format}`, 'exports', format === 'excel' ? 'application/vnd.ms-excel' : 'application/pdf');
  const downloadableBuffer = await storage.readFile(exportRecord);

  res.setHeader('Content-Type', format === 'excel' ? 'application/vnd.ms-excel' : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="matching-export.${format}"`);
  return res.send(downloadableBuffer);
});

app.get('/api/admin/matching/unassigned-students', requireAdmin, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  res.json({ students: buildUnassignedStudents(session) });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

const _unusedDefaultSession = createDefaultMatchingSession();
