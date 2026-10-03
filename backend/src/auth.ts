import { supabaseAdmin, supabaseAuth } from './supabase';
import type { AuthenticatedUser, UserRole } from './types';

export function isSupabaseConfigured(): boolean {
  return supabaseAuth !== null && supabaseAdmin !== null;
}

export async function resolveAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser | null> {
  if (!supabaseAuth || !supabaseAdmin || !accessToken) {
    return null;
  }

  const { data: authData, error: authError } = await supabaseAuth.auth.getUser(accessToken);
  if (authError || !authData.user?.email) {
    return null;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, email, full_name, role, student_id')
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  if (!profile || !['ADMIN', 'STUDENT', 'MENTOR'].includes(profile.role)) {
    return null;
  }

  return {
    id: authData.user.id,
    email: authData.user.email,
    fullName: profile.full_name,
    role: profile.role as UserRole,
    studentId: profile.student_id,
  };
}
