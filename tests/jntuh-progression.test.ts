import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import * as dotenv from 'dotenv';
import { and, asc, eq, ilike, inArray } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  auditLogs,
  classes,
  departments,
  profiles,
  promotionBatches,
  promotionBatchItems,
  roles,
  semesters,
  staffAssignments,
  studentAcademicHistory,
  studentEnrollments,
  subjects,
} from '../src/db/schema.ts';
import { ensureBaselineSeeded, INITIAL_SUPER_ADMIN_EMAIL } from '../src/server/seed.ts';
import { signSessionToken } from '../src/server/crypto.ts';
import {
  executeBulkPromotion,
  previewAcademicProgression,
  rollbackPromotionBatch,
} from '../src/server/progression.ts';
import { authAndPublicRouter } from '../src/server/routes/authAndPublic.ts';
import { adminRouter } from '../src/server/routes/adminRoutes.ts';
import { staffRouter } from '../src/server/routes/staffRoutes.ts';
import { studentRouter } from '../src/server/routes/studentRoutes.ts';
import { reportRouter } from '../src/server/routes/reportRoutes.ts';

const TEST_TAG = `JNTUH_${Date.now()}`;
const createdStudentIds: string[] = [];
const createdStaffIds: string[] = [];
const createdBatchIds: string[] = [];
const createdSessionCodes: string[] = [];
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
  const address = server!.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

after(async () => {
  try {
    if (createdBatchIds.length > 0) {
      await db
        .delete(studentAcademicHistory)
        .where(inArray(studentAcademicHistory.promotionBatchId, createdBatchIds));
      await db
        .delete(promotionBatchItems)
        .where(inArray(promotionBatchItems.batchId, createdBatchIds));
      await db
        .delete(promotionBatches)
        .where(inArray(promotionBatches.id, createdBatchIds));
    }
    if (createdStudentIds.length > 0) {
      for (let i = 0; i < createdStudentIds.length; i += 500) {
        const chunk = createdStudentIds.slice(i, i + 500);
        await db.delete(attendanceRecords).where(inArray(attendanceRecords.studentId, chunk));
        await db.delete(studentAcademicHistory).where(inArray(studentAcademicHistory.studentId, chunk));
        await db.delete(studentEnrollments).where(inArray(studentEnrollments.studentId, chunk));
        await db.delete(profiles).where(inArray(profiles.id, chunk));
      }
    }
    if (createdStaffIds.length > 0) {
      await db.delete(staffAssignments).where(inArray(staffAssignments.staffId, createdStaffIds));
      await db.delete(profiles).where(inArray(profiles.id, createdStaffIds));
    }
    if (createdSessionCodes.length > 0) {
      await db
        .delete(attendanceSessions)
        .where(inArray(attendanceSessions.sessionCode, createdSessionCodes));
    }
    await db.delete(auditLogs).where(ilike(auditLogs.entityType, 'promotion_batch'));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  }
});

