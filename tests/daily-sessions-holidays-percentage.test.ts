import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import * as dotenv from 'dotenv';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
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
  profiles,
  roles,
  semesters,
  staffAssignments,
  studentAcademicHistory,
  studentEnrollments,
  subjects,
} from '../src/db/schema.ts';
import { ensureBaselineSeeded, INITIAL_SUPER_ADMIN_EMAIL } from '../src/server/seed.ts';
import {
  averageAndNormalizeDescriptors,
  encryptBiometricDescriptor,
  getISTDateString,
  signSessionToken,
} from '../src/server/crypto.ts';
import {
  computeSlotStatusForTime,
  evaluateDayScheduleStatus,
  getISTWeekday,
  getStudentSlotMessage,
  syncAutomaticDailySessions,
  validateSessionAttendanceWindow,
} from '../src/server/attendanceScheduler.ts';
import {
  computeBulkSemesterAttendance,
  computeStudentFullAttendanceProfile,
  NO_ATTENDANCE_DATA_MESSAGE,
  roundPercentage2,
} from '../src/server/attendanceCalculator.ts';
import { authAndPublicRouter } from '../src/server/routes/authAndPublic.ts';
import { adminRouter } from '../src/server/routes/adminRoutes.ts';
import { staffRouter } from '../src/server/routes/staffRoutes.ts';
import { studentRouter } from '../src/server/routes/studentRoutes.ts';
import { reportRouter } from '../src/server/routes/reportRoutes.ts';

function istInstant(dateIST: string, timeHHMM: string): Date {
  return new Date(`${dateIST}T${timeHHMM}:00+05:30`);
}

function makeDescriptor(seed = 1): number[] {
  const vec = Array.from({ length: 128 }, (_, i) => Math.sin((i + 1) * seed * 0.13) + 0.5);
  return averageAndNormalizeDescriptors([vec]);
}

const TEST_TAG = `DAILY_${Date.now()}`;
const createdProfileIds: string[] = [];
const createdSessionIds: string[] = [];
const createdHolidayIds: string[] = [];
const createdOverrideIds: string[] = [];
const createdClassIds: string[] = [];
let originalSettingsSnapshot: typeof collegeSettings.$inferSelect | null = null;
let server: http.Server | null = null;
let baseUrl = '';

async function startTestServer() {
  if (server) return baseUrl;
  const app = express();
  app.use(express.json());
  app.use('/api', authAndPublicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/reports', reportRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server!.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return baseUrl;
}

after(async () => {
  try {
    if (originalSettingsSnapshot) {
      await db
        .update(collegeSettings)
        .set({
          autoDailySessionsEnabled: originalSettingsSnapshot.autoDailySessionsEnabled,
          morningStartTime: originalSettingsSnapshot.morningStartTime,
          morningEndTime: originalSettingsSnapshot.morningEndTime,
          afternoonStartTime: originalSettingsSnapshot.afternoonStartTime,
          afternoonEndTime: originalSettingsSnapshot.afternoonEndTime,
          workingWeekdays: originalSettingsSnapshot.workingWeekdays,
          locationVerificationEnabled: originalSettingsSnapshot.locationVerificationEnabled,
        })
        .where(eq(collegeSettings.id, originalSettingsSnapshot.id));
    }

    if (createdProfileIds.length > 0) {
      await db
        .delete(attendanceCorrectionRequests)
        .where(inArray(attendanceCorrectionRequests.studentId, createdProfileIds));
      await db
        .delete(attendanceRecords)
        .where(inArray(attendanceRecords.studentId, createdProfileIds));
      await db
        .delete(biometricTemplates)
        .where(inArray(biometricTemplates.studentId, createdProfileIds));
      await db
        .delete(studentAcademicHistory)
        .where(inArray(studentAcademicHistory.studentId, createdProfileIds));
      await db
        .delete(studentEnrollments)
        .where(inArray(studentEnrollments.studentId, createdProfileIds));
      await db
        .delete(staffAssignments)
        .where(inArray(staffAssignments.staffId, createdProfileIds));
    }

    if (createdSessionIds.length > 0) {
      await db
        .delete(attendanceCorrectionRequests)
        .where(inArray(attendanceCorrectionRequests.sessionId, createdSessionIds));
      await db
        .delete(attendanceRecords)
        .where(inArray(attendanceRecords.sessionId, createdSessionIds));
      await db
        .delete(attendanceSessions)
        .where(inArray(attendanceSessions.id, createdSessionIds));
    }

    // Remove all synthetic 2099 test auto-sessions created during deterministic IST simulation
    const futureSessions = await db
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(gte(attendanceSessions.sessionDate, '2099-01-01'));
    if (futureSessions.length > 0) {
      const fIds = futureSessions.map((s) => s.id);
      await db
        .delete(attendanceRecords)
        .where(inArray(attendanceRecords.sessionId, fIds));
      await db
        .delete(attendanceSessions)
        .where(inArray(attendanceSessions.id, fIds));
    }

    if (createdHolidayIds.length > 0) {
      await db.delete(holidays).where(inArray(holidays.id, createdHolidayIds));
    }
    if (createdOverrideIds.length > 0) {
      await db
        .delete(calendarOverrides)
        .where(inArray(calendarOverrides.id, createdOverrideIds));
    }
    if (createdProfileIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.actorId, createdProfileIds));
      await db.delete(profiles).where(inArray(profiles.id, createdProfileIds));
    }
    if (createdClassIds.length > 0) {
      await db
        .delete(attendanceSessions)
        .where(inArray(attendanceSessions.classId, createdClassIds));
      await db.delete(classes).where(inArray(classes.id, createdClassIds));
    }
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  }
});

