import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// 1. Roles
export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(), // 'super_admin' | 'staff' | 'student'
  description: text('description').notNull(),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Profiles (Users across Super Admin, Staff, Student)
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firebaseUid: text('firebase_uid').unique(),
    roleId: uuid('role_id')
      .references(() => roles.id, { onDelete: 'restrict' })
      .notNull(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone'),
    rollNumber: text('roll_number').unique(),
    employeeId: text('employee_id').unique(),
    passwordHash: text('password_hash'),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected' | 'deactivated'
    emailVerified: boolean('email_verified').notNull().default(false),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('profiles_role_status_idx').on(t.roleId, t.status),
    index('profiles_email_idx').on(t.email),
    index('profiles_roll_number_idx').on(t.rollNumber),
  ]
);

// 3. Departments (7 official SBIST departments)
export const departments = pgTable('departments', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'CSM C', 'CSMB C', 'CSM A', 'CSE C', 'CSE B', 'CSE A', 'CSD'
  name: text('name').notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 4. Academic Years (1..4)
export const academicYears = pgTable('academic_years', {
  id: uuid('id').defaultRandom().primaryKey(),
  yearNumber: integer('year_number').notNull().unique(),
  label: text('label').notNull(),
  academicSession: text('academic_session').notNull().default('2026-2027'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 5. Semesters (1..8)
export const semesters = pgTable('semesters', {
  id: uuid('id').defaultRandom().primaryKey(),
  semesterNumber: integer('semester_number').notNull().unique(),
  label: text('label').notNull(),
  academicYearId: uuid('academic_year_id')
    .references(() => academicYears.id, { onDelete: 'cascade' })
    .notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 6. Classes & Sections
export const classes = pgTable(
  'classes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'cascade' })
      .notNull(),
    academicYearId: uuid('academic_year_id')
      .references(() => academicYears.id, { onDelete: 'cascade' })
      .notNull(),
    semesterId: uuid('semester_id')
      .references(() => semesters.id, { onDelete: 'cascade' })
      .notNull(),
    sectionName: text('section_name').notNull(),
    displayName: text('display_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('classes_dept_year_sem_sec_uidx').on(
      t.departmentId,
      t.academicYearId,
      t.semesterId,
      t.sectionName
    ),
    index('classes_dept_idx').on(t.departmentId),
  ]
);

// 7. Subjects
export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'cascade' })
      .notNull(),
    semesterId: uuid('semester_id')
      .references(() => semesters.id, { onDelete: 'cascade' })
      .notNull(),
    credits: integer('credits').notNull().default(3),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('subjects_code_dept_sem_uidx').on(t.code, t.departmentId, t.semesterId),
    index('subjects_dept_sem_idx').on(t.departmentId, t.semesterId),
  ]
);

// 8. Student Enrollments
export const studentEnrollments = pgTable(
  'student_enrollments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    rollNumber: text('roll_number').notNull().unique(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'restrict' })
      .notNull(),
    academicYearId: uuid('academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    semesterId: uuid('semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    classId: uuid('class_id')
      .references(() => classes.id, { onDelete: 'restrict' })
      .notNull(),
    isActive: boolean('is_active').notNull().default(true),
    regulation: text('regulation').notNull().default('R22'), // 'R22' | 'R20' | 'R18'
    academicStanding: text('academic_standing').notNull().default('active'), // 'active' | 'detained' | 'graduated'
    creditsEarned: integer('credits_earned').notNull().default(0),
    totalCreditsAttempted: integer('total_credits_attempted').notNull().default(0),
    activeBacklogs: integer('active_backlogs').notNull().default(0),
    latestResultStatus: text('latest_result_status').notNull().default('pending'), // 'passed' | 'promoted_with_backlogs' | 'failed' | 'detained' | 'pending'
    detentionReason: text('detention_reason'),
    lastPromotedAt: timestamp('last_promoted_at', { withTimezone: true }),
    lastPromotionBatchId: uuid('last_promotion_batch_id'),
    approvedBy: uuid('approved_by').references(() => profiles.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    joinedDateIST: text('joined_date_ist'), // YYYY-MM-DD in IST
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('enrollments_dept_class_idx').on(t.departmentId, t.classId),
    index('enrollments_year_sem_idx').on(t.academicYearId, t.semesterId),
    index('enrollments_sem_standing_idx').on(t.semesterId, t.academicStanding),
  ]
);

// 9. Staff Assignments
export const staffAssignments = pgTable(
  'staff_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    staffId: uuid('staff_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'cascade' })
      .notNull(),
    classId: uuid('class_id').references(() => classes.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    canCreateSessions: boolean('can_create_sessions').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('staff_assignments_unique_idx').on(
      t.staffId,
      t.departmentId,
      t.classId,
      t.subjectId
    ),
    index('staff_assignments_staff_idx').on(t.staffId),
    index('staff_assignments_dept_idx').on(t.departmentId),
  ]
);

