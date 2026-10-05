import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('Persisted Student')).toBeTruthy();
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