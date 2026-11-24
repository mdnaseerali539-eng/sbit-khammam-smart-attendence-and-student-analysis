import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  academicYears,
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  classes,
  collegeSettings,
  departments,
  profiles,
  registrationQrCodes,
  semesters,
  studentEnrollments,
  subjects,
} from '../../db/schema.ts';
import { type AuthRequest, getStaffScope, requireAuth, requireRole } from '../../middleware/auth.ts';
import { formatISTTimestamp, isValidUuid } from '../crypto.ts';
import { writeAuditLog } from '../audit.ts';
import {
  formatTime12h,
  getDayScheduleContext,
  getNormalizedScheduleSettings,
  syncAutomaticDailySessions,
} from '../attendanceScheduler.ts';
import {
  computeBulkSemesterAttendance,
  NO_ATTENDANCE_DATA_MESSAGE,
} from '../attendanceCalculator.ts';

export const staffRouter = Router();

staffRouter.use(requireAuth, requireRole('staff'));

staffRouter.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    const syncRes = await syncAutomaticDailySessions();
    const scope = await getStaffScope(staff.id);
    const todayIST = syncRes.todayIST;
    const [settings] = await db.select().from(collegeSettings).limit(1);
    const normSettings = getNormalizedScheduleSettings(settings);

    if (scope.departmentIds.length === 0) {
      return res.json({
        scope,
        todayIST,
        todayDayEval: syncRes.dayEval,
        dailySchedule: null,
        assignedDepartments: [],
        assignedClasses: [],
        assignedSubjects: [],
        todaySessions: [],
        metrics: { assignedStudents: 0, presentToday: 0, absentToday: 0, activeSessions: 0 },
      });
    }

    const assignedDepartments = await db
      .select()
      .from(departments)
      .where(inArray(departments.id, scope.departmentIds))
      .orderBy(asc(departments.code));

    const classConditions = [inArray(classes.departmentId, scope.departmentIds)];
    if (scope.classIds.length > 0) {
      classConditions.push(inArray(classes.id, scope.classIds));
    }
    const assignedClasses = await db
      .select({
        id: classes.id,
        departmentId: classes.departmentId,
        departmentCode: departments.code,
        academicYearId: classes.academicYearId,
        yearLabel: academicYears.label,
        semesterId: classes.semesterId,
        semesterLabel: semesters.label,
        displayName: classes.displayName,
      })
      .from(classes)
      .innerJoin(departments, eq(classes.departmentId, departments.id))
      .innerJoin(academicYears, eq(classes.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(classes.semesterId, semesters.id))
      .where(and(...classConditions));

    const subjectConditions = [inArray(subjects.departmentId, scope.departmentIds)];
    if (scope.subjectIds.length > 0) {
      subjectConditions.push(inArray(subjects.id, scope.subjectIds));
    }
    const assignedSubjects = await db
      .select({
        id: subjects.id,
        code: subjects.code,
        name: subjects.name,
        departmentId: subjects.departmentId,
        departmentCode: departments.code,
        semesterId: subjects.semesterId,
        semesterLabel: semesters.label,
      })
      .from(subjects)
      .innerJoin(departments, eq(subjects.departmentId, departments.id))
      .innerJoin(semesters, eq(subjects.semesterId, semesters.id))
      .where(and(...subjectConditions));

    const scopedClassIds = assignedClasses.map((c) => c.id);

    const [{ count: assignedStudents }] =
      scopedClassIds.length > 0
        ? await db
            .select({ count: sql<number>`count(*)::int` })
            .from(studentEnrollments)
            .where(
              and(
                inArray(studentEnrollments.classId, scopedClassIds),
                eq(studentEnrollments.isActive, true)
              )
            )
        : [{ count: 0 }];

    const todaySessionsRaw =
      scopedClassIds.length > 0
        ? await db
            .select({
              id: attendanceSessions.id,
              sessionCode: attendanceSessions.sessionCode,
              departmentCode: departments.code,
              classId: attendanceSessions.classId,
              className: classes.displayName,
              subjectId: attendanceSessions.subjectId,
              subjectCode: subjects.code,
              subjectName: subjects.name,
              periodSlot: attendanceSessions.periodSlot,
              sessionDate: attendanceSessions.sessionDate,
              startTime: attendanceSessions.startTime,
              endTime: attendanceSessions.endTime,
              status: attendanceSessions.status,
              presentCount: sql<number>`(select count(*)::int from attendance_records ar where ar.session_id = ${attendanceSessions.id} and ar.status in ('present', 'excused'))`,
            })
            .from(attendanceSessions)
            .innerJoin(departments, eq(attendanceSessions.departmentId, departments.id))
            .innerJoin(classes, eq(attendanceSessions.classId, classes.id))
            .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
            .where(
              and(
                inArray(attendanceSessions.classId, scopedClassIds),
                eq(attendanceSessions.sessionDate, todayIST)
              )
            )
            .orderBy(desc(attendanceSessions.createdAt))
        : [];

    const todaySessions = todaySessionsRaw.map((s) => ({
      ...s,
      subjectCode: s.subjectCode ?? 'DAILY',
      subjectName:
        s.subjectName ?? (s.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
    }));

    const buildSlotSummary = (slot: 'morning' | 'afternoon') => {
      const slotSessions = todaySessions.filter((s) => s.periodSlot === slot);
      const startTime =
        slot === 'morning' ? normSettings.morningStartTime : normSettings.afternoonStartTime;
      const endTime =
        slot === 'morning' ? normSettings.morningEndTime : normSettings.afternoonEndTime;
      return {
        slot,
        label: slot === 'morning' ? 'Morning Session' : 'Afternoon Session',
        startTime,
        endTime,
        startTime12h: formatTime12h(startTime),
        endTime12h: formatTime12h(endTime),
        status: slot === 'morning' ? syncRes.morningStatus : syncRes.afternoonStatus,
        totalSessions: slotSessions.length,
        presentCount: slotSessions.reduce((acc, s) => acc + (s.presentCount ?? 0), 0),
      };
    };

    const [{ count: presentToday }] =
      scopedClassIds.length > 0
        ? await db
            .select({ count: sql<number>`count(distinct ${attendanceRecords.studentId})::int` })
            .from(attendanceRecords)
            .where(
              and(
                inArray(attendanceRecords.classId, scopedClassIds),
                eq(attendanceRecords.attendanceDate, todayIST),
                inArray(attendanceRecords.status, ['present', 'excused'])
              )
            )
        : [{ count: 0 }];

    res.json({
      scope,
      todayIST,
      todayDayEval: syncRes.dayEval,
      dailySchedule: {
        morning: buildSlotSummary('morning'),
        afternoon: buildSlotSummary('afternoon'),
      },
      assignedDepartments,
      assignedClasses,
      assignedSubjects,
      todaySessions,
      metrics: {
        assignedStudents,
        presentToday,
        absentToday: Math.max(0, assignedStudents - presentToday),
        activeSessions: todaySessions.filter((s) => s.status === 'active').length,
      },
    });
  } catch (err) {
    console.error('Staff dashboard error:', err);
    res.status(500).json({ error: 'Failed to load staff dashboard.' });
  }
});

