import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  academicYears,
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  auditLogs,
  biometricTemplates,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
  jntuhRegulationRules,
  profiles,
  promotionBatches,
  promotionBatchItems,
  registrationQrCodes,
  roles,
  semesters,
  staffAssignments,
  studentEnrollments,
  subjects,
} from '../../db/schema.ts';
import { type AuthRequest, requireAuth, requireRole } from '../../middleware/auth.ts';
import {
  formatISTTimestamp,
  getISTDateString,
  isValidUuid,
  signAccountSetupToken,
} from '../crypto.ts';
import { writeAuditLog } from '../audit.ts';
import {
  executeBulkPromotion,
  listPromotionHistory,
  previewAcademicProgression,
  rollbackPromotionBatch,
} from '../progression.ts';
import {
  formatTime12h,
  getDayScheduleContext,
  getNormalizedScheduleSettings,
  syncAutomaticDailySessions,
} from '../attendanceScheduler.ts';
import {
  computeBulkSemesterAttendance,
  NO_ATTENDANCE_DATA_MESSAGE,
  roundPercentage2,
} from '../attendanceCalculator.ts';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole('super_admin'));

// 1. Admin Dashboard Aggregations
adminRouter.get('/dashboard', async (_req, res) => {
  try {
    const syncRes = await syncAutomaticDailySessions();
    const todayIST = syncRes.todayIST;

    const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
    const [staffRole] = await db.select().from(roles).where(eq(roles.name, 'staff')).limit(1);
    const [settingsRow] = await db.select().from(collegeSettings).limit(1);
    const normSettings = getNormalizedScheduleSettings(settingsRow);

    const [{ count: totalStudents }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(profiles)
      .where(and(eq(profiles.roleId, studentRole.id), eq(profiles.status, 'approved')));

    const [{ count: pendingRegistrations }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(profiles)
      .where(and(eq(profiles.roleId, studentRole.id), eq(profiles.status, 'pending')));

    const [{ count: totalStaff }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(profiles)
      .where(and(eq(profiles.roleId, staffRole.id), eq(profiles.status, 'approved')));

    const [{ count: activeSessions }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(attendanceSessions)
      .where(eq(attendanceSessions.status, 'active'));

    const [{ count: presentToday }] = await db
      .select({ count: sql<number>`count(distinct ${attendanceRecords.studentId})::int` })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.attendanceDate, todayIST),
          inArray(attendanceRecords.status, ['present', 'excused'])
        )
      );

    const absentToday = Math.max(0, totalStudents - presentToday);

    // Authoritative centralized semester attendance calculations across all active approved students
    const activeEnrollments = await db
      .select({
        studentId: studentEnrollments.studentId,
        departmentId: studentEnrollments.departmentId,
        classId: studentEnrollments.classId,
        semesterId: studentEnrollments.semesterId,
        academicYearId: studentEnrollments.academicYearId,
        joinedDateIST: studentEnrollments.joinedDateIST,
        approvedAt: studentEnrollments.approvedAt,
        enrolledAt: studentEnrollments.enrolledAt,
        lastPromotedAt: studentEnrollments.lastPromotedAt,
      })
      .from(studentEnrollments)
      .innerJoin(profiles, eq(studentEnrollments.studentId, profiles.id))
      .where(and(eq(studentEnrollments.isActive, true), eq(profiles.status, 'approved')));

    const attMap = await computeBulkSemesterAttendance({
      targets: activeEnrollments.map((e) => ({
        ...e,
        currentSemesterId: e.semesterId,
      })),
    });

    const deptAgg = new Map<
      string,
      { enrolled: number; totalCompleted: number; presentCompleted: number }
    >();
    let overallTotalCompleted = 0;
    let overallPresentCompleted = 0;

    for (const enr of activeEnrollments) {
      const summary = attMap.get(enr.studentId);
      const totalSes = summary?.totalSessions ?? 0;
      const presentSes = summary?.presentSessions ?? 0;
      overallTotalCompleted += totalSes;
      overallPresentCompleted += presentSes;

      const cur = deptAgg.get(enr.departmentId) ?? {
        enrolled: 0,
        totalCompleted: 0,
        presentCompleted: 0,
      };
      cur.enrolled += 1;
      cur.totalCompleted += totalSes;
      cur.presentCompleted += presentSes;
      deptAgg.set(enr.departmentId, cur);
    }

    const overallHasData = overallTotalCompleted > 0;
    const overallPercentage = roundPercentage2(overallPresentCompleted, overallTotalCompleted);

    // Department-wise attendance breakdown
    const allDepts = await db.select().from(departments).orderBy(asc(departments.code));
    const deptTodayPresent = await db
      .select({
        departmentId: attendanceRecords.departmentId,
        presentToday: sql<number>`count(distinct ${attendanceRecords.studentId})::int`,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.attendanceDate, todayIST),
          inArray(attendanceRecords.status, ['present', 'excused'])
        )
      )
      .groupBy(attendanceRecords.departmentId);

    const todayPresentMap = new Map(deptTodayPresent.map((d) => [d.departmentId, d.presentToday]));

    const departmentBreakdown = allDepts.map((dept) => {
      const agg = deptAgg.get(dept.id) ?? {
        enrolled: 0,
        totalCompleted: 0,
        presentCompleted: 0,
      };
      const present = todayPresentMap.get(dept.id) ?? 0;
      const hasData = agg.totalCompleted > 0;
      return {
        departmentId: dept.id,
        code: dept.code,
        name: dept.name,
        enrolledStudents: agg.enrolled,
        presentToday: present,
        absentToday: Math.max(0, agg.enrolled - present),
        totalCompletedSessions: agg.totalCompleted,
        presentSessions: agg.presentCompleted,
        absentSessions: Math.max(0, agg.totalCompleted - agg.presentCompleted),
        percentage: roundPercentage2(agg.presentCompleted, agg.totalCompleted),
        hasData,
        message: hasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
      };
    });

    // Today's Morning & Afternoon daily schedule counts
    const [todayAutoSessions, todayRecCounts, upcomingHolidays, recentAudit] = await Promise.all([
      db
        .select({
          id: attendanceSessions.id,
          periodSlot: attendanceSessions.periodSlot,
          status: attendanceSessions.status,
        })
        .from(attendanceSessions)
        .where(eq(attendanceSessions.sessionDate, todayIST)),
      db
        .select({
          sessionId: attendanceRecords.sessionId,
          status: attendanceRecords.status,
        })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.attendanceDate, todayIST),
            inArray(attendanceRecords.status, ['present', 'excused'])
          )
        ),
      db
        .select()
        .from(holidays)
        .where(gte(holidays.endDate, todayIST))
        .orderBy(asc(holidays.startDate))
        .limit(5),
      db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(8),
    ]);

    const presentCountBySession = new Map<string, number>();
    for (const r of todayRecCounts) {
      presentCountBySession.set(r.sessionId, (presentCountBySession.get(r.sessionId) ?? 0) + 1);
    }

    const buildAdminSlot = (slot: 'morning' | 'afternoon') => {
      const slotSes = todayAutoSessions.filter((s) => s.periodSlot === slot);
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
        totalSessions: slotSes.length,
        presentCount: slotSes.reduce(
          (sum, s) => sum + (presentCountBySession.get(s.id) ?? 0),
          0
        ),
      };
    };

    res.json({
      todayIST,
      todayDayEval: syncRes.dayEval,
      dailySchedule: {
        autoDailySessionsEnabled: normSettings.autoDailySessionsEnabled,
        workingWeekdays: normSettings.workingWeekdays,
        morning: buildAdminSlot('morning'),
        afternoon: buildAdminSlot('afternoon'),
      },
      upcomingHolidays,
      metrics: {
        totalStudents,
        totalStaff,
        pendingRegistrations,
        activeSessions,
        presentToday,
        absentToday,
        overallPercentage,
        overallHasData,
        overallMessage: overallHasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
      },
      departmentBreakdown,
      recentAudit: recentAudit.map((a) => ({
        ...a,
        createdAtIST: formatISTTimestamp(new Date(a.createdAt)),
      })),
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to load admin dashboard.' });
  }
});

