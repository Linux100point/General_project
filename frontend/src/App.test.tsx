import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, getActionErrorMessage } from './actionErrors';
import { MatchingDashboard } from './App';
import { resolveApiBaseUrl } from './config';

const persistedSession = {
  mentors: [{ id: 'mentor-db', name: 'Persisted Mentor', cvFileIds: [] }],
  students: [{
    id: 'student-db',
    name: 'Persisted Student',
    desiredSkills: 'TypeScript',
    topicsForExpertConsultation: 'API design',
    projectOverview: 'Persisted project',
    mentorshipSupportNeeds: 'Architecture feedback',
  }],
  currentRecommendations: [{
    id: 'recommendation-db',
    mentorId: 'mentor-db',
    studentId: 'student-db',
    score: 93,
    reason: 'Loaded from the persisted session.',
    category: 'selected' as const,
    source: 'ai' as const,
  }],
  originalRecommendations: [{
    id: 'original-db',
    mentorId: 'mentor-db',
    studentId: 'student-db',
    score: 93,
    reason: 'Original persisted recommendation.',
    category: 'selected' as const,
    source: 'ai' as const,
  }],
  finalAssignments: [{ mentorId: 'mentor-db', studentId: 'student-db' }],
  uploadedMentorFiles: [],
};

function createManualAssignmentSession(finalAssignments: Array<{ mentorId: string; studentId: string }> = []) {
  return {
    mentors: [
      { id: 'mentor-one', name: 'Mentor One', cvFileIds: [] },
      { id: 'mentor-two', name: 'Mentor Two', cvFileIds: [] },
    ],
    students: [
      { id: 'student-a', studentId: 'S001', name: 'Student A', desiredSkills: '', topicsForExpertConsultation: '', projectOverview: '', mentorshipSupportNeeds: '' },
      { id: 'student-b', studentId: 'S002', name: 'Student B', desiredSkills: '', topicsForExpertConsultation: '', projectOverview: '', mentorshipSupportNeeds: '' },
    ],
    currentRecommendations: [
      { id: 'ai-a', mentorId: 'mentor-one', studentId: 'student-a', score: 88, reason: 'AI reason for Student A.', category: 'selected' as const, source: 'ai' as const },
      { id: 'ai-b', mentorId: 'mentor-two', studentId: 'student-b', score: 72, reason: 'AI reason for Student B.', category: 'alternative' as const, source: 'ai' as const },
    ],
    originalRecommendations: [
      { id: 'ai-a', mentorId: 'mentor-one', studentId: 'student-a', score: 88, reason: 'AI reason for Student A.', category: 'selected' as const, source: 'ai' as const },
      { id: 'ai-b', mentorId: 'mentor-two', studentId: 'student-b', score: 72, reason: 'AI reason for Student B.', category: 'alternative' as const, source: 'ai' as const },
    ],
    finalAssignments,
    uploadedMentorFiles: [],
  };
}

function getMentorCard(mentorName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: mentorName });
  return heading.parentElement?.parentElement as HTMLElement;
}

function getFinalAssignmentSection(mentorName: string) {
  const card = within(getMentorCard(mentorName));
  return within(card.getByText('FINAL ASSIGNMENTS').parentElement as HTMLElement);
}

function getUnassignedSection() {
  const heading = screen.getByRole('heading', { name: 'Unassigned Students' });
  return within(heading.parentElement as HTMLElement);
}

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    blob: async () => new Blob(['synthetic export']),
  } as Response;
}

