import type { NextFunction, Request, Response } from 'express';
import { isSupabaseConfigured, resolveAuthenticatedUser } from '../auth';
import type { AuthenticatedUser, UserRole } from '../types';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const bearerToken = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

  if (!bearerToken) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required.',
    });
  }

  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      error: 'Authentication unavailable',
      message: 'Supabase authentication is not configured on the server.',
    });
  }

  void resolveAuthenticatedUser(bearerToken)
    .then((user) => {
      if (!user) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid session or application profile not provisioned.',
        });
      }

      (req as Request & { user?: AuthenticatedUser }).user = user;
      return next();
    })
    .catch(() => res.status(503).json({
      error: 'Authentication unavailable',
      message: 'Unable to verify the account profile right now.',
    }));
}

export function requireRole(requiredRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & { user?: AuthenticatedUser }).user;

    if (!user || user.role !== requiredRole) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `${requiredRole} role required to access this resource.`,
      });
    }

    return next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  return requireAuth(req, res, () => {
    const user = (req as Request & { user?: AuthenticatedUser }).user;

    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'ADMIN role required to access matching management endpoints.',
      });
    }

    return next();
  });
}