// 2. Pending / All Student Registrations
adminRouter.get('/registrations', async (req, res) => {
  try {
    const statusFilter = (req.query.status as string) || 'pending';
    const search = ((req.query.search as string) || '').trim();
    const departmentId = (req.query.departmentId as string) || '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);

    const conditions = [eq(profiles.roleId, studentRole.id)];
    if (statusFilter !== 'all') {
      conditions.push(eq(profiles.status, statusFilter));
    }
    if (isValidUuid(departmentId)) {
      conditions.push(eq(studentEnrollments.departmentId, departmentId));
    }
    if (search) {
      conditions.push(
        or(
          ilike(profiles.fullName, `%${search}%`),
          ilike(profiles.email, `%${search}%`),
          ilike(profiles.rollNumber, `%${search}%`)
        )!
      );
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(profiles)
      .innerJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .where(and(...conditions));

    const items = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        email: profiles.email,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        status: profiles.status,
        emailVerified: profiles.emailVerified,
        rejectionReason: profiles.rejectionReason,
        createdAt: profiles.createdAt,
        departmentId: studentEnrollments.departmentId,
        departmentCode: departments.code,
        yearLabel: academicYears.label,
        semesterLabel: semesters.label,
        className: classes.displayName,
      })
      .from(profiles)
      .innerJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
      .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
      .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
      .where(and(...conditions))
      .orderBy(desc(profiles.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      items: items.map((i) => ({
        ...i,
        createdAtIST: formatISTTimestamp(new Date(i.createdAt)),
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('List registrations error:', err);
    res.status(500).json({ error: 'Failed to load registrations.' });
  }
});

adminRouter.post('/registrations/:id/approve', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const studentId = req.params.id;
    if (!isValidUuid(studentId)) return res.status(400).json({ error: 'Invalid student ID.' });

    const [profile] = await db.select().from(profiles).where(eq(profiles.id, studentId)).limit(1);
    if (!profile) {
      return res.status(404).json({ error: 'Student registration not found.' });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({ status: 'approved', rejectionReason: null, updatedAt: new Date() })
        .where(eq(profiles.id, studentId));

      await tx
        .update(studentEnrollments)
        .set({
          isActive: true,
          approvedBy: admin.id,
          approvedAt: new Date(),
          joinedDateIST: getISTDateString(),
        })
        .where(eq(studentEnrollments.studentId, studentId));
    });

    const setupToken = signAccountSetupToken(profile.id, profile.email, 72);

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'APPROVE_REGISTRATION',
      entityType: 'profile',
      entityId: studentId,
      details: { rollNumber: profile.rollNumber, email: profile.email },
      ipAddress: req.clientIp,
    });

    res.json({
      message: 'Student registration approved. Portal access unlocked.',
      setupToken,
    });
  } catch (err) {
    console.error('Approve registration error:', err);
    res.status(500).json({ error: 'Failed to approve registration.' });
  }
});

adminRouter.post('/registrations/:id/reject', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const studentId = req.params.id;
    if (!isValidUuid(studentId)) return res.status(400).json({ error: 'Invalid student ID.' });
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason || reason.length < 4) {
      return res.status(400).json({ error: 'A rejection reason (min 4 characters) is required.' });
    }

    const found = await db.transaction(async (tx) => {
      const updated = await tx
        .update(profiles)
        .set({ status: 'rejected', rejectionReason: reason, updatedAt: new Date() })
        .where(eq(profiles.id, studentId))
        .returning({ id: profiles.id });

      if (updated.length === 0) return false;

      await tx
        .update(studentEnrollments)
        .set({ isActive: false })
        .where(eq(studentEnrollments.studentId, studentId));

      return true;
    });

    if (!found) {
      return res.status(404).json({ error: 'Student registration not found.' });
    }

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'REJECT_REGISTRATION',
      entityType: 'profile',
      entityId: studentId,
      details: { reason },
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Student registration rejected.' });
  } catch (err) {
    console.error('Reject registration error:', err);
    res.status(500).json({ error: 'Failed to reject registration.' });
  }
});

// 3. Student Directory (Paginated for 5,000 - 10,000 accounts)
adminRouter.get('/students', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = ((req.query.search as string) || '').trim();
    const departmentId = (req.query.departmentId as string) || '';
    const academicYearId = (req.query.academicYearId as string) || '';
    const semesterId = (req.query.semesterId as string) || '';
    const status = (req.query.status as string) || 'all';

    const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
    const conditions = [eq(profiles.roleId, studentRole.id)];

    if (status !== 'all') conditions.push(eq(profiles.status, status));
    if (isValidUuid(departmentId)) conditions.push(eq(studentEnrollments.departmentId, departmentId));
    if (isValidUuid(academicYearId)) conditions.push(eq(studentEnrollments.academicYearId, academicYearId));
    if (isValidUuid(semesterId)) conditions.push(eq(studentEnrollments.semesterId, semesterId));
    if (search) {
      conditions.push(
        or(
          ilike(profiles.fullName, `%${search}%`),
          ilike(profiles.email, `%${search}%`),
          ilike(profiles.rollNumber, `%${search}%`)
        )!
      );
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(profiles)
      .innerJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .where(and(...conditions));

    const items = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        email: profiles.email,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        status: profiles.status,
        departmentId: studentEnrollments.departmentId,
        departmentCode: departments.code,
        academicYearId: studentEnrollments.academicYearId,
        yearLabel: academicYears.label,
        semesterId: studentEnrollments.semesterId,
        semesterLabel: semesters.label,
        classId: studentEnrollments.classId,
        className: classes.displayName,
        biometricEnrolled: sql<boolean>`exists(select 1 from biometric_templates bt where bt.student_id = ${profiles.id} and bt.is_active = true)`,
      })
      .from(profiles)
      .innerJoin(studentEnrollments, eq(profiles.id, studentEnrollments.studentId))
      .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
      .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
      .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
      .where(and(...conditions))
      .orderBy(asc(profiles.rollNumber))
      .limit(limit)
      .offset(offset);

    res.json({
      items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('List students error:', err);
    res.status(500).json({ error: 'Failed to load students.' });
  }
});

const createStudentSchema = z.object({
  fullName: z.string().min(2).max(120),
  rollNumber: z.string().min(3).max(40),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  departmentId: z.string().uuid('Please select a valid department.'),
  academicYearId: z.string().uuid('Please select a valid academic year.'),
  semesterId: z.string().uuid('Please select a valid semester.'),
});

adminRouter.post('/students', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = createStudentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid student input.' });
    }
    const data = parsed.data;
    const email = data.email.toLowerCase().trim();
    const rollNumber = data.rollNumber.toUpperCase().trim();

    const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
    const [dept] = await db.select().from(departments).where(eq(departments.id, data.departmentId)).limit(1);
    const [sem] = await db.select().from(semesters).where(eq(semesters.id, data.semesterId)).limit(1);
    if (!dept || !sem) {
      return res.status(400).json({ error: 'Invalid department or semester.' });
    }

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
      const inserted = await db
        .insert(classes)
        .values({
          departmentId: data.departmentId,
          academicYearId: data.academicYearId,
          semesterId: data.semesterId,
          sectionName: 'Regular',
          displayName: `${dept.code} · Sem ${sem.semesterNumber}`,
        })
        .returning();
      classRow = inserted[0];
    }

    const created = await db.transaction(async (tx) => {
      const [prof] = await tx
        .insert(profiles)
        .values({
          roleId: studentRole.id,
          fullName: data.fullName.trim(),
          email,
          phone: data.phone.trim(),
          rollNumber,
          status: 'approved',
          emailVerified: false,
        })
        .returning();

      await tx.insert(studentEnrollments).values({
        studentId: prof.id,
        rollNumber,
        departmentId: data.departmentId,
        academicYearId: data.academicYearId,
        semesterId: data.semesterId,
        classId: classRow.id,
        isActive: true,
        approvedBy: admin.id,
        approvedAt: new Date(),
        joinedDateIST: getISTDateString(),
      });

      return prof;
    });

    const setupToken = signAccountSetupToken(created.id, email, 72);

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_STUDENT',
      entityType: 'profile',
      entityId: created.id,
      details: { rollNumber, email, departmentCode: dept.code },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ student: created, setupToken });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({ error: 'A student with this email or roll number already exists.' });
    }
    console.error('Create student error:', err);
    res.status(500).json({ error: 'Failed to create student.' });
  }
});

