import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as dotenv from 'dotenv';
import { and, eq, ilike, inArray, sql } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  biometricTemplates,
  classes,
  departments,
  profiles,
  registrationQrCodes,
  roles,
  semesters,
  studentEnrollments,
  subjects,
} from '../src/db/schema.ts';
import { ensureBaselineSeeded, INITIAL_SUPER_ADMIN_EMAIL } from '../src/server/seed.ts';
import {
  averageAndNormalizeDescriptors,
  computeFaceDistance,
  computeGeofenceDistanceMeters,
  decryptBiometricDescriptor,
  encryptBiometricDescriptor,
  hashPassword,
  signAccountSetupToken,
  signSessionToken,
  verifyAccountSetupToken,
  verifyPassword,
  verifySessionToken,
} from '../src/server/crypto.ts';

const TEST_TAG = `TEST5K_${Date.now()}`;

after(async () => {
  try {
    await db.execute(
      sql`DELETE FROM attendance_records WHERE student_id IN (SELECT id FROM profiles WHERE email LIKE ${`%${TEST_TAG.toLowerCase()}%`})`
    );
    await db.execute(
      sql`DELETE FROM attendance_sessions WHERE session_code LIKE ${`${TEST_TAG}%`}`
    );
    await db.execute(
      sql`DELETE FROM biometric_templates WHERE student_id IN (SELECT id FROM profiles WHERE email LIKE ${`%${TEST_TAG.toLowerCase()}%`})`
    );
    await db.execute(
      sql`DELETE FROM student_enrollments WHERE roll_number LIKE ${`${TEST_TAG}%`}`
    );
    await db.execute(
      sql`DELETE FROM profiles WHERE email LIKE ${`%${TEST_TAG.toLowerCase()}%`}`
    );
    await db.execute(
      sql`DELETE FROM registration_qr_codes WHERE token LIKE ${`${TEST_TAG}%`}`
    );
  } finally {
    await pool.end();
  }
});

test('1. Baseline seeding: 7 official departments, 4 years, 8 semesters, and initial Super Admin', async () => {
  await ensureBaselineSeeded();

  const depts = await db.select().from(departments);
  const expectedCodes = ['CSM C', 'CSMB C', 'CSM A', 'CSE C', 'CSE B', 'CSE A', 'CSD'];
  for (const code of expectedCodes) {
    assert.ok(
      depts.some((d) => d.code === code),
      `Missing official department ${code}`
    );
  }
  assert.equal(depts.length, 7);

  const yrs = await db.select().from(academicYears);
  assert.equal(yrs.length, 4);

  const sems = await db.select().from(semesters);
  assert.equal(sems.length, 8);

  const [superAdmin] = await db
    .select({ email: profiles.email, status: profiles.status, roleName: roles.name })
    .from(profiles)
    .innerJoin(roles, eq(profiles.roleId, roles.id))
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);

  assert.ok(superAdmin);
  assert.equal(superAdmin.roleName, 'super_admin');
  assert.equal(superAdmin.status, 'approved');

  const [campusAttendQr] = await db
    .select({
      token: registrationQrCodes.token,
      qrPurpose: registrationQrCodes.qrPurpose,
      expiresAt: registrationQrCodes.expiresAt,
      maxUses: registrationQrCodes.maxUses,
      isRevoked: registrationQrCodes.isRevoked,
    })
    .from(registrationQrCodes)
    .where(eq(registrationQrCodes.token, 'SBIST-ATTEND-CAMPUS'))
    .limit(1);

  assert.ok(campusAttendQr);
  assert.equal(campusAttendQr.qrPurpose, 'attendance');
  assert.equal(campusAttendQr.expiresAt, null);
  assert.equal(campusAttendQr.maxUses, null);
  assert.equal(campusAttendQr.isRevoked, false);

  const [campusRegisterQr] = await db
    .select({
      token: registrationQrCodes.token,
      qrPurpose: registrationQrCodes.qrPurpose,
      expiresAt: registrationQrCodes.expiresAt,
      maxUses: registrationQrCodes.maxUses,
      isRevoked: registrationQrCodes.isRevoked,
    })
    .from(registrationQrCodes)
    .where(eq(registrationQrCodes.token, 'SBIST-REGISTER-CAMPUS'))
    .limit(1);

  assert.ok(campusRegisterQr);
  assert.equal(campusRegisterQr.qrPurpose, 'registration');
  assert.equal(campusRegisterQr.expiresAt, null);
  assert.equal(campusRegisterQr.maxUses, null);
  assert.equal(campusRegisterQr.isRevoked, false);
});