describe('MatchingDashboard', () => {
  let requests: Array<[RequestInfo | URL, RequestInit | undefined]>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requests = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: persistedSession });
      if (path.startsWith('/api/admin/matching/upload-')) return response(200, { success: true, session: persistedSession });
      if (path === '/api/admin/matching/run') return response(500, { error: 'Sensitive internal stack details.' });
      return response(200, { success: true, session: persistedSession });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads persisted session data on mount with the current access token', async () => {
    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);

    expect(await screen.findByRole('heading', { name: 'Persisted Mentor' })).toBeTruthy();
    expect(screen.getAllByText('Persisted Student').length).toBeGreaterThan(0);
    expect(Array.from(document.querySelectorAll('p')).some((paragraph) => paragraph.textContent?.includes('Loaded from the persisted session.'))).toBe(true);

    const sessionRequest = requests.find(([input]) => new URL(String(input)).pathname === '/api/admin/matching/session');
    expect(sessionRequest?.[1]?.method ?? 'GET').toBe('GET');
    expect(new Headers(sessionRequest?.[1]?.headers).get('Authorization')).toBe('Bearer diagnostic-access-token');
    expect(requests.filter(([input]) => new URL(String(input)).pathname === '/api/admin/matching/session')).toHaveLength(1);
  });

  it('sends mentor uploads as multipart FormData with the files field and shows success', async () => {
    const { container } = render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Persisted Mentor' });

    const input = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    const file = new File(['synthetic PDF'], 'mentor.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    const button = screen.getByRole('button', { name: 'Upload mentor CVs' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('Mentor CVs uploaded successfully.')).toBeTruthy();
    const request = requests.find(([url]) => String(url).includes('/upload-mentor-cvs'));
    const body = request?.[1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll('files')).toHaveLength(1);
    expect(new Headers(request?.[1]?.headers).get('Authorization')).toBe('Bearer diagnostic-access-token');
    expect(new Headers(request?.[1]?.headers).has('Content-Type')).toBe(false);
  });

  it('sends student uploads as multipart FormData with the file field and shows success', async () => {
    const { container } = render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Persisted Mentor' });

    const input = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    const file = new File(['synthetic XLSX'], 'students.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.change(input, { target: { files: [file] } });
    const button = screen.getByRole('button', { name: 'Upload student Excel' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('Student spreadsheet uploaded successfully.')).toBeTruthy();
    const request = requests.find(([url]) => String(url).includes('/upload-students-excel'));
    const body = request?.[1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBe(file);
    expect(new Headers(request?.[1]?.headers).get('Authorization')).toBe('Bearer diagnostic-access-token');
  });

  it('shows a safe visible error when an action receives HTTP 500', async () => {
    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Persisted Mentor' });
    fireEvent.click(screen.getByRole('button', { name: 'Run Matching' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The server could not complete the request. Try again later.');
    expect(alert.textContent).not.toContain('Sensitive internal stack details.');
  });

  it('shows a visible network error when an action cannot reach the backend', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      if (new URL(String(input)).pathname === '/api/health') return response(200, { status: 'ok' });
      if (new URL(String(input)).pathname === '/api/admin/matching/session') return response(200, { session: persistedSession });
      throw new TypeError('Network request failed.');
    });
    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Persisted Mentor' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not reach the server. Check your connection and try again.');
  });

  it('requires an explicit student choice and assigns different students to different mentors', async () => {
    const initialSession = createManualAssignmentSession();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: initialSession });
      return response(200, { success: true, session: initialSession });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    const addForMentorOne = screen.getAllByRole('button', { name: 'Add student' })[0];
    expect((addForMentorOne as HTMLButtonElement).disabled).toBe(true);
    const selectForMentorOne = screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor One' });
    fireEvent.change(selectForMentorOne, { target: { value: 'student-b' } });
    fireEvent.click(addForMentorOne);

    const mentorOneAssignments = getFinalAssignmentSection('Mentor One');
    expect(mentorOneAssignments.getByText('Student B')).toBeTruthy();
    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
    expect(getUnassignedSection().queryByText('S002 — Student B')).toBeNull();

    const selectForMentorTwo = screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor Two' });
    fireEvent.change(selectForMentorTwo, { target: { value: 'student-a' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add student' })[1]);

    expect(getFinalAssignmentSection('Mentor One').getByText('Student B')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getAllByText('Student A')).toHaveLength(1);
    expect(screen.getByText('No unassigned students.')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Added manually')).toBeTruthy();
    expect(within(getMentorCard('Mentor Two')).getByText((_, element) => element?.textContent === 'Student B — 72%')).toBeTruthy();
  });

  it('renders an AI-recommended final assignment once with its score, full reason, and badge', async () => {
    const session = {
      ...createManualAssignmentSession([{ mentorId: 'mentor-one', studentId: 'student-a' }]),
      currentRecommendations: [
        { id: 'ai-a', mentorId: 'mentor-one', studentId: 'student-a', score: 99, reason: 'Full explanation: the mentor has directly relevant Spring Boot and PostgreSQL experience for this project.', category: 'selected' as const, source: 'ai' as const },
        { id: 'duplicate-alt-a', mentorId: 'mentor-one', studentId: 'student-a', score: 81, reason: 'A duplicate alternative record.', category: 'alternative' as const, source: 'ai' as const },
        { id: 'alt-b', mentorId: 'mentor-one', studentId: 'student-b', score: 72, reason: 'Valid alternative.', category: 'alternative' as const, source: 'ai' as const },
      ],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    const mentorCard = within(getMentorCard('Mentor One'));
    expect(mentorCard.getAllByText('Student A')).toHaveLength(1);
    expect(mentorCard.getByText('99%')).toBeTruthy();
    expect(mentorCard.getByText('Why: Full explanation: the mentor has directly relevant Spring Boot and PostgreSQL experience for this project.')).toBeTruthy();
    expect(mentorCard.getByText('AI recommendation')).toBeTruthy();
    expect(mentorCard.queryByText('AI SELECTED RECOMMENDATIONS')).toBeNull();
    expect(mentorCard.getByText('Student B')).toBeTruthy();
    expect(mentorCard.queryByText('A duplicate alternative record.')).toBeNull();
  });

  it('uses the known student identity instead of a placeholder and preserves real names containing Student', async () => {
    const session = {
      ...createManualAssignmentSession(),
      students: [
        { id: 'internal-student-b', studentId: 'S017', name: 'Example Student Name', desiredSkills: '', topicsForExpertConsultation: '', projectOverview: '', mentorshipSupportNeeds: '' },
        { id: 'internal-student-c', studentId: 'S018', name: 'Student 3', desiredSkills: '', topicsForExpertConsultation: '', projectOverview: '', mentorshipSupportNeeds: '' },
      ],
      currentRecommendations: [
        { id: 'alt-known', mentorId: 'mentor-one', studentId: 'S017', score: 81, reason: 'Known real student.', category: 'alternative' as const, source: 'ai' as const },
        { id: 'alt-missing', mentorId: 'mentor-one', studentId: 'S099', score: 78, reason: 'Unknown student record.', category: 'alternative' as const, source: 'ai' as const },
        { id: 'alt-placeholder', mentorId: 'mentor-one', studentId: 'S018', score: 74, reason: 'Placeholder name with a known student ID.', category: 'alternative' as const, source: 'ai' as const },
      ],
      finalAssignments: [],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    const mentorCard = within(getMentorCard('Mentor One'));
    expect(mentorCard.getByText('Example Student Name')).toBeTruthy();
    expect(mentorCard.getByText((_, element) => element?.textContent === 'Example Student Name — 81%')).toBeTruthy();
    expect(mentorCard.queryByText('S017')).toBeNull();
    expect(mentorCard.queryByText('S099')).toBeNull();
    expect(mentorCard.queryByText('S018')).toBeNull();
    expect(mentorCard.queryByText((_, element) => element?.textContent === 'S017 — 81%')).toBeNull();
    expect(mentorCard.queryByText((_, element) => element?.textContent === 'S099 — 78%')).toBeNull();
    expect(mentorCard.queryByText((_, element) => element?.textContent === 'S018 — 74%')).toBeNull();
    expect(mentorCard.queryByText('Student 3')).toBeNull();
  });

  it('does not render duplicate final assignment cards for the same student', async () => {
    const session = createManualAssignmentSession([
      { mentorId: 'mentor-one', studentId: 'student-a' },
      { mentorId: 'mentor-one', studentId: 'student-a' },
      { mentorId: 'mentor-two', studentId: 'student-a' },
    ]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    expect(getFinalAssignmentSection('Mentor One').getAllByText('Student A')).toHaveLength(1);
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student A')).toBeNull();
  });

  it('accounts for all 17 uploaded students when 14 have final assignments', async () => {
    const students = Array.from({ length: 17 }, (_, index) => ({
      id: `internal-${index + 1}`,
      studentId: `S${String(index + 1).padStart(3, '0')}`,
      name: `Learner Name ${index + 1}`,
      desiredSkills: '',
      topicsForExpertConsultation: '',
      projectOverview: '',
      mentorshipSupportNeeds: '',
    }));
    const finalAssignments = students.slice(0, 14).map((student, index) => ({
      mentorId: index % 2 === 0 ? 'mentor-one' : 'mentor-two',
      studentId: student.studentId,
    }));
    const session = { ...createManualAssignmentSession(), students, finalAssignments };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    const assignedNames = [
      ...getFinalAssignmentSection('Mentor One').getAllByText(/^Learner Name \d+$/),
      ...getFinalAssignmentSection('Mentor Two').getAllByText(/^Learner Name \d+$/),
    ];
    expect(assignedNames).toHaveLength(14);
    for (const [index, student] of students.slice(0, 14).entries()) {
      const mentorName = finalAssignments[index].mentorId === 'mentor-one' ? 'Mentor One' : 'Mentor Two';
      expect(getFinalAssignmentSection(mentorName).getAllByText(student.name)).toHaveLength(1);
      expect(getUnassignedSection().queryByText(student.name)).toBeNull();
    }
    for (const student of students.slice(14)) {
      expect(getUnassignedSection().getByText(student.name)).toBeTruthy();
    }
  });

  it('returns assignments with unknown mentors to Unassigned Students', async () => {
    const session = createManualAssignmentSession([{ mentorId: 'deleted-mentor', studentId: 'student-a' }]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    expect(getFinalAssignmentSection('Mentor One').queryByText('Student A')).toBeNull();
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student A')).toBeNull();
    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
  });

  it('keeps a student mentioned by duplicate recommendations unassigned unless finalAssignments assigns them', async () => {
    const session = {
      ...createManualAssignmentSession(),
      currentRecommendations: [
        { id: 'selected-one', mentorId: 'mentor-one', studentId: 'student-a', score: 91, reason: 'First recommendation.', category: 'selected' as const, source: 'ai' as const },
        { id: 'selected-two', mentorId: 'mentor-two', studentId: 'student-a', score: 87, reason: 'Duplicate recommendation.', category: 'selected' as const, source: 'ai' as const },
      ],
      finalAssignments: [],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor One').queryByText('Student A')).toBeNull();
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student A')).toBeNull();
  });

  it('does not count recommendations in Alternatives as final assignments', async () => {
    const session = {
      ...createManualAssignmentSession(),
      currentRecommendations: [
        { id: 'alternative-only', mentorId: 'mentor-one', studentId: 'student-b', score: 81, reason: 'Alternative only.', category: 'alternative' as const, source: 'ai' as const },
        { id: 'selected-for-another', mentorId: 'mentor-two', studentId: 'student-b', score: 77, reason: 'Another mentor recommendation.', category: 'selected' as const, source: 'ai' as const },
      ],
      finalAssignments: [],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session });
      return response(200, { success: true, session });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });

    expect(getUnassignedSection().getByText('Student B')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor One').queryByText('Student B')).toBeNull();
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student B')).toBeNull();
    expect(within(getMentorCard('Mentor One')).getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === 'Student B — 81%')).toBeTruthy();
  });

  it('assigns the chosen unassigned student and keeps the other student unassigned until selected', async () => {
    const initialSession = createManualAssignmentSession();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: initialSession });
      return response(200, { success: true, session: initialSession });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor One' }), { target: { value: 'student-a' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add student' })[0]);

    expect(getFinalAssignmentSection('Mentor One').getByText('Student A')).toBeTruthy();
    expect(getUnassignedSection().getByText('Student B')).toBeTruthy();
    expect(getUnassignedSection().queryByText('Student A')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor Two' }), { target: { value: 'student-b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add student' })[1]);
    expect(getFinalAssignmentSection('Mentor One').getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Student B')).toBeTruthy();
    expect(screen.getByText('No unassigned students.')).toBeTruthy();
  });

  it('does not automatically assign the first unassigned student when another is explicitly selected', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: createManualAssignmentSession() });
      return response(200, { success: true, session: createManualAssignmentSession() });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor One' }), { target: { value: 'student-b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add student' })[0]);

    const finalAssignments = getFinalAssignmentSection('Mentor One');
    expect(finalAssignments.getByText('Student B')).toBeTruthy();
    expect(finalAssignments.queryByText('Student A')).toBeNull();
    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
  });

  it('moves a student to one mentor and removing the assignment returns the student to unassigned', async () => {
    const initialSession = createManualAssignmentSession([
      { mentorId: 'mentor-one', studentId: 'student-a' },
      { mentorId: 'mentor-two', studentId: 'student-b' },
    ]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: initialSession });
      return response(200, { success: true, session: initialSession });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Move Student A to mentor' }), { target: { value: 'mentor-two' } });

    expect(getFinalAssignmentSection('Mentor One').queryByText('Student A')).toBeNull();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Student B')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Student A from Mentor Two' }));
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student A')).toBeNull();
    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').getByText('Student B')).toBeTruthy();
  });

  it('reset restores original AI assignments without changing AI recommendations', async () => {
    const originalSession = createManualAssignmentSession([{ mentorId: 'mentor-one', studentId: 'student-a' }]);
    let currentSession = originalSession;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: currentSession });
      if (path === '/api/admin/matching/reset') {
        currentSession = {
          ...currentSession,
          finalAssignments: originalSession.finalAssignments,
          currentRecommendations: originalSession.originalRecommendations,
        };
        return response(200, { success: true, session: currentSession });
      }
      return response(200, { success: true, session: currentSession });
    });

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Move Student A to mentor' }), { target: { value: 'mentor-two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to AI Recommendations' }));

    await screen.findByText('Recommendations restored successfully.');
    expect(getFinalAssignmentSection('Mentor One').getByText('Student A')).toBeTruthy();
    expect(getFinalAssignmentSection('Mentor Two').queryByText('Student A')).toBeNull();
    expect(screen.getByText('Why: AI reason for Student A.')).toBeTruthy();
    expect(within(getMentorCard('Mentor Two')).getByText((_, element) => element?.textContent === 'Student B — 72%')).toBeTruthy();
  });

  it('saves manual final assignments and retains them when the session is reloaded', async () => {
    let currentSession = createManualAssignmentSession();
    let savedBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([input, init]);
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response(200, { status: 'ok' });
      if (path === '/api/admin/matching/session') return response(200, { session: currentSession });
      if (path === '/api/admin/matching/save') {
        savedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        currentSession = { ...currentSession, finalAssignments: savedBody.finalAssignments as typeof currentSession.finalAssignments };
        return response(200, { success: true, session: currentSession });
      }
      return response(200, { success: true, session: currentSession });
    });

    const firstRender = render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose unassigned student for Mentor Two' }), { target: { value: 'student-b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add student' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByText('Changes saved successfully.');

    expect(savedBody?.finalAssignments).toEqual([{ mentorId: 'mentor-two', studentId: 'student-b' }]);
    expect(currentSession.currentRecommendations).toEqual(currentSession.originalRecommendations);
    firstRender.unmount();

    render(<MatchingDashboard sessionToken="diagnostic-access-token" />);
    await screen.findByRole('heading', { name: 'Mentor One' });
    const mentorTwoAssignments = getFinalAssignmentSection('Mentor Two');
    expect(mentorTwoAssignments.getByText('Student B')).toBeTruthy();
    expect(getUnassignedSection().getByText('Student A')).toBeTruthy();
  });
});

describe('visible API error messages', () => {
  it.each([
    [new ApiRequestError(401), 'Your session has expired. Sign in again.'],
    [new ApiRequestError(403), 'Your account is not authorized to perform this action.'],
    [new ApiRequestError(404), 'The requested service was not found.'],
    [new ApiRequestError(400), 'Check the selected file and required data, then try again.'],
    [new ApiRequestError(500), 'The server could not complete the request. Try again later.'],
    [new TypeError('network'), 'Could not reach the server. Check your connection and try again.'],
  ])('maps %s to a user-safe message', (error, message) => {
    expect(getActionErrorMessage(error)).toBe(message);
  });
});

describe('production API URL configuration', () => {
  it('uses localhost only in development when no API URL is configured', () => {
    expect(resolveApiBaseUrl(undefined, true)).toBe('http://localhost:3001');
  });

  it('requires VITE_API_BASE_URL when not in development', () => {
    expect(() => resolveApiBaseUrl(undefined, false)).toThrow(/Missing VITE_API_BASE_URL/);
  });

  it('normalizes a configured production API URL', () => {
    expect(resolveApiBaseUrl('https://backend.example.test///', false)).toBe('https://backend.example.test');
  });
});