adminRouter.patch('/students/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const studentId = req.params.id;
    if (!isValidUuid(studentId)) return res.status(400).json({ error: 'Invalid student ID.' });
    const { fullName, phone, status, departmentId, academicYearId, semesterId } = req.body;

    const [existing] = await db.select().from(profiles).where(eq(profiles.id, studentId)).limit(1);
    if (!existing) return res.status(404).json({ error: 'Student not found.' });

    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({
          fullName: fullName ? String(fullName).trim() : existing.fullName,
          phone: phone !== undefined ? String(phone).trim() : existing.phone,
          status: status || existing.status,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, studentId));

      if (status === 'deactivated') {
        // Deactivating account preserves all historical attendance records!
        await tx
          .update(studentEnrollments)
          .set({ isActive: false })
          .where(eq(studentEnrollments.studentId, studentId));
      } else if (status === 'approved') {
        await tx
          .update(studentEnrollments)
          .set({ isActive: true })
          .where(eq(studentEnrollments.studentId, studentId));
      }

      if (isValidUuid(departmentId) && isValidUuid(academicYearId) && isValidUuid(semesterId)) {
        const [dept] = await tx.select().from(departments).where(eq(departments.id, departmentId)).limit(1);
        const [sem] = await tx.select().from(semesters).where(eq(semesters.id, semesterId)).limit(1);
        if (dept && sem) {
          let [classRow] = await tx
            .select()
            .from(classes)
            .where(
              and(
                eq(classes.departmentId, departmentId),
                eq(classes.academicYearId, academicYearId),
                eq(classes.semesterId, semesterId)
              )
            )
            .limit(1);
          if (!classRow) {
            const ins = await tx
              .insert(classes)
              .values({
                departmentId,
                academicYearId,
                semesterId,
                sectionName: 'Regular',
                displayName: `${dept.code} · Sem ${sem.semesterNumber}`,
              })
              .returning();
            classRow = ins[0];
          }
          await tx
            .update(studentEnrollments)
            .set({
              departmentId,
              academicYearId,
              semesterId,
              classId: classRow.id,
            })
            .where(eq(studentEnrollments.studentId, studentId));
        }
      }
    });

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: status === 'deactivated' ? 'DEACTIVATE_STUDENT' : 'UPDATE_STUDENT',
      entityType: 'profile',
      entityId: studentId,
      details: { status, fullName },
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Student updated successfully.' });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ error: 'Failed to update student.' });
  }
});

// 4. Staff Management & Assignments
adminRouter.get('/staff', async (_req, res) => {
  try {
    const [staffRole] = await db.select().from(roles).where(eq(roles.name, 'staff')).limit(1);
    const [adminRole] = await db.select().from(roles).where(eq(roles.name, 'super_admin')).limit(1);

    const staffList = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        email: profiles.email,
        phone: profiles.phone,
        employeeId: profiles.employeeId,
        status: profiles.status,
        roleName: roles.name,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(inArray(profiles.roleId, [staffRole.id, adminRole.id]))
      .orderBy(asc(profiles.fullName));

    const allAssignments = await db
      .select({
        id: staffAssignments.id,
        staffId: staffAssignments.staffId,
        departmentId: staffAssignments.departmentId,
        departmentCode: departments.code,
        classId: staffAssignments.classId,
        className: classes.displayName,
        subjectId: staffAssignments.subjectId,
        subjectName: subjects.name,
        subjectCode: subjects.code,
        canCreateSessions: staffAssignments.canCreateSessions,
      })
      .from(staffAssignments)
      .innerJoin(departments, eq(staffAssignments.departmentId, departments.id))
      .leftJoin(classes, eq(staffAssignments.classId, classes.id))
      .leftJoin(subjects, eq(staffAssignments.subjectId, subjects.id))
      .where(eq(staffAssignments.isActive, true));

    const assignMap = new Map<string, typeof allAssignments>();
    for (const a of allAssignments) {
      const list = assignMap.get(a.staffId) ?? [];
      list.push(a);
      assignMap.set(a.staffId, list);
    }

    res.json({
      items: staffList.map((s) => ({
        ...s,
        assignments: assignMap.get(s.id) ?? [],
      })),
    });
  } catch (err) {
    console.error('List staff error:', err);
    res.status(500).json({ error: 'Failed to load staff directory.' });
  }
});

const createStaffSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().min(10).max(15).optional(),
  employeeId: z.string().min(2).max(40),
  assignments: z
    .array(
      z.object({
        departmentId: z.string().uuid('Please select a valid department.'),
        classId: z.string().uuid('Please select a valid class.').nullable().optional(),
        subjectId: z.string().uuid('Please select a valid subject.').nullable().optional(),
        canCreateSessions: z.boolean().default(true),
      })
    )
    .min(1, 'Assign at least one department to the staff member.'),
});

adminRouter.post('/staff', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = createStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid staff input.' });
    }
    const data = parsed.data;
    const email = data.email.toLowerCase().trim();
    const employeeId = data.employeeId.toUpperCase().trim();
    const [staffRole] = await db.select().from(roles).where(eq(roles.name, 'staff')).limit(1);

    const created = await db.transaction(async (tx) => {
      const [prof] = await tx
        .insert(profiles)
        .values({
          roleId: staffRole.id,
          fullName: data.fullName.trim(),
          email,
          phone: data.phone?.trim() || null,
          employeeId,
          status: 'approved',
          emailVerified: false,
        })
        .returning();

      for (const a of data.assignments) {
        await tx.insert(staffAssignments).values({
          staffId: prof.id,
          departmentId: a.departmentId,
          classId: a.classId || null,
          subjectId: a.subjectId || null,
          canCreateSessions: a.canCreateSessions,
        });
      }
      return prof;
    });

    const setupToken = signAccountSetupToken(created.id, email, 72);

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_STAFF',
      entityType: 'profile',
      entityId: created.id,
      details: { email, employeeId, assignmentCount: data.assignments.length },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ staff: created, setupToken });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({ error: 'Staff email or employee ID already exists.' });
    }
    console.error('Create staff error:', err);
    res.status(500).json({ error: 'Failed to create staff account.' });
  }
});

adminRouter.patch('/staff/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const staffId = req.params.id;
    if (!isValidUuid(staffId)) return res.status(400).json({ error: 'Invalid staff ID.' });
    const { status, assignments } = req.body;

    if (Array.isArray(assignments)) {
      for (const a of assignments) {
        if (!isValidUuid(a?.departmentId)) {
          return res.status(400).json({ error: 'Each staff assignment requires a valid department ID.' });
        }
        if (a?.classId && !isValidUuid(a.classId)) {
          return res.status(400).json({ error: 'Invalid class ID in staff assignment.' });
        }
        if (a?.subjectId && !isValidUuid(a.subjectId)) {
          return res.status(400).json({ error: 'Invalid subject ID in staff assignment.' });
        }
      }
    }

    await db.transaction(async (tx) => {
      if (status) {
        await tx
          .update(profiles)
          .set({ status, updatedAt: new Date() })
          .where(eq(profiles.id, staffId));
      }
      if (Array.isArray(assignments)) {
        await tx.delete(staffAssignments).where(eq(staffAssignments.staffId, staffId));
        for (const a of assignments) {
          await tx.insert(staffAssignments).values({
            staffId,
            departmentId: a.departmentId,
            classId: a.classId || null,
            subjectId: a.subjectId || null,
            canCreateSessions: Boolean(a.canCreateSessions ?? true),
          });
        }
      }
    });

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_STAFF',
      entityType: 'profile',
      entityId: staffId,
      details: { status, updatedAssignments: Array.isArray(assignments) },
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Staff account updated.' });
  } catch (err) {
    console.error('Update staff error:', err);
    res.status(500).json({ error: 'Failed to update staff account.' });
  }
});

// Create additional Super Admin (Strictly restricted to existing Super Admin)
adminRouter.post('/admins', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        fullName: z.string().min(2).max(120),
        email: z.string().email(),
        phone: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid name and email are required.' });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const [adminRole] = await db.select().from(roles).where(eq(roles.name, 'super_admin')).limit(1);

    const [created] = await db
      .insert(profiles)
      .values({
        roleId: adminRole.id,
        fullName: parsed.data.fullName.trim(),
        email,
        phone: parsed.data.phone?.trim() || null,
        status: 'approved',
        emailVerified: false,
      })
      .returning();

    const setupToken = signAccountSetupToken(created.id, email, 72);

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_SUPER_ADMIN',
      entityType: 'profile',
      entityId: created.id,
      details: { newAdminEmail: email },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ admin: created, setupToken });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('Create admin error:', err);
    res.status(500).json({ error: 'Failed to create administrator.' });
  }
});

// 5. Academics Structure Management
adminRouter.get('/academics', async (_req, res) => {
  try {
    const [depts, years, sems, classList, subjectList] = await Promise.all([
      db.select().from(departments).orderBy(asc(departments.code)),
      db.select().from(academicYears).orderBy(asc(academicYears.yearNumber)),
      db.select().from(semesters).orderBy(asc(semesters.semesterNumber)),
      db
        .select({
          id: classes.id,
          departmentId: classes.departmentId,
          departmentCode: departments.code,
          academicYearId: classes.academicYearId,
          yearLabel: academicYears.label,
          semesterId: classes.semesterId,
          semesterLabel: semesters.label,
          sectionName: classes.sectionName,
          displayName: classes.displayName,
          isActive: classes.isActive,
        })
        .from(classes)
        .innerJoin(departments, eq(classes.departmentId, departments.id))
        .innerJoin(academicYears, eq(classes.academicYearId, academicYears.id))
        .innerJoin(semesters, eq(classes.semesterId, semesters.id))
        .orderBy(asc(departments.code), asc(semesters.semesterNumber)),
      db
        .select({
          id: subjects.id,
          code: subjects.code,
          name: subjects.name,
          departmentId: subjects.departmentId,
          departmentCode: departments.code,
          semesterId: subjects.semesterId,
          semesterLabel: semesters.label,
          credits: subjects.credits,
          isActive: subjects.isActive,
        })
        .from(subjects)
        .innerJoin(departments, eq(subjects.departmentId, departments.id))
        .innerJoin(semesters, eq(subjects.semesterId, semesters.id))
        .orderBy(asc(departments.code), asc(subjects.code)),
    ]);

    res.json({
      departments: depts,
      academicYears: years,
      semesters: sems,
      classes: classList,
      subjects: subjectList,
    });
  } catch (err) {
    console.error('Academics fetch error:', err);
    res.status(500).json({ error: 'Failed to load academic structure.' });
  }
});