// 10. Registration & Attendance Check-In QR Codes
export const registrationQrCodes = pgTable(
  'registration_qr_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    token: text('token').notNull().unique(),
    qrPurpose: text('qr_purpose').notNull().default('registration'), // 'registration' | 'attendance'
    label: text('label').notNull(),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    academicYearId: uuid('academic_year_id').references(() => academicYears.id, { onDelete: 'set null' }),
    semesterId: uuid('semester_id').references(() => semesters.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => attendanceSessions.id, { onDelete: 'set null' }),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isRevoked: boolean('is_revoked').notNull().default(false),
    createdBy: uuid('created_by')
      .references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('qr_codes_token_idx').on(t.token)]
);

// 11. Attendance Sessions
export const attendanceSessions = pgTable(
  'attendance_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionCode: text('session_code').notNull().unique(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'restrict' })
      .notNull(),
    classId: uuid('class_id')
      .references(() => classes.id, { onDelete: 'restrict' })
      .notNull(),
    academicYearId: uuid('academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    semesterId: uuid('semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    subjectId: uuid('subject_id')
      .references(() => subjects.id, { onDelete: 'restrict' }),
    sessionDate: text('session_date').notNull(), // YYYY-MM-DD in IST
    startTime: text('start_time').notNull(), // HH:mm in IST
    endTime: text('end_time').notNull(), // HH:mm in IST
    periodSlot: text('period_slot').notNull().default('daily'), // 'morning' | 'afternoon' | 'daily'
    sessionType: text('session_type').notNull().default('manual'), // 'auto_morning' | 'auto_afternoon' | 'manual'
    isAutoScheduled: boolean('is_auto_scheduled').notNull().default(false),
    autoScheduleKey: text('auto_schedule_key').unique(), // '<classId>:<YYYY-MM-DD>:<morning|afternoon>' for duplicate prevention
    status: text('status').notNull().default('scheduled'), // 'scheduled' | 'active' | 'closed' | 'cancelled'
    cancelledReason: text('cancelled_reason'),
    createdBy: uuid('created_by')
      .references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('sessions_status_date_idx').on(t.status, t.sessionDate),
    index('sessions_dept_class_status_idx').on(t.departmentId, t.classId, t.status),
    index('sessions_subject_date_idx').on(t.subjectId, t.sessionDate),
    index('sessions_auto_date_slot_idx').on(t.sessionDate, t.periodSlot, t.isAutoScheduled),
  ]
);

// 12. Attendance Records (Database unique constraint on (student_id, session_id))
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'restrict' })
      .notNull(),
    sessionId: uuid('session_id')
      .references(() => attendanceSessions.id, { onDelete: 'restrict' })
      .notNull(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'restrict' })
      .notNull(),
    classId: uuid('class_id')
      .references(() => classes.id, { onDelete: 'restrict' })
      .notNull(),
    subjectId: uuid('subject_id')
      .references(() => subjects.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id').references(() => academicYears.id, { onDelete: 'restrict' }),
    semesterId: uuid('semester_id').references(() => semesters.id, { onDelete: 'restrict' }),
    attendanceDate: text('attendance_date').notNull(), // YYYY-MM-DD in IST
    markedAt: timestamp('marked_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull(), // 'present' | 'absent' | 'excused'
    verificationMethod: text('verification_method').notNull(), // 'face_geofence' | 'face_staff_override' | 'staff_assisted' | 'admin_correction'
    verificationResult: text('verification_result').notNull(), // 'verified' | 'rejected' | 'assisted' | 'corrected'
    faceConfidence: real('face_confidence'),
    livenessPassed: boolean('liveness_passed').notNull().default(false),
    latitude: real('latitude'),
    longitude: real('longitude'),
    geofenceDistanceM: real('geofence_distance_m'),
    correctionReason: text('correction_reason'),
    correctedBy: uuid('corrected_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('attendance_records_student_session_uidx').on(t.studentId, t.sessionId),
    index('attendance_date_dept_idx').on(t.attendanceDate, t.departmentId),
    index('attendance_student_date_idx').on(t.studentId, t.attendanceDate),
    index('attendance_session_status_idx').on(t.sessionId, t.status),
    index('attendance_subject_date_idx').on(t.subjectId, t.attendanceDate),
    index('attendance_student_sem_idx').on(t.studentId, t.semesterId),
  ]
);

// 13. Biometric Templates (AES-256-GCM encrypted on server, never returned to frontend)
export const biometricTemplates = pgTable(
  'biometric_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    encryptedDescriptor: text('encrypted_descriptor').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    algorithm: text('algorithm').notNull().default('face-api-128d-aes256gcm'),
    sampleCount: integer('sample_count').notNull().default(3),
    consentGiven: boolean('consent_given').notNull().default(false),
    consentTimestamp: timestamp('consent_timestamp', { withTimezone: true }).notNull(),
    retentionPolicyVersion: text('retention_policy_version').notNull().default('SBIST-BIO-2026-v1'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('biometric_student_idx').on(t.studentId)]
);

// 14. Attendance Correction Requests (Staff correction requests, location/liveness fallback)
export const attendanceCorrectionRequests = pgTable(
  'attendance_correction_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull(),
    sessionId: uuid('session_id')
      .references(() => attendanceSessions.id, { onDelete: 'cascade' })
      .notNull(),
    requestedBy: uuid('requested_by')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull(),
    requestedStatus: text('requested_status').notNull().default('present'),
    requestType: text('request_type').notNull().default('correction'), // 'correction' | 'location_bypass' | 'liveness_assisted'
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    reviewedBy: uuid('reviewed_by').references(() => profiles.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('corrections_status_idx').on(t.status),
    index('corrections_student_session_idx').on(t.studentId, t.sessionId),
  ]
);

// 15. Audit Logs
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => profiles.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_logs_created_at_idx').on(t.createdAt),
    index('audit_logs_actor_idx').on(t.actorId),
    index('audit_logs_action_idx').on(t.action),
  ]
);

