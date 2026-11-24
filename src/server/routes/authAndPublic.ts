import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  biometricTemplates,
  classes,
  collegeSettings,
  departments,
  profiles,
  registrationQrCodes,
  roles,
  semesters,
  staffAssignments,
  studentEnrollments,
  subjects,
} from '../../db/schema.ts';
import {
  averageAndNormalizeDescriptors,
  computeFaceDistance,
  computeGeofenceDistanceMeters,
  decryptBiometricDescriptor,
  formatISTTimestamp,
  getISTDateString,
  hashPassword,
  signAccountSetupToken,
  signSessionToken,
  verifyAccountSetupToken,
  verifyPassword,
} from '../crypto.ts';
import { ensureBaselineSeeded } from '../seed.ts';
import { writeAuditLog } from '../audit.ts';
import { type AuthRequest, extractClientIp, requireAuth } from '../../middleware/auth.ts';
import { generateWebsiteAssistantReply, isGeminiConfigured } from '../geminiClient.ts';
import {
  formatTime12h,
  getNormalizedScheduleSettings,
  getStudentSlotMessage,
  syncAutomaticDailySessions,
  validateSessionAttendanceWindow,
} from '../attendanceScheduler.ts';

export const authAndPublicRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait 15 minutes and try again.' },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration requests from this IP. Please try again shortly.' },
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 35,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many help chat messages. Please wait a few minutes and try again.' },
});