adminRouter.post('/classes', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        departmentId: z.string().uuid('Please select a valid department.'),
        academicYearId: z.string().uuid('Please select a valid academic year.'),
        semesterId: z.string().uuid('Please select a valid semester.'),
        sectionName: z.string().min(1).max(30),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid class parameters.' });

    const [dept] = await db.select().from(departments).where(eq(departments.id, parsed.data.departmentId)).limit(1);
    const [sem] = await db.select().from(semesters).where(eq(semesters.id, parsed.data.semesterId)).limit(1);
    if (!dept || !sem) return res.status(400).json({ error: 'Invalid department or semester.' });

    const [created] = await db
      .insert(classes)
      .values({
        ...parsed.data,
        displayName: `${dept.code} · Sem ${sem.semesterNumber} (${parsed.data.sectionName.trim()})`,
      })
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_CLASS',
      entityType: 'class',
      entityId: created.id,
      details: { displayName: created.displayName },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ classGroup: created });
  } catch (err) {
    console.error('Create class error:', err);
    res.status(409).json({ error: 'Class already exists or invalid parameters.' });
  }
});

adminRouter.post('/subjects', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        code: z.string().min(2).max(24),
        name: z.string().min(2).max(120),
        departmentId: z.string().uuid('Please select a valid department.'),
        semesterId: z.string().uuid('Please select a valid semester.'),
        credits: z.number().int().min(1).max(10).default(3),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid subject parameters.' });

    const [created] = await db
      .insert(subjects)
      .values({
        code: parsed.data.code.toUpperCase().trim(),
        name: parsed.data.name.trim(),
        departmentId: parsed.data.departmentId,
        semesterId: parsed.data.semesterId,
        credits: parsed.data.credits,
      })
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_SUBJECT',
      entityType: 'subject',
      entityId: created.id,
      details: { code: created.code, name: created.name },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ subject: created });
  } catch (err) {
    console.error('Create subject error:', err);
    res.status(409).json({ error: 'Subject code already exists for this department & semester.' });
  }
});

adminRouter.patch('/departments/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid department ID.' });
    const { name, isActive } = req.body;
    const [updated] = await db
      .update(departments)
      .set({
        ...(name ? { name: String(name).trim() } : {}),
        ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
      })
      .where(eq(departments.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Department not found.' });
    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_DEPARTMENT',
      entityType: 'department',
      entityId: req.params.id,
      details: { name, isActive },
      ipAddress: req.clientIp,
    });
    res.json({ department: updated });
  } catch (err) {
    console.error('Update dept error:', err);
    res.status(500).json({ error: 'Failed to update department.' });
  }
});

adminRouter.patch('/academic-years/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid academic year ID.' });
    const { academicSession, isActive } = req.body;
    const [updated] = await db
      .update(academicYears)
      .set({
        ...(academicSession ? { academicSession: String(academicSession).trim() } : {}),
        ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
      })
      .where(eq(academicYears.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Academic year not found.' });
    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_ACADEMIC_YEAR',
      entityType: 'academic_year',
      entityId: req.params.id,
      details: { academicSession, isActive },
      ipAddress: req.clientIp,
    });
    res.json({ academicYear: updated });
  } catch (err) {
    console.error('Update year error:', err);
    res.status(500).json({ error: 'Failed to update academic year.' });
  }
});

// 6. Registration & Attendance Check-In QR Codes
adminRouter.get('/qr-codes', async (_req, res) => {
  try {
    const list = await db
      .select({
        id: registrationQrCodes.id,
        token: registrationQrCodes.token,
        qrPurpose: registrationQrCodes.qrPurpose,
        label: registrationQrCodes.label,
        departmentId: registrationQrCodes.departmentId,
        departmentCode: departments.code,
        academicYearId: registrationQrCodes.academicYearId,
        semesterId: registrationQrCodes.semesterId,
        sessionId: registrationQrCodes.sessionId,
        sessionCode: attendanceSessions.sessionCode,
        maxUses: registrationQrCodes.maxUses,
        usedCount: registrationQrCodes.usedCount,
        expiresAt: registrationQrCodes.expiresAt,
        isRevoked: registrationQrCodes.isRevoked,
        createdAt: registrationQrCodes.createdAt,
      })
      .from(registrationQrCodes)
      .leftJoin(departments, eq(registrationQrCodes.departmentId, departments.id))
      .leftJoin(attendanceSessions, eq(registrationQrCodes.sessionId, attendanceSessions.id))
      .orderBy(desc(registrationQrCodes.createdAt));

    res.json({
      items: list.map((q) => ({
        ...q,
        expiresAtIST: q.expiresAt ? formatISTTimestamp(new Date(q.expiresAt)) : 'No Expiry',
      })),
    });
  } catch (err) {
    console.error('List QR codes error:', err);
    res.status(500).json({ error: 'Failed to load QR codes.' });
  }
});

