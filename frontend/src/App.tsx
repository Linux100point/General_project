import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { buildApiUrl } from './config';
import { supabase } from './supabase';
import { ApiRequestError, getActionErrorMessage } from './actionErrors';
import {
  assignStudentToMentor,
  getAlternativeStudentName,
  getCanonicalStudentId,
  getUnassignedStudents,
  getStudentDisplayName,
  getUniqueAssignments,
  removeStudentAssignment,
  reorderMentorAssignment,
} from './matchingAssignments';

type Role = 'ADMIN' | 'STUDENT' | 'MENTOR';

type AppUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  studentId?: string | null;
};

type AuthSession = {
  token: string;
  user: AppUser;
};

type Recommendation = {
  id: string;
  mentorId: string;
  studentId: string;
  score: number;
  reason: string;
  category: 'selected' | 'alternative';
  source: 'ai' | 'manual';
  assignedToMentorId?: string | null;
};

type Student = {
  id: string;
  name: string;
  studentId?: string;
  email?: string;
  desiredSkills: string;
  topicsForExpertConsultation: string;
  projectOverview: string;
  mentorshipSupportNeeds: string;
  mentorId?: string | null;
};

type Mentor = {
  id: string;
  name: string;
  cvFileIds: string[];
};

type SessionState = {
  mentors: Mentor[];
  students: Student[];
  currentRecommendations: Recommendation[];
  originalRecommendations: Recommendation[];
  finalAssignments: Array<{ mentorId: string; studentId: string }>;
  uploadedMentorFiles: Array<{ originalName: string }>;
  uploadedStudentFile?: { originalName?: string };
};

type AssignmentCardItem = {
  id: string;
  mentorId: string;
  studentId: string;
  recommendation?: Recommendation;
};

const defaultSession: SessionState = {
  mentors: [],
  students: [],
  currentRecommendations: [],
  originalRecommendations: [],
  finalAssignments: [],
  uploadedMentorFiles: [],
};

function normalizeSession(value: Partial<SessionState>): SessionState {
  const mentors = value.mentors ?? [];
  const students = value.students ?? [];
  return {
    mentors,
    students,
    currentRecommendations: value.currentRecommendations ?? [],
    originalRecommendations: value.originalRecommendations ?? [],
    finalAssignments: getUniqueAssignments(
      value.finalAssignments ?? [],
      students,
      mentors.map((mentor) => mentor.id),
    ),
    uploadedMentorFiles: value.uploadedMentorFiles ?? [],
    uploadedStudentFile: value.uploadedStudentFile,
  };
}