// 16. College Settings
export const collegeSettings = pgTable('college_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  collegeName: text('college_name')
    .notNull()
    .default('Swarna Bharathi Institute of Science and Technology'),
  logoUrl: text('logo_url').default('/src/assets/images/sbist_college_crest_1795533458624.jpg'),
  locationVerificationEnabled: boolean('location_verification_enabled').notNull().default(true),
  collegeLatitude: real('college_latitude').notNull().default(17.2473),
  collegeLongitude: real('college_longitude').notNull().default(80.1514),
  geofenceRadiusMeters: integer('geofence_radius_meters').notNull().default(300),
  attendanceFrequency: text('attendance_frequency').notNull().default('every_class_period'), // 'once_per_day' | 'morning_afternoon' | 'every_class_period'
  qrDefaultExpiryHours: integer('qr_default_expiry_hours').notNull().default(24),
  faceMatchThreshold: real('face_match_threshold').notNull().default(0.5),
  livenessRequired: boolean('liveness_required').notNull().default(true),
  autoDailySessionsEnabled: boolean('auto_daily_sessions_enabled').notNull().default(true),
  morningStartTime: text('morning_start_time').notNull().default('09:00'),
  morningEndTime: text('morning_end_time').notNull().default('09:40'),
  afternoonStartTime: text('afternoon_start_time').notNull().default('13:30'),
  afternoonEndTime: text('afternoon_end_time').notNull().default('13:40'),
  workingWeekdays: jsonb('working_weekdays').$type<number[]>().notNull().default([1, 2, 3, 4, 5, 6]),
  updatedBy: uuid('updated_by').references(() => profiles.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 17. Holidays (Date ranges blocking attendance sessions)
export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    startDate: text('start_date').notNull(), // YYYY-MM-DD in IST
    endDate: text('end_date').notNull(), // YYYY-MM-DD in IST
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('holidays_date_range_idx').on(t.startDate, t.endDate)]
);

// 17b. Calendar Overrides (Special working days on weekends or special single-day closures)
export const calendarOverrides = pgTable(
  'calendar_overrides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    overrideDate: text('override_date').notNull().unique(), // YYYY-MM-DD in IST
    overrideType: text('override_type').notNull(), // 'working_day' | 'closed_day'
    title: text('title').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('calendar_overrides_date_idx').on(t.overrideDate)]
);