adminRouter.post('/qr-codes', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        qrPurpose: z.enum(['registration', 'attendance']).default('registration'),
        label: z.string().min(2).max(120),
        departmentId: z.string().uuid('Please select a valid department.').nullable().optional(),
        academicYearId: z.string().uuid('Please select a valid academic year.').nullable().optional(),
        semesterId: z.string().uuid('Please select a valid semester.').nullable().optional(),
        sessionId: z.string().uuid('Please select a valid session.').nullable().optional(),
        expiryHours: z.number().int().min(0).max(8760).nullable().optional(),
        maxUses: z.number().int().min(1).max(10000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid QR configuration.' });

    const prefix = parsed.data.qrPurpose === 'attendance' ? 'SBIST-ATT' : 'SBIST';
    const token = `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const expiresAt =
      parsed.data.expiryHours && parsed.data.expiryHours > 0
        ? new Date(Date.now() + parsed.data.expiryHours * 3600 * 1000)
        : null;

    const [created] = await db
      .insert(registrationQrCodes)
      .values({
        token,
        qrPurpose: parsed.data.qrPurpose,
        label: parsed.data.label.trim(),
        departmentId: parsed.data.departmentId || null,
        academicYearId: parsed.data.academicYearId || null,
        semesterId: parsed.data.semesterId || null,
        sessionId: parsed.data.qrPurpose === 'attendance' ? parsed.data.sessionId || null : null,
        maxUses: parsed.data.maxUses ?? null,
        expiresAt,
        createdBy: admin.id,
      })
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action:
        parsed.data.qrPurpose === 'attendance'
          ? 'CREATE_ATTENDANCE_QR'
          : 'CREATE_REGISTRATION_QR',
      entityType: 'registration_qr_code',
      entityId: created.id,
      details: {
        qrPurpose: created.qrPurpose,
        label: created.label,
        sessionId: created.sessionId,
        expiryHours: parsed.data.expiryHours,
      },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ qr: created });
  } catch (err) {
    console.error('Create QR error:', err);
    res.status(500).json({ error: 'Failed to generate QR code.' });
  }
});

adminRouter.patch('/qr-codes/:id/revoke', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid QR code ID.' });
    const [existingQr] = await db
      .select({ id: registrationQrCodes.id, token: registrationQrCodes.token })
      .from(registrationQrCodes)
      .where(eq(registrationQrCodes.id, req.params.id))
      .limit(1);
    if (!existingQr) return res.status(404).json({ error: 'QR code not found.' });
    if (existingQr.token === 'SBIST-ATTEND-CAMPUS' || existingQr.token === 'SBIST-REGISTER-CAMPUS') {
      return res.status(400).json({ error: 'Permanent lifetime campus QR codes cannot be revoked.' });
    }
    const [updated] = await db
      .update(registrationQrCodes)
      .set({ isRevoked: true })
      .where(eq(registrationQrCodes.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: 'Registration QR code not found.' });

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'REVOKE_REGISTRATION_QR',
      entityType: 'registration_qr_code',
      entityId: req.params.id,
      ipAddress: req.clientIp,
    });

    res.json({ qr: updated });
  } catch (err) {
    console.error('Revoke QR error:', err);
    res.status(500).json({ error: 'Failed to revoke QR code.' });
  }
});

// 7. College Settings
adminRouter.get('/settings', async (_req, res) => {
  try {
    const [settings] = await db.select().from(collegeSettings).limit(1);
    res.json({ settings });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Failed to load college settings.' });
  }
});

adminRouter.patch('/settings', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        collegeName: z.string().min(3).max(200).optional(),
        logoUrl: z.string().max(500).optional(),
        locationVerificationEnabled: z.boolean().optional(),
        collegeLatitude: z.number().min(-90).max(90).optional(),
        collegeLongitude: z.number().min(-180).max(180).optional(),
        geofenceRadiusMeters: z.number().int().min(20).max(10000).optional(),
        attendanceFrequency: z.enum(['once_per_day', 'morning_afternoon', 'every_class_period']).optional(),
        qrDefaultExpiryHours: z.number().int().min(1).max(8760).optional(),
        faceMatchThreshold: z.number().min(0.25).max(0.75).optional(),
        livenessRequired: z.boolean().optional(),
        autoDailySessionsEnabled: z.boolean().optional(),
        morningStartTime: z.string().regex(/^\d{2}:\d{2}$/, 'Morning start time must be HH:MM.').optional(),
        morningEndTime: z.string().regex(/^\d{2}:\d{2}$/, 'Morning end time must be HH:MM.').optional(),
        afternoonStartTime: z.string().regex(/^\d{2}:\d{2}$/, 'Afternoon start time must be HH:MM.').optional(),
        afternoonEndTime: z.string().regex(/^\d{2}:\d{2}$/, 'Afternoon end time must be HH:MM.').optional(),
        workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Select at least one working day.').max(7).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid settings.' });
    }

    const [existing] = await db.select().from(collegeSettings).limit(1);
    const nextMorningStart = parsed.data.morningStartTime ?? existing.morningStartTime;
    const nextMorningEnd = parsed.data.morningEndTime ?? existing.morningEndTime;
    const nextAfternoonStart = parsed.data.afternoonStartTime ?? existing.afternoonStartTime;
    const nextAfternoonEnd = parsed.data.afternoonEndTime ?? existing.afternoonEndTime;

    if (nextMorningStart >= nextMorningEnd) {
      return res.status(400).json({ error: 'Morning session start time must be before end time.' });
    }
    if (nextAfternoonStart >= nextAfternoonEnd) {
      return res.status(400).json({ error: 'Afternoon session start time must be before end time.' });
    }
    if (nextMorningEnd > nextAfternoonStart) {
      return res.status(400).json({ error: 'Morning session must finish before Afternoon session starts.' });
    }

    const [updated] = await db
      .update(collegeSettings)
      .set({
        ...parsed.data,
        ...(parsed.data.workingWeekdays
          ? { workingWeekdays: Array.from(new Set(parsed.data.workingWeekdays)).sort() }
          : {}),
        updatedBy: admin.id,
        updatedAt: new Date(),
      })
      .where(eq(collegeSettings.id, existing.id))
      .returning();

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_COLLEGE_SETTINGS',
      entityType: 'college_settings',
      entityId: updated.id,
      details: parsed.data,
      ipAddress: req.clientIp,
    });

    res.json({ settings: updated });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to update college settings.' });
  }
});

// 8. Attendance Sessions
adminRouter.get('/sessions', async (req, res) => {
  try {
    await syncAutomaticDailySessions();
    const status = (req.query.status as string) || 'all';
    const departmentId = (req.query.departmentId as string) || '';
    const conditions = [];
    if (status !== 'all') conditions.push(eq(attendanceSessions.status, status));
    if (isValidUuid(departmentId)) conditions.push(eq(attendanceSessions.departmentId, departmentId));

    const list = await db
      .select({
        id: attendanceSessions.id,
        sessionCode: attendanceSessions.sessionCode,
        departmentId: attendanceSessions.departmentId,
        departmentCode: departments.code,
        classId: attendanceSessions.classId,
        className: classes.displayName,
        academicYearId: attendanceSessions.academicYearId,
        semesterId: attendanceSessions.semesterId,
        subjectId: attendanceSessions.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionDate: attendanceSessions.sessionDate,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
        periodSlot: attendanceSessions.periodSlot,
        sessionType: attendanceSessions.sessionType,
        isAutoScheduled: attendanceSessions.isAutoScheduled,
        cancelledReason: attendanceSessions.cancelledReason,
        status: attendanceSessions.status,
        createdAt: attendanceSessions.createdAt,
        presentCount: sql<number>`(select count(*)::int from attendance_records ar where ar.session_id = ${attendanceSessions.id} and ar.status in ('present', 'excused'))`,
      })
      .from(attendanceSessions)
      .innerJoin(departments, eq(attendanceSessions.departmentId, departments.id))
      .innerJoin(classes, eq(attendanceSessions.classId, classes.id))
      .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(attendanceSessions.sessionDate), desc(attendanceSessions.createdAt))
      .limit(150);

    res.json({
      items: list.map((s) => ({
        ...s,
        subjectCode: s.subjectCode ?? 'DAILY',
        subjectName:
          s.subjectName ??
          (s.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
      })),
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to load attendance sessions.' });
  }
});

adminRouter.post('/sessions', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid session configuration.' });

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
        createdBy: admin.id,
      })
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_ATTENDANCE_SESSION',
      entityType: 'attendance_session',
      entityId: created.id,
      details: { sessionCode, status: created.status },
      ipAddress: req.clientIp,
    });

    res.status(201).json({ session: created });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Failed to create attendance session.' });
  }
});

adminRouter.patch('/sessions/:id/status', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid session ID.' });
    const parsed = z.object({ status: z.enum(['scheduled', 'active', 'closed', 'cancelled']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid session status.' });

    const [existingSession] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, req.params.id))
      .limit(1);

    if (!existingSession) return res.status(404).json({ error: 'Session not found.' });

    if (parsed.data.status === 'active' || parsed.data.status === 'scheduled') {
      const { dayEval } = await getDayScheduleContext(existingSession.sessionDate);
      if (dayEval.isHoliday) {
        return res.status(409).json({
          error: `Cannot ${parsed.data.status === 'active' ? 'activate' : 'schedule'} session on ${existingSession.sessionDate}: marked as Holiday ("${dayEval.holidayTitle}").`,
          code: 'HOLIDAY_BLOCKED',
        });
      }
      if (dayEval.dayStatus === 'closed_day') {
        return res.status(409).json({
          error: `Cannot ${parsed.data.status === 'active' ? 'activate' : 'schedule'} session on ${existingSession.sessionDate}: marked as Closed (${dayEval.overrideTitle}).`,
          code: 'CLOSED_DAY_BLOCKED',
        });
      }
    }

    const [updated] = await db
      .update(attendanceSessions)
      .set({
        status: parsed.data.status,
        cancelledReason: parsed.data.status === 'cancelled' ? 'MANUAL_ADMIN_CANCELLED' : null,
        updatedAt: new Date(),
      })
      .where(eq(attendanceSessions.id, req.params.id))
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_SESSION_STATUS',
      entityType: 'attendance_session',
      entityId: updated.id,
      details: { status: parsed.data.status, sessionCode: updated.sessionCode },
      ipAddress: req.clientIp,
    });

    res.json({ session: updated });
  } catch (err) {
    console.error('Update session status error:', err);
    res.status(500).json({ error: 'Failed to update session status.' });
  }
});

// 8b. Holiday Scheduler & Working Day Override Management
adminRouter.get('/holidays', async (_req, res) => {
  try {
    const [items, overrides, settingsRow] = await Promise.all([
      db.select().from(holidays).orderBy(asc(holidays.startDate), desc(holidays.createdAt)),
      db.select().from(calendarOverrides).orderBy(asc(calendarOverrides.overrideDate)),
      db.select().from(collegeSettings).limit(1),
    ]);
    const normSettings = getNormalizedScheduleSettings(settingsRow[0]);
    res.json({
      todayIST: getISTDateString(),
      items: items.map((h) => ({
        ...h,
        createdAtIST: formatISTTimestamp(new Date(h.createdAt)),
      })),
      overrides: overrides.map((o) => ({
        ...o,
        createdAtIST: formatISTTimestamp(new Date(o.createdAt)),
      })),
      scheduleSettings: normSettings,
    });
  } catch (err) {
    console.error('List holidays error:', err);
    res.status(500).json({ error: 'Failed to load scheduled holidays.' });
  }
});

const holidayPayloadSchema = z.object({
  title: z.string().trim().min(2, 'Holiday name must be at least 2 characters.').max(120),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be YYYY-MM-DD.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be YYYY-MM-DD.'),
  reason: z.string().trim().max(300).optional().nullable(),
});

adminRouter.post('/holidays', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = holidayPayloadSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid holiday range.' });
    }

    const { title, startDate, endDate, reason } = parsed.data;
    if (startDate > endDate) {
      return res.status(400).json({ error: 'Start date cannot be after end date.' });
    }

    const result = await db.transaction(async (tx) => {
      const [createdHoliday] = await tx
        .insert(holidays)
        .values({
          title,
          startDate,
          endDate,
          reason: reason || null,
          createdBy: admin.id,
        })
        .returning();

      const cancelledSessions = await tx
        .update(attendanceSessions)
        .set({
          status: 'cancelled',
          cancelledReason: `HOLIDAY: ${title}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            gte(attendanceSessions.sessionDate, startDate),
            lte(attendanceSessions.sessionDate, endDate),
            inArray(attendanceSessions.status, ['scheduled', 'active'])
          )
        )
        .returning({
          id: attendanceSessions.id,
          sessionCode: attendanceSessions.sessionCode,
          sessionDate: attendanceSessions.sessionDate,
        });

      return { createdHoliday, cancelledSessions };
    });

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'CREATE_HOLIDAY',
      entityType: 'holiday',
      entityId: result.createdHoliday.id,
      details: {
        title,
        startDate,
        endDate,
        reason: reason || null,
        cancelledSessionsCount: result.cancelledSessions.length,
      },
      ipAddress: req.clientIp,
    });

    res.status(201).json({
      holiday: {
        ...result.createdHoliday,
        createdAtIST: formatISTTimestamp(new Date(result.createdHoliday.createdAt)),
      },
      cancelledCount: result.cancelledSessions.length,
      cancelledSessions: result.cancelledSessions,
      message:
        result.cancelledSessions.length > 0
          ? `Holiday "${title}" saved (${startDate} to ${endDate}). Automatically cancelled ${result.cancelledSessions.length} scheduled/active session(s).`
          : `Holiday "${title}" saved (${startDate} to ${endDate}). Attendance sessions are automatically disabled for these dates.`,
    });
  } catch (err) {
    console.error('Create holiday error:', err);
    res.status(500).json({ error: 'Failed to mark holiday range.' });
  }
});