authAndPublicRouter.get('/college/public-info', async (_req, res) => {
  try {
    await ensureBaselineSeeded();
    const [settings] = await db.select().from(collegeSettings).limit(1);
    const activeDepartments = await db
      .select()
      .from(departments)
      .where(eq(departments.isActive, true))
      .orderBy(asc(departments.code));
    const activeYears = await db
      .select()
      .from(academicYears)
      .where(eq(academicYears.isActive, true))
      .orderBy(asc(academicYears.yearNumber));
    const activeSemesters = await db
      .select()
      .from(semesters)
      .where(eq(semesters.isActive, true))
      .orderBy(asc(semesters.semesterNumber));

    res.json({
      settings: settings ?? null,
      departments: activeDepartments,
      academicYears: activeYears,
      semesters: activeSemesters,
    });
  } catch (err) {
    console.error('Public college info error:', err);
    res.status(500).json({ error: 'Failed to load college configuration.' });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

authAndPublicRouter.post('/auth/login', authLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password (min 6 chars) are required.' });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const ip = extractClientIp(req);

    const rows = await db
      .select({
        id: profiles.id,
        email: profiles.email,
        fullName: profiles.fullName,
        passwordHash: profiles.passwordHash,
        status: profiles.status,
        roleName: roles.name,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.email, email))
      .limit(1);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    if (!user.passwordHash) {
      return res.status(401).json({
        error:
          'This account uses Google Sign-In or has not claimed a portal password yet. Sign in with Google or use your admin-issued setup link.',
      });
    }

    const valid = verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      await writeAuditLog({
        actorId: user.id,
        actorEmail: user.email,
        actorRole: user.roleName,
        action: 'LOGIN_FAILED',
        entityType: 'profile',
        entityId: user.id,
        details: { method: 'password' },
        ipAddress: ip,
      });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.status !== 'approved') {
      return res.status(403).json({
        error:
          user.status === 'pending'
            ? 'Your account is pending Super Admin approval.'
            : user.status === 'rejected'
              ? 'Your registration was rejected.'
              : 'Your account has been deactivated.',
      });
    }

    const token = signSessionToken({
      profileId: user.id,
      email: user.email,
      role: user.roleName,
    });

    await writeAuditLog({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.roleName,
      action: 'LOGIN_SUCCESS',
      entityType: 'profile',
      entityId: user.id,
      details: { method: 'password' },
      ipAddress: ip,
    });

    res.json({ token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed due to a server error.' });
  }
});

const claimSchema = z.object({
  setupToken: z.string().min(10),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

authAndPublicRouter.post('/auth/claim-with-token', authLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input.' });
    }
    const verified = verifyAccountSetupToken(parsed.data.setupToken);
    if (!verified) {
      return res.status(400).json({ error: 'Setup link is invalid or has expired.' });
    }

    const [profile] = await db
      .select({
        id: profiles.id,
        email: profiles.email,
        status: profiles.status,
        passwordHash: profiles.passwordHash,
        roleName: roles.name,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(and(eq(profiles.id, verified.profileId), eq(profiles.email, verified.email)))
      .limit(1);

    if (!profile || profile.status !== 'approved') {
      return res.status(403).json({ error: 'Account is not approved for password setup.' });
    }
    if (profile.passwordHash) {
      return res.status(409).json({
        error: 'Password has already been configured for this account. Please sign in normally.',
      });
    }

    const newHash = hashPassword(parsed.data.password);
    await db
      .update(profiles)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(profiles.id, profile.id));

    await writeAuditLog({
      actorId: profile.id,
      actorEmail: profile.email,
      actorRole: profile.roleName,
      action: 'ACCOUNT_PASSWORD_CLAIMED',
      entityType: 'profile',
      entityId: profile.id,
      ipAddress: extractClientIp(req),
    });

    const token = signSessionToken({
      profileId: profile.id,
      email: profile.email,
      role: profile.roleName,
    });

    res.json({ message: 'Password configured successfully.', token });
  } catch (err) {
    console.error('Claim password error:', err);
    res.status(500).json({ error: 'Failed to configure password.' });
  }
});

const setPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

authAndPublicRouter.post('/auth/set-password', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid password.' });
    }
    const user = req.authProfile!;
    const newHash = hashPassword(parsed.data.password);
    await db
      .update(profiles)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(profiles.id, user.id));

    await writeAuditLog({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'PASSWORD_UPDATED',
      entityType: 'profile',
      entityId: user.id,
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Portal password saved securely.' });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

authAndPublicRouter.get('/auth/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const profile = req.authProfile!;
    let enrollment = null;
    let biometricStatus: {
      enrolled: boolean;
      sampleCount: number;
      consentTimestamp: Date | null;
      retentionPolicyVersion: string | null;
    } = {
      enrolled: false,
      sampleCount: 0,
      consentTimestamp: null,
      retentionPolicyVersion: null,
    };
    let assignments: Array<{
      id: string;
      departmentId: string;
      departmentCode: string;
      departmentName: string;
      classId: string | null;
      className: string | null;
      subjectId: string | null;
      subjectCode: string | null;
      subjectName: string | null;
      canCreateSessions: boolean;
    }> = [];

    if (profile.role === 'student') {
      const enrollRows = await db
        .select({
          id: studentEnrollments.id,
          rollNumber: studentEnrollments.rollNumber,
          departmentId: studentEnrollments.departmentId,
          departmentCode: departments.code,
          departmentName: departments.name,
          academicYearId: studentEnrollments.academicYearId,
          yearLabel: academicYears.label,
          semesterId: studentEnrollments.semesterId,
          semesterLabel: semesters.label,
          semesterNumber: semesters.semesterNumber,
          classId: studentEnrollments.classId,
          className: classes.displayName,
          isActive: studentEnrollments.isActive,
          regulation: studentEnrollments.regulation,
          academicStanding: studentEnrollments.academicStanding,
          creditsEarned: studentEnrollments.creditsEarned,
          activeBacklogs: studentEnrollments.activeBacklogs,
          latestResultStatus: studentEnrollments.latestResultStatus,
        })
        .from(studentEnrollments)
        .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
        .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
        .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
        .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
        .where(eq(studentEnrollments.studentId, profile.id))
        .limit(1);

      enrollment = enrollRows[0] ?? null;

      const bioRows = await db
        .select({
          sampleCount: biometricTemplates.sampleCount,
          consentTimestamp: biometricTemplates.consentTimestamp,
          retentionPolicyVersion: biometricTemplates.retentionPolicyVersion,
          isActive: biometricTemplates.isActive,
        })
        .from(biometricTemplates)
        .where(and(eq(biometricTemplates.studentId, profile.id), eq(biometricTemplates.isActive, true)))
        .limit(1);

      if (bioRows.length > 0) {
        biometricStatus = {
          enrolled: true,
          sampleCount: bioRows[0].sampleCount,
          consentTimestamp: bioRows[0].consentTimestamp,
          retentionPolicyVersion: bioRows[0].retentionPolicyVersion,
        };
      }
    } else if (profile.role === 'staff') {
      const assignRows = await db
        .select({
          id: staffAssignments.id,
          departmentId: staffAssignments.departmentId,
          departmentCode: departments.code,
          departmentName: departments.name,
          classId: staffAssignments.classId,
          className: classes.displayName,
          subjectId: staffAssignments.subjectId,
          subjectCode: subjects.code,
          subjectName: subjects.name,
          canCreateSessions: staffAssignments.canCreateSessions,
        })
        .from(staffAssignments)
        .innerJoin(departments, eq(staffAssignments.departmentId, departments.id))
        .leftJoin(classes, eq(staffAssignments.classId, classes.id))
        .leftJoin(subjects, eq(staffAssignments.subjectId, subjects.id))
        .where(and(eq(staffAssignments.staffId, profile.id), eq(staffAssignments.isActive, true)));

      assignments = assignRows;
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);

    res.json({
      profile,
      enrollment,
      biometricStatus,
      assignments,
      collegeSettings: settings ?? null,
    });
  } catch (err) {
    console.error('/auth/me error:', err);
    res.status(500).json({ error: 'Failed to load profile context.' });
  }
});

// QR Registration inspection
authAndPublicRouter.get('/qr/:token', async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const token = req.params.token.trim();
    const [qr] = await db
      .select()
      .from(registrationQrCodes)
      .where(and(eq(registrationQrCodes.token, token), eq(registrationQrCodes.qrPurpose, 'registration')))
      .limit(1);

    if (!qr) {
      return res.status(404).json({ error: 'Invalid registration QR code.' });
    }
    if (qr.isRevoked) {
      return res.status(410).json({ error: 'This registration QR code has been revoked by administration.' });
    }
    if (qr.expiresAt && new Date() > new Date(qr.expiresAt)) {
      return res.status(410).json({ error: 'This registration QR code has expired.' });
    }
    if (qr.maxUses !== null && qr.usedCount >= qr.maxUses) {
      return res.status(410).json({ error: 'This registration QR code has reached its maximum usage limit.' });
    }

    res.json({
      qr: {
        id: qr.id,
        label: qr.label,
        departmentId: qr.departmentId,
        academicYearId: qr.academicYearId,
        semesterId: qr.semesterId,
        expiresAt: qr.expiresAt,
      },
    });
  } catch (err) {
    console.error('QR lookup error:', err);
    res.status(500).json({ error: 'Failed to validate QR code.' });
  }
});