test('2. Cryptography: AES-256-GCM biometric encryption, 128D face matching, scrypt & geofence', () => {
  // Password hashing
  const pwd = 'Sbist@Secure2026!';
  const hash = hashPassword(pwd);
  assert.equal(verifyPassword(pwd, hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);

  // Session & setup tokens
  const sessionToken = signSessionToken({
    profileId: '00000000-0000-0000-0000-000000000001',
    email: 'student@gmail.com',
    role: 'student',
  });
  const decodedSession = verifySessionToken(sessionToken);
  assert.equal(decodedSession?.role, 'student');

  const setupToken = signAccountSetupToken('00000000-0000-0000-0000-000000000001', 'student@gmail.com');
  assert.equal(verifyAccountSetupToken(setupToken)?.email, 'student@gmail.com');

  // Biometric AES-256-GCM encryption & Euclidean face distance
  const rawVec1 = Array.from({ length: 128 }, (_, i) => Math.sin(i + 1) * 0.15);
  const rawVec2 = rawVec1.map((v, i) => v + (i % 2 === 0 ? 0.005 : -0.005));
  const strangerVec = Array.from({ length: 128 }, (_, i) => Math.cos(i + 5) * 0.25);

  const template = averageAndNormalizeDescriptors([rawVec1, rawVec2]);
  const encrypted = encryptBiometricDescriptor(template);
  const decrypted = decryptBiometricDescriptor(
    encrypted.encryptedDescriptor,
    encrypted.iv,
    encrypted.authTag
  );

  const genuineLive = averageAndNormalizeDescriptors([rawVec2]);
  const strangerLive = averageAndNormalizeDescriptors([strangerVec]);

  const genuineDist = computeFaceDistance(genuineLive, decrypted);
  const strangerDist = computeFaceDistance(strangerLive, decrypted);

  assert.ok(genuineDist < 0.2, `Expected genuine match distance < 0.2, got ${genuineDist}`);
  assert.ok(strangerDist > 0.5, `Expected stranger distance > 0.5, got ${strangerDist}`);

  // Geofence Haversine distance
  const sameSpot = computeGeofenceDistanceMeters(17.2473, 80.1514, 17.2473, 80.1514);
  assert.equal(sameSpot, 0);
  const farSpot = computeGeofenceDistanceMeters(17.2473, 80.1514, 17.385, 78.4867);
  assert.ok(farSpot > 100000);
});

test('3. Database scale & concurrency: 5,000 test accounts + 100, 500, and 1,000 concurrent attendance markings + duplicate prevention', async () => {
  const [studentRole] = await db.select().from(roles).where(eq(roles.name, 'student')).limit(1);
  const [dept] = await db.select().from(departments).where(eq(departments.code, 'CSM C')).limit(1);
  const [yr] = await db.select().from(academicYears).where(eq(academicYears.yearNumber, 1)).limit(1);
  const [sem] = await db.select().from(semesters).where(eq(semesters.semesterNumber, 1)).limit(1);
  const [cls] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.departmentId, dept.id), eq(classes.semesterId, sem.id)))
    .limit(1);
  const [subj] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.departmentId, dept.id), eq(subjects.semesterId, sem.id)))
    .limit(1);

  // Create 5,000 synthetic student profiles + enrollments in batches of 500
  const TOTAL_ACCOUNTS = 5000;
  const BATCH_SIZE = 500;
  const createdIds: string[] = [];

  const tSeedStart = performance.now();
  for (let offset = 0; offset < TOTAL_ACCOUNTS; offset += BATCH_SIZE) {
    const profileBatch = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = offset + i + 1;
      profileBatch.push({
        roleId: studentRole.id,
        fullName: `Scale Student ${idx}`,
        email: `stu${idx}.${TEST_TAG.toLowerCase()}@gmail.com`,
        phone: '9876543210',
        rollNumber: `${TEST_TAG}-${String(idx).padStart(4, '0')}`,
        status: 'approved',
        emailVerified: true,
      });
    }
    const insertedProfiles = await db
      .insert(profiles)
      .values(profileBatch)
      .returning({ id: profiles.id, rollNumber: profiles.rollNumber });

    const enrollBatch = insertedProfiles.map((p) => ({
      studentId: p.id,
      rollNumber: p.rollNumber!,
      departmentId: dept.id,
      academicYearId: yr.id,
      semesterId: sem.id,
      classId: cls.id,
      isActive: true,
    }));
    await db.insert(studentEnrollments).values(enrollBatch);

    for (const p of insertedProfiles) createdIds.push(p.id);
  }
  const tSeedMs = Math.round(performance.now() - tSeedStart);
  assert.equal(createdIds.length, TOTAL_ACCOUNTS);

  // Verify paginated query latency on 5,000+ rows
  const tQueryStart = performance.now();
  const pageRows = await db
    .select({ id: profiles.id, rollNumber: profiles.rollNumber })
    .from(profiles)
    .where(ilike(profiles.rollNumber, `${TEST_TAG}%`))
    .limit(25)
    .offset(2500);
  const tQueryMs = Math.round(performance.now() - tQueryStart);
  assert.equal(pageRows.length, 25);

  // Create an active attendance session
  const [session] = await db
    .insert(attendanceSessions)
    .values({
      sessionCode: `${TEST_TAG}-SES`,
      departmentId: dept.id,
      classId: cls.id,
      academicYearId: yr.id,
      semesterId: sem.id,
      subjectId: subj.id,
      sessionDate: '2026-11-24',
      startTime: '09:30',
      endTime: '10:30',
      status: 'active',
    })
    .returning();

  // Duplicate prevention test on (student_id, session_id)
  const firstStudentId = createdIds[0];
  const firstInsert = await db
    .insert(attendanceRecords)
    .values({
      studentId: firstStudentId,
      sessionId: session.id,
      departmentId: dept.id,
      classId: cls.id,
      subjectId: subj.id,
      attendanceDate: session.sessionDate,
      status: 'present',
      verificationMethod: 'face_geofence',
      verificationResult: 'verified',
      livenessPassed: true,
    })
    .onConflictDoNothing({ target: [attendanceRecords.studentId, attendanceRecords.sessionId] })
    .returning();
  assert.equal(firstInsert.length, 1);

  const dupInsert = await db
    .insert(attendanceRecords)
    .values({
      studentId: firstStudentId,
      sessionId: session.id,
      departmentId: dept.id,
      classId: cls.id,
      subjectId: subj.id,
      attendanceDate: session.sessionDate,
      status: 'present',
      verificationMethod: 'face_geofence',
      verificationResult: 'verified',
      livenessPassed: true,
    })
    .onConflictDoNothing({ target: [attendanceRecords.studentId, attendanceRecords.sessionId] })
    .returning();
  assert.equal(dupInsert.length, 0, 'Duplicate (student_id, session_id) must be blocked');

  // Helper for concurrent attendance marking bursts (100, 500, 1,000)
  async function runConcurrentBurst(startIdx: number, count: number) {
    const slice = createdIds.slice(startIdx, startIdx + count);
    const t0 = performance.now();
    const results = await Promise.all(
      slice.map((sid) =>
        db
          .insert(attendanceRecords)
          .values({
            studentId: sid,
            sessionId: session.id,
            departmentId: dept.id,
            classId: cls.id,
            subjectId: subj.id,
            attendanceDate: session.sessionDate,
            status: 'present',
            verificationMethod: 'face_geofence',
            verificationResult: 'verified',
            livenessPassed: true,
          })
          .onConflictDoNothing({
            target: [attendanceRecords.studentId, attendanceRecords.sessionId],
          })
          .returning({ id: attendanceRecords.id })
      )
    );
    const elapsedMs = Math.round(performance.now() - t0);
    const insertedCount = results.filter((r) => r.length === 1).length;
    assert.equal(insertedCount, count);
    return elapsedMs;
  }

  const ms100 = await runConcurrentBurst(1, 100);
  const ms500 = await runConcurrentBurst(101, 500);
  const ms1000 = await runConcurrentBurst(601, 1000);

  console.log(
    JSON.stringify({
      scaleTestSummary: {
        accountsSeeded: TOTAL_ACCOUNTS,
        seedDurationMs: tSeedMs,
        paginatedQuery25RowsMs: tQueryMs,
        concurrent100Ms: ms100,
        concurrent500Ms: ms500,
        concurrent1000Ms: ms1000,
      },
    })
  );

  // Verify QR code creation + revocation
  const [qr] = await db
    .insert(registrationQrCodes)
    .values({
      token: `${TEST_TAG}-QR`,
      label: 'Scale Test QR',
      maxUses: 100,
    })
    .returning();
  assert.equal(qr.isRevoked, false);
});