adminRouter.patch('/holidays/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid holiday ID.' });

    const parsed = holidayPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid holiday update.' });
    }

    const { title, startDate, endDate, reason } = parsed.data;
    if (startDate > endDate) {
      return res.status(400).json({ error: 'Start date cannot be after end date.' });
    }

    const result = await db.transaction(async (tx) => {
      const [updatedHoliday] = await tx
        .update(holidays)
        .set({
          title,
          startDate,
          endDate,
          reason: reason || null,
          updatedAt: new Date(),
        })
        .where(eq(holidays.id, req.params.id))
        .returning();

      if (!updatedHoliday) return null;

      const cancelledSessions = await tx
        .update(attendanceSessions)
        .set({
          status: 'cancelled',
          cancelledReason: `HOLIDAY: ${title}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            gte(attendanceSessions.sessionDate, startDate),
            lte(attendanceSessions.sessionDate, endDate),
            inArray(attendanceSessions.status, ['scheduled', 'active'])
          )
        )
        .returning({ id: attendanceSessions.id });

      return { updatedHoliday, cancelledCount: cancelledSessions.length };
    });

    if (!result) return res.status(404).json({ error: 'Holiday record not found.' });

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPDATE_HOLIDAY',
      entityType: 'holiday',
      entityId: result.updatedHoliday.id,
      details: {
        title,
        startDate,
        endDate,
        reason: reason || null,
        cancelledCount: result.cancelledCount,
      },
      ipAddress: req.clientIp,
    });

    res.json({
      holiday: {
        ...result.updatedHoliday,
        createdAtIST: formatISTTimestamp(new Date(result.updatedHoliday.createdAt)),
      },
      message: `Holiday "${title}" updated (${startDate} to ${endDate}).`,
    });
  } catch (err) {
    console.error('Update holiday error:', err);
    res.status(500).json({ error: 'Failed to update holiday.' });
  }
});

adminRouter.delete('/holidays/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid holiday ID.' });

    const [deleted] = await db
      .delete(holidays)
      .where(eq(holidays.id, req.params.id))
      .returning();

    if (!deleted) return res.status(404).json({ error: 'Holiday record not found.' });

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'DELETE_HOLIDAY',
      entityType: 'holiday',
      entityId: deleted.id,
      details: { title: deleted.title, startDate: deleted.startDate, endDate: deleted.endDate },
      ipAddress: req.clientIp,
    });

    res.json({ message: `Removed holiday "${deleted.title}" (${deleted.startDate} to ${deleted.endDate}).` });
  } catch (err) {
    console.error('Delete holiday error:', err);
    res.status(500).json({ error: 'Failed to remove holiday.' });
  }
});

// 8c. Special Working Day / Closure Calendar Overrides
adminRouter.get('/calendar-overrides', async (_req, res) => {
  try {
    const items = await db
      .select()
      .from(calendarOverrides)
      .orderBy(asc(calendarOverrides.overrideDate));
    res.json({
      items: items.map((o) => ({
        ...o,
        createdAtIST: formatISTTimestamp(new Date(o.createdAt)),
      })),
    });
  } catch (err) {
    console.error('List calendar overrides error:', err);
    res.status(500).json({ error: 'Failed to load calendar overrides.' });
  }
});

adminRouter.post('/calendar-overrides', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        overrideDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.'),
        overrideType: z.enum(['working_day', 'closed_day']),
        title: z.string().trim().min(2, 'Title must be at least 2 characters.').max(120),
        reason: z.string().trim().max(300).optional().nullable(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid calendar override.' });
    }

    const { overrideDate, overrideType, title, reason } = parsed.data;

    const [saved] = await db
      .insert(calendarOverrides)
      .values({
        overrideDate,
        overrideType,
        title,
        reason: reason || null,
        createdBy: admin.id,
      })
      .onConflictDoUpdate({
        target: calendarOverrides.overrideDate,
        set: {
          overrideType,
          title,
          reason: reason || null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (overrideType === 'closed_day') {
      await db
        .update(attendanceSessions)
        .set({
          status: 'cancelled',
          cancelledReason: `CLOSED_DAY: ${title}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(attendanceSessions.sessionDate, overrideDate),
            inArray(attendanceSessions.status, ['scheduled', 'active'])
          )
        );
    }

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'UPSERT_CALENDAR_OVERRIDE',
      entityType: 'calendar_override',
      entityId: saved.id,
      details: { overrideDate, overrideType, title, reason: reason || null },
      ipAddress: req.clientIp,
    });

    res.status(201).json({
      override: {
        ...saved,
        createdAtIST: formatISTTimestamp(new Date(saved.createdAt)),
      },
      message:
        overrideType === 'working_day'
          ? `Special working day "${title}" set for ${overrideDate}. Daily attendance sessions enabled.`
          : `Closure "${title}" set for ${overrideDate}. Attendance sessions disabled.`,
    });
  } catch (err) {
    console.error('Upsert calendar override error:', err);
    res.status(500).json({ error: 'Failed to save calendar override.' });
  }
});

adminRouter.delete('/calendar-overrides/:id', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid override ID.' });

    const [deleted] = await db
      .delete(calendarOverrides)
      .where(eq(calendarOverrides.id, req.params.id))
      .returning();

    if (!deleted) return res.status(404).json({ error: 'Calendar override not found.' });

    await syncAutomaticDailySessions();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'DELETE_CALENDAR_OVERRIDE',
      entityType: 'calendar_override',
      entityId: deleted.id,
      details: { overrideDate: deleted.overrideDate, overrideType: deleted.overrideType, title: deleted.title },
      ipAddress: req.clientIp,
    });

    res.json({ message: `Removed calendar override for ${deleted.overrideDate}.` });
  } catch (err) {
    console.error('Delete calendar override error:', err);
    res.status(500).json({ error: 'Failed to delete calendar override.' });
  }
});

