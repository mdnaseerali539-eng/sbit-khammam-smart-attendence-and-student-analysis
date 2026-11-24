import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { db } from '../db/index.ts';
import { profiles, roles, staffAssignments } from '../db/schema.ts';
import { verifySessionToken } from '../server/crypto.ts';
import { ensureBaselineSeeded } from '../server/seed.ts';

export type PortalRole = 'super_admin' | 'staff' | 'student';

export interface AuthProfile {
  id: string;
  firebaseUid: string | null;
  email: string;
  fullName: string;
  phone: string | null;
  rollNumber: string | null;
  employeeId: string | null;
  role: PortalRole;
  permissions: string[];
  status: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface AuthRequest extends Request {
  authProfile?: AuthProfile;
  clientIp?: string;
}

export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

async function resolveProfileByToken(token: string): Promise<
  | { ok: true; profile: AuthProfile }
  | { ok: false; status: number; message: string }
> {
  // 1. Try SBIST server-signed session token
  if (token.startsWith('sbist.')) {
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return { ok: false, status: 401, message: 'Session expired or invalid. Please sign in again.' };
    }
    const rows = await db
      .select({
        id: profiles.id,
        firebaseUid: profiles.firebaseUid,
        email: profiles.email,
        fullName: profiles.fullName,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        employeeId: profiles.employeeId,
        passwordHash: profiles.passwordHash,
        status: profiles.status,
        emailVerified: profiles.emailVerified,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.id, decoded.profileId))
      .limit(1);

    if (rows.length === 0) {
      return { ok: false, status: 401, message: 'Account not found.' };
    }
    const p = rows[0];
    if (p.status !== 'approved') {
      return {
        ok: false,
        status: 403,
        message:
          p.status === 'pending'
            ? 'Your account is pending Super Admin approval.'
            : p.status === 'rejected'
              ? 'Your registration was rejected. Contact college administration.'
              : 'Your account has been deactivated.',
      };
    }

    return {
      ok: true,
      profile: {
        id: p.id,
        firebaseUid: p.firebaseUid,
        email: p.email,
        fullName: p.fullName,
        phone: p.phone,
        rollNumber: p.rollNumber,
        employeeId: p.employeeId,
        role: p.roleName as PortalRole,
        permissions: (p.permissions as string[]) ?? [],
        status: p.status,
        emailVerified: p.emailVerified,
        hasPassword: Boolean(p.passwordHash),
      },
    };
  }

  // 2. Verify Firebase ID Token
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase().trim();
    if (!email) {
      return { ok: false, status: 401, message: 'Google account email missing from token.' };
    }

    let rows = await db
      .select({
        id: profiles.id,
        firebaseUid: profiles.firebaseUid,
        email: profiles.email,
        fullName: profiles.fullName,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        employeeId: profiles.employeeId,
        passwordHash: profiles.passwordHash,
        status: profiles.status,
        emailVerified: profiles.emailVerified,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.firebaseUid, decoded.uid))
      .limit(1);

    if (rows.length === 0) {
      rows = await db
        .select({
          id: profiles.id,
          firebaseUid: profiles.firebaseUid,
          email: profiles.email,
          fullName: profiles.fullName,
          phone: profiles.phone,
          rollNumber: profiles.rollNumber,
          employeeId: profiles.employeeId,
          passwordHash: profiles.passwordHash,
          status: profiles.status,
          emailVerified: profiles.emailVerified,
          roleName: roles.name,
          permissions: roles.permissions,
        })
        .from(profiles)
        .innerJoin(roles, eq(profiles.roleId, roles.id))
        .where(eq(profiles.email, email))
        .limit(1);

      if (rows.length > 0 && !rows[0].firebaseUid) {
        await db
          .update(profiles)
          .set({
            firebaseUid: decoded.uid,
            emailVerified: Boolean(decoded.email_verified ?? true),
            updatedAt: new Date(),
          })
          .where(eq(profiles.id, rows[0].id));
        rows[0].firebaseUid = decoded.uid;
        rows[0].emailVerified = Boolean(decoded.email_verified ?? true);
      }
    }

    if (rows.length === 0) {
      return {
        ok: false,
        status: 403,
        message: `No registered SBIST portal account found for ${email}. Students must register via an admin QR code and await approval.`,
      };
    }

    const p = rows[0];
    if (p.status !== 'approved') {
      return {
        ok: false,
        status: 403,
        message:
          p.status === 'pending'
            ? 'Your registration is currently Pending Approval by the Super Admin.'
            : p.status === 'rejected'
              ? 'Your registration was rejected by college administration.'
              : 'Your account has been deactivated.',
      };
    }

    return {
      ok: true,
      profile: {
        id: p.id,
        firebaseUid: p.firebaseUid,
        email: p.email,
        fullName: p.fullName,
        phone: p.phone,
        rollNumber: p.rollNumber,
        employeeId: p.employeeId,
        role: p.roleName as PortalRole,
        permissions: (p.permissions as string[]) ?? [],
        status: p.status,
        emailVerified: p.emailVerified,
        hasPassword: Boolean(p.passwordHash),
      },
    };
  } catch (err) {
    console.error('Token verification failed:', err);
    return { ok: false, status: 401, message: 'Invalid or expired authentication token.' };
  }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await ensureBaselineSeeded();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'Authentication token is empty.' });
    }

    const resolved = await resolveProfileByToken(token);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.message });
    }

    req.authProfile = resolved.profile;
    req.clientIp = extractClientIp(req);
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Authentication verification failed.' });
  }
}

export function requireRole(...allowedRoles: PortalRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.authProfile) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.authProfile.role)) {
      return res.status(403).json({
        error: `Forbidden: ${req.authProfile.role} role cannot access this resource.`,
      });
    }
    next();
  };
}

export interface StaffScope {
  departmentIds: string[];
  classIds: string[];
  subjectIds: string[];
  canCreateSessions: boolean;
  assignments: Array<{
    id: string;
    departmentId: string;
    classId: string | null;
    subjectId: string | null;
    canCreateSessions: boolean;
  }>;
}

export async function getStaffScope(staffId: string): Promise<StaffScope> {
  const rows = await db
    .select({
      id: staffAssignments.id,
      departmentId: staffAssignments.departmentId,
      classId: staffAssignments.classId,
      subjectId: staffAssignments.subjectId,
      canCreateSessions: staffAssignments.canCreateSessions,
    })
    .from(staffAssignments)
    .where(and(eq(staffAssignments.staffId, staffId), eq(staffAssignments.isActive, true)));

  const deptSet = new Set<string>();
  const classSet = new Set<string>();
  const subjectSet = new Set<string>();
  let canCreate = false;

  for (const r of rows) {
    deptSet.add(r.departmentId);
    if (r.classId) classSet.add(r.classId);
    if (r.subjectId) subjectSet.add(r.subjectId);
    if (r.canCreateSessions) canCreate = true;
  }

  return {
    departmentIds: Array.from(deptSet),
    classIds: Array.from(classSet),
    subjectIds: Array.from(subjectSet),
    canCreateSessions: canCreate,
    assignments: rows,
  };
}
