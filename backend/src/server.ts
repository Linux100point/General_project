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
import { safeAsyncRoute } from './middleware/safeAsyncRoute';
import { LocalFileStorage, SupabaseFileStorage, createStorageProvider, createSupabaseStorageClient } from './services/storage/LocalFileStorage';
import { parseStudentsExcel } from './services/excel/StudentExcelParser';
import { MockAIProvider, MockMatchingService } from './services/matching/MockMatchingService';
import { createMentorIdFromFileName, normalizeMentorNameFromFileName } from './services/matching/MentorIdentity';
import { applyUploadedMentorCvFiles, reconcileMentorCvSession, resolveMentorCvFile } from './services/matching/MentorCvSession';
import { InMemoryMentorProfileCache, MentorCVExtractionService, OpenAIMentorProfileExtractor } from './services/matching/MentorCVExtractionService';
import { MatchingConfigurationError, OpenAIProvider } from './services/matching/OpenAIProvider';
import { MatchingInputError, OpenAIMatchingService } from './services/matching/OpenAIMatchingService';
import { createMatchingRunStageError, logMatchingRunFailure, matchingRunFailureResponse, type MatchingRunStage } from './services/matching/MatchingRunDiagnostics';
import { BasicExportService, getExportMetadata } from './services/export/ExportService';
import { enforceFinalAssignmentConstraint, buildUnassignedStudents } from './services/matching/MatchingBusinessRules';
import { MatchingSessionPersistenceError, SupabaseMatchingSessionRepository } from './services/matching/MatchingSessionRepository';
import type { MatchingService, MatchingSession, UserRole } from './types';

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
const storageProvider = createStorageProvider();
const storage = storageProvider === 'supabase'
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
    const cvFile = resolveMentorCvFile(session, mentor);
    if (!cvFile) {
      throw createMatchingRunStageError('mentor-file-record', 'MentorFileRecordError', {
        storageProvider,
        mentorId: mentor.id,
        fileRecordExists: false,
        storageObjectPathPresent: false,
      });
    }
    try {
      return await storage.readFile(cvFile);
    } catch {
      throw createMatchingRunStageError('mentor-cv-read', 'StorageReadError', {
        storageProvider,
        mentorId: mentor.id,
        fileRecordExists: true,
        storageObjectPathPresent: Boolean(cvFile.storagePath),
      });
    }
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
  const reconciledSession = reconcileMentorCvSession(loadedSession);
  if (reconciledSession !== loadedSession) {
    return sessionRepository.saveCurrentSession(adminUserId, reconciledSession);
  }
  return reconciledSession;
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

app.get('/api/admin/matching/session', requireAdmin, safeAsyncRoute(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await sessionRepository.loadCurrentSession(user!.id);
  res.json({ session });
}));

app.post('/api/admin/matching/upload-mentor-cvs', requireAdmin, mentorUpload.array('files', 5), safeAsyncRoute(async (req, res) => {
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

    const existingMentorIds = new Set(importedSession.mentors.map((mentor) => mentor.id));
    const incomingMentorIds = new Set(fileIdentities.map((identity) => identity.id));
    const newMentorCount = [...incomingMentorIds].filter((mentorId) => !existingMentorIds.has(mentorId)).length;
    if (existingMentorIds.size + newMentorCount > 5) {
      await removeTemporaryUploads(uploadedFiles);
      return res.status(400).json({ error: 'A matching session supports at most five mentors.' });
    }

    const savedFiles = await Promise.all(uploadedFiles.map((file) => storage.save(file, 'mentor-cv')));

    const nextSession = {
      ...applyUploadedMentorCvFiles(importedSession, savedFiles, fileIdentities),
      updatedAt: new Date().toISOString(),
    };
    const savedSession = await sessionRepository.saveCurrentSession(user!.id, nextSession);
    return res.json({ success: true, session: savedSession });
  } catch (error) {
    await removeTemporaryUploads(req.files as Express.Multer.File[] | undefined);
    if (error instanceof MatchingSessionPersistenceError) {
      console.error('Matching session persistence failed.', { operation: error.operation });
      return res.status(500).json({ error: 'Unable to persist matching session.' });
    }
    const message = error instanceof Error ? error.message : 'Unable to upload mentor CV files.';
    return res.status(400).json({ error: message });
  }
}));

app.post('/api/admin/matching/upload-students-excel', requireAdmin, studentUpload.single('file'), safeAsyncRoute(async (req, res) => {
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
    if (error instanceof MatchingSessionPersistenceError) {
      console.error('Matching session persistence failed.', { operation: error.operation });
      return res.status(500).json({ error: 'Unable to persist matching session.' });
    }
    const message = error instanceof Error ? error.message : 'Unable to parse student Excel file.';
    return res.status(400).json({ error: message });
  }
}));

app.post('/api/admin/matching/run', requireAdmin, safeAsyncRoute(async (req, res) => {
  let stage: MatchingRunStage = 'session-load';
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

    stage = 'response';
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

    stage = 'session-persistence';
    const savedSession = await sessionRepository.saveCurrentSession(user!.id, nextSession);
    return res.json({ success: true, session: savedSession });
  } catch (error) {
    if (error instanceof MatchingSessionPersistenceError) {
      logMatchingRunFailure(error, stage);
      return res.status(500).json({ error: 'Unable to persist matching session.' });
    }
    if (error instanceof MatchingConfigurationError) {
      return res.status(503).json({ error: 'AI matching is selected but OPENAI_API_KEY is not configured on the backend.' });
    }
    if (error instanceof MatchingInputError) {
      return res.status(400).json({ error: error.message });
    }
    logMatchingRunFailure(error, stage);
    return res.status(500).json(matchingRunFailureResponse);
  }
}));

app.post('/api/admin/matching/save', requireAdmin, safeAsyncRoute(async (req, res) => {
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
}));

app.post('/api/admin/matching/reset', requireAdmin, safeAsyncRoute(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  const savedSession = await sessionRepository.resetToOriginal(user!.id, session);
  return res.json({ success: true, session: savedSession });
}));

app.get('/api/admin/matching/export', requireAdmin, safeAsyncRoute(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  const requestedFormat = req.query.format ?? 'excel';
  if (requestedFormat !== 'excel' && requestedFormat !== 'pdf') {
    return res.status(400).json({ error: 'Export format must be excel or pdf.' });
  }
  const format = requestedFormat;
  const exportMetadata = getExportMetadata(format);
  const fileBuffer = await exportService.exportFinalMatching(session, format);
  const exportRecord = await storage.saveBuffer(fileBuffer, exportMetadata.fileName, 'exports', exportMetadata.contentType);
  const downloadableBuffer = await storage.readFile(exportRecord);

  res.setHeader('Content-Type', exportMetadata.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${exportMetadata.fileName}"`);
  return res.send(downloadableBuffer);
}));

app.get('/api/admin/matching/unassigned-students', requireAdmin, safeAsyncRoute(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const session = await getSessionForAdmin(user!.id);
  res.json({ students: buildUnassignedStudents(session) });
}));

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