// 9. Attendance Records & Mandatory-Reason Corrections
adminRouter.get('/attendance', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const departmentId = (req.query.departmentId as string) || '';
    const date = (req.query.date as string) || '';
    const search = ((req.query.search as string) || '').trim();

    const conditions = [];
    if (isValidUuid(departmentId)) conditions.push(eq(attendanceRecords.departmentId, departmentId));
    if (date) conditions.push(eq(attendanceRecords.attendanceDate, date));
    if (search) {
      conditions.push(
        or(
          ilike(profiles.fullName, `%${search}%`),
          ilike(profiles.rollNumber, `%${search}%`)
        )!
      );
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(attendanceRecords)
      .innerJoin(profiles, eq(attendanceRecords.studentId, profiles.id))
      .where(conditions.length ? and(...conditions) : undefined);

    const items = await db
      .select({
        id: attendanceRecords.id,
        studentId: attendanceRecords.studentId,
        studentName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        sessionId: attendanceRecords.sessionId,
        sessionCode: attendanceSessions.sessionCode,
        periodSlot: attendanceSessions.periodSlot,
        departmentCode: departments.code,
        className: classes.displayName,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        attendanceDate: attendanceRecords.attendanceDate,
        markedAt: attendanceRecords.markedAt,
        status: attendanceRecords.status,
        verificationMethod: attendanceRecords.verificationMethod,
        verificationResult: attendanceRecords.verificationResult,
        faceConfidence: attendanceRecords.faceConfidence,
        livenessPassed: attendanceRecords.livenessPassed,
        correctionReason: attendanceRecords.correctionReason,
      })
      .from(attendanceRecords)
      .innerJoin(profiles, eq(attendanceRecords.studentId, profiles.id))
      .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
      .innerJoin(departments, eq(attendanceRecords.departmentId, departments.id))
      .innerJoin(classes, eq(attendanceRecords.classId, classes.id))
      .leftJoin(subjects, eq(attendanceRecords.subjectId, subjects.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(attendanceRecords.markedAt))
      .limit(limit)
      .offset(offset);

    res.json({
      items: items.map((i) => ({
        ...i,
        subjectCode: i.subjectCode ?? 'DAILY',
        subjectName:
          i.subjectName ??
          (i.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
        markedAtIST: formatISTTimestamp(new Date(i.markedAt)),
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('Admin attendance list error:', err);
    res.status(500).json({ error: 'Failed to load attendance records.' });
  }
});

adminRouter.post('/attendance/correct', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = z
      .object({
        studentId: z.string().uuid('Please select a valid student.'),
        sessionId: z.string().uuid('Please select a valid attendance session.'),
        status: z.enum(['present', 'absent', 'excused']),
        reason: z.string().min(8, 'A mandatory correction reason (min 8 characters) is required.').max(500),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid correction payload.' });
    }

    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, parsed.data.sessionId))
      .limit(1);
    if (!session) return res.status(404).json({ error: 'Attendance session not found.' });

    const [record] = await db
      .insert(attendanceRecords)
      .values({
        studentId: parsed.data.studentId,
        sessionId: parsed.data.sessionId,
        departmentId: session.departmentId,
        classId: session.classId,
        subjectId: session.subjectId,
        academicYearId: session.academicYearId,
        semesterId: session.semesterId,
        attendanceDate: session.sessionDate,
        status: parsed.data.status,
        verificationMethod: 'admin_correction',
        verificationResult: 'corrected',
        livenessPassed: false,
        correctionReason: parsed.data.reason.trim(),
        correctedBy: admin.id,
      })
      .onConflictDoUpdate({
        target: [attendanceRecords.studentId, attendanceRecords.sessionId],
        set: {
          status: parsed.data.status,
          verificationMethod: 'admin_correction',
          verificationResult: 'corrected',
          correctionReason: parsed.data.reason.trim(),
          correctedBy: admin.id,
          markedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'ATTENDANCE_CORRECTED',
      entityType: 'attendance_record',
      entityId: record.id,
      details: {
        studentId: parsed.data.studentId,
        sessionId: parsed.data.sessionId,
        status: parsed.data.status,
        reason: parsed.data.reason.trim(),
      },
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Attendance record corrected with audit trail.', record });
  } catch (err) {
    console.error('Correct attendance error:', err);
    res.status(500).json({ error: 'Failed to correct attendance.' });
  }
});

// 10. Correction & Override Requests
adminRouter.get('/correction-requests', async (_req, res) => {
  try {
    const list = await db
      .select({
        id: attendanceCorrectionRequests.id,
        studentId: attendanceCorrectionRequests.studentId,
        studentName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        sessionId: attendanceCorrectionRequests.sessionId,
        sessionCode: attendanceSessions.sessionCode,
        periodSlot: attendanceSessions.periodSlot,
        sessionDate: attendanceSessions.sessionDate,
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
      .orderBy(desc(attendanceCorrectionRequests.createdAt))
      .limit(100);

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
    console.error('List correction requests error:', err);
    res.status(500).json({ error: 'Failed to load correction requests.' });
  }
});

adminRouter.post('/correction-requests/:id/review', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'Invalid correction request ID.' });
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reviewNote: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

    const [reqRow] = await db
      .select()
      .from(attendanceCorrectionRequests)
      .where(eq(attendanceCorrectionRequests.id, req.params.id))
      .limit(1);
    if (!reqRow) return res.status(404).json({ error: 'Correction request not found.' });

    await db.transaction(async (tx) => {
      await tx
        .update(attendanceCorrectionRequests)
        .set({
          status: parsed.data.decision,
          reviewedBy: admin.id,
          reviewNote: parsed.data.reviewNote?.trim() || null,
          reviewedAt: new Date(),
        })
        .where(eq(attendanceCorrectionRequests.id, reqRow.id));

      if (parsed.data.decision === 'approved') {
        const [session] = await tx
          .select()
          .from(attendanceSessions)
          .where(eq(attendanceSessions.id, reqRow.sessionId))
          .limit(1);
        if (session) {
          await tx
            .insert(attendanceRecords)
            .values({
              studentId: reqRow.studentId,
              sessionId: reqRow.sessionId,
              departmentId: session.departmentId,
              classId: session.classId,
              subjectId: session.subjectId,
              academicYearId: session.academicYearId,
              semesterId: session.semesterId,
              attendanceDate: session.sessionDate,
              status: reqRow.requestedStatus,
              verificationMethod:
                reqRow.requestType === 'correction' ? 'admin_correction' : 'staff_assisted',
              verificationResult: 'corrected',
              correctionReason: reqRow.reason,
              correctedBy: admin.id,
            })
            .onConflictDoUpdate({
              target: [attendanceRecords.studentId, attendanceRecords.sessionId],
              set: {
                status: reqRow.requestedStatus,
                verificationMethod:
                  reqRow.requestType === 'correction' ? 'admin_correction' : 'staff_assisted',
                verificationResult: 'corrected',
                correctionReason: reqRow.reason,
                correctedBy: admin.id,
              },
            });
        }
      }
    });

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'REVIEW_CORRECTION_REQUEST',
      entityType: 'attendance_correction_request',
      entityId: reqRow.id,
      details: { decision: parsed.data.decision },
      ipAddress: req.clientIp,
    });

    res.json({ message: `Correction request ${parsed.data.decision}.` });
  } catch (err) {
    console.error('Review correction error:', err);
    res.status(500).json({ error: 'Failed to review correction request.' });
  }
});

// 11. Audit Logs & Biometric Reset
adminRouter.get('/audit-logs', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(15, Number(req.query.limit) || 30));
    const offset = (page - 1) * limit;
    const actionFilter = ((req.query.action as string) || '').trim();

    const conditions = actionFilter ? [ilike(auditLogs.action, `%${actionFilter}%`)] : [];

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined);

    const items = await db
      .select()
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      items: items.map((a) => ({ ...a, createdAtIST: formatISTTimestamp(new Date(a.createdAt)) })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('Audit logs error:', err);
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

adminRouter.delete('/biometrics/:studentId', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.studentId)) return res.status(400).json({ error: 'Invalid student ID.' });
    await db.delete(biometricTemplates).where(eq(biometricTemplates.studentId, req.params.studentId));
    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'ADMIN_RESET_BIOMETRICS',
      entityType: 'biometric_template',
      entityId: req.params.studentId,
      ipAddress: req.clientIp,
    });
    res.json({ message: 'Student biometric template cleared for re-enrollment.' });
  } catch (err) {
    console.error('Admin delete biometrics error:', err);
    res.status(500).json({ error: 'Failed to clear biometric template.' });
  }
});

// 12. JNTUH Academic Year & Semester Progression
adminRouter.get('/progression/preview', async (req, res) => {
  try {
    const fromSemesterId = ((req.query.fromSemesterId as string) || '').trim();
    const departmentId = ((req.query.departmentId as string) || '').trim();
    const regulationOverride = ((req.query.regulation as string) || '').trim() || null;

    if (!isValidUuid(fromSemesterId)) {
      return res.status(400).json({ error: 'Valid source semester ID is required.' });
    }
    if (departmentId && !isValidUuid(departmentId)) {
      return res.status(400).json({ error: 'Invalid department ID.' });
    }

    const preview = await previewAcademicProgression({
      fromSemesterId,
      departmentId: departmentId || null,
      regulationOverride,
    });
    res.json(preview);
  } catch (err) {
    console.error('Progression preview error:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to preview academic progression.',
    });
  }
});

const updateEligibilitySchema = z.object({
  updates: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        regulation: z.enum(['R22', 'R20', 'R18']).optional(),
        academicStanding: z.enum(['active', 'detained', 'graduated']).optional(),
        latestResultStatus: z
          .enum(['passed', 'promoted_with_backlogs', 'failed', 'detained', 'pending'])
          .optional(),
        creditsEarned: z.number().int().min(0).max(300).optional(),
        totalCreditsAttempted: z.number().int().min(0).max(300).optional(),
        activeBacklogs: z.number().int().min(0).max(60).optional(),
        detentionReason: z.string().max(300).nullable().optional(),
      })
    )
    .min(1)
    .max(500),
});

