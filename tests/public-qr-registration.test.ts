import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import * as dotenv from 'dotenv';
import { sql } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { authAndPublicRouter } from '../src/server/routes/authAndPublic.ts';
import { adminRouter } from '../src/server/routes/adminRoutes.ts';
import { staffRouter } from '../src/server/routes/staffRoutes.ts';
import { studentRouter } from '../src/server/routes/studentRoutes.ts';
import { reportRouter } from '../src/server/routes/reportRoutes.ts';

const TEST_TAG = `QRREG_${Date.now()}`;
let server: http.Server | null = null;
let baseUrl = '';

after(async () => {
  try {
    await db.execute(
      sql`DELETE FROM audit_logs WHERE actor_email LIKE ${`%${TEST_TAG.toLowerCase()}%`}`
    );
    await db.execute(
      sql`DELETE FROM student_enrollments WHERE roll_number LIKE ${`${TEST_TAG}%`}`
    );
    await db.execute(
      sql`DELETE FROM profiles WHERE email LIKE ${`%${TEST_TAG.toLowerCase()}%`}`
    );
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  }
});

test('Public QR registration & attendance lookup endpoints work without auth while protected portals require auth', async () => {
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

  // 1. Public college metadata (no Authorization header)
  const pubRes = await fetch(`${baseUrl}/api/college/public-info`);
  assert.equal(pubRes.status, 200);
  const pubData = (await pubRes.json()) as {
    departments: Array<{ id: string }>;
    academicYears: Array<{ id: string }>;
    semesters: Array<{ id: string }>;
  };
  assert.ok(pubData.departments.length === 7);
  assert.ok(pubData.academicYears.length === 4);
  assert.ok(pubData.semesters.length === 8);

  // 2. Unauthenticated registration QR token validation
  const qrRes = await fetch(`${baseUrl}/api/qr/SBIST-REGISTER-CAMPUS`);
  assert.equal(qrRes.status, 200);
  const qrData = (await qrRes.json()) as { qr: { label: string; expiresAt: string | null } };
  assert.equal(qrData.qr.expiresAt, null);

  // 3. Unauthenticated attendance QR token validation
  const attendQrRes = await fetch(`${baseUrl}/api/qr/attendance/SBIST-ATTEND-CAMPUS`);
  assert.equal(attendQrRes.status, 200);

  // 4. Unauthenticated student QR registration submission
  const regRes = await fetch(`${baseUrl}/api/qr/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qrToken: 'SBIST-REGISTER-CAMPUS',
      fullName: 'Public QR Test Student',
      rollNumber: `${TEST_TAG}01`,
      departmentId: pubData.departments[0].id,
      academicYearId: pubData.academicYears[0].id,
      semesterId: pubData.semesters[0].id,
      email: `${TEST_TAG.toLowerCase()}@gmail.com`,
      phone: '9876543210',
    }),
  });
  assert.equal(regRes.status, 201);
  const regBody = (await regRes.json()) as { status: string; rollNumber: string };
  assert.equal(regBody.status, 'pending');
  assert.equal(regBody.rollNumber, `${TEST_TAG}01`);

  // 5. Protected endpoints still enforce auth (401 without Bearer token, never leaked)
  const adminRes = await fetch(`${baseUrl}/api/admin/dashboard`);
  assert.equal(adminRes.status, 401);
  const staffRes = await fetch(`${baseUrl}/api/staff/dashboard`);
  assert.equal(staffRes.status, 401);
  const studentRes = await fetch(`${baseUrl}/api/student/dashboard`);
  assert.equal(studentRes.status, 401);

  // 6. Public website chatbot validates empty/malformed inputs cleanly
  const badChatRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(badChatRes.status, 400);

  const badHistoryRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Hello',
      history: [{ role: 'admin', text: 'fake role' }],
    }),
  });
  assert.equal(badHistoryRes.status, 400);
});