const qrRegisterSchema = z.object({
  qrToken: z.string().min(6, 'Please enter a valid registration QR token.'),
  fullName: z.string().min(2, 'Full name is required.').max(120),
  rollNumber: z.string().min(3, 'Roll number is required.').max(40),
  departmentId: z.string().uuid('Please select a valid department.'),
  academicYearId: z.string().uuid('Please select a valid academic year.'),
  semesterId: z.string().uuid('Please select a valid semester.'),
  sectionName: z.string().min(1).max(30).optional(),
  email: z.string().email('Please enter a valid email address.'),
  phone: z.string().min(10, 'Please enter a valid phone number.').max(15),
});

authAndPublicRouter.post('/qr/register', registerLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const parsed = qrRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration fields.' });
    }

    const data = parsed.data;
    const normalizedEmail = data.email.toLowerCase().trim();
    const normalizedRoll = data.rollNumber.toUpperCase().trim();
    const ip = extractClientIp(req);

    const [qr] = await db
      .select()
      .from(registrationQrCodes)
      .where(and(eq(registrationQrCodes.token, data.qrToken.trim()), eq(registrationQrCodes.qrPurpose, 'registration')))
      .limit(1);

    if (!qr) {
      return res.status(404).json({ error: 'Invalid registration QR code.' });
    }
    if (qr.isRevoked) {
      return res.status(410).json({ error: 'This registration QR code has been revoked.' });
    }
    if (qr.expiresAt && new Date() > new Date(qr.expiresAt)) {
      return res.status(410).json({ error: 'This registration QR code has expired.' });
    }
    if (qr.maxUses !== null && qr.usedCount >= qr.maxUses) {
      return res.status(410).json({ error: 'This registration QR code usage limit has been reached.' });
    }

    // Check unique roll number and unique email
    const existingRoll = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.rollNumber, normalizedRoll))
      .limit(1);

    if (existingRoll.length > 0) {
      return res.status(409).json({
        error: `Roll number ${normalizedRoll} is already registered. Contact administration if this is an error.`,
      });
    }

    const existingEmail = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.email, normalizedEmail))
      .limit(1);

    if (existingEmail.length > 0) {
      return res.status(409).json({
        error: `Email ${normalizedEmail} is already registered in the system.`,
      });
    }

    const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
    const [dept] = await db
      .select()
      .from(departments)
      .where(eq(departments.id, data.departmentId))
      .limit(1);
    const [sem] = await db
      .select()
      .from(semesters)
      .where(eq(semesters.id, data.semesterId))
      .limit(1);

    if (!studentRole || !dept || !sem) {
      return res.status(400).json({ error: 'Invalid department or semester selection.' });
    }

    // Find or create matching class group
    const section = data.sectionName?.trim() || 'Regular';
    let [classRow] = await db
      .select()
      .from(classes)
      .where(
        and(
          eq(classes.departmentId, data.departmentId),
          eq(classes.academicYearId, data.academicYearId),
          eq(classes.semesterId, data.semesterId)
        )
      )
      .limit(1);

    if (!classRow) {
      const insertedClasses = await db
        .insert(classes)
        .values({
          departmentId: data.departmentId,
          academicYearId: data.academicYearId,
          semesterId: data.semesterId,
          sectionName: section,
          displayName: `${dept.code} · Sem ${sem.semesterNumber}`,
        })
        .returning();
      classRow = insertedClasses[0];
    }

    const createdProfile = await db.transaction(async (tx) => {
      const [prof] = await tx
        .insert(profiles)
        .values({
          roleId: studentRole.id,
          fullName: data.fullName.trim(),
          email: normalizedEmail,
          phone: data.phone.trim(),
          rollNumber: normalizedRoll,
          status: 'pending',
          emailVerified: false,
        })
        .returning();

      await tx.insert(studentEnrollments).values({
        studentId: prof.id,
        rollNumber: normalizedRoll,
        departmentId: data.departmentId,
        academicYearId: data.academicYearId,
        semesterId: data.semesterId,
        classId: classRow.id,
        isActive: false,
      });

      await tx
        .update(registrationQrCodes)
        .set({ usedCount: sql`${registrationQrCodes.usedCount} + 1` })
        .where(eq(registrationQrCodes.id, qr.id));

      return prof;
    });

    await writeAuditLog({
      actorId: createdProfile.id,
      actorEmail: normalizedEmail,
      actorRole: 'student',
      action: 'STUDENT_QR_REGISTERED',
      entityType: 'profile',
      entityId: createdProfile.id,
      details: {
        rollNumber: normalizedRoll,
        departmentCode: dept.code,
        qrLabel: qr.label,
      },
      ipAddress: ip,
    });

    res.status(201).json({
      message:
        'Registration submitted successfully. Status: Pending Approval. An administrator must approve your account before portal access and face enrollment are unlocked.',
      status: 'pending',
      rollNumber: normalizedRoll,
      setupHint: signAccountSetupToken(createdProfile.id, normalizedEmail, 1), // internal reference only, not active until approved
    });
  } catch (err) {
    console.error('QR registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// QR Attendance Check-In: inspect attendance QR token
authAndPublicRouter.get('/qr/attendance/:token', async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const token = req.params.token.trim();
    const [qr] = await db
      .select()
      .from(registrationQrCodes)
      .where(and(eq(registrationQrCodes.token, token), eq(registrationQrCodes.qrPurpose, 'attendance')))
      .limit(1);

    if (!qr) {
      return res.status(404).json({ error: 'Invalid attendance check-in QR code.' });
    }
    if (qr.isRevoked) {
      return res.status(410).json({ error: 'This attendance QR code has been revoked by administration.' });
    }
    if (qr.expiresAt && new Date() > new Date(qr.expiresAt)) {
      return res.status(410).json({ error: 'This attendance QR code has expired.' });
    }
    if (qr.maxUses !== null && qr.usedCount >= qr.maxUses) {
      return res.status(410).json({ error: 'This attendance QR code has reached its maximum usage limit.' });
    }

    let boundSession: {
      id: string;
      sessionCode: string;
      subjectCode: string;
      subjectName: string;
      className: string;
      sessionDate: string;
      startTime: string;
      endTime: string;
      status: string;
    } | null = null;

    const syncRes = await syncAutomaticDailySessions();

    if (qr.sessionId) {
      const [ses] = await db
        .select({
          id: attendanceSessions.id,
          sessionCode: attendanceSessions.sessionCode,
          subjectCode: subjects.code,
          subjectName: subjects.name,
          periodSlot: attendanceSessions.periodSlot,
          className: classes.displayName,
          sessionDate: attendanceSessions.sessionDate,
          startTime: attendanceSessions.startTime,
          endTime: attendanceSessions.endTime,
          status: attendanceSessions.status,
        })
        .from(attendanceSessions)
        .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
        .innerJoin(classes, eq(attendanceSessions.classId, classes.id))
        .where(eq(attendanceSessions.id, qr.sessionId))
        .limit(1);
      boundSession = ses
        ? {
            id: ses.id,
            sessionCode: ses.sessionCode,
            subjectCode: ses.subjectCode ?? 'DAILY',
            subjectName:
              ses.subjectName ??
              (ses.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
            className: ses.className,
            sessionDate: ses.sessionDate,
            startTime: ses.startTime,
            endTime: ses.endTime,
            status: ses.status,
          }
        : null;
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);

    res.json({
      qr: {
        id: qr.id,
        token: qr.token,
        label: qr.label,
        departmentId: qr.departmentId,
        sessionId: qr.sessionId,
        expiresAt: qr.expiresAt,
      },
      boundSession,
      todayDayEval: syncRes.dayEval,
      collegeSettings: settings
        ? {
            locationVerificationEnabled: settings.locationVerificationEnabled,
            livenessRequired: settings.livenessRequired,
          }
        : { locationVerificationEnabled: true, livenessRequired: true },
    });
  } catch (err) {
    console.error('Attendance QR lookup error:', err);
    res.status(500).json({ error: 'Failed to validate attendance QR code.' });
  }
});

const attendanceLookupSchema = z.object({
  qrToken: z.string().min(4, 'Please enter a valid attendance QR token.'),
  rollNumber: z.string().min(3, 'Please enter your hall ticket / roll number.').max(40),
});

authAndPublicRouter.post('/qr/attendance/lookup', authLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const syncRes = await syncAutomaticDailySessions();
    const parsed = attendanceLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid hall ticket lookup.' });
    }

    const token = parsed.data.qrToken.trim();
    const rollNumber = parsed.data.rollNumber.toUpperCase().trim();

    const [qr] = await db
      .select()
      .from(registrationQrCodes)
      .where(and(eq(registrationQrCodes.token, token), eq(registrationQrCodes.qrPurpose, 'attendance')))
      .limit(1);

    if (!qr) return res.status(404).json({ error: 'Invalid attendance check-in QR code.' });
    if (qr.isRevoked) return res.status(410).json({ error: 'This attendance QR code has been revoked.' });
    if (qr.expiresAt && new Date() > new Date(qr.expiresAt)) {
      return res.status(410).json({ error: 'This attendance QR code has expired.' });
    }
    if (qr.maxUses !== null && qr.usedCount >= qr.maxUses) {
      return res.status(410).json({ error: 'This attendance QR code usage limit has been reached.' });
    }

    const [studentRow] = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        status: profiles.status,
        roleName: roles.name,
        departmentId: studentEnrollments.departmentId,
        departmentCode: departments.code,
        classId: studentEnrollments.classId,
        className: classes.displayName,
        enrollmentActive: studentEnrollments.isActive,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .leftJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .leftJoin(departments, eq(studentEnrollments.departmentId, departments.id))
      .leftJoin(classes, eq(studentEnrollments.classId, classes.id))
      .where(eq(profiles.rollNumber, rollNumber))
      .limit(1);

    if (!studentRow || studentRow.roleName !== 'student') {
      return res.status(404).json({ error: `Hall ticket number ${rollNumber} was not found.` });
    }
    if (studentRow.status === 'pending') {
      return res.status(403).json({
        error: 'Your student registration is still Pending Super Admin Approval.',
      });
    }
    if (studentRow.status !== 'approved' || !studentRow.enrollmentActive || !studentRow.departmentId || !studentRow.classId) {
      return res.status(403).json({ error: 'Your student enrollment is not active. Contact administration.' });
    }
    if (qr.departmentId && studentRow.departmentId !== qr.departmentId) {
      return res.status(403).json({
        error: `This QR code is restricted to a different department (your department: ${studentRow.departmentCode}).`,
      });
    }

    const [bio] = await db
      .select({ id: biometricTemplates.id })
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, studentRow.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    const sessionFilters = [
      eq(attendanceSessions.departmentId, studentRow.departmentId),
      eq(attendanceSessions.classId, studentRow.classId),
      eq(attendanceSessions.status, 'active'),
    ];
    if (qr.sessionId) {
      sessionFilters.push(eq(attendanceSessions.id, qr.sessionId));
    }

    const openSessionsRaw = await db
      .select({
        id: attendanceSessions.id,
        sessionCode: attendanceSessions.sessionCode,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionDate: attendanceSessions.sessionDate,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
        periodSlot: attendanceSessions.periodSlot,
      })
      .from(attendanceSessions)
      .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(and(...sessionFilters));

    const openSessions = openSessionsRaw.map((s) => ({
      ...s,
      subjectCode: s.subjectCode ?? 'DAILY',
      subjectName:
        s.subjectName ?? (s.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
    }));

    const existingRecords = await db
      .select({ sessionId: attendanceRecords.sessionId })
      .from(attendanceRecords)
      .where(eq(attendanceRecords.studentId, studentRow.id));
    const markedSet = new Set(existingRecords.map((r) => r.sessionId));

    const [settings] = await db.select().from(collegeSettings).limit(1);
    const normSettings = getNormalizedScheduleSettings(settings);

    const todayAuto = await db
      .select({
        id: attendanceSessions.id,
        periodSlot: attendanceSessions.periodSlot,
        status: attendanceSessions.status,
      })
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.departmentId, studentRow.departmentId),
          eq(attendanceSessions.classId, studentRow.classId),
          eq(attendanceSessions.sessionDate, syncRes.todayIST)
        )
      );

    const buildQrSlot = (slot: 'morning' | 'afternoon') => {
      const ses = todayAuto.find((s) => s.periodSlot === slot);
      const startTime =
        slot === 'morning' ? normSettings.morningStartTime : normSettings.afternoonStartTime;
      const endTime =
        slot === 'morning' ? normSettings.morningEndTime : normSettings.afternoonEndTime;
      const status = ses
        ? (ses.status as 'scheduled' | 'active' | 'closed' | 'cancelled')
        : slot === 'morning'
          ? syncRes.morningStatus
          : syncRes.afternoonStatus;
      const alreadyMarked = ses ? markedSet.has(ses.id) : false;
      return {
        slot,
        startTime12h: formatTime12h(startTime),
        endTime12h: formatTime12h(endTime),
        status,
        alreadyMarked,
        message: getStudentSlotMessage({
          slot,
          status,
          startTime,
          dayEval: syncRes.dayEval,
          alreadyMarked,
        }),
      };
    };

    res.json({
      student: {
        fullName: studentRow.fullName,
        rollNumber: studentRow.rollNumber,
        departmentCode: studentRow.departmentCode,
        className: studentRow.className,
        hasBiometrics: Boolean(bio),
      },
      todaySchedule: {
        dayEval: syncRes.dayEval,
        morning: buildQrSlot('morning'),
        afternoon: buildQrSlot('afternoon'),
      },
      activeSessions: openSessions.map((s) => ({
        ...s,
        alreadyMarked: markedSet.has(s.id),
      })),
      collegeSettings: {
        locationVerificationEnabled: settings?.locationVerificationEnabled ?? true,
        livenessRequired: settings?.livenessRequired ?? true,
      },
    });
  } catch (err) {
    console.error('QR attendance lookup error:', err);
    res.status(500).json({ error: 'Failed to look up hall ticket number.' });
  }
});