test('1. Full JNTUH Transitions (Sem 1->2->3->4->5->6->7->8), 7 Departments, Staff Carry-Forward, Eligibility, History Preservation & RBAC', async () => {
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
  const allDepts = await db.select().from(departments).orderBy(asc(departments.code));
  const allYears = await db.select().from(academicYears).orderBy(asc(academicYears.yearNumber));
  const allSems = await db.select().from(semesters).orderBy(asc(semesters.semesterNumber));

  assert.equal(allDepts.length, 7);
  assert.equal(allYears.length, 4);
  assert.equal(allSems.length, 8);

  const semByNum = new Map(allSems.map((s) => [s.semesterNumber, s]));
  const yearById = new Map(allYears.map((y) => [y.id, y]));
  const sem1 = semByNum.get(1)!;
  const sem2 = semByNum.get(2)!;
  const sem3 = semByNum.get(3)!;

  // Create one staff member assigned to CSM C Sem 1 class & subject
  const csmC = allDepts.find((d) => d.code === 'CSM C')!;
  const [sem1ClassCsm] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, csmC.id), eq(classes.semesterId, sem1.id)))
    .limit(1);
  const [sem1SubjCsm] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.departmentId, csmC.id), eq(subjects.semesterId, sem1.id)))
    .limit(1);
  assert.ok(sem1ClassCsm && sem1SubjCsm);

  const [staffUser] = await db
    .insert(profiles)
    .values({
      roleId: staffRole.id,
      fullName: 'JNTUH Test Faculty',
      email: `staff.${TEST_TAG.toLowerCase()}@gmail.com`,
      employeeId: `${TEST_TAG}-FAC1`,
      status: 'approved',
      emailVerified: true,
    })
    .returning();
  createdStaffIds.push(staffUser.id);

  await db.insert(staffAssignments).values({
    staffId: staffUser.id,
    departmentId: csmC.id,
    classId: sem1ClassCsm.id,
    subjectId: sem1SubjCsm.id,
    canCreateSessions: true,
    isActive: true,
  });

  const staffToken = signSessionToken({
    profileId: staffUser.id,
    email: staffUser.email,
    role: 'staff',
  });

  // Create 1 eligible student in EVERY ONE of the 7 departments (passed)
  const deptStudents: Array<{ id: string; rollNumber: string; departmentId: string; departmentCode: string }> = [];
  for (let i = 0; i < allDepts.length; i++) {
    const dept = allDepts[i];
    const [cls1] = await db
      .select()
      .from(classes)
      .where(and(eq(classes.departmentId, dept.id), eq(classes.semesterId, sem1.id)))
      .limit(1);

    const roll = `${TEST_TAG}-D${i + 1}`;
    const [stu] = await db
      .insert(profiles)
      .values({
        roleId: studentRole.id,
        fullName: `Dept ${dept.code} Eligible Student`,
        email: `d${i + 1}.${TEST_TAG.toLowerCase()}@gmail.com`,
        rollNumber: roll,
        status: 'approved',
        emailVerified: true,
      })
      .returning();
    createdStudentIds.push(stu.id);

    await db.insert(studentEnrollments).values({
      studentId: stu.id,
      rollNumber: roll,
      departmentId: dept.id,
      academicYearId: sem1.academicYearId,
      semesterId: sem1.id,
      classId: cls1.id,
      regulation: 'R22',
      academicStanding: 'active',
      creditsEarned: 22,
      activeBacklogs: 0,
      latestResultStatus: 'passed',
      isActive: true,
    });
    deptStudents.push({ id: stu.id, rollNumber: roll, departmentId: dept.id, departmentCode: dept.code });
  }

  // Create 4 special eligibility test students in CSM C Sem 1:
  // 1) Promoted with backlogs (eligible!)
  // 2) Detained due to low attendance (< 65%)
  // 3) Failed exam result
  // 4) Pending exam result
  const specialSpecs = [
    { key: 'backlog', standing: 'active', result: 'promoted_with_backlogs', backlogs: 2, credits: 18 },
    { key: 'lowatt', standing: 'active', result: 'passed', backlogs: 0, credits: 22 },
    { key: 'failed', standing: 'active', result: 'failed', backlogs: 3, credits: 14 },
    { key: 'pending', standing: 'active', result: 'pending', backlogs: 0, credits: 0 },
  ] as const;

  const specialIds: Record<string, string> = {};
  for (const sp of specialSpecs) {
    const roll = `${TEST_TAG}-${sp.key.toUpperCase()}`;
    const [stu] = await db
      .insert(profiles)
      .values({
        roleId: studentRole.id,
        fullName: `Special ${sp.key}`,
        email: `${sp.key}.${TEST_TAG.toLowerCase()}@gmail.com`,
        rollNumber: roll,
        status: 'approved',
        emailVerified: true,
      })
      .returning();
    createdStudentIds.push(stu.id);
    specialIds[sp.key] = stu.id;

    await db.insert(studentEnrollments).values({
      studentId: stu.id,
      rollNumber: roll,
      departmentId: csmC.id,
      academicYearId: sem1.academicYearId,
      semesterId: sem1.id,
      classId: sem1ClassCsm.id,
      regulation: 'R22',
      academicStanding: sp.standing,
      creditsEarned: sp.credits,
      activeBacklogs: sp.backlogs,
      latestResultStatus: sp.result,
      isActive: true,
    });
  }

  // Record 2 conducted Sem 1 sessions for CSM C so attendance % is evaluated:
  // - All CSM C eligible students + backlog + failed + pending attend BOTH sessions (100%)
  // - lowatt student attends ONLY 1 of 2 sessions (50% < 65% => DETAINED)
  const ses1Code = `${TEST_TAG}-S1-A`;
  const ses2Code = `${TEST_TAG}-S1-B`;
  createdSessionCodes.push(ses1Code, ses2Code);

  const [ses1] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: ses1Code,
      departmentId: csmC.id,
      classId: sem1ClassCsm.id,
      academicYearId: sem1.academicYearId,
      semesterId: sem1.id,
      subjectId: sem1SubjCsm.id,
      sessionDate: '2026-08-10',
      startTime: '09:30',
      endTime: '10:30',
      status: 'closed',
    })
    .returning();
  const [ses2] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: ses2Code,
      departmentId: csmC.id,
      classId: sem1ClassCsm.id,
      academicYearId: sem1.academicYearId,
      semesterId: sem1.id,
      subjectId: sem1SubjCsm.id,
      sessionDate: '2026-08-11',
      startTime: '09:30',
      endTime: '10:30',
      status: 'closed',
    })
    .returning();

  const csmPrimaryStudent = deptStudents.find((d) => d.departmentCode === 'CSM C')!;
  const hundredPctIds = [
    csmPrimaryStudent.id,
    specialIds.backlog,
    specialIds.failed,
    specialIds.pending,
  ];
  for (const sid of hundredPctIds) {
    await db.insert(attendanceRecords).values([
      {
        studentId: sid,
        sessionId: ses1.id,
        departmentId: csmC.id,
        classId: sem1ClassCsm.id,
        subjectId: sem1SubjCsm.id,
        academicYearId: sem1.academicYearId,
        semesterId: sem1.id,
        attendanceDate: '2026-08-10',
        status: 'present',
        verificationMethod: 'face_geofence',
        verificationResult: 'verified',
        livenessPassed: true,
      },
      {
        studentId: sid,
        sessionId: ses2.id,
        departmentId: csmC.id,
        classId: sem1ClassCsm.id,
        subjectId: sem1SubjCsm.id,
        academicYearId: sem1.academicYearId,
        semesterId: sem1.id,
        attendanceDate: '2026-08-11',
        status: 'excused',
        verificationMethod: 'admin_correction',
        verificationResult: 'corrected',
        correctionReason: 'NSS academic representation verified',
        correctedBy: adminProfile.id,
        livenessPassed: false,
      },
    ]);
  }
  await db.insert(attendanceRecords).values({
    studentId: specialIds.lowatt,
    sessionId: ses1.id,
    departmentId: csmC.id,
    classId: sem1ClassCsm.id,
    subjectId: sem1SubjCsm.id,
    academicYearId: sem1.academicYearId,
    semesterId: sem1.id,
    attendanceDate: '2026-08-10',
    status: 'present',
    verificationMethod: 'face_geofence',
    verificationResult: 'verified',
    livenessPassed: true,
  });

  // RBAC check: student & staff must receive 403 on admin progression endpoints
  const primaryStudentToken = signSessionToken({
    profileId: csmPrimaryStudent.id,
    email: `d_csm.${TEST_TAG.toLowerCase()}@gmail.com`,
    role: 'student',
  });
  const unauthRes = await fetch(`${url}/api/admin/progression/preview?fromSemesterId=${sem1.id}`);
  assert.equal(unauthRes.status, 401);
  const stuForbidden = await fetch(`${url}/api/admin/progression/preview?fromSemesterId=${sem1.id}`, {
    headers: { Authorization: `Bearer ${primaryStudentToken}` },
  });
  assert.equal(stuForbidden.status, 403);
  const staffForbidden = await fetch(`${url}/api/admin/progression/preview?fromSemesterId=${sem1.id}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  assert.equal(staffForbidden.status, 403);

  // Preview Sem 1 -> Sem 2 across all 7 departments
  const previewRes = await fetch(
    `${url}/api/admin/progression/preview?fromSemesterId=${sem1.id}&regulation=R22`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(previewRes.status, 200);
  const previewJson = (await previewRes.json()) as {
    toSemester: { id: string; semesterNumber: number };
    departmentSummaries: Array<{ departmentCode: string }>;
    students: Array<{ studentId: string; bucket: string; attendancePercentage: number | null }>;
  };
  assert.equal(previewJson.toSemester.semesterNumber, 2);
  assert.equal(previewJson.departmentSummaries.length, 7);

  const byId = new Map(previewJson.students.map((s) => [s.studentId, s]));
  for (const ds of deptStudents) {
    assert.equal(byId.get(ds.id)?.bucket, 'eligible');
  }
  assert.equal(byId.get(specialIds.backlog)?.bucket, 'eligible');
  assert.equal(byId.get(specialIds.lowatt)?.bucket, 'detained');
  assert.equal(byId.get(specialIds.lowatt)?.attendancePercentage, 50);
  assert.equal(byId.get(specialIds.failed)?.bucket, 'failed');
  assert.equal(byId.get(specialIds.pending)?.bucket, 'pending');

  // Missing confirmPromotion=true must be rejected with 400
  const noConfirmRes = await fetch(`${url}/api/admin/progression/promote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      fromSemesterId: sem1.id,
      selectedStudentIds: [...deptStudents.map((d) => d.id), specialIds.backlog],
      confirmPromotion: false,
    }),
  });
  assert.equal(noConfirmRes.status, 400);

  // Execute bulk promotion Sem 1 -> Sem 2 across ALL 7 departments
  const testScopeIds = [...deptStudents.map((d) => d.id), ...Object.values(specialIds)];
  const promoteRes = await fetch(`${url}/api/admin/progression/promote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      fromSemesterId: sem1.id,
      departmentId: null,
      regulation: 'R22',
      selectedStudentIds: testScopeIds,
      updateStaffAssignments: true,
      confirmationNote: 'Acceptance test Sem 1 -> Sem 2 across 7 depts',
      confirmPromotion: true,
    }),
  });
  assert.equal(promoteRes.status, 201);
  const promoteJson = (await promoteRes.json()) as {
    batch: {
      id: string;
      promotedCount: number;
      staffAssignmentsUpdated: number;
    };
  };
  createdBatchIds.push(promoteJson.batch.id);
  assert.equal(promoteJson.batch.promotedCount, 8); // 7 dept students + 1 promoted_with_backlogs
  assert.ok(promoteJson.batch.staffAssignmentsUpdated >= 1);

  // Verify ineligible students stayed in Sem 1
  const ineligibleEnrollments = await db
    .select()
    .from(studentEnrollments)
    .where(inArray(studentEnrollments.studentId, [specialIds.lowatt, specialIds.failed, specialIds.pending]));
  for (const enr of ineligibleEnrollments) {
    assert.equal(enr.semesterId, sem1.id, 'Ineligible student must remain in Semester 1');
  }

  // Verify all 8 eligible students moved to Sem 2, roll numbers unchanged, staff carried forward
  const [sem2ClassCsm] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, csmC.id), eq(classes.semesterId, sem2.id)))
    .limit(1);
  assert.ok(sem2ClassCsm);

  const staffSem2Assignments = await db
    .select()
    .from(staffAssignments)
    .where(and(eq(staffAssignments.staffId, staffUser.id), eq(staffAssignments.classId, sem2ClassCsm.id)));
  assert.ok(staffSem2Assignments.length >= 1, 'Authorized staff assignment should carry forward to Sem 2 class');

  const promotedEnrollments = await db
    .select()
    .from(studentEnrollments)
    .where(inArray(studentEnrollments.studentId, deptStudents.map((d) => d.id)));
  for (const enr of promotedEnrollments) {
    assert.equal(enr.semesterId, sem2.id);
    assert.equal(enr.academicYearId, sem2.academicYearId);
    const orig = deptStudents.find((d) => d.id === enr.studentId)!;
    assert.equal(enr.rollNumber, orig.rollNumber);
  }

  // Duplicate promotion prevention: promoting the same students from Sem 1 again must fail (409)
  const dupPromoteRes = await fetch(`${url}/api/admin/progression/promote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      fromSemesterId: sem1.id,
      selectedStudentIds: [csmPrimaryStudent.id],
      confirmPromotion: true,
    }),
  });
  assert.ok(dupPromoteRes.status === 400 || dupPromoteRes.status === 409);

  // Historical preservation verification via Student Dashboard & Reports API
  const stuHistRes = await fetch(`${url}/api/student/dashboard?semesterId=${sem1.id}`, {
    headers: { Authorization: `Bearer ${primaryStudentToken}` },
  });
  assert.equal(stuHistRes.status, 200);
  const stuHistJson = (await stuHistRes.json()) as {
    enrollment: { semesterId: string; semesterNumber: number };
    viewingHistoricalSemester: boolean;
    summary: { attendancePercentage: number; totalSessions: number; presentSessions: number };
    recentRecords: Array<{ id: string; subjectCode: string }>;
    academicHistory: Array<{ semesterId: string; resultStatus: string; attendancePercentage: number }>;
  };
  assert.equal(stuHistJson.enrollment.semesterId, sem2.id);
  assert.equal(stuHistJson.viewingHistoricalSemester, true);
  assert.equal(stuHistJson.summary.attendancePercentage, 100);
  assert.equal(stuHistJson.summary.totalSessions, 2);
  assert.equal(stuHistJson.recentRecords.length, 2);
  assert.equal(stuHistJson.academicHistory.length, 1);
  assert.equal(stuHistJson.academicHistory[0].semesterId, sem1.id);

  // Admin report for Sem 1 still shows preserved records & correction reason
  const repRes = await fetch(
    `${url}/api/reports/attendance?semesterId=${sem1.id}&search=${encodeURIComponent(csmPrimaryStudent.rollNumber)}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(repRes.status, 200);
  const repJson = (await repRes.json()) as { items: Array<{ semesterLabel: string }> };
  assert.equal(repJson.items.length, 2);
  assert.equal(repJson.items[0].semesterLabel, sem1.label);

  // Verify year-end credit barrier for Sem 2 -> Sem 3 (requires >= 20 credits under R22)
  // Give csmPrimaryStudent only 16 credits initially -> must be DETAINED for credit shortage!
  await db
    .update(studentEnrollments)
    .set({ latestResultStatus: 'passed', creditsEarned: 16 })
    .where(eq(studentEnrollments.studentId, csmPrimaryStudent.id));

  const creditShortagePreview = await previewAcademicProgression({
    fromSemesterId: sem2.id,
    departmentId: csmC.id,
  });
  const shortRow = creditShortagePreview.students.find((s) => s.studentId === csmPrimaryStudent.id);
  assert.equal(shortRow?.bucket, 'detained');
  assert.ok(shortRow?.eligibilityReason.includes('Credit shortage'));

  // Now test full progression chain Sem 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 with valid JNTUH credits!
  const stepCredits: Record<number, number> = {
    2: 24, // >= 20 required for 2->3
    3: 32,
    4: 44, // >= 40 required for 4->5
    5: 56,
    6: 66, // >= 60 required for 6->7
    7: 80,
  };

  for (let currentSem = 2; currentSem <= 7; currentSem++) {
    await db
      .update(studentEnrollments)
      .set({
        latestResultStatus: 'passed',
        academicStanding: 'active',
        creditsEarned: stepCredits[currentSem],
        activeBacklogs: 0,
      })
      .where(eq(studentEnrollments.studentId, csmPrimaryStudent.id));

    const fromSem = semByNum.get(currentSem)!;
    const promo = await executeBulkPromotion({
      fromSemesterId: fromSem.id,
      departmentId: csmC.id,
      selectedStudentIds: [csmPrimaryStudent.id],
      updateStaffAssignments: true,
      confirmationNote: `Transition Sem ${currentSem} -> ${currentSem + 1}`,
      actorId: adminProfile.id,
      actorEmail: adminProfile.email,
    });
    createdBatchIds.push(promo.batch.id);
    assert.equal(promo.batch.promotedCount, 1);

    const [updatedEnr] = await db
      .select()
      .from(studentEnrollments)
      .where(eq(studentEnrollments.studentId, csmPrimaryStudent.id))
      .limit(1);
    const nextSem = semByNum.get(currentSem + 1)!;
    assert.equal(updatedEnr.semesterId, nextSem.id);
    assert.equal(updatedEnr.academicYearId, nextSem.academicYearId);
    const expectedYearNum = Math.ceil((currentSem + 1) / 2);
    assert.equal(yearById.get(updatedEnr.academicYearId)?.yearNumber, expectedYearNum);
  }

  // Sem 8 -> further promotion must be blocked
  const sem8 = semByNum.get(8)!;
  await assert.rejects(
    () =>
      executeBulkPromotion({
        fromSemesterId: sem8.id,
        departmentId: csmC.id,
        selectedStudentIds: [csmPrimaryStudent.id],
        actorId: adminProfile.id,
        actorEmail: adminProfile.email,
      }),
    /final JNTUH semester/i
  );

  // Confirm Sem 1 attendance records remain completely untouched after reaching Sem 8
  const preservedSem1Records = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.studentId, csmPrimaryStudent.id), eq(attendanceRecords.semesterId, sem1.id)));
  assert.equal(preservedSem1Records.length, 2);
  assert.ok(
    preservedSem1Records.some((r) => r.correctionReason === 'NSS academic representation verified'),
    'Correction history must remain intact'
  );

  // Verify Sem 2 -> Sem 3 rollback safety: promote a fresh student Sem 1 -> Sem 2, then roll back via HTTP endpoint
  const rollbackBatchId = createdBatchIds[createdBatchIds.length - 1]; // latest batch was Sem 7 -> Sem 8
  const rbRes = await fetch(`${url}/api/admin/progression/batches/${rollbackBatchId}/rollback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ reason: 'Correcting Sem 7 -> 8 test batch' }),
  });
  assert.equal(rbRes.status, 200);
  const rbJson = (await rbRes.json()) as { restoredCount: number };
  assert.equal(rbJson.restoredCount, 1);

  const [restoredEnr] = await db
    .select()
    .from(studentEnrollments)
    .where(eq(studentEnrollments.studentId, csmPrimaryStudent.id))
    .limit(1);
  assert.equal(restoredEnr.semesterId, semByNum.get(7)!.id);

  // Double rollback must return 409
  const rbDupRes = await fetch(`${url}/api/admin/progression/batches/${rollbackBatchId}/rollback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ reason: 'Duplicate rollback check' }),
  });
  assert.equal(rbDupRes.status, 409);

  // Check student still has preserved Sem 1 attendance after rollback
  const [stillPreservedSem1] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.studentId, csmPrimaryStudent.id), eq(attendanceRecords.semesterId, sem1.id)));
  assert.ok(stillPreservedSem1);

  // Batch history & audit endpoint check
  const batchesRes = await fetch(`${url}/api/admin/progression/batches`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(batchesRes.status, 200);
  const batchesJson = (await batchesRes.json()) as {
    batches: Array<{ id: string; status: string }>;
    auditLogs: Array<{ action: string }>;
  };
  assert.ok(batchesJson.batches.some((b) => b.id === rollbackBatchId && b.status === 'rolled_back'));
  assert.ok(batchesJson.auditLogs.some((a) => a.action === 'ACADEMIC_PROMOTION_EXECUTED'));
  assert.ok(batchesJson.auditLogs.some((a) => a.action === 'ACADEMIC_PROMOTION_ROLLED_BACK'));
});

test('2. Multi-Thousand Student Scale Progression: 3,500 Students Across All 7 Departments in Single Transaction + Rollback', async () => {
  await ensureBaselineSeeded();

  const [adminProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);
  const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
  const allDepts = await db.select().from(departments).orderBy(asc(departments.code));
  const allSems = await db.select().from(semesters).orderBy(asc(semesters.semesterNumber));
  const sem3 = allSems.find((s) => s.semesterNumber === 3)!;
  const sem4 = allSems.find((s) => s.semesterNumber === 4)!;

  const STUDENTS_PER_DEPT = 500; // 7 * 500 = 3,500 students
  const scaleStudentIds: string[] = [];

  for (const dept of allDepts) {
    const [cls3] = await db
      .select()
      .from(classes)
      .where(and(eq(classes.departmentId, dept.id), eq(classes.semesterId, sem3.id)))
      .limit(1);

    const profBatch = [];
    for (let i = 1; i <= STUDENTS_PER_DEPT; i++) {
      const roll = `${TEST_TAG}-SC-${dept.code.replace(/\s+/g, '')}-${String(i).padStart(4, '0')}`;
      profBatch.push({
        roleId: studentRole.id,
        fullName: `Scale ${dept.code} ${i}`,
        email: `${roll.toLowerCase()}@gmail.com`,
        rollNumber: roll,
        status: 'approved',
        emailVerified: true,
      });
    }
    const inserted = await db
      .insert(profiles)
      .values(profBatch)
      .returning({ id: profiles.id, rollNumber: profiles.rollNumber });

    const enrollBatch = inserted.map((p, idx) => ({
      studentId: p.id,
      rollNumber: p.rollNumber!,
      departmentId: dept.id,
      academicYearId: sem3.academicYearId,
      semesterId: sem3.id,
      classId: cls3.id,
      regulation: 'R22',
      academicStanding: 'active',
      creditsEarned: 30,
      activeBacklogs: idx % 10 === 0 ? 1 : 0,
      latestResultStatus: idx % 10 === 0 ? 'promoted_with_backlogs' : 'passed',
      isActive: true,
    }));
    await db.insert(studentEnrollments).values(enrollBatch);
    for (const p of inserted) {
      scaleStudentIds.push(p.id);
      createdStudentIds.push(p.id);
    }
  }

  assert.equal(scaleStudentIds.length, 3500);

  const t0 = performance.now();
  const bulkPromo = await executeBulkPromotion({
    fromSemesterId: sem3.id,
    departmentId: null,
    selectedStudentIds: scaleStudentIds,
    updateStaffAssignments: false,
    confirmationNote: '3500-student scale test across 7 departments',
    actorId: adminProfile.id,
    actorEmail: adminProfile.email,
  });
  const promoteMs = Math.round(performance.now() - t0);
  createdBatchIds.push(bulkPromo.batch.id);

  assert.equal(bulkPromo.batch.promotedCount, 3500);

  // Spot check all 3,500 moved to Semester 4
  const checkSample = await db
    .select({ semesterId: studentEnrollments.semesterId })
    .from(studentEnrollments)
    .where(inArray(studentEnrollments.studentId, scaleStudentIds.slice(0, 500)));
  assert.ok(checkSample.every((r) => r.semesterId === sem4.id));

  // Verify rollback works cleanly at scale too
  const tRb0 = performance.now();
  const rbResult = await rollbackPromotionBatch({
    batchId: bulkPromo.batch.id,
    reason: 'Cleanup scale test rollback check',
    actorId: adminProfile.id,
    actorEmail: adminProfile.email,
  });
  const rollbackMs = Math.round(performance.now() - tRb0);
  assert.equal(rbResult.restoredCount, 3500);

  console.log(
    JSON.stringify({
      jntuhScaleSummary: {
        departments: 7,
        studentsPromoted: 3500,
        promoteDurationMs: promoteMs,
        rollbackDurationMs: rollbackMs,
      },
    })
  );
});