test('1. Automatic IST Daily Schedule Lifecycle Across All 7 Departments, Server-Restart Recovery & Concurrency', async () => {
  await ensureBaselineSeeded();
  const [settingsRow] = await db.select().from(collegeSettings).limit(1);
  assert.ok(settingsRow);
  originalSettingsSnapshot = { ...settingsRow };

  assert.equal(settingsRow.morningStartTime, '09:00');
  assert.equal(settingsRow.morningEndTime, '09:40');
  assert.equal(settingsRow.afternoonStartTime, '13:30');
  assert.equal(settingsRow.afternoonEndTime, '13:40');
  assert.equal(settingsRow.autoDailySessionsEnabled, true);

  const testDate = '2099-01-12'; // Monday
  const sundayDate = '2099-01-11'; // Sunday
  assert.equal(getISTWeekday(testDate), 1);
  assert.equal(getISTWeekday(sundayDate), 0);

  const activeDepts = await db.select().from(departments).where(eq(departments.isActive, true));
  const activeClasses = await db.select().from(classes).where(eq(classes.isActive, true));
  assert.equal(activeDepts.length, 7);
  const expectedClassCount = activeClasses.length;

  // 1a. Before 9:00 AM IST (08:59) -> morning scheduled, afternoon scheduled
  const beforeMorning = await syncAutomaticDailySessions(istInstant(testDate, '08:59'));
  assert.equal(beforeMorning.morningStatus, 'scheduled');
  assert.equal(beforeMorning.afternoonStatus, 'scheduled');

  const daySessions0859 = await db
    .select()
    .from(attendanceSessions)
    .where(and(eq(attendanceSessions.sessionDate, testDate), eq(attendanceSessions.isAutoScheduled, true)));
  assert.equal(daySessions0859.length, expectedClassCount * 2);
  assert.equal(new Set(daySessions0859.map((s) => s.departmentId)).size, 7);
  assert.ok(daySessions0859.every((s) => s.status === 'scheduled'));

  // No fake attendance records generated
  const fakeRecords = await db
    .select()
    .from(attendanceRecords)
    .where(eq(attendanceRecords.attendanceDate, testDate));
  assert.equal(fakeRecords.length, 0);

  // 1b. Idempotency under repeated/concurrent sync calls -> zero duplicate sessions
  const [r1, r2] = await Promise.all([
    syncAutomaticDailySessions(istInstant(testDate, '09:00')),
    syncAutomaticDailySessions(istInstant(testDate, '09:00')),
  ]);
  assert.equal(r1.morningStatus, 'active');
  assert.equal(r2.morningStatus, 'active');

  const daySessions0900 = await db
    .select()
    .from(attendanceSessions)
    .where(and(eq(attendanceSessions.sessionDate, testDate), eq(attendanceSessions.isAutoScheduled, true)));
  assert.equal(daySessions0900.length, expectedClassCount * 2);
  assert.equal(
    daySessions0900.filter((s) => s.periodSlot === 'morning' && s.status === 'active').length,
    expectedClassCount
  );
  assert.equal(
    daySessions0900.filter((s) => s.periodSlot === 'afternoon' && s.status === 'scheduled').length,
    expectedClassCount
  );

  // 1c. Exact end boundary 09:40 AM IST -> morning closed, afternoon scheduled
  const at0940 = await syncAutomaticDailySessions(istInstant(testDate, '09:40'));
  assert.equal(at0940.morningStatus, 'closed');
  assert.equal(at0940.afternoonStatus, 'scheduled');

  // 1d. Afternoon active 13:30–13:39 IST, closed at 13:40 IST
  const at1335 = await syncAutomaticDailySessions(istInstant(testDate, '13:35'));
  assert.equal(at1335.morningStatus, 'closed');
  assert.equal(at1335.afternoonStatus, 'active');

  const at1340 = await syncAutomaticDailySessions(istInstant(testDate, '13:40'));
  assert.equal(at1340.morningStatus, 'closed');
  assert.equal(at1340.afternoonStatus, 'closed');

  const daySessions1340 = await db
    .select()
    .from(attendanceSessions)
    .where(and(eq(attendanceSessions.sessionDate, testDate), eq(attendanceSessions.isAutoScheduled, true)));
  assert.ok(daySessions1340.every((s) => s.status === 'closed'));

  // 1e. Server restart recovery: if past date auto-session was left 'active', syncing a future date settles it to 'closed'
  const oneMorningSes = daySessions1340.find((s) => s.periodSlot === 'morning')!;
  await db
    .update(attendanceSessions)
    .set({ status: 'active' })
    .where(eq(attendanceSessions.id, oneMorningSes.id));

  await syncAutomaticDailySessions(istInstant('2099-01-13', '09:05'));
  const [settled] = await db
    .select()
    .from(attendanceSessions)
    .where(eq(attendanceSessions.id, oneMorningSes.id));
  assert.equal(settled.status, 'closed');

  // 1f. Non-working Sunday -> no auto sessions created
  const sunSync = await syncAutomaticDailySessions(istInstant(sundayDate, '09:10'));
  assert.equal(sunSync.dayEval.isWorkingDay, false);
  const sunSessions = await db
    .select()
    .from(attendanceSessions)
    .where(eq(attendanceSessions.sessionDate, sundayDate));
  assert.equal(sunSessions.length, 0);
});