const qrAttendanceVerifySchema = z.object({
  qrToken: z.string().min(4),
  rollNumber: z.string().min(3).max(40),
  sessionId: z.string().uuid('Please select a valid attendance session.').nullable().optional(),
  descriptor: z.array(z.number().finite()).length(128),
  livenessPassed: z.boolean(),
  livenessSignals: z
    .object({
      blinkDetected: z.boolean(),
      headTurnDetected: z.boolean(),
      frameVariance: z.number().nonnegative(),
    })
    .optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
});

authAndPublicRouter.post('/qr/attendance/verify-and-mark', authLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const parsed = qrAttendanceVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid verification payload.' });
    }

    const payload = parsed.data;
    const token = payload.qrToken.trim();
    const rollNumber = payload.rollNumber.toUpperCase().trim();
    const ip = extractClientIp(req);

    const [qr] = await db
      .select()
      .from(registrationQrCodes)
      .where(and(eq(registrationQrCodes.token, token), eq(registrationQrCodes.qrPurpose, 'attendance')))
      .limit(1);

    if (!qr) return res.status(404).json({ error: 'Invalid attendance check-in QR code.' });
    if (qr.isRevoked) return res.status(410).json({ error: 'This attendance QR code has been revoked.' });
    if (qr.expiresAt && new Date() > new Date(qr.expiresAt)) {
      return res.status(410).json({ error: 'This attendance QR code has expired.' });
    }
    if (qr.maxUses !== null && qr.usedCount >= qr.maxUses) {
      return res.status(410).json({ error: 'This attendance QR code usage limit has been reached.' });
    }

    const [student] = await db
      .select({
        id: profiles.id,
        email: profiles.email,
        fullName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        status: profiles.status,
        roleName: roles.name,
        departmentId: studentEnrollments.departmentId,
        classId: studentEnrollments.classId,
        enrollmentActive: studentEnrollments.isActive,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .innerJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .where(eq(profiles.rollNumber, rollNumber))
      .limit(1);

    if (!student || student.roleName !== 'student') {
      return res.status(404).json({ error: 'Student hall ticket number not found.' });
    }
    if (student.status !== 'approved' || !student.enrollmentActive) {
      return res.status(403).json({ error: 'Student account is not approved or active.' });
    }
    if (qr.departmentId && student.departmentId !== qr.departmentId) {
      return res.status(403).json({ error: 'This QR code is restricted to a different department.' });
    }

    const [template] = await db
      .select()
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    if (!template) {
      return res.status(400).json({
        error: 'Face enrollment is required before using QR Face Check-In. Please sign in once to enroll your face.',
        code: 'BIOMETRIC_NOT_ENROLLED',
      });
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);
    const locationEnabled = settings?.locationVerificationEnabled ?? true;
    const geofenceRadius = settings?.geofenceRadiusMeters ?? 300;
    const faceThreshold = settings?.faceMatchThreshold ?? 0.5;
    const livenessRequired = settings?.livenessRequired ?? true;

    if (livenessRequired) {
      const signalsValid =
        payload.livenessPassed &&
        (!payload.livenessSignals ||
          (payload.livenessSignals.blinkDetected && payload.livenessSignals.frameVariance > 0.0001));
      if (!signalsValid) {
        await writeAuditLog({
          actorId: student.id,
          actorEmail: student.email,
          actorRole: 'student',
          action: 'QR_LIVENESS_FAILED',
          entityType: 'profile',
          entityId: student.id,
          ipAddress: ip,
        });
        return res.status(403).json({
          error: 'Liveness check incomplete. Please blink naturally and retry.',
          code: 'LIVENESS_FAILED',
        });
      }
    }

    const normalizedLive = averageAndNormalizeDescriptors([payload.descriptor]);
    const enrolledVector = decryptBiometricDescriptor(
      template.encryptedDescriptor,
      template.iv,
      template.authTag
    );
    const distance = computeFaceDistance(normalizedLive, enrolledVector);
    const confidence = Math.max(0, Math.min(1, Math.round((1 - distance) * 1000) / 1000));

    if (distance > faceThreshold) {
      await writeAuditLog({
        actorId: student.id,
        actorEmail: student.email,
        actorRole: 'student',
        action: 'QR_FACE_AUTH_REJECTED',
        entityType: 'profile',
        entityId: student.id,
        details: { rollNumber, distance: Math.round(distance * 1000) / 1000, threshold: faceThreshold },
        ipAddress: ip,
      });
      return res.status(403).json({
        error: `Face verification rejected (distance ${distance.toFixed(3)} exceeds threshold ${faceThreshold.toFixed(2)}). Ensure proper lighting and only your face is visible.`,
        code: 'FACE_MISMATCH',
      });
    }

    // Face verified! Determine target active session if specified or available
    const targetSessionId = qr.sessionId || payload.sessionId || null;
    let attendanceMessage = 'Face authenticated. Welcome to your Student Dashboard.';
    let marked = false;
    let alreadyMarked = false;
    let markedAtIST: string | null = null;

    if (targetSessionId) {
      const windowCheck = await validateSessionAttendanceWindow({
        sessionId: targetSessionId,
        studentClassId: student.classId,
        studentDepartmentId: student.departmentId,
      });
      if (!windowCheck.allowed) {
        return res.status(windowCheck.httpStatus).json({
          error: windowCheck.error,
          code: windowCheck.code,
        });
      }
      const session = windowCheck.session;

      const [existingForSession] = await db
        .select({ id: attendanceRecords.id, markedAt: attendanceRecords.markedAt })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.studentId, student.id),
            eq(attendanceRecords.sessionId, session.id)
          )
        )
        .limit(1);

      if (existingForSession) {
        alreadyMarked = true;
        markedAtIST = formatISTTimestamp(new Date(existingForSession.markedAt));
        attendanceMessage = `Attendance has already been marked for this session (${markedAtIST}).`;
      } else {
        // Check geofence before marking
        let distanceMeters: number | null = null;
        if (locationEnabled) {
          if (payload.latitude == null || payload.longitude == null) {
            return res.status(400).json({
              error: 'Location permission is required by college policy to verify campus proximity.',
              code: 'LOCATION_REQUIRED',
            });
          }
          distanceMeters = computeGeofenceDistanceMeters(
            payload.latitude,
            payload.longitude,
            settings!.collegeLatitude,
            settings!.collegeLongitude
          );
          if (distanceMeters > geofenceRadius) {
            return res.status(403).json({
              error: `Outside campus geofence (${distanceMeters}m away; allowed radius is ${geofenceRadius}m).`,
              code: 'OUTSIDE_GEOFENCE',
            });
          }
        }

        // Check attendance frequency policy
        const frequency = settings?.attendanceFrequency ?? 'every_class_period';
        let blockedByPolicy: string | null = null;
        if (frequency === 'once_per_day') {
          const existingToday = await db
            .select({ id: attendanceRecords.id })
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.studentId, student.id),
                eq(attendanceRecords.attendanceDate, session.sessionDate),
                eq(attendanceRecords.status, 'present')
              )
            )
            .limit(1);
          if (existingToday.length > 0) {
            blockedByPolicy = 'Daily attendance was already marked today under Once-Per-Day policy.';
          }
        } else if (frequency === 'morning_afternoon') {
          const slotGroup = session.periodSlot === 'afternoon' ? 'afternoon' : 'morning';
          const existingSlot = await db
            .select({ id: attendanceRecords.id, periodSlot: attendanceSessions.periodSlot })
            .from(attendanceRecords)
            .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
            .where(
              and(
                eq(attendanceRecords.studentId, student.id),
                eq(attendanceRecords.attendanceDate, session.sessionDate),
                eq(attendanceRecords.status, 'present')
              )
            );
          if (existingSlot.some((e) => (e.periodSlot === 'afternoon' ? 'afternoon' : 'morning') === slotGroup)) {
            blockedByPolicy = `Attendance was already marked for the ${slotGroup} session today.`;
          }
        }

        if (blockedByPolicy) {
          alreadyMarked = true;
          attendanceMessage = `Face authenticated. ${blockedByPolicy}`;
        } else {
          const istDate = session.sessionDate || getISTDateString();
          const insertResult = await db.transaction(async (tx) => {
            const [freshSession] = await tx
              .select()
              .from(attendanceSessions)
              .where(eq(attendanceSessions.id, session.id))
              .limit(1);
            if (!freshSession || freshSession.status !== 'active') {
              return { kind: 'inactive' as const };
            }

            const inserted = await tx
              .insert(attendanceRecords)
              .values({
                studentId: student.id,
                sessionId: session.id,
                departmentId: student.departmentId,
                classId: student.classId,
                subjectId: session.subjectId,
                academicYearId: session.academicYearId,
                semesterId: session.semesterId,
                attendanceDate: istDate,
                status: 'present',
                verificationMethod: locationEnabled ? 'face_geofence' : 'face_only',
                verificationResult: 'verified',
                faceConfidence: confidence,
                livenessPassed: payload.livenessPassed,
                latitude: payload.latitude ?? null,
                longitude: payload.longitude ?? null,
                geofenceDistanceM: distanceMeters,
              })
              .onConflictDoNothing({
                target: [attendanceRecords.studentId, attendanceRecords.sessionId],
              })
              .returning();

            if (inserted.length === 0) {
              return { kind: 'duplicate' as const };
            }

            await tx
              .update(registrationQrCodes)
              .set({ usedCount: sql`${registrationQrCodes.usedCount} + 1` })
              .where(eq(registrationQrCodes.id, qr.id));

            return { kind: 'created' as const, record: inserted[0] };
          });

          if (insertResult.kind === 'created') {
            marked = true;
            markedAtIST = formatISTTimestamp(new Date(insertResult.record.markedAt));
            attendanceMessage = `Face verified & attendance marked successfully at ${markedAtIST}!`;
          } else if (insertResult.kind === 'duplicate') {
            alreadyMarked = true;
            attendanceMessage = 'Face authenticated. Attendance was already marked for this session.';
          } else {
            return res.status(409).json({ error: 'Selected attendance session is no longer active.' });
          }
        }
      }
    }

    const sessionToken = signSessionToken({
      profileId: student.id,
      email: student.email,
      role: 'student',
    });

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: marked ? 'QR_FACE_ATTENDANCE_MARKED' : 'QR_FACE_PORTAL_LOGIN',
      entityType: 'profile',
      entityId: student.id,
      details: {
        rollNumber,
        sessionId: targetSessionId,
        confidence,
        marked,
        alreadyMarked,
      },
      ipAddress: ip,
    });

    res.json({
      token: sessionToken,
      marked,
      alreadyMarked,
      markedAtIST,
      message: attendanceMessage,
    });
  } catch (err) {
    console.error('QR face verify-and-mark error:', err);
    res.status(500).json({ error: 'Failed to verify face and mark attendance.' });
  }
});

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, 'Please enter a question.').max(1000, 'Message is too long.'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        text: z.string().trim().min(1).max(2000),
      })
    )
    .max(16)
    .optional(),
});