staffRouter.get('/students', async (req: AuthRequest, res) => {
  try {
    await syncAutomaticDailySessions();
    const staff = req.authProfile!;
    const scope = await getStaffScope(staff.id);
    if (scope.departmentIds.length === 0) {
      return res.json({ items: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = ((req.query.search as string) || '').trim();
    const classId = (req.query.classId as string) || '';

    const conditions = [
      inArray(studentEnrollments.departmentId, scope.departmentIds),
      eq(studentEnrollments.isActive, true),
    ];
    if (scope.classIds.length > 0) {
      conditions.push(inArray(studentEnrollments.classId, scope.classIds));
    }
    if (classId) {
      if (!isValidUuid(classId)) {
        return res.status(400).json({ error: 'Invalid class filter selected.' });
      }
      if (scope.classIds.length > 0 && !scope.classIds.includes(classId)) {
        return res.status(403).json({ error: 'Forbidden: Class is outside your assigned scope.' });
      }
      conditions.push(eq(studentEnrollments.classId, classId));
    }
    if (search) {
      conditions.push(
        or(
          ilike(profiles.fullName, `%${search}%`),
          ilike(profiles.rollNumber, `%${search}%`),
          ilike(profiles.email, `%${search}%`)
        )!
      );
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(studentEnrollments)
      .innerJoin(profiles, eq(studentEnrollments.studentId, profiles.id))
      .where(and(...conditions));

    const items = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        email: profiles.email,
        phone: profiles.phone,
        departmentId: studentEnrollments.departmentId,
        departmentCode: departments.code,
        classId: studentEnrollments.classId,
        className: classes.displayName,
        semesterId: studentEnrollments.semesterId,
        academicYearId: studentEnrollments.academicYearId,
        yearLabel: academicYears.label,
        semesterLabel: semesters.label,
        joinedDateIST: studentEnrollments.joinedDateIST,
        approvedAt: studentEnrollments.approvedAt,
        enrolledAt: studentEnrollments.enrolledAt,
        lastPromotedAt: studentEnrollments.lastPromotedAt,
      })
      .from(studentEnrollments)
      .innerJoin(profiles, eq(studentEnrollments.studentId, profiles.id))
      .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
      .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
      .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
      .where(and(...conditions))
      .orderBy(asc(profiles.rollNumber))
      .limit(limit)
      .offset(offset);

    const attMap = await computeBulkSemesterAttendance({
      targets: items.map((s) => ({
        studentId: s.id,
        departmentId: s.departmentId,
        classId: s.classId,
        semesterId: s.semesterId,
        academicYearId: s.academicYearId,
        joinedDateIST: s.joinedDateIST,
        approvedAt: s.approvedAt,
        enrolledAt: s.enrolledAt,
        lastPromotedAt: s.lastPromotedAt,
        currentSemesterId: s.semesterId,
      })),
    });

    res.json({
      items: items.map((s) => {
        const att = attMap.get(s.id);
        const totalSessions = att?.totalSessions ?? 0;
        const presentCount = att?.presentSessions ?? 0;
        const absentCount = att?.absentSessions ?? 0;
        const hasData = att?.hasData ?? false;
        return {
          id: s.id,
          fullName: s.fullName,
          rollNumber: s.rollNumber,
          email: s.email,
          phone: s.phone,
          departmentCode: s.departmentCode,
          classId: s.classId,
          className: s.className,
          yearLabel: s.yearLabel,
          semesterLabel: s.semesterLabel,
          presentCount,
          absentCount,
          totalSessions,
          attendancePercentage: att?.attendancePercentage ?? 0,
          hasData,
          message: hasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
        };
      }),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('Staff students error:', err);
    res.status(500).json({ error: 'Failed to load assigned students.' });
  }
});

staffRouter.get('/sessions', async (req: AuthRequest, res) => {
  try {
    await syncAutomaticDailySessions();
    const scope = await getStaffScope(req.authProfile!.id);
    if (scope.departmentIds.length === 0) return res.json({ items: [] });

    const conditions = [inArray(attendanceSessions.departmentId, scope.departmentIds)];
    if (scope.classIds.length > 0) {
      conditions.push(inArray(attendanceSessions.classId, scope.classIds));
    }
    if (scope.subjectIds.length > 0) {
      conditions.push(
        or(
          inArray(attendanceSessions.subjectId, scope.subjectIds),
          isNull(attendanceSessions.subjectId)
        )!
      );
    }

    const rawItems = await db
      .select({
        id: attendanceSessions.id,
        sessionCode: attendanceSessions.sessionCode,
        departmentId: attendanceSessions.departmentId,
        departmentCode: departments.code,
        classId: attendanceSessions.classId,
        className: classes.displayName,
        subjectId: attendanceSessions.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionDate: attendanceSessions.sessionDate,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
        periodSlot: attendanceSessions.periodSlot,
        sessionType: attendanceSessions.sessionType,
        isAutoScheduled: attendanceSessions.isAutoScheduled,
        status: attendanceSessions.status,
        presentCount: sql<number>`(select count(*)::int from attendance_records ar where ar.session_id = ${attendanceSessions.id} and ar.status in ('present', 'excused'))`,
      })
      .from(attendanceSessions)
      .innerJoin(departments, eq(attendanceSessions.departmentId, departments.id))
      .innerJoin(classes, eq(attendanceSessions.classId, classes.id))
      .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(and(...conditions))
      .orderBy(desc(attendanceSessions.sessionDate), desc(attendanceSessions.createdAt))
      .limit(100);

    res.json({
      items: rawItems.map((s) => ({
        ...s,
        subjectCode: s.subjectCode ?? 'DAILY',
        subjectName:
          s.subjectName ??
          (s.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
      })),
    });
  } catch (err) {
    console.error('Staff sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions.' });
  }
});

staffRouter.post('/sessions', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    const scope = await getStaffScope(staff.id);
    if (!scope.canCreateSessions) {
      return res.status(403).json({ error: 'You are not authorized to create attendance sessions.' });
    }

    const parsed = z
      .object({
        departmentId: z.string().uuid('Please select a valid department.'),
        classId: z.string().uuid('Please select a valid class.'),
        subjectId: z.string().uuid('Please select a valid subject.'),
        sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        periodSlot: z.string().default('daily'),
        status: z.enum(['scheduled', 'active']).default('active'),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid session fields.' });

    if (!scope.departmentIds.includes(parsed.data.departmentId)) {
      return res.status(403).json({ error: 'Department is outside your assigned scope.' });
    }
    if (scope.classIds.length > 0 && !scope.classIds.includes(parsed.data.classId)) {
      return res.status(403).json({ error: 'Class is outside your assigned scope.' });
    }
    if (scope.subjectIds.length > 0 && !scope.subjectIds.includes(parsed.data.subjectId)) {
      return res.status(403).json({ error: 'Subject is outside your assigned scope.' });
    }

    const { dayEval } = await getDayScheduleContext(parsed.data.sessionDate);
    if (dayEval.isHoliday) {
      return res.status(409).json({
        error: `Cannot create attendance session on ${parsed.data.sessionDate}: marked as Holiday ("${dayEval.holidayTitle}").`,
        code: 'HOLIDAY_BLOCKED',
      });
    }
    if (dayEval.dayStatus === 'closed_day') {
      return res.status(409).json({
        error: `Cannot create attendance session on ${parsed.data.sessionDate}: marked as Closed (${dayEval.overrideTitle}).`,
        code: 'CLOSED_DAY_BLOCKED',
      });
    }

    const [classRow] = await db.select().from(classes).where(eq(classes.id, parsed.data.classId)).limit(1);
    if (!classRow) return res.status(404).json({ error: 'Class not found.' });

    const sessionCode = `SES-${parsed.data.sessionDate.replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const [created] = await db
      .insert(attendanceSessions)
      .values({
        sessionCode,
        departmentId: parsed.data.departmentId,
        classId: parsed.data.classId,
        academicYearId: classRow.academicYearId,
        semesterId: classRow.semesterId,
        subjectId: parsed.data.subjectId,
        sessionDate: parsed.data.sessionDate,
        startTime: parsed.data.startTime,
        endTime: parsed.data.endTime,
        periodSlot: parsed.data.periodSlot,
        status: parsed.data.status,
        createdBy: staff.id,
      })
      .returning();

    await writeAuditLog({
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: 'staff',
      action: 'STAFF_CREATE_SESSION',
      entityType: 'attendance_session',
      entityId: created.id,
      details: { sessionCode },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ session: created });
  } catch (err) {
    console.error('Staff create session error:', err);
    res.status(500).json({ error: 'Failed to create attendance session.' });
  }
});

staffRouter.patch('/sessions/:id/status', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid session ID.' });
    const scope = await getStaffScope(staff.id);
    const parsed = z.object({ status: z.enum(['scheduled', 'active', 'closed', 'cancelled']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status.' });

    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, req.params.id))
      .limit(1);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    if (!scope.departmentIds.includes(session.departmentId)) {
      return res.status(403).json({ error: 'Session is outside your assigned department scope.' });
    }

    if (parsed.data.status === 'active' || parsed.data.status === 'scheduled') {
      const { dayEval } = await getDayScheduleContext(session.sessionDate);
      if (dayEval.isHoliday) {
        return res.status(409).json({
          error: `Cannot ${parsed.data.status === 'active' ? 'activate' : 'schedule'} session on ${session.sessionDate}: marked as Holiday ("${dayEval.holidayTitle}").`,
          code: 'HOLIDAY_BLOCKED',
        });
      }
      if (dayEval.dayStatus === 'closed_day') {
        return res.status(409).json({
          error: `Cannot ${parsed.data.status === 'active' ? 'activate' : 'schedule'} session on ${session.sessionDate}: marked as Closed (${dayEval.overrideTitle}).`,
          code: 'CLOSED_DAY_BLOCKED',
        });
      }
    }

    const [updated] = await db
      .update(attendanceSessions)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(attendanceSessions.id, session.id))
      .returning();

    await writeAuditLog({
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: 'staff',
      action: 'STAFF_UPDATE_SESSION_STATUS',
      entityType: 'attendance_session',
      entityId: session.id,
      details: { status: parsed.data.status },
      ipAddress: req.clientIp,
    });

    res.json({ session: updated });
  } catch (err) {
    console.error('Staff update session status error:', err);
    res.status(500).json({ error: 'Failed to update session status.' });
  }
});

staffRouter.get('/sessions/:id/roster', async (req: AuthRequest, res) => {
  try {
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid session ID.' });
    const scope = await getStaffScope(req.authProfile!.id);
    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, req.params.id))
      .limit(1);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    if (!scope.departmentIds.includes(session.departmentId)) {
      return res.status(403).json({ error: 'Forbidden: Session outside your assigned scope.' });
    }

    const enrolled = await db
      .select({
        studentId: profiles.id,
        fullName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        email: profiles.email,
      })
      .from(studentEnrollments)
      .innerJoin(profiles, eq(studentEnrollments.studentId, profiles.id))
      .where(
        and(
          eq(studentEnrollments.classId, session.classId),
          eq(studentEnrollments.isActive, true)
        )
      )
      .orderBy(asc(profiles.rollNumber));

    const marked = await db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.sessionId, session.id));

    const markedMap = new Map(marked.map((m) => [m.studentId, m]));

    const roster = enrolled.map((s) => {
      const rec = markedMap.get(s.studentId);
      return {
        ...s,
        attendanceStatus: rec ? rec.status : 'absent',
        verificationMethod: rec ? rec.verificationMethod : null,
        markedAtIST: rec ? formatISTTimestamp(new Date(rec.markedAt)) : null,
      };
    });

    res.json({ session, roster });
  } catch (err) {
    console.error('Session roster error:', err);
    res.status(500).json({ error: 'Failed to load session roster.' });
  }
});

// Generate or retrieve an active Attendance Check-In QR for a scoped session
staffRouter.post('/sessions/:id/qr', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid session ID.' });
    const scope = await getStaffScope(staff.id);

    const [session] = await db
      .select({
        id: attendanceSessions.id,
        sessionCode: attendanceSessions.sessionCode,
        departmentId: attendanceSessions.departmentId,
        academicYearId: attendanceSessions.academicYearId,
        semesterId: attendanceSessions.semesterId,
        periodSlot: attendanceSessions.periodSlot,
        status: attendanceSessions.status,
        subjectCode: subjects.code,
      })
      .from(attendanceSessions)
      .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(eq(attendanceSessions.id, req.params.id))
      .limit(1);

    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!scope.departmentIds.includes(session.departmentId)) {
      return res.status(403).json({ error: 'Forbidden: Session outside your assigned scope.' });
    }

    const [existing] = await db
      .select()
      .from(registrationQrCodes)
      .where(
        and(
          eq(registrationQrCodes.sessionId, session.id),
          eq(registrationQrCodes.qrPurpose, 'attendance'),
          eq(registrationQrCodes.isRevoked, false)
        )
      )
      .orderBy(desc(registrationQrCodes.createdAt))
      .limit(1);

    if (existing && (!existing.expiresAt || new Date() < new Date(existing.expiresAt))) {
      return res.json({ qr: existing });
    }

    const token = `SBIST-ATT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000);
    const qrLabelPrefix =
      session.subjectCode ??
      (session.periodSlot === 'afternoon' ? 'AFTERNOON' : 'MORNING');
    const [created] = await db
      .insert(registrationQrCodes)
      .values({
        token,
        qrPurpose: 'attendance',
        label: `${qrLabelPrefix} · ${session.sessionCode}`,
        departmentId: session.departmentId,
        academicYearId: session.academicYearId,
        semesterId: session.semesterId,
        sessionId: session.id,
        expiresAt,
        createdBy: staff.id,
      })
      .returning();

    await writeAuditLog({
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: 'staff',
      action: 'STAFF_CREATE_ATTENDANCE_QR',
      entityType: 'registration_qr_code',
      entityId: created.id,
      details: { sessionId: session.id, sessionCode: session.sessionCode },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ qr: created });
  } catch (err) {
    console.error('Staff session QR error:', err);
    res.status(500).json({ error: 'Failed to generate attendance QR code.' });
  }
});

// Staff-assisted attendance fallback (when liveness/camera/GPS fails in classroom)
staffRouter.post('/attendance/assist', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    const scope = await getStaffScope(staff.id);
    const parsed = z
      .object({
        studentId: z.string().uuid('Please select a valid student.'),
        sessionId: z.string().uuid('Please select a valid session.'),
        reason: z.string().min(6, 'Reason is required for staff-assisted attendance.').max(300),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input.' });

    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, parsed.data.sessionId))
      .limit(1);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Staff-assisted attendance requires an active session.' });
    }
    if (!scope.departmentIds.includes(session.departmentId)) {
      return res.status(403).json({ error: 'Session is outside your assigned department.' });
    }

    const [record] = await db
      .insert(attendanceRecords)
      .values({
        studentId: parsed.data.studentId,
        sessionId: session.id,
        departmentId: session.departmentId,
        classId: session.classId,
        subjectId: session.subjectId,
        academicYearId: session.academicYearId,
        semesterId: session.semesterId,
        attendanceDate: session.sessionDate,
        status: 'present',
        verificationMethod: 'staff_assisted',
        verificationResult: 'assisted',
        livenessPassed: false,
        correctionReason: parsed.data.reason.trim(),
        correctedBy: staff.id,
      })
      .onConflictDoNothing({
        target: [attendanceRecords.studentId, attendanceRecords.sessionId],
      })
      .returning();

    if (!record) {
      return res.status(409).json({ error: 'Attendance has already been marked for this session.' });
    }

    await writeAuditLog({
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: 'staff',
      action: 'STAFF_ASSISTED_ATTENDANCE',
      entityType: 'attendance_record',
      entityId: record.id,
      details: { studentId: parsed.data.studentId, sessionId: session.id, reason: parsed.data.reason },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ message: 'Staff-assisted attendance recorded.', record });
  } catch (err) {
    console.error('Staff assisted attendance error:', err);
    res.status(500).json({ error: 'Failed to record assisted attendance.' });
  }
});