test('2. Exact Student Messages & Validation Window Enforcement (Morning, Afternoon, Holiday, Duplicate, Wrong Class)', async () => {
  await ensureBaselineSeeded();
  const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
  const allDepts = await db.select().from(departments).orderBy(asc(departments.code));
  const csmC = allDepts.find((d) => d.code === 'CSM C')!;
  const cseA = allDepts.find((d) => d.code === 'CSE A')!;
  const [sem1] = await db.select().from(semesters).where(eq(semesters.semesterNumber, 1)).limit(1);
  const [yr1] = await db.select().from(academicYears).where(eq(academicYears.yearNumber, 1)).limit(1);

  const [csmClass] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, csmC.id), eq(classes.semesterId, sem1.id)))
    .limit(1);
  const [cseClass] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, cseA.id), eq(classes.semesterId, sem1.id)))
    .limit(1);
  assert.ok(csmClass && cseClass);

  const testDate = '2099-01-14'; // Wednesday
  await syncAutomaticDailySessions(istInstant(testDate, '08:50'));

  const [morningSes] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.classId, csmClass.id),
        eq(attendanceSessions.sessionDate, testDate),
        eq(attendanceSessions.periodSlot, 'morning')
      )
    )
    .limit(1);
  const [afternoonSes] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.classId, csmClass.id),
        eq(attendanceSessions.sessionDate, testDate),
        eq(attendanceSessions.periodSlot, 'afternoon')
      )
    )
    .limit(1);
  const [otherClassSes] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.classId, cseClass.id),
        eq(attendanceSessions.sessionDate, testDate),
        eq(attendanceSessions.periodSlot, 'morning')
      )
    )
    .limit(1);
  assert.ok(morningSes && afternoonSes && otherClassSes);

  // Exact Morning/Afternoon messages
  const dayEvalWorking = evaluateDayScheduleStatus(testDate, null, [], []);
  assert.equal(
    getStudentSlotMessage({
      slot: 'morning',
      status: computeSlotStatusForTime('08:59', '09:00', '09:40', dayEvalWorking),
      startTime: '09:00',
      dayEval: dayEvalWorking,
    }),
    'Morning attendance starts at 9:00 AM.'
  );
  assert.equal(
    getStudentSlotMessage({
      slot: 'morning',
      status: computeSlotStatusForTime('09:40', '09:00', '09:40', dayEvalWorking),
      startTime: '09:00',
      dayEval: dayEvalWorking,
    }),
    'Morning attendance session is closed.'
  );
  assert.equal(
    getStudentSlotMessage({
      slot: 'afternoon',
      status: computeSlotStatusForTime('13:29', '13:30', '13:40', dayEvalWorking),
      startTime: '13:30',
      dayEval: dayEvalWorking,
    }),
    'Afternoon attendance starts at 1:30 PM.'
  );
  assert.equal(
    getStudentSlotMessage({
      slot: 'afternoon',
      status: computeSlotStatusForTime('13:40', '13:30', '13:40', dayEvalWorking),
      startTime: '13:30',
      dayEval: dayEvalWorking,
    }),
    'Afternoon attendance session is closed.'
  );

  // Server-side window validation checks
  const resBeforeMorning = await validateSessionAttendanceWindow({
    sessionId: morningSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '08:59'),
  });
  assert.equal(resBeforeMorning.allowed, false);
  assert.equal(resBeforeMorning.error, 'Morning attendance starts at 9:00 AM.');

  const resDuringMorning = await validateSessionAttendanceWindow({
    sessionId: morningSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '09:15'),
  });
  assert.equal(resDuringMorning.allowed, true);

  const resAfterMorning = await validateSessionAttendanceWindow({
    sessionId: morningSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '09:40'),
  });
  assert.equal(resAfterMorning.allowed, false);
  assert.equal(resAfterMorning.error, 'Morning attendance session is closed.');

  const resBeforeAfternoon = await validateSessionAttendanceWindow({
    sessionId: afternoonSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '13:25'),
  });
  assert.equal(resBeforeAfternoon.allowed, false);
  assert.equal(resBeforeAfternoon.error, 'Afternoon attendance starts at 1:30 PM.');

  const resDuringAfternoon = await validateSessionAttendanceWindow({
    sessionId: afternoonSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '13:35'),
  });
  assert.equal(resDuringAfternoon.allowed, true);

  const resAfterAfternoon = await validateSessionAttendanceWindow({
    sessionId: afternoonSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '13:40'),
  });
  assert.equal(resAfterAfternoon.allowed, false);
  assert.equal(resAfterAfternoon.error, 'Afternoon attendance session is closed.');

  const resWrongClass = await validateSessionAttendanceWindow({
    sessionId: otherClassSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '09:15'),
  });
  assert.equal(resWrongClass.allowed, false);
  assert.equal(resWrongClass.error, 'No active attendance session is available for your class.');

  // Multi-day consecutive holiday cancels sessions and returns exact Holiday message
  const [holiday] = await db
    .insert(holidays)
    .values({
      title: 'Sankranti Break',
      startDate: '2099-01-14',
      endDate: '2099-01-16',
      reason: 'Festival break across campus',
    })
    .returning();
  createdHolidayIds.push(holiday.id);

  const resOnHoliday = await validateSessionAttendanceWindow({
    sessionId: morningSes.id,
    studentClassId: csmClass.id,
    studentDepartmentId: csmC.id,
    now: istInstant(testDate, '09:15'),
  });
  assert.equal(resOnHoliday.allowed, false);
  assert.equal(
    resOnHoliday.error,
    'Today is a holiday: Sankranti Break. Attendance sessions are unavailable.'
  );

  // Schedule automatically resumes on next working day (2099-01-17 Saturday)
  const resumeSync = await syncAutomaticDailySessions(istInstant('2099-01-17', '09:10'));
  assert.equal(resumeSync.dayEval.isWorkingDay, true);
  assert.equal(resumeSync.morningStatus, 'active');

  // Verify unused variable silence for studentRole/yr1 by keeping test clean
  assert.ok(studentRole && yr1);
});

