import { useEffect, useState } from 'react';

const API_URL = 'http://localhost:3001/api/health';

function App() {
  const [status, setStatus] = useState<string>('Checking backend...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          throw new Error(`Backend responded with status ${response.status}`);
        }

        const data = (await response.json()) as { status?: string };
        setStatus(data.status === 'ok' ? 'Backend OK' : 'Backend responded unexpectedly');
        setError(null);
      } catch (err) {
        setStatus('Backend unavailable');
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    };

    fetchHealth();
  }, []);

  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f3f4f6',
      fontFamily: 'Arial, sans-serif'
    }}>
      <div style={{
        padding: '2rem 3rem',
        borderRadius: '16px',
        background: '#ffffff',
        boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
        textAlign: 'center'
      }}>
        <h1 style={{ marginBottom: '0.5rem' }}>University Project</h1>
        <p style={{ fontSize: '1.25rem', margin: 0, color: '#111827' }}>{status}</p>
        {error && (
          <p style={{ marginTop: '0.75rem', color: '#b91c1c' }}>Error: {error}</p>
        )}
      </div>
    </main>
  );
}

export default App;