staffRouter.get('/correction-requests', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    const scope = await getStaffScope(staff.id);
    if (scope.departmentIds.length === 0) return res.json({ items: [] });

    const list = await db
      .select({
        id: attendanceCorrectionRequests.id,
        studentId: attendanceCorrectionRequests.studentId,
        studentName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        sessionId: attendanceCorrectionRequests.sessionId,
        sessionCode: attendanceSessions.sessionCode,
        periodSlot: attendanceSessions.periodSlot,
        subjectName: subjects.name,
        requestedStatus: attendanceCorrectionRequests.requestedStatus,
        requestType: attendanceCorrectionRequests.requestType,
        reason: attendanceCorrectionRequests.reason,
        status: attendanceCorrectionRequests.status,
        reviewNote: attendanceCorrectionRequests.reviewNote,
        createdAt: attendanceCorrectionRequests.createdAt,
      })
      .from(attendanceCorrectionRequests)
      .innerJoin(profiles, eq(attendanceCorrectionRequests.studentId, profiles.id))
      .innerJoin(attendanceSessions, eq(attendanceCorrectionRequests.sessionId, attendanceSessions.id))
      .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(inArray(attendanceSessions.departmentId, scope.departmentIds))
      .orderBy(desc(attendanceCorrectionRequests.createdAt))
      .limit(50);

    res.json({
      items: list.map((i) => ({
        ...i,
        subjectName:
          i.subjectName ??
          (i.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
        createdAtIST: formatISTTimestamp(new Date(i.createdAt)),
      })),
    });
  } catch (err) {
    console.error('Staff correction requests error:', err);
    res.status(500).json({ error: 'Failed to load correction requests.' });
  }
});