test('3. Holiday CRUD, Working Weekdays, Special Working Day Override, RBAC & Live Marking / Duplicate Enforcement', async () => {
  await ensureBaselineSeeded();
  const url = await startTestServer();
  const [adminProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);
  assert.ok(adminProfile);

  const adminToken = signSessionToken({
    profileId: adminProfile.id,
    email: adminProfile.email,
    role: 'super_admin',
  });

  const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
  const [staffRole] = await db.select().from(roles).where(eq(roles.name, 'staff')).limit(1);
  const [csmC] = await db.select().from(departments).where(eq(departments.code, 'CSM C')).limit(1);
  const [sem1] = await db.select().from(semesters).where(eq(semesters.semesterNumber, 1)).limit(1);
  const [yr1] = await db.select().from(academicYears).where(eq(academicYears.yearNumber, 1)).limit(1);
  const [csmClass] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, csmC.id), eq(classes.semesterId, sem1.id)))
    .limit(1);
  const [settingsRow] = await db.select().from(collegeSettings).limit(1);

  // Ensure geofence won't reject using exact college coordinates
  const lat = settingsRow.collegeLatitude;
  const lng = settingsRow.collegeLongitude;

  // Create student + staff for RBAC & marking checks
  const descriptor = makeDescriptor(3.7);
  const encrypted = encryptBiometricDescriptor(descriptor);
  const [studentProf] = await db
    .insert(profiles)
    .values({
      roleId: studentRole.id,
      fullName: 'Daily Attendance Student',
      email: `stu_${TEST_TAG}@sbist.edu.in`.toLowerCase(),
      rollNumber: `D${TEST_TAG.slice(-7)}1`,
      status: 'approved',
      emailVerified: true,
    })
    .returning();
  createdProfileIds.push(studentProf.id);

  await db.insert(studentEnrollments).values({
    studentId: studentProf.id,
    rollNumber: studentProf.rollNumber!,
    departmentId: csmC.id,
    academicYearId: yr1.id,
    semesterId: sem1.id,
    classId: csmClass.id,
    isActive: true,
    joinedDateIST: getISTDateString(),
  });
  await db.insert(biometricTemplates).values({
    studentId: studentProf.id,
    encryptedDescriptor: encrypted.encryptedDescriptor,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    sampleCount: 3,
    consentGiven: true,
    consentTimestamp: new Date(),
    isActive: true,
  });

  const [staffProf] = await db
    .insert(profiles)
    .values({
      roleId: staffRole.id,
      fullName: 'Daily Test Staff',
      email: `stf_${TEST_TAG}@sbist.edu.in`.toLowerCase(),
      employeeId: `E${TEST_TAG.slice(-6)}`,
      status: 'approved',
      emailVerified: true,
    })
    .returning();
  createdProfileIds.push(staffProf.id);
  await db.insert(staffAssignments).values({
    staffId: staffProf.id,
    departmentId: csmC.id,
    classId: csmClass.id,
    canCreateSessions: true,
    isActive: true,
  });

  const stuToken = signSessionToken({
    profileId: studentProf.id,
    email: studentProf.email,
    role: 'student',
  });
  const stfToken = signSessionToken({
    profileId: staffProf.id,
    email: staffProf.email,
    role: 'staff',
  });

  // RBAC: Student & Staff cannot create holidays or modify settings
  const stuHolidayAttempt = await fetch(`${url}/api/admin/holidays`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Unauthorized',
      startDate: '2099-02-01',
      endDate: '2099-02-01',
    }),
  });
  assert.equal(stuHolidayAttempt.status, 403);

  const stfSettingsAttempt = await fetch(`${url}/api/admin/settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${stfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workingWeekdays: [1, 2] }),
  });
  assert.equal(stfSettingsAttempt.status, 403);

  // Create active session for todayIST (daily subjectless roll-call or period session)
  const todayIST = getISTDateString();
  const [liveSes] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: `LIVE-${TEST_TAG}`,
      departmentId: csmC.id,
      classId: csmClass.id,
      academicYearId: yr1.id,
      semesterId: sem1.id,
      subjectId: null,
      sessionDate: todayIST,
      startTime: '00:00',
      endTime: '23:59',
      periodSlot: 'daily',
      status: 'active',
      createdBy: adminProfile.id,
    })
    .returning();
  createdSessionIds.push(liveSes.id);

  // Failed liveness must be rejected and NOT create attendance record
  const failLivenessRes = await fetch(`${url}/api/student/attendance/mark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: liveSes.id,
      descriptor,
      livenessPassed: false,
      livenessSignals: { blinkDetected: false, headTurnDetected: false, frameVariance: 0 },
      latitude: lat,
      longitude: lng,
    }),
  });
  assert.equal(failLivenessRes.status, 403);

  // Face mismatch must be rejected
  const wrongDescriptor = makeDescriptor(9.4);
  const faceMismatchRes = await fetch(`${url}/api/student/attendance/mark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: liveSes.id,
      descriptor: wrongDescriptor,
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.02 },
      latitude: lat,
      longitude: lng,
    }),
  });
  assert.equal(faceMismatchRes.status, 403);

  // Valid attendance mark succeeds (201)
  const validMarkRes = await fetch(`${url}/api/student/attendance/mark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: liveSes.id,
      descriptor,
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.02 },
      latitude: lat,
      longitude: lng,
    }),
  });
  assert.equal(validMarkRes.status, 201);

  // Duplicate mark rejected with exact message
  const dupMarkRes = await fetch(`${url}/api/student/attendance/mark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: liveSes.id,
      descriptor,
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.02 },
      latitude: lat,
      longitude: lng,
    }),
  });
  assert.equal(dupMarkRes.status, 409);
  const dupJson = (await dupMarkRes.json()) as { error: string };
  assert.equal(dupJson.error, 'Attendance has already been marked for this session.');

  // Admin creates holiday covering todayIST -> cancels open sessions & blocks student marking + QR check-in
  const createHolRes = await fetch(`${url}/api/admin/holidays`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'College Annual Day',
      startDate: todayIST,
      endDate: todayIST,
      reason: 'Declared holiday for Annual Day celebrations',
    }),
  });
  assert.equal(createHolRes.status, 201);
  const createdHol = (await createHolRes.json()) as { holiday: { id: string } };
  createdHolidayIds.push(createdHol.holiday.id);

  // Student dashboard shows holiday name & reason and holiday message
  const stuDashHolRes = await fetch(`${url}/api/student/dashboard`, {
    headers: { Authorization: `Bearer ${stuToken}` },
  });
  assert.equal(stuDashHolRes.status, 200);
  const stuDashHol = (await stuDashHolRes.json()) as {
    todayDayEval: { isHoliday: boolean; holidayTitle: string; holidayReason: string };
    todaySchedule: { morning: { message: string }; afternoon: { message: string } };
  };
  assert.equal(stuDashHol.todayDayEval.isHoliday, true);
  assert.equal(stuDashHol.todayDayEval.holidayTitle, 'College Annual Day');
  assert.equal(stuDashHol.todayDayEval.holidayReason, 'Declared holiday for Annual Day celebrations');
  assert.equal(
    stuDashHol.todaySchedule.morning.message,
    'Today is a holiday: College Annual Day. Attendance sessions are unavailable.'
  );

  // Student mark attempt on holiday returns 403 with exact holiday message
  const markOnHolidayRes = await fetch(`${url}/api/student/attendance/mark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stuToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: liveSes.id,
      descriptor,
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.02 },
      latitude: lat,
      longitude: lng,
    }),
  });
  assert.equal(markOnHolidayRes.status, 403);
  const markOnHolJson = (await markOnHolidayRes.json()) as { error: string };
  assert.equal(
    markOnHolJson.error,
    'Today is a holiday: College Annual Day. Attendance sessions are unavailable.'
  );

  // Edit holiday via PATCH
  const editHolRes = await fetch(`${url}/api/admin/holidays/${createdHol.holiday.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Updated Annual Day',
      startDate: todayIST,
      endDate: todayIST,
      reason: 'Updated holiday reason',
    }),
  });
  assert.equal(editHolRes.status, 200);

  // Delete holiday -> resumes normal schedule immediately
  const delHolRes = await fetch(`${url}/api/admin/holidays/${createdHol.holiday.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(delHolRes.status, 200);
  createdHolidayIds.pop();

  // Special Working Day Override on a Sunday (2099-01-18 Sunday)
  const specialSunday = '2099-01-18';
  assert.equal(getISTWeekday(specialSunday), 0);
  const ovRes = await fetch(`${url}/api/admin/calendar-overrides`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      overrideDate: specialSunday,
      overrideType: 'working_day',
      title: 'Sunday Compensatory Class',
      reason: 'Compensating previous holiday',
    }),
  });
  assert.equal(ovRes.status, 201);
  const ovJson = (await ovRes.json()) as { override: { id: string } };
  createdOverrideIds.push(ovJson.override.id);

  const sunSyncWithOverride = await syncAutomaticDailySessions(istInstant(specialSunday, '09:10'));
  assert.equal(sunSyncWithOverride.dayEval.isWorkingDay, true);
  assert.equal(sunSyncWithOverride.dayEval.dayStatus, 'special_working_day');
  assert.equal(sunSyncWithOverride.morningStatus, 'active');
});