adminRouter.post('/progression/student-eligibility', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = updateEligibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid eligibility update payload.' });
    }

    let updatedCount = 0;
    await db.transaction(async (tx) => {
      for (const item of parsed.data.updates) {
        const patch: Partial<typeof studentEnrollments.$inferInsert> = {};
        if (item.regulation !== undefined) patch.regulation = item.regulation;
        if (item.academicStanding !== undefined) patch.academicStanding = item.academicStanding;
        if (item.latestResultStatus !== undefined) patch.latestResultStatus = item.latestResultStatus;
        if (item.creditsEarned !== undefined) patch.creditsEarned = item.creditsEarned;
        if (item.totalCreditsAttempted !== undefined) {
          patch.totalCreditsAttempted = item.totalCreditsAttempted;
        }
        if (item.activeBacklogs !== undefined) patch.activeBacklogs = item.activeBacklogs;
        if (item.detentionReason !== undefined) patch.detentionReason = item.detentionReason;

        if (Object.keys(patch).length > 0) {
          const updated = await tx
            .update(studentEnrollments)
            .set(patch)
            .where(eq(studentEnrollments.studentId, item.studentId))
            .returning({ id: studentEnrollments.id });
          updatedCount += updated.length;
        }
      }
    });

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'JNTUH_STUDENT_ELIGIBILITY_UPDATED',
      entityType: 'student_enrollment',
      details: {
        updatedCount,
        studentIds: parsed.data.updates.slice(0, 25).map((u) => u.studentId),
      },
      ipAddress: req.clientIp,
    });

    res.json({ message: `Updated JNTUH eligibility records for ${updatedCount} student(s).`, updatedCount });
  } catch (err) {
    console.error('Update student eligibility error:', err);
    res.status(500).json({ error: 'Failed to update student eligibility records.' });
  }
});

const updateRuleSchema = z.object({
  code: z.enum(['R22', 'R20', 'R18']),
  minAttendancePercent: z.number().min(0).max(100),
  sem2To3MinCredits: z.number().int().min(0).max(100),
  sem4To5MinCredits: z.number().int().min(0).max(150),
  sem6To7MinCredits: z.number().int().min(0).max(200),
  maxBacklogsForPromotion: z.number().int().min(0).max(50).nullable(),
  requireResultPublished: z.boolean(),
});

adminRouter.post('/progression/rules', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = updateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid regulation rules.' });
    }

    const d = parsed.data;
    const [updated] = await db
      .update(jntuhRegulationRules)
      .set({
        minAttendancePercent: d.minAttendancePercent,
        sem2To3MinCredits: d.sem2To3MinCredits,
        sem4To5MinCredits: d.sem4To5MinCredits,
        sem6To7MinCredits: d.sem6To7MinCredits,
        maxBacklogsForPromotion: d.maxBacklogsForPromotion,
        requireResultPublished: d.requireResultPublished,
        updatedAt: new Date(),
      })
      .where(eq(jntuhRegulationRules.code, d.code))
      .returning();

    await writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      action: 'JNTUH_REGULATION_RULE_UPDATED',
      entityType: 'jntuh_regulation_rule',
      entityId: updated?.id ?? null,
      details: d,
      ipAddress: req.clientIp,
    });

    res.json({ message: `JNTUH ${d.code} regulation rules updated.`, rule: updated });
  } catch (err) {
    console.error('Update JNTUH rule error:', err);
    res.status(500).json({ error: 'Failed to update JNTUH regulation rule.' });
  }
});

const executePromoteSchema = z.object({
  fromSemesterId: z.string().uuid(),
  departmentId: z.string().uuid().nullable().optional(),
  regulation: z.enum(['R22', 'R20', 'R18']).nullable().optional(),
  selectedStudentIds: z.array(z.string().uuid()).max(10000).nullable().optional(),
  updateStaffAssignments: z.boolean().optional(),
  confirmationNote: z.string().max(300).nullable().optional(),
  confirmPromotion: z.literal(true, {
    message: 'Explicit promotion confirmation is required.',
  }),
});

adminRouter.post('/progression/promote', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    const parsed = executePromoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid promotion request.' });
    }

    const result = await executeBulkPromotion({
      fromSemesterId: parsed.data.fromSemesterId,
      departmentId: parsed.data.departmentId ?? null,
      regulationOverride: parsed.data.regulation ?? null,
      selectedStudentIds: parsed.data.selectedStudentIds ?? null,
      updateStaffAssignments: parsed.data.updateStaffAssignments ?? true,
      confirmationNote: parsed.data.confirmationNote ?? null,
      actorId: admin.id,
      actorEmail: admin.email,
      actorIp: req.clientIp ?? null,
    });

    res.status(201).json({
      message: `Promoted ${result.batch.promotedCount} eligible student(s). Detained: ${result.batch.detainedCount}, Failed: ${result.batch.failedCount}, Pending: ${result.batch.pendingCount}.`,
      batch: {
        ...result.batch,
        createdAtIST: formatISTTimestamp(new Date(result.batch.createdAt)),
      },
      promotedStudents: result.promotedStudents,
    });
  } catch (err) {
    console.error('Execute bulk promotion error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to execute academic promotion.';
    const status = msg.includes('already been promoted') ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

adminRouter.get('/progression/batches', async (_req, res) => {
  try {
    const batches = await listPromotionHistory(40);
    const promoAudits = await db
      .select()
      .from(auditLogs)
      .where(
        inArray(auditLogs.action, [
          'ACADEMIC_PROMOTION_EXECUTED',
          'ACADEMIC_PROMOTION_ROLLED_BACK',
          'JNTUH_STUDENT_ELIGIBILITY_UPDATED',
          'JNTUH_REGULATION_RULE_UPDATED',
        ])
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(50);

    res.json({
      batches: batches.map((b) => ({
        ...b,
        createdAtIST: formatISTTimestamp(new Date(b.createdAt)),
        rolledBackAtIST: b.rolledBackAt ? formatISTTimestamp(new Date(b.rolledBackAt)) : null,
      })),
      auditLogs: promoAudits.map((a) => ({
        ...a,
        createdAtIST: formatISTTimestamp(new Date(a.createdAt)),
      })),
    });
  } catch (err) {
    console.error('List promotion batches error:', err);
    res.status(500).json({ error: 'Failed to load promotion history.' });
  }
});

adminRouter.get('/progression/batches/:batchId', async (req, res) => {
  try {
    if (!isValidUuid(req.params.batchId)) {
      return res.status(400).json({ error: 'Invalid promotion batch ID.' });
    }
    const [batch] = await db
      .select()
      .from(promotionBatches)
      .where(eq(promotionBatches.id, req.params.batchId))
      .limit(1);
    if (!batch) {
      return res.status(404).json({ error: 'Promotion batch not found.' });
    }

    const items = await db
      .select({
        id: promotionBatchItems.id,
        studentId: promotionBatchItems.studentId,
        fullName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        departmentCode: departments.code,
        outcome: promotionBatchItems.outcome,
        reason: promotionBatchItems.reason,
        attendancePercentage: promotionBatchItems.attendancePercentage,
        previousCreditsEarned: promotionBatchItems.previousCreditsEarned,
        previousActiveBacklogs: promotionBatchItems.previousActiveBacklogs,
        previousResultStatus: promotionBatchItems.previousResultStatus,
      })
      .from(promotionBatchItems)
      .innerJoin(profiles, eq(promotionBatchItems.studentId, profiles.id))
      .innerJoin(departments, eq(promotionBatchItems.departmentId, departments.id))
      .where(eq(promotionBatchItems.batchId, batch.id))
      .orderBy(asc(departments.code), asc(profiles.rollNumber))
      .limit(500);

    res.json({ batch, items });
  } catch (err) {
    console.error('Batch detail error:', err);
    res.status(500).json({ error: 'Failed to load batch details.' });
  }
});

const rollbackSchema = z.object({
  reason: z.string().min(3, 'Rollback reason must be at least 3 characters.').max(300),
});

adminRouter.post('/progression/batches/:batchId/rollback', async (req: AuthRequest, res) => {
  try {
    const admin = req.authProfile!;
    if (!isValidUuid(req.params.batchId)) {
      return res.status(400).json({ error: 'Invalid promotion batch ID.' });
    }
    const parsed = rollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Rollback reason required.' });
    }

    const result = await rollbackPromotionBatch({
      batchId: req.params.batchId,
      reason: parsed.data.reason,
      actorId: admin.id,
      actorEmail: admin.email,
      actorIp: req.clientIp ?? null,
    });

    res.json({
      message: `Safely rolled back promotion batch ${result.batch.batchCode}; restored ${result.restoredCount} student(s) with attendance history untouched.`,
      restoredCount: result.restoredCount,
    });
  } catch (err) {
    console.error('Rollback promotion batch error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to roll back promotion batch.';
    const status = msg.includes('already been rolled back') || msg.includes('Cannot roll back') ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});