authAndPublicRouter.post('/chat', chatLimiter, async (req, res) => {
  try {
    await ensureBaselineSeeded();
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid chat message.' });
    }

    if (!isGeminiConfigured()) {
      return res.status(503).json({
        error: 'The website help assistant is temporarily unavailable while the AI service is unconfigured.',
      });
    }

    // Load strictly public non-confidential college metadata only
    const [settings] = await db
      .select({
        collegeName: collegeSettings.collegeName,
        attendanceFrequency: collegeSettings.attendanceFrequency,
        locationVerificationEnabled: collegeSettings.locationVerificationEnabled,
        geofenceRadiusMeters: collegeSettings.geofenceRadiusMeters,
        livenessRequired: collegeSettings.livenessRequired,
      })
      .from(collegeSettings)
      .limit(1);

    const activeDepts = await db
      .select({ code: departments.code, name: departments.name })
      .from(departments)
      .where(eq(departments.isActive, true))
      .orderBy(asc(departments.code));

    const reply = await generateWebsiteAssistantReply({
      message: parsed.data.message,
      history: parsed.data.history ?? [],
      context: {
        collegeName:
          settings?.collegeName || 'Swarna Bharathi Institute of Science and Technology',
        departments: activeDepts.map((d) => d.code),
        attendanceFrequency: settings?.attendanceFrequency || 'every_class_period',
        locationVerificationEnabled: settings?.locationVerificationEnabled ?? true,
        geofenceRadiusMeters: settings?.geofenceRadiusMeters ?? 300,
        livenessRequired: settings?.livenessRequired ?? true,
      },
    });

    res.json({ reply });
  } catch (err: unknown) {
    console.error('Public website chat error:', err);
    const errObj = err as { status?: number; message?: string } | null;
    const errText = err instanceof Error ? err.message : String(errObj?.message || '');
    const status = errObj?.status;

    if (errText.includes('GEMINI_API_KEY')) {
      return res.status(503).json({
        error: 'The website help assistant is temporarily unavailable while the AI service is unconfigured.',
      });
    }
    if (
      status === 403 ||
      status === 401 ||
      errText.includes('PERMISSION_DENIED') ||
      errText.includes('API_KEY_INVALID') ||
      errText.toLowerCase().includes('api key')
    ) {
      return res.status(502).json({
        error: 'The website help assistant could not authenticate with the AI service.',
      });
    }
    if (status === 429 || errText.includes('RESOURCE_EXHAUSTED') || errText.includes('429')) {
      return res.status(429).json({
        error: 'Assistant quota is temporarily busy. Please try again shortly.',
      });
    }
    if (status === 404 || errText.includes('NOT_FOUND')) {
      return res.status(502).json({
        error: 'Configured Gemini model was not found or is unavailable in this environment.',
      });
    }
    if (status === 503 || errText.includes('UNAVAILABLE')) {
      return res.status(503).json({
        error: 'Assistant is temporarily unavailable (503). Please try again in a moment.',
      });
    }
    res.status(502).json({
      error: `Unable to get assistant reply right now (${status || 'upstream error'}). Please try again.`,
    });
  }
});