test('4. Accurate Percentage Edge Cases (36/40, 30/40, 0/40, 40/40, 0/0, 2/3, Mid-Sem Join, Holiday Exclusion, Subject Isolation, Corrections)', async () => {
  await ensureBaselineSeeded();
  const url = await startTestServer();
  const [adminProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);
  const adminToken = signSessionToken({
    profileId: adminProfile.id,
    email: adminProfile.email,
    role: 'super_admin',
  });

  // Verify rounding utility directly
  assert.equal(roundPercentage2(36, 40), 90);
  assert.equal(roundPercentage2(30, 40), 75);
  assert.equal(roundPercentage2(0, 40), 0);
  assert.equal(roundPercentage2(40, 40), 100);
  assert.equal(roundPercentage2(0, 0), 0);
  assert.equal(roundPercentage2(2, 3), 66.67);

  const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
  const [cseB] = await db.select().from(departments).where(eq(departments.code, 'CSE B')).limit(1);
  const [sem2] = await db.select().from(semesters).where(eq(semesters.semesterNumber, 2)).limit(1);
  const [yr1] = await db.select().from(academicYears).where(eq(academicYears.yearNumber, 1)).limit(1);
  const [cseBClass] = await db
    .insert(classes)
    .values({
      departmentId: cseB.id,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      sectionName: `Z-${TEST_TAG.slice(-4)}`,
      displayName: `CSE B Calc Section ${TEST_TAG.slice(-4)}`,
      isActive: true,
    })
    .returning();
  createdClassIds.push(cseBClass.id);
  const [cseBSubj] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.departmentId, cseB.id), eq(subjects.semesterId, sem2.id)))
    .limit(1);
  assert.ok(cseBClass && cseBSubj);

  // Create 3 students:
  // A: joined 2026-01-01, 40 closed sessions (30 subject + 10 daily roll-call) -> 36 present = 90%
  // B: joined 2026-01-01 -> 30 present / 40 = 75%, later corrected to 31/40 = 77.5%
  // C: joined mid-semester 2026-01-16 (after first 30 sessions, eligible for last 10 sessions only), present for 8 of last 10 = 80%
  const studentsSpec = [
    { name: 'Student 90Pct', roll: `P${TEST_TAG.slice(-7)}A`, joined: '2026-01-01' },
    { name: 'Student 75Pct', roll: `P${TEST_TAG.slice(-7)}B`, joined: '2026-01-01' },
    { name: 'Student MidSem', roll: `P${TEST_TAG.slice(-7)}C`, joined: '2026-01-16' },
    { name: 'Student NoData', roll: `P${TEST_TAG.slice(-7)}D`, joined: '2098-01-01' },
  ];

  const stuIds: string[] = [];
  for (const sp of studentsSpec) {
    const [p] = await db
      .insert(profiles)
      .values({
        roleId: studentRole.id,
        fullName: sp.name,
        email: `${sp.roll}@sbist.edu.in`.toLowerCase(),
        rollNumber: sp.roll,
        status: 'approved',
        emailVerified: true,
      })
      .returning();
    createdProfileIds.push(p.id);
    stuIds.push(p.id);

    await db.insert(studentEnrollments).values({
      studentId: p.id,
      rollNumber: sp.roll,
      departmentId: cseB.id,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      classId: cseBClass.id,
      isActive: true,
      joinedDateIST: sp.joined,
    });
  }

  // Create 40 closed sessions across 20 dates (2026-01-01 .. 2026-01-20)
  // First 30 sessions (dates 01..15) have subjectId = cseBSubj.id
  // Last 10 sessions (dates 16..20) have subjectId = null (daily roll-call)
  const closedSessionRows: Array<{ id: string; date: string; subjectId: string | null }> = [];
  for (let i = 0; i < 40; i++) {
    const dayNum = Math.floor(i / 2) + 1;
    const dateStr = `2026-01-${String(dayNum).padStart(2, '0')}`;
    const isMorning = i % 2 === 0;
    const subjId = i < 30 ? cseBSubj.id : null;
    const [ses] = await db
      .insert(attendanceSessions)
      .values({
        sessionCode: `CALC-${TEST_TAG}-${i}`,
        departmentId: cseB.id,
        classId: cseBClass.id,
        academicYearId: yr1.id,
        semesterId: sem2.id,
        subjectId: subjId,
        sessionDate: dateStr,
        startTime: isMorning ? '09:00' : '13:30',
        endTime: isMorning ? '09:40' : '13:40',
        periodSlot: isMorning ? 'morning' : 'afternoon',
        isAutoScheduled: subjId === null,
        status: 'closed',
      })
      .returning();
    createdSessionIds.push(ses.id);
    closedSessionRows.push({ id: ses.id, date: dateStr, subjectId: subjId });
  }

  // Add 1 active session (must NOT count in completed denominator) and 1 cancelled session (must NOT count)
  const [unclosedSes] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: `OPEN-${TEST_TAG}`,
      departmentId: cseB.id,
      classId: cseBClass.id,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      subjectId: cseBSubj.id,
      sessionDate: '2026-01-21',
      startTime: '09:00',
      endTime: '09:40',
      periodSlot: 'morning',
      status: 'active',
    })
    .returning();
  createdSessionIds.push(unclosedSes.id);

  const [cancelledSes] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: `CANC-${TEST_TAG}`,
      departmentId: cseB.id,
      classId: cseBClass.id,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      subjectId: cseBSubj.id,
      sessionDate: '2026-01-22',
      startTime: '09:00',
      endTime: '09:40',
      periodSlot: 'morning',
      status: 'cancelled',
    })
    .returning();
  createdSessionIds.push(cancelledSes.id);

  // Add a holiday on 2026-01-25 with a mistakenly closed session on that date -> excluded from denominator!
  const [pastHoliday] = await db
    .insert(holidays)
    .values({
      title: 'Republic Day Holiday',
      startDate: '2026-01-25',
      endDate: '2026-01-25',
      reason: 'National Holiday',
    })
    .returning();
  createdHolidayIds.push(pastHoliday.id);

  const [holClosedSes] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: `HOL-${TEST_TAG}`,
      departmentId: cseB.id,
      classId: cseBClass.id,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      subjectId: cseBSubj.id,
      sessionDate: '2026-01-25',
      startTime: '09:00',
      endTime: '09:40',
      periodSlot: 'morning',
      status: 'closed',
    })
    .returning();
  createdSessionIds.push(holClosedSes.id);

  // Insert attendance records for A (36/40), B (30/40), C (8/10 from 2026-01-16..20)
  const recordInserts: Array<typeof attendanceRecords.$inferInsert> = [];
  for (let i = 0; i < 36; i++) {
    recordInserts.push({
      studentId: stuIds[0],
      sessionId: closedSessionRows[i].id,
      departmentId: cseB.id,
      classId: cseBClass.id,
      subjectId: closedSessionRows[i].subjectId,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      attendanceDate: closedSessionRows[i].date,
      status: 'present',
      verificationMethod: 'face_liveness',
      verificationResult: 'verified',
      livenessPassed: true,
    });
  }
  for (let i = 0; i < 30; i++) {
    recordInserts.push({
      studentId: stuIds[1],
      sessionId: closedSessionRows[i].id,
      departmentId: cseB.id,
      classId: cseBClass.id,
      subjectId: closedSessionRows[i].subjectId,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      attendanceDate: closedSessionRows[i].date,
      status: 'present',
      verificationMethod: 'face_liveness',
      verificationResult: 'verified',
      livenessPassed: true,
    });
  }
  // C is present for 8 of the last 10 sessions (indices 30..37)
  for (let i = 30; i < 38; i++) {
    recordInserts.push({
      studentId: stuIds[2],
      sessionId: closedSessionRows[i].id,
      departmentId: cseB.id,
      classId: cseBClass.id,
      subjectId: closedSessionRows[i].subjectId,
      academicYearId: yr1.id,
      semesterId: sem2.id,
      attendanceDate: closedSessionRows[i].date,
      status: 'present',
      verificationMethod: 'face_liveness',
      verificationResult: 'verified',
      livenessPassed: true,
    });
  }
  await db.insert(attendanceRecords).values(recordInserts);

  // Verify centralized bulk computation
  const enrollments = await db
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
    .where(inArray(studentEnrollments.studentId, stuIds));

  const bulkMap = await computeBulkSemesterAttendance({ targets: enrollments });

  const sumA = bulkMap.get(stuIds[0])!;
  assert.equal(sumA.totalSessions, 40);
  assert.equal(sumA.presentSessions, 36);
  assert.equal(sumA.attendancePercentage, 90);
  assert.equal(sumA.hasData, true);

  const sumB = bulkMap.get(stuIds[1])!;
  assert.equal(sumB.totalSessions, 40);
  assert.equal(sumB.presentSessions, 30);
  assert.equal(sumB.attendancePercentage, 75);

  const sumC = bulkMap.get(stuIds[2])!;
  assert.equal(sumC.totalSessions, 10);
  assert.equal(sumC.presentSessions, 8);
  assert.equal(sumC.attendancePercentage, 80);

  const sumD = bulkMap.get(stuIds[3])!;
  assert.equal(sumD.totalSessions, 0);
  assert.equal(sumD.attendancePercentage, 0);
  assert.equal(sumD.hasData, false);
  assert.equal(sumD.message, NO_ATTENDANCE_DATA_MESSAGE);

  // Verify student A subject-wise counts ONLY the 30 subject sessions (excludes the 10 daily roll-call sessions)
  const profA = await computeStudentFullAttendanceProfile({ studentId: stuIds[0] });
  assert.ok(profA);
  assert.equal(profA.summary.attendancePercentage, 90);
  assert.equal(profA.subjectWise.length, 1);
  assert.equal(profA.subjectWise[0].subjectId, cseBSubj.id);
  assert.equal(profA.subjectWise[0].total, 30);
  assert.equal(profA.subjectWise[0].present, 30);
  assert.equal(profA.subjectWise[0].percentage, 100);

  // Admin approves attendance correction for Student B (session 30 -> present => 31/40 = 77.5%)
  const corrRes = await fetch(`${url}/api/admin/attendance/correct`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: stuIds[1],
      sessionId: closedSessionRows[30].id,
      status: 'present',
      reason: 'Verified classroom attendance log correction',
    }),
  });
  assert.equal(corrRes.status, 200);

  const profBAfter = await computeStudentFullAttendanceProfile({ studentId: stuIds[1] });
  assert.ok(profBAfter);
  assert.equal(profBAfter.summary.presentSessions, 31);
  assert.equal(profBAfter.summary.totalSessions, 40);
  assert.equal(profBAfter.summary.attendancePercentage, 77.5);

  // Student D (0/0) via GET /api/student/dashboard shows 0% & "No attendance data available" (never 100%)
  const stuDToken = signSessionToken({
    profileId: stuIds[3],
    email: `${studentsSpec[3].roll}@sbist.edu.in`.toLowerCase(),
    role: 'student',
  });
  const dashDRes = await fetch(`${url}/api/student/dashboard`, {
    headers: { Authorization: `Bearer ${stuDToken}` },
  });
  assert.equal(dashDRes.status, 200);
  const dashD = (await dashDRes.json()) as {
    summary: { attendancePercentage: number; hasData: boolean; message: string };
  };
  assert.equal(dashD.summary.attendancePercentage, 0);
  assert.equal(dashD.summary.hasData, false);
  assert.equal(dashD.summary.message, 'No attendance data available');
});
