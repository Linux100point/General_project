import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { UploadedFileRecord } from '../../types';

export type FileStorageKind = 'mentor-cv' | 'students-excel' | 'exports';
export type StorageProviderName = 'local' | 'supabase';

export interface StorageClientLike {
  upload: (bucket: string, objectPath: string, data: Buffer | Uint8Array | Blob | ArrayBuffer, options?: Record<string, unknown>) => Promise<{ data?: { path?: string } | null; error: { message: string } | null }>;
  download: (bucket: string, objectPath: string) => Promise<{ data: Blob | ArrayBuffer | Uint8Array | Buffer | string | null; error: { message: string } | null }>;
}

export function createSupabaseStorageClient(client: { storage?: { from: (bucket: string) => { upload: (objectPath: string, data: Buffer | Uint8Array | Blob | ArrayBuffer, options?: Record<string, unknown>) => Promise<{ data: { path?: string } | null; error: { message: string } | null }>; download: (objectPath: string) => Promise<{ data: Blob | ArrayBuffer | Uint8Array | Buffer | string | null; error: { message: string } | null }> } } } | null | undefined): StorageClientLike | null {
  const storageClient = client?.storage;
  if (!storageClient) {
    return null;
  }

  return {
    upload: async (bucket, objectPath, data, options) => {
      const { data: uploadData, error } = await storageClient.from(bucket).upload(objectPath, data as never, options as never);
      return { data: uploadData ?? null, error: error ? { message: error.message || 'Unable to upload to Supabase Storage.' } : null };
    },
    download: async (bucket, objectPath) => {
      const { data, error } = await storageClient.from(bucket).download(objectPath);
      return {
        data: data ?? null,
        error: error ? { message: error.message || 'Unable to download from Supabase Storage.' } : null,
      };
    },
  };
}

export interface FileStorage {
  save(file: Express.Multer.File, kind: FileStorageKind): Promise<UploadedFileRecord>;
  saveBuffer(buffer: Buffer, originalName: string, kind: FileStorageKind, mimeType?: string): Promise<UploadedFileRecord>;
  readFile(record: UploadedFileRecord): Promise<Buffer>;
}

export function createStorageProvider(): StorageProviderName {
  const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  return hasSupabase ? 'supabase' : 'local';
}

export class LocalFileStorage implements FileStorage {
  private readonly baseDir: string;

  constructor(baseDir = path.join(process.cwd(), 'uploads')) {
    this.baseDir = baseDir;
    this.ensureDirectories();
  }

  private ensureDirectories() {
    fs.mkdirSync(path.join(this.baseDir, 'mentor-cvs'), { recursive: true });
    fs.mkdirSync(path.join(this.baseDir, 'student-excel'), { recursive: true });
    fs.mkdirSync(path.join(this.baseDir, 'exports'), { recursive: true });
  }

  private buildTargetDirectory(kind: FileStorageKind): string {
    if (kind === 'mentor-cv') return 'mentor-cvs';
    if (kind === 'students-excel') return 'student-excel';
    return 'exports';
  }

  async save(file: Express.Multer.File, kind: FileStorageKind): Promise<UploadedFileRecord> {
    const timestamp = Date.now();
    const random = crypto.randomBytes(6).toString('hex');
    const extension = path.extname(file.originalname) || '';
    const targetDirectory = this.buildTargetDirectory(kind);
    const targetName = `${timestamp}-${random}${extension}`;
    const storagePath = path.join(this.baseDir, targetDirectory, targetName);

    fs.copyFileSync(file.path, storagePath);
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return {
      id: crypto.randomUUID(),
      originalName: file.originalname,
      filename: targetName,
      storagePath,
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      kind,
    };
  }

  async saveBuffer(buffer: Buffer, originalName: string, kind: FileStorageKind, mimeType = 'application/octet-stream'): Promise<UploadedFileRecord> {
    const timestamp = Date.now();
    const random = crypto.randomBytes(6).toString('hex');
    const extension = path.extname(originalName) || '';
    const targetDirectory = this.buildTargetDirectory(kind);
    const targetName = `${timestamp}-${random}${extension}`;
    const storagePath = path.join(this.baseDir, targetDirectory, targetName);

    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, buffer);

    return {
      id: crypto.randomUUID(),
      originalName,
      filename: targetName,
      storagePath,
      mimeType,
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
      kind,
    };
  }

  async readFile(record: UploadedFileRecord): Promise<Buffer> {
    return fs.readFileSync(record.storagePath);
  }
}

export class SupabaseFileStorage implements FileStorage {
  private readonly bucketName: string;

  constructor(
    private readonly client: StorageClientLike | null = null,
    bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'project-files',
  ) {
    this.bucketName = bucketName;
  }

  private resolveClient(): StorageClientLike {
    if (this.client) {
      return this.client;
    }

    throw new Error('Supabase storage is not configured.');
  }

  private buildObjectPath(kind: FileStorageKind, originalName: string): string {
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `file-${Date.now()}`;
    const folder = kind === 'mentor-cv' ? 'mentors' : kind === 'students-excel' ? 'students' : 'exports';
    return `${folder}/${Date.now()}-${crypto.randomUUID()}-${sanitizedName}`;
  }

  async save(file: Express.Multer.File, kind: FileStorageKind): Promise<UploadedFileRecord> {
    const objectPath = this.buildObjectPath(kind, file.originalname);
    const fileBuffer = fs.existsSync(file.path) ? fs.readFileSync(file.path) : Buffer.alloc(0);
    const client = this.resolveClient();
    const uploadBuffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer as ArrayBuffer);
    const { error } = await client.upload(this.bucketName, objectPath, uploadBuffer, {
      upsert: true,
      contentType: file.mimetype || 'application/octet-stream',
    });

    if (error) {
      throw new Error(error.message || 'Unable to upload to Supabase Storage.');
    }

    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return {
      id: crypto.randomUUID(),
      originalName: file.originalname,
      filename: objectPath,
      storagePath: objectPath,
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      kind,
    };
  }

  async saveBuffer(buffer: Buffer, originalName: string, kind: FileStorageKind, mimeType = 'application/octet-stream'): Promise<UploadedFileRecord> {
    const objectPath = this.buildObjectPath(kind, originalName);
    const client = this.resolveClient();
    const uploadBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
    const { error } = await client.upload(this.bucketName, objectPath, uploadBuffer, {
      upsert: true,
      contentType: mimeType,
    });

    if (error) {
      throw new Error(error.message || 'Unable to upload the generated export to Supabase Storage.');
    }

    return {
      id: crypto.randomUUID(),
      originalName,
      filename: objectPath,
      storagePath: objectPath,
      mimeType,
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
      kind,
    };
  }

  async readFile(record: UploadedFileRecord): Promise<Buffer> {
    const client = this.resolveClient();
    const { data, error } = await client.download(this.bucketName, record.storagePath);

    if (error) {
      throw new Error(error.message || 'Unable to download from Supabase Storage.');
    }

    if (!data) {
      return Buffer.alloc(0);
    }

    if (data instanceof Blob) {
      return Buffer.from(await data.arrayBuffer());
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    if (Buffer.isBuffer(data)) {
      return Buffer.from(data);
    }

    if (data instanceof Uint8Array) {
      return Buffer.from(data);
    }

    if (typeof data === 'string') {
      return Buffer.from(data);
    }

    return Buffer.alloc(0);
  }
}

export function createStorage(): FileStorage {
  return createStorageProvider() === 'supabase'
    ? new SupabaseFileStorage()
    : new LocalFileStorage();
}