export function MatchingDashboard({ sessionToken }: { sessionToken: string }) {
  const [backendStatus, setBackendStatus] = useState('Checking backend...');
  const [session, setSession] = useState<SessionState>(defaultSession);
  const [mentorFiles, setMentorFiles] = useState<File[]>([]);
  const [studentFile, setStudentFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [selectedStudentByMentor, setSelectedStudentByMentor] = useState<Record<string, string>>({});
  const mentorInputRef = useRef<HTMLInputElement>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch(buildApiUrl('/api/health'));
        if (!response.ok) {
          throw new Error('Backend not reachable');
        }
        setBackendStatus('Backend OK');
      } catch {
        setBackendStatus('Backend unavailable');
      }
    };

    fetchHealth();
  }, []);

  useEffect(() => {
    let active = true;

    const loadSession = async () => {
      setSessionLoading(true);
      try {
        const response = await fetch(buildApiUrl('/api/admin/matching/session'), {
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        if (!response.ok) throw new ApiRequestError(response.status);

        const result = await response.json();
        if (!result.session) throw new Error('Matching session response was empty.');
        if (active) {
          setSession(normalizeSession(result.session));
        }
      } catch (error) {
        if (active) setActionError(getActionErrorMessage(error));
      } finally {
        if (active) setSessionLoading(false);
      }
    };

    void loadSession();
    return () => { active = false; };
  }, [sessionToken]);

  const updateCurrentSessionFromServer = async (url: string, method: string, body?: FormData | Record<string, unknown>) => {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${sessionToken}`);

    if (!(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(buildApiUrl(url), {
      method,
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      throw new ApiRequestError(response.status);
    }

    const result = await response.json();
    if (result.session) {
      setSession(normalizeSession(result.session));
    }
  };

  const mentorCards = useMemo(() => {
    const mentorIds = session.mentors.map((mentor) => mentor.id);
    const validAssignments = getUniqueAssignments(session.finalAssignments, session.students, mentorIds);

    return session.mentors.map((mentor) => {
      const finalAssignments: AssignmentCardItem[] = validAssignments
        .filter((assignment) => assignment.mentorId === mentor.id)
        .map((assignment) => {
          const recommendation = session.currentRecommendations
            .filter((item) => (
              item.mentorId === mentor.id
              && getCanonicalStudentId(session.students, item.studentId) === assignment.studentId
            ))
            .sort((left, right) => {
              if (left.category !== right.category) return left.category === 'selected' ? -1 : 1;
              return right.score - left.score;
            })[0];
          return {
            id: `assignment-${assignment.studentId}-${mentor.id}`,
            mentorId: mentor.id,
            studentId: assignment.studentId,
            recommendation,
          };
        });
      const assignedStudentIds = new Set(finalAssignments.map((assignment) => assignment.studentId));
      const alternatives = session.currentRecommendations.flatMap((item) => {
        if (
          item.mentorId !== mentor.id
          || item.category !== 'alternative'
        ) return [];
        const studentId = getCanonicalStudentId(session.students, item.studentId);
        if (!studentId || assignedStudentIds.has(studentId)) return [];
        const studentName = getAlternativeStudentName(session.students, item.studentId);
        return studentName ? [{ ...item, studentName }] : [];
      });
      return { mentor, finalAssignments, alternatives };
    });
  }, [session]);

  const unassignedStudents = useMemo(() => {
    return getUnassignedStudents(
      session.students,
      session.finalAssignments,
      session.mentors.map((mentor) => mentor.id),
    );
  }, [session]);

  const performAction = async (action: () => Promise<void>, successMessage: string) => {
    setActionError(null);
    setActionSuccess(null);
    setLoading(true);
    try {
      await action();
      setActionSuccess(successMessage);
    } catch (error) {
      setActionError(getActionErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleMentorUpload = async () => {
    if (!mentorFiles.length) {
      setActionError('Select at least one mentor CV before uploading.');
      return;
    }
    await performAction(async () => {
      const formData = new FormData();
      mentorFiles.forEach((file) => formData.append('files', file));
      await updateCurrentSessionFromServer('/api/admin/matching/upload-mentor-cvs', 'POST', formData);
      setMentorFiles([]);
      if (mentorInputRef.current) mentorInputRef.current.value = '';
    }, 'Mentor CVs uploaded successfully.');
  };

  const handleStudentUpload = async () => {
    if (!studentFile) {
      setActionError('Select a student Excel file before uploading.');
      return;
    }
    await performAction(async () => {
      const formData = new FormData();
      formData.append('file', studentFile);
      await updateCurrentSessionFromServer('/api/admin/matching/upload-students-excel', 'POST', formData);
      setStudentFile(null);
      if (studentInputRef.current) studentInputRef.current.value = '';
    }, 'Student spreadsheet uploaded successfully.');
  };

  const handleRunMatching = async () => {
    await performAction(async () => {
      await updateCurrentSessionFromServer('/api/admin/matching/run', 'POST');
    }, 'Matching recommendations updated.');
  };

  const handleSaveChanges = async () => {
    const finalAssignments = getUniqueAssignments(
      session.finalAssignments,
      session.students,
      session.mentors.map((mentor) => mentor.id),
    );
    await performAction(async () => {
      await updateCurrentSessionFromServer('/api/admin/matching/save', 'POST', { finalAssignments });
    }, 'Changes saved successfully.');
  };

  const handleReset = async () => {
    await performAction(async () => {
      await updateCurrentSessionFromServer('/api/admin/matching/reset', 'POST');
    }, 'Recommendations restored successfully.');
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    await performAction(async () => {
      const response = await fetch(`${buildApiUrl('/api/admin/matching/export')}?format=${format}`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) throw new ApiRequestError(response.status);

      const downloadUrl = URL.createObjectURL(await response.blob());
      const downloadLink = document.createElement('a');
      downloadLink.href = downloadUrl;
      downloadLink.download = format === 'excel' ? 'matching-export.xlsx' : 'matching-export.pdf';
      downloadLink.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    }, `${format === 'excel' ? 'Excel' : 'PDF'} export downloaded.`);
  };

  const reorderSelected = (mentorId: string, studentId: string, direction: 'up' | 'down') => {
    setSession((current) => {
      const finalAssignments = reorderMentorAssignment(current.finalAssignments, mentorId, studentId, direction);
      return finalAssignments === current.finalAssignments ? current : { ...current, finalAssignments };
    });
  };

  const removeSelectedStudent = (_mentorId: string, studentId: string) => {
    setSession((current) => ({
      ...current,
      finalAssignments: removeStudentAssignment(current.finalAssignments, studentId),
    }));
    setSelectedStudentByMentor({});
  };

  const moveStudentBetweenMentors = (studentId: string, targetMentorId: string) => {
    setSession((current) => {
      const finalAssignments = assignStudentToMentor(current.finalAssignments, studentId, targetMentorId);
      return finalAssignments === current.finalAssignments ? current : { ...current, finalAssignments };
    });
    setSelectedStudentByMentor({});
  };

  const addStudentToMentor = (mentorId: string, studentId: string) => {
    setSession((current) => {
      const isKnownStudent = current.students.some((student) => student.id === studentId);
      const isUnassigned = !current.finalAssignments.some((assignment) => assignment.studentId === studentId);
      if (!isKnownStudent || !isUnassigned) return current;
      return {
        ...current,
        finalAssignments: assignStudentToMentor(current.finalAssignments, studentId, mentorId),
      };
    });
    setSelectedStudentByMentor({});
  };

  return (
    <main style={{ minHeight: '100vh', background: '#f3f4f6', padding: '32px 16px', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <div>
              <p style={{ margin: 0, color: '#2563eb', fontWeight: 700 }}>General Project</p>
              <h1 style={{ margin: '8px 0 0' }}>Mentor–Student Matching</h1>
            </div>
            <div style={{ padding: '8px 12px', borderRadius: '999px', background: backendStatus === 'Backend OK' ? '#dcfce7' : '#fee2e2', color: backendStatus === 'Backend OK' ? '#166534' : '#991b1b', fontWeight: 700 }}>{backendStatus}</div>
          </div>
        </div>

        {sessionLoading && <p role="status" style={{ background: '#fff', padding: '12px 16px', borderRadius: '8px' }}>Loading saved matching session...</p>}
        {actionError && <div role="alert" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' }}>{actionError}</div>}
        {actionSuccess && <div role="status" style={{ background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' }}>{actionSuccess}</div>}

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ marginTop: 0 }}>1. Upload mentor CVs</h2>
          <input ref={mentorInputRef} type="file" multiple accept="application/pdf" disabled={loading || sessionLoading} onChange={(event) => { setActionError(null); setActionSuccess(null); setMentorFiles(Array.from(event.target.files ?? [])); }} style={{ display: 'block', marginBottom: '12px' }} />
          {mentorFiles.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              {mentorFiles.map((file, index) => (
                <div key={`${file.name}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', background: '#f9fafb', padding: '8px 12px', borderRadius: '8px', marginBottom: '8px' }}>
                  <span>{file.name}</span>
                  <button type="button" onClick={() => setMentorFiles((current) => current.filter((_, idx) => idx !== index))}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={handleMentorUpload} disabled={loading || sessionLoading || !mentorFiles.length} style={{ padding: '10px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Upload mentor CVs</button>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <h2 style={{ marginTop: 0 }}>2. Upload students Excel</h2>
          <input ref={studentInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={loading || sessionLoading} onChange={(event) => { setActionError(null); setActionSuccess(null); setStudentFile(event.target.files?.[0] ?? null); }} style={{ display: 'block', marginBottom: '12px' }} />
          {studentFile && <div style={{ marginBottom: '12px', background: '#f9fafb', padding: '8px 12px', borderRadius: '8px' }}>Selected file: {studentFile.name}</div>}
          <button type="button" onClick={handleStudentUpload} disabled={loading || sessionLoading || !studentFile} style={{ padding: '10px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Upload student Excel</button>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', marginBottom: '24px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <button type="button" onClick={handleRunMatching} disabled={loading || sessionLoading} style={{ padding: '12px 18px', border: 'none', borderRadius: '10px', background: '#111827', color: '#fff', cursor: 'pointer' }}>Run Matching</button>
            <button type="button" onClick={handleSaveChanges} disabled={loading || sessionLoading} style={{ padding: '12px 18px', border: 'none', borderRadius: '10px', background: '#0f766e', color: '#fff', cursor: 'pointer' }}>Save Changes</button>
            <button type="button" onClick={handleReset} disabled={loading || sessionLoading} style={{ padding: '12px 18px', border: 'none', borderRadius: '10px', background: '#b91c1c', color: '#fff', cursor: 'pointer' }}>Reset to AI Recommendations</button>
            <button type="button" onClick={() => void handleExport('excel')} disabled={loading || sessionLoading} style={{ padding: '12px 18px', border: 'none', borderRadius: '10px', background: '#e5e7eb', color: '#111827', cursor: 'pointer' }}>Export Excel</button>
            <button type="button" onClick={() => void handleExport('pdf')} disabled={loading || sessionLoading} style={{ padding: '12px 18px', border: 'none', borderRadius: '10px', background: '#e5e7eb', color: '#111827', cursor: 'pointer' }}>Export PDF</button>
          </div>
        </section>

        <section style={{ marginBottom: '24px' }}>
          <h2 style={{ marginBottom: '16px' }}>Mentor cards</h2>
          <div style={{ display: 'grid', gap: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {mentorCards.map(({ mentor, finalAssignments, alternatives }) => (
              <div key={mentor.id} style={{ background: '#ffffff', borderRadius: '16px', padding: '20px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 style={{ margin: 0 }}>{mentor.name}</h3>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <label htmlFor={`unassigned-student-${mentor.id}`} style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
                    Choose unassigned student for {mentor.name}
                  </label>
                  <select
                    id={`unassigned-student-${mentor.id}`}
                    aria-label={`Choose unassigned student for ${mentor.name}`}
                    value={selectedStudentByMentor[mentor.id] ?? ''}
                    onChange={(event) => setSelectedStudentByMentor((current) => ({ ...current, [mentor.id]: event.target.value }))}
                    disabled={!unassignedStudents.length}
                    style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff' }}
                  >
                    <option value="">Choose an unassigned student</option>
                    {unassignedStudents.map((student) => (
                      <option key={student.id} value={student.id}>{student.studentId ? `${student.studentId} — ` : ''}{student.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => addStudentToMentor(mentor.id, selectedStudentByMentor[mentor.id] ?? '')}
                    disabled={!selectedStudentByMentor[mentor.id] || !unassignedStudents.length}
                    style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff' }}
                  >
                    Add student
                  </button>
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <p style={{ margin: '0 0 8px', fontWeight: 700 }}>FINAL ASSIGNMENTS</p>
                  {finalAssignments.length ? finalAssignments.map((item, index) => {
                    const studentName = getStudentDisplayName(session.students, item.studentId);
                    return (
                      <div key={item.id} style={{ background: '#ecfdf5', borderRadius: '10px', padding: '10px 12px', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                          <strong>{studentName}</strong>
                          <span>{item.recommendation ? `${item.recommendation.score}%` : '—'}</span>
                        </div>
                        <span style={{ display: 'inline-block', marginTop: '4px', padding: '3px 8px', borderRadius: '999px', background: item.recommendation ? '#dbeafe' : '#f3f4f6', color: item.recommendation ? '#1d4ed8' : '#374151', fontSize: '12px', fontWeight: 700 }}>
                          {item.recommendation ? 'AI recommendation' : 'Added manually'}
                        </span>
                        {item.recommendation && <p style={{ margin: '8px 0' }}>Why: {item.recommendation.reason}</p>}
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' }}>
                          <button type="button" aria-label={`Move ${studentName} up`} onClick={() => reorderSelected(mentor.id, item.studentId, 'up')} disabled={index === 0}>↑</button>
                          <button type="button" aria-label={`Move ${studentName} down`} onClick={() => reorderSelected(mentor.id, item.studentId, 'down')} disabled={index === finalAssignments.length - 1}>↓</button>
                          <button type="button" aria-label={`Remove ${studentName} from ${mentor.name}`} onClick={() => removeSelectedStudent(mentor.id, item.studentId)}>Remove</button>
                        </div>
                        <label style={{ display: 'block', fontSize: '12px', color: '#374151', marginBottom: '4px' }}>Move to mentor</label>
                        <select aria-label={`Move ${studentName} to mentor`} value={mentor.id} onChange={(event) => moveStudentBetweenMentors(item.studentId, event.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                          {session.mentors.map((mentorOption) => (
                            <option key={mentorOption.id} value={mentorOption.id}>{mentorOption.name}</option>
                          ))}
                        </select>
                      </div>
                    );
                  }) : <p style={{ margin: 0, color: '#6b7280' }}>No final assignments.</p>}
                </div>

                <div>
                  <p style={{ margin: '0 0 8px', fontWeight: 700 }}>ALTERNATIVES</p>
                  {alternatives.length ? alternatives.map((item) => {
                    const assignmentText = item.assignedToMentorId ? ` — assigned to ${session.mentors.find((m) => m.id === item.assignedToMentorId)?.name ?? 'another mentor'}` : '';
                    return <div key={item.id} style={{ background: '#f8fafc', borderRadius: '10px', padding: '10px 12px', marginBottom: '8px' }}><strong>{item.studentName}</strong> — {item.score}%{assignmentText}</div>;
                  }) : <p style={{ margin: 0, color: '#6b7280' }}>No alternatives.</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginTop: 0 }}>Unassigned Students</h2>
          {unassignedStudents.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {unassignedStudents.map((student) => <span key={student.id} style={{ background: '#f3f4f6', padding: '8px 12px', borderRadius: '999px' }}>{student.name}</span>)}
            </div>
          ) : <p style={{ margin: 0, color: '#6b7280' }}>No unassigned students.</p>}
        </section>
      </div>
    </main>
  );
}

function StudentDashboard({ user }: { user: AppUser }) {
  return (
    <main style={{ minHeight: 'calc(100vh - 72px)', background: '#f3f4f6', padding: '32px 16px', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', display: 'grid', gap: '20px' }}>
        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '28px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <p style={{ margin: 0, color: '#2563eb', fontWeight: 700 }}>Student dashboard</p>
          <h1 style={{ margin: '10px 0 8px', fontSize: '32px' }}>Welcome, {user.fullName}</h1>
          <div style={{ display: 'inline-flex', padding: '6px 12px', borderRadius: '999px', background: '#dbeafe', color: '#1d4ed8', fontWeight: 700 }}>STUDENT</div>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginTop: 0 }}>Feature 1 status</h2>
          <p style={{ margin: '0 0 10px', color: '#374151' }}>Your authenticated profile is active and your role has been resolved from the backend session.</p>
          <div style={{ background: '#f9fafb', borderRadius: '12px', padding: '16px', border: '1px solid #e5e7eb' }}>
            <p style={{ margin: '0 0 6px', fontWeight: 700 }}>Current user</p>
            <p style={{ margin: '0 0 6px' }}>Name: {user.fullName}</p>
            <p style={{ margin: '0 0 6px' }}>Email: {user.email}</p>
            <p style={{ margin: 0 }}>Role: STUDENT</p>
          </div>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginTop: 0 }}>Your result / grade</h2>
          <p style={{ margin: 0, color: '#6b7280' }}>No final student grade is currently available in this demo flow yet.</p>
        </section>
      </div>
    </main>
  );
}

function MentorDashboard({ user }: { user: AppUser }) {
  return (
    <main style={{ minHeight: 'calc(100vh - 72px)', background: '#f3f4f6', padding: '32px 16px', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', display: 'grid', gap: '20px' }}>
        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '28px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <p style={{ margin: 0, color: '#2563eb', fontWeight: 700 }}>Mentor dashboard</p>
          <h1 style={{ margin: '10px 0 8px', fontSize: '32px' }}>Welcome, {user.fullName}</h1>
          <div style={{ display: 'inline-flex', padding: '6px 12px', borderRadius: '999px', background: '#e0f2fe', color: '#075985', fontWeight: 700 }}>MENTOR</div>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginTop: 0 }}>Mentor workspace</h2>
          <p style={{ margin: '0 0 10px', color: '#374151' }}>This area is the mentor landing page for the authenticated mentor role.</p>
          <div style={{ background: '#f9fafb', borderRadius: '12px', padding: '16px', border: '1px solid #e5e7eb' }}>
            <p style={{ margin: '0 0 6px', fontWeight: 700 }}>Current user</p>
            <p style={{ margin: '0 0 6px' }}>Name: {user.fullName}</p>
            <p style={{ margin: '0 0 6px' }}>Email: {user.email}</p>
            <p style={{ margin: 0 }}>Role: MENTOR</p>
          </div>
        </section>

        <section style={{ background: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)' }}>
          <h2 style={{ marginTop: 0 }}>Future mentor functionality</h2>
          <p style={{ margin: 0, color: '#6b7280' }}>Mentor CV upload is reserved for the admin matching workflow and is not part of the mentor landing experience.</p>
        </section>
      </div>
    </main>
  );
}

function LoginScreen({ onLogin, loading, error, notice }: { onLogin: (email: string, password: string) => Promise<void>; loading: boolean; error: string | null; notice: string | null; }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onLogin(email, password);
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', fontFamily: 'Arial, sans-serif', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '460px', background: '#ffffff', borderRadius: '16px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', padding: '32px' }}>
        <h1 style={{ margin: '0 0 8px', textAlign: 'center' }}>Sign in</h1>
        <p style={{ textAlign: 'center', margin: '0 0 24px', color: '#4b5563' }}>Sign in with your invited university account.</p>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}>Email</label>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid #d1d5db' }} />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 600 }}>Password</label>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid #d1d5db' }} />
          </div>

          {error && <div style={{ color: '#b91c1c', background: '#fee2e2', borderRadius: '8px', padding: '10px 12px' }}>{error}</div>}
          {notice && <div style={{ color: '#166534', background: '#dcfce7', borderRadius: '8px', padding: '10px 12px' }}>{notice}</div>}

          <button type="submit" disabled={loading} style={{ padding: '12px 16px', border: 'none', borderRadius: '10px', background: '#2563eb', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

      </div>
    </main>
  );
}

function SetPasswordScreen({ onSetPassword, loading, error }: { onSetPassword: (password: string) => Promise<void>; loading: boolean; error: string | null; }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < 8) {
      setValidationError('Use a password with at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setValidationError('The passwords do not match.');
      return;
    }
    setValidationError(null);
    await onSetPassword(password);
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', fontFamily: 'Arial, sans-serif', padding: '24px' }}>
      <div style={{ width: '100%', maxWidth: '460px', background: '#ffffff', borderRadius: '16px', boxShadow: '0 10px 30px rgba(0,0,0,0.08)', padding: '32px' }}>
        <h1 style={{ margin: '0 0 8px', textAlign: 'center' }}>Set your password</h1>
        <p style={{ textAlign: 'center', margin: '0 0 24px', color: '#4b5563' }}>Choose a password for your invited university account.</p>
        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '16px' }}>
          <label style={{ display: 'grid', gap: '8px', fontWeight: 600 }}>
            New password
            <input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid #d1d5db' }} />
          </label>
          <label style={{ display: 'grid', gap: '8px', fontWeight: 600 }}>
            Confirm password
            <input type="password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid #d1d5db' }} />
          </label>
          {(validationError || error) && <div style={{ color: '#b91c1c', background: '#fee2e2', borderRadius: '8px', padding: '10px 12px' }}>{validationError || error}</div>}
          <button type="submit" disabled={loading} style={{ padding: '12px 16px', border: 'none', borderRadius: '10px', background: '#2563eb', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            {loading ? 'Saving...' : 'Save password'}
          </button>
        </form>
      </div>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const syncSession = async (accessToken: string | null) => {
      const currentRequestId = ++requestId;
      if (!accessToken) {
        if (active) {
          setSession(null);
          setAuthReady(true);
        }
        return;
      }
      try {
        const response = await fetch(buildApiUrl('/api/auth/session'), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.message || 'Unable to resolve the account profile.');
        }
        if (active && currentRequestId === requestId) {
          setSession({ token: accessToken, user: result.user as AppUser });
          setLoginError(null);
        }
      } catch (error) {
        if (active && currentRequestId === requestId) {
          setSession(null);
          setLoginError(error instanceof Error ? error.message : 'Unable to restore the session.');
        }
      } finally {
        if (active && currentRequestId === requestId) {
          setAuthReady(true);
        }
      }
    };

    if (!supabase) {
      setLoginError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the root .env file.');
      setAuthReady(true);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, authSession) => {
      void syncSession(authSession?.access_token ?? null);
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        setLoginError(error.message);
      }
      void syncSession(data.session?.access_token ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleLogin = async (email: string, password: string) => {
    setLoginLoading(true);
    setLoginError(null);
    setLoginNotice(null);

    try {
      if (!supabase) {
        throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the root .env file.');
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        throw error;
      }
      if (!data.session) {
        throw new Error('Supabase did not return an authenticated session.');
      }

      const response = await fetch(buildApiUrl('/api/auth/session'), {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const result = await response.json();
      if (!response.ok || !result.user) {
        await supabase.auth.signOut();
        throw new Error(result.message || 'This account has no provisioned application profile. Contact an administrator.');
      }

      setSession({ token: data.session.access_token, user: result.user as AppUser });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sign in.';
      setLoginError(message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSetPassword = async (password: string) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      if (!supabase) {
        throw new Error('Supabase is not configured.');
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        throw error;
      }
      await supabase.auth.signOut();
      window.history.replaceState({}, document.title, window.location.pathname);
      setSession(null);
      setLoginNotice('Password set. Sign in with your new password.');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Unable to set the password.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase?.auth.signOut();
    setSession(null);
    setLoginError(null);
  };

  if (!authReady) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f3f4f6' }}>Loading...</div>;
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} loading={loginLoading} error={loginError} notice={loginNotice} />;
  }

  if (new URLSearchParams(window.location.search).get('set-password') === '1') {
    return <SetPasswordScreen onSetPassword={handleSetPassword} loading={loginLoading} error={loginError} />;
  }

  const role = session.user.role;

  return (
    <div style={{ fontFamily: 'Arial, sans-serif' }}>
      <header style={{ background: '#111827', color: '#fff', padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <strong>{session.user.fullName} · {session.user.email}</strong>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>{role}</div>
        </div>
        <button type="button" onClick={handleLogout} style={{ background: '#ffffff', color: '#111827', border: 'none', borderRadius: '999px', padding: '8px 14px', fontWeight: 700, cursor: 'pointer' }}>Logout</button>
      </header>

      {role === 'ADMIN' ? (
        <MatchingDashboard sessionToken={session.token} />
      ) : role === 'STUDENT' ? (
        <StudentDashboard user={session.user} />
      ) : (
        <MentorDashboard user={session.user} />
      )}
    </div>
  );
}

export default App;