staffRouter.post('/correction-requests', async (req: AuthRequest, res) => {
  try {
    const staff = req.authProfile!;
    const scope = await getStaffScope(staff.id);
    const parsed = z
      .object({
        studentId: z.string().uuid('Please select a valid student.'),
        sessionId: z.string().uuid('Please select a valid session.'),
        requestedStatus: z.enum(['present', 'absent', 'excused']),
        reason: z.string().min(8).max(500),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Valid student, session, status, and reason required.' });

    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, parsed.data.sessionId))
      .limit(1);
    if (!session || !scope.departmentIds.includes(session.departmentId)) {
      return res.status(403).json({ error: 'Session not found in your assigned scope.' });
    }

    const [created] = await db
      .insert(attendanceCorrectionRequests)
      .values({
        studentId: parsed.data.studentId,
        sessionId: parsed.data.sessionId,
        requestedBy: staff.id,
        requestedStatus: parsed.data.requestedStatus,
        requestType: 'correction',
        reason: parsed.data.reason.trim(),
        status: 'pending',
      })
      .returning();

    await writeAuditLog({
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: 'staff',
      action: 'STAFF_CORRECTION_REQUESTED',
      entityType: 'attendance_correction_request',
      entityId: created.id,
      details: { studentId: parsed.data.studentId, sessionId: parsed.data.sessionId },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ request: created });
  } catch (err) {
    console.error('Staff create correction error:', err);
    res.status(500).json({ error: 'Failed to submit correction request.' });
  }
});
