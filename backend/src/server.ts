import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './supabase';

dotenv.config({ path: '../.env' });

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/supabase-status', (_req, res) => {
  const isConfigured = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;

  res.json({
    configured: isConfigured,
    clientReady: !!supabase,
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
