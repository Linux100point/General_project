import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalFileStorage, SupabaseFileStorage, createStorageProvider, type StorageProviderName } from './LocalFileStorage';

test('local storage still works in development', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-storage-'));
  const storage = new LocalFileStorage(tmpDir);
  const source = path.join(tmpDir, 'source.pdf');
  fs.writeFileSync(source, 'pdf-bytes');

  const saved = await storage.save({
    path: source,
    originalname: 'mentor.pdf',
    mimetype: 'application/pdf',
    size: 9,
  } as Express.Multer.File, 'mentor-cv');

  assert.equal(saved.kind, 'mentor-cv');
  assert.equal(fs.existsSync(saved.storagePath), true);
  const payload = await storage.readFile(saved);
  assert.equal(payload.toString('utf8'), 'pdf-bytes');
});

test('production storage provider selection prefers Supabase when configured', () => {
  const original = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  try {
    const provider = createStorageProvider();
    assert.equal(provider, 'supabase');
  } finally {
    if (original === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = original;

    if (serviceRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRole;
  }
});

test('SupabaseFileStorage can upload and read a buffer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-storage-'));
  const filePath = path.join(tmpDir, 'example.pdf');
  fs.writeFileSync(filePath, 'stored-blob');

  const calls: Array<{ bucket: string; path: string; data: Buffer; options?: Record<string, unknown> }> = [];
  const storage = new SupabaseFileStorage({
    async upload(bucket: string, pathName: string, data: Buffer | Uint8Array | Blob | ArrayBuffer, options?: Record<string, unknown>) {
      let payload: Uint8Array;
      if (data instanceof Blob) {
        payload = new Uint8Array(await data.arrayBuffer());
      } else if (data instanceof ArrayBuffer) {
        payload = new Uint8Array(data);
      } else {
        payload = new Uint8Array(data as Uint8Array);
      }

      calls.push({ bucket, path: pathName, data: Buffer.from(payload), options });
      return { data: { path: pathName }, error: null };
    },
    async download(bucket: string, pathName: string) {
      const match = calls.find((call) => call.bucket === bucket && call.path === pathName);
      if (!match) {
        return { data: new Blob([Buffer.from('stored-blob')]), error: null };
      }
      return { data: new Blob([match.data.toString('utf8')]), error: null };
    },
  } as never, 'project-files');

  const record = await storage.save({
    path: filePath,
    originalname: 'example.pdf',
    mimetype: 'application/pdf',
    size: 12,
  } as Express.Multer.File, 'mentor-cv');

  const content = await storage.readFile(record);
  assert.equal(content.toString('utf8'), 'stored-blob');
  assert.equal((calls[0]?.bucket ?? 'project-files'), 'project-files');
  assert.equal(record.kind, 'mentor-cv');
  assert.equal((record as { storagePath: string }).storagePath.startsWith('mentors/'), true);
});

test('createStorageProvider exposes the typed provider name', () => {
  const original = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const localProvider: StorageProviderName = createStorageProvider();
  assert.equal(localProvider, 'local');

  if (original === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = original;

  if (serviceRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRole;
});