// 18. JNTUH Regulation Rules
export const jntuhRegulationRules = pgTable('jntuh_regulation_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'R22' | 'R20' | 'R18'
  name: text('name').notNull(),
  minAttendancePercent: real('min_attendance_percent').notNull().default(65),
  sem2To3MinCredits: integer('sem2_to_3_min_credits').notNull().default(20),
  sem4To5MinCredits: integer('sem4_to_5_min_credits').notNull().default(40),
  sem6To7MinCredits: integer('sem6_to_7_min_credits').notNull().default(60),
  maxBacklogsForPromotion: integer('max_backlogs_for_promotion'),
  requireResultPublished: boolean('require_result_published').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 19. Promotion Batches (Bulk JNTUH progression tracking & safe rollback)
export const promotionBatches = pgTable(
  'promotion_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchCode: text('batch_code').notNull().unique(),
    fromAcademicYearId: uuid('from_academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    fromSemesterId: uuid('from_semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    toAcademicYearId: uuid('to_academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    toSemesterId: uuid('to_semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    regulation: text('regulation').notNull().default('R22'),
    totalReviewed: integer('total_reviewed').notNull().default(0),
    promotedCount: integer('promoted_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    detainedCount: integer('detained_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    pendingCount: integer('pending_count').notNull().default(0),
    staffAssignmentsUpdated: integer('staff_assignments_updated').notNull().default(0),
    status: text('status').notNull().default('completed'), // 'completed' | 'rolled_back'
    promotedBy: uuid('promoted_by').references(() => profiles.id, { onDelete: 'set null' }),
    promotedByEmail: text('promoted_by_email'),
    confirmationNote: text('confirmation_note'),
    rolledBackBy: uuid('rolled_back_by').references(() => profiles.id, { onDelete: 'set null' }),
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    rollbackReason: text('rollback_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('promotion_batches_status_idx').on(t.status, t.createdAt),
    index('promotion_batches_from_sem_idx').on(t.fromSemesterId, t.departmentId),
  ]
);

// 20. Promotion Batch Items (Per-student transition snapshot for audit and rollback)
export const promotionBatchItems = pgTable(
  'promotion_batch_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .references(() => promotionBatches.id, { onDelete: 'cascade' })
      .notNull(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'restrict' })
      .notNull(),
    fromAcademicYearId: uuid('from_academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    fromSemesterId: uuid('from_semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    fromClassId: uuid('from_class_id')
      .references(() => classes.id, { onDelete: 'restrict' })
      .notNull(),
    toAcademicYearId: uuid('to_academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    toSemesterId: uuid('to_semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    toClassId: uuid('to_class_id').references(() => classes.id, { onDelete: 'restrict' }),
    previousStanding: text('previous_standing').notNull(),
    previousCreditsEarned: integer('previous_credits_earned').notNull().default(0),
    previousActiveBacklogs: integer('previous_active_backlogs').notNull().default(0),
    previousResultStatus: text('previous_result_status').notNull().default('pending'),
    outcome: text('outcome').notNull(), // 'promoted' | 'detained' | 'failed' | 'pending' | 'skipped' | 'rolled_back'
    reason: text('reason'),
    attendancePercentage: real('attendance_percentage'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('promotion_batch_items_batch_student_uidx').on(t.batchId, t.studentId),
    index('promotion_batch_items_student_idx').on(t.studentId),
  ]
);

// 21. Student Academic History (Immutable semester-by-semester progression archive)
export const studentAcademicHistory = pgTable(
  'student_academic_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .references(() => profiles.id, { onDelete: 'cascade' })
      .notNull(),
    rollNumber: text('roll_number').notNull(),
    departmentId: uuid('department_id')
      .references(() => departments.id, { onDelete: 'restrict' })
      .notNull(),
    academicYearId: uuid('academic_year_id')
      .references(() => academicYears.id, { onDelete: 'restrict' })
      .notNull(),
    semesterId: uuid('semester_id')
      .references(() => semesters.id, { onDelete: 'restrict' })
      .notNull(),
    classId: uuid('class_id')
      .references(() => classes.id, { onDelete: 'restrict' })
      .notNull(),
    regulation: text('regulation').notNull().default('R22'),
    creditsEarned: integer('credits_earned').notNull().default(0),
    activeBacklogs: integer('active_backlogs').notNull().default(0),
    resultStatus: text('result_status').notNull().default('pending'),
    attendancePercentage: real('attendance_percentage'),
    status: text('status').notNull().default('promoted'), // 'promoted' | 'detained' | 'rolled_back'
    promotionBatchId: uuid('promotion_batch_id').references(() => promotionBatches.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('student_academic_history_student_sem_idx').on(t.studentId, t.semesterId),
    index('student_academic_history_batch_idx').on(t.promotionBatchId),
  ]
);

// Drizzle Relations
export const profilesRelations = relations(profiles, ({ one, many }) => ({
  role: one(roles, { fields: [profiles.roleId], references: [roles.id] }),
  enrollment: one(studentEnrollments, { fields: [profiles.id], references: [studentEnrollments.studentId] }),
  biometricTemplate: one(biometricTemplates, { fields: [profiles.id], references: [biometricTemplates.studentId] }),
  staffAssignments: many(staffAssignments),
  attendanceRecords: many(attendanceRecords),
}));

export const studentEnrollmentsRelations = relations(studentEnrollments, ({ one }) => ({
  student: one(profiles, { fields: [studentEnrollments.studentId], references: [profiles.id] }),
  department: one(departments, { fields: [studentEnrollments.departmentId], references: [departments.id] }),
  academicYear: one(academicYears, { fields: [studentEnrollments.academicYearId], references: [academicYears.id] }),
  semester: one(semesters, { fields: [studentEnrollments.semesterId], references: [semesters.id] }),
  classGroup: one(classes, { fields: [studentEnrollments.classId], references: [classes.id] }),
}));
