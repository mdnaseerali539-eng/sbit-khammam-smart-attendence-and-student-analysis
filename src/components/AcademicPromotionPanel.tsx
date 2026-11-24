import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Edit3,
  Eye,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AcademicYear, Department, Semester } from '../types';

interface AcademicPromotionPanelProps {
  departments: Department[];
  academicYears: AcademicYear[];
  semesters: Semester[];
  onPromoted?: () => void;
}

type JntuhResultStatus =
  | 'passed'
  | 'promoted_with_backlogs'
  | 'failed'
  | 'detained'
  | 'pending';

type AcademicStanding = 'active' | 'detained' | 'graduated';
type EligibilityBucket = 'eligible' | 'detained' | 'failed' | 'pending';

interface JntuhRuleConfig {
  id: string;
  code: string;
  name: string;
  minAttendancePercent: number;
  sem2To3MinCredits: number;
  sem4To5MinCredits: number;
  sem6To7MinCredits: number;
  maxBacklogsForPromotion: number | null;
  requireResultPublished: boolean;
}

interface StudentPreviewItem {
  enrollmentId: string;
  studentId: string;
  rollNumber: string;
  fullName: string;
  email: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  classId: string;
  className: string;
  sectionName: string;
  regulation: string;
  academicStanding: AcademicStanding;
  creditsEarned: number;
  totalCreditsAttempted: number;
  activeBacklogs: number;
  latestResultStatus: JntuhResultStatus;
  detentionReason: string | null;
  conductedSessionsCount: number;
  presentSessionsCount: number;
  attendancePercentage: number | null;
  bucket: EligibilityBucket;
  eligibilityReason: string;
}

interface ProgressionPreviewResponse {
  fromSemester: {
    id: string;
    semesterNumber: number;
    label: string;
    academicYearId: string;
    yearNumber: number;
    yearLabel: string;
    academicSession: string;
  };
  toSemester: {
    id: string;
    semesterNumber: number;
    label: string;
    academicYearId: string;
    yearNumber: number;
    yearLabel: string;
    academicSession: string;
  } | null;
  rule: JntuhRuleConfig;
  allRules: JntuhRuleConfig[];
  counts: {
    total: number;
    eligible: number;
    detained: number;
    failed: number;
    pending: number;
  };
  departmentSummaries: Array<{
    departmentId: string;
    departmentCode: string;
    departmentName: string;
    total: number;
    eligible: number;
    detained: number;
    failed: number;
    pending: number;
    targetClassReady: boolean;
    targetSubjectsCount: number;
  }>;
  students: StudentPreviewItem[];
}

interface PromotionBatchSummary {
  id: string;
  batchCode: string;
  fromSemesterLabel: string;
  fromYearLabel: string;
  toSemesterLabel: string;
  toYearLabel: string;
  departmentCode: string;
  regulation: string;
  totalReviewed: number;
  promotedCount: number;
  skippedCount: number;
  detainedCount: number;
  failedCount: number;
  pendingCount: number;
  staffAssignmentsUpdated: number;
  status: string;
  promotedByEmail: string;
  confirmationNote: string | null;
  rollbackReason: string | null;
  createdAtIST: string;
  rolledBackAtIST: string | null;
}

interface PromotionAuditItem {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAtIST: string;
  details: Record<string, unknown> | null;
}

interface BatchDetailItem {
  id: string;
  studentId: string;
  fullName: string;
  rollNumber: string | null;
  departmentCode: string;
  outcome: string;
  reason: string;
  attendancePercentage: number | null;
  previousCreditsEarned: number;
  previousActiveBacklogs: number;
  previousResultStatus: string;
}

export const AcademicPromotionPanel: React.FC<AcademicPromotionPanelProps> = ({
  departments,
  academicYears,
  semesters,
  onPromoted,
}) => {
  const sortedYears = useMemo(
    () => [...academicYears].sort((a, b) => a.yearNumber - b.yearNumber),
    [academicYears]
  );
  const sortedSemesters = useMemo(
    () => [...semesters].sort((a, b) => a.semesterNumber - b.semesterNumber),
    [semesters]
  );

  const [selectedYearId, setSelectedYearId] = useState<string>('');
  const [selectedSemesterId, setSelectedSemesterId] = useState<string>('');
  const [selectedDeptId, setSelectedDeptId] = useState<string>('');
  const [regulation, setRegulation] = useState<'R22' | 'R20' | 'R18'>('R22');

  const [preview, setPreview] = useState<ProgressionPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [batches, setBatches] = useState<PromotionBatchSummary[]>([]);
  const [promoAudits, setPromoAudits] = useState<PromotionAuditItem[]>([]);

  const [bucketTab, setBucketTab] = useState<'all' | EligibilityBucket>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());

  const [showRuleEditor, setShowRuleEditor] = useState(false);
  const [ruleForm, setRuleForm] = useState<JntuhRuleConfig | null>(null);
  const [savingRule, setSavingRule] = useState(false);

  // Student eligibility edit modal (single or bulk)
  const [editingTargetIds, setEditingTargetIds] = useState<string[] | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [eligForm, setEligForm] = useState<{
    regulation: 'R22' | 'R20' | 'R18';
    academicStanding: AcademicStanding;
    latestResultStatus: JntuhResultStatus;
    creditsEarned: number;
    activeBacklogs: number;
    detentionReason: string;
  }>({
    regulation: 'R22',
    academicStanding: 'active',
    latestResultStatus: 'passed',
    creditsEarned: 24,
    activeBacklogs: 0,
    detentionReason: '',
  });
  const [savingElig, setSavingElig] = useState(false);

  // Promotion execution confirmation
  const [updateStaffAssignments, setUpdateStaffAssignments] = useState(true);
  const [confirmationNote, setConfirmationNote] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [promoting, setPromoting] = useState(false);

  // Batch inspection & rollback
  const [inspectingBatch, setInspectingBatch] = useState<{
    batch: PromotionBatchSummary;
    items: BatchDetailItem[];
  } | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<PromotionBatchSummary | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollingBack, setRollingBack] = useState(false);

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastPromotionSummary, setLastPromotionSummary] = useState<{
    batchCode: string;
    promotedCount: number;
    detainedCount: number;
    failedCount: number;
    pendingCount: number;
    skippedCount: number;
    staffAssignmentsUpdated: number;
  } | null>(null);

  // Initialize default year & semester when props arrive
  useEffect(() => {
    if (!selectedYearId && sortedYears.length > 0) {
      setSelectedYearId(sortedYears[0].id);
    }
  }, [sortedYears, selectedYearId]);

  const yearSemesters = useMemo(() => {
    if (!selectedYearId) return sortedSemesters;
    return sortedSemesters.filter((s) => s.academicYearId === selectedYearId);
  }, [sortedSemesters, selectedYearId]);

  useEffect(() => {
    if (yearSemesters.length > 0 && !yearSemesters.some((s) => s.id === selectedSemesterId)) {
      setSelectedSemesterId(yearSemesters[0].id);
    }
  }, [yearSemesters, selectedSemesterId]);

  const loadPreview = useCallback(async () => {
    if (!selectedSemesterId) return;
    setLoadingPreview(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({
        fromSemesterId: selectedSemesterId,
        regulation,
        ...(selectedDeptId ? { departmentId: selectedDeptId } : {}),
      });
      const res = await apiFetch<ProgressionPreviewResponse>(
        `/api/admin/progression/preview?${qs.toString()}`
      );
      setPreview(res);
      setRuleForm(res.rule);
      setSelectedStudentIds(
        new Set(res.students.filter((s) => s.bucket === 'eligible').map((s) => s.studentId))
      );
      setConfirmChecked(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to preview academic progression.');
    } finally {
      setLoadingPreview(false);
    }
  }, [selectedSemesterId, selectedDeptId, regulation]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch<{
        batches: PromotionBatchSummary[];
        auditLogs: PromotionAuditItem[];
      }>('/api/admin/progression/batches');
      setBatches(res.batches);
      setPromoAudits(res.auditLogs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load promotion history.');
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const filteredStudents = useMemo(() => {
    if (!preview) return [];
    const q = searchQuery.trim().toLowerCase();
    return preview.students.filter((s) => {
      if (bucketTab !== 'all' && s.bucket !== bucketTab) return false;
      if (!q) return true;
      return (
        s.rollNumber.toLowerCase().includes(q) ||
        s.fullName.toLowerCase().includes(q) ||
        s.departmentCode.toLowerCase().includes(q)
      );
    });
  }, [preview, bucketTab, searchQuery]);

  const eligibleSelectedCount = useMemo(() => {
    if (!preview) return 0;
    return preview.students.filter(
      (s) => s.bucket === 'eligible' && selectedStudentIds.has(s.studentId)
    ).length;
  }, [preview, selectedStudentIds]);

  function openSingleEdit(stu: StudentPreviewItem) {
    setEditingTargetIds([stu.studentId]);
    setEditingLabel(`${stu.rollNumber} · ${stu.fullName}`);
    setEligForm({
      regulation: (['R22', 'R20', 'R18'].includes(stu.regulation) ? stu.regulation : 'R22') as
        | 'R22'
        | 'R20'
        | 'R18',
      academicStanding: stu.academicStanding,
      latestResultStatus: stu.latestResultStatus,
      creditsEarned: stu.creditsEarned,
      activeBacklogs: stu.activeBacklogs,
      detentionReason: stu.detentionReason || '',
    });
  }

  function openBulkEditForFiltered() {
    const ids = filteredStudents.map((s) => s.studentId);
    if (ids.length === 0) return;
    setEditingTargetIds(ids.slice(0, 500));
    setEditingLabel(
      `${Math.min(ids.length, 500)} filtered student(s)${ids.length > 500 ? ' (first 500)' : ''}`
    );
    setEligForm({
      regulation,
      academicStanding: 'active',
      latestResultStatus: 'passed',
      creditsEarned: Math.max(
        preview?.rule.sem2To3MinCredits ?? 20,
        (preview?.fromSemester.semesterNumber ?? 1) * 18
      ),
      activeBacklogs: 0,
      detentionReason: '',
    });
  }

  async function handleSaveEligibility(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTargetIds || editingTargetIds.length === 0) return;
    setSavingElig(true);
    setErr(null);
    setMsg(null);
    try {
      const updates = editingTargetIds.map((studentId) => ({
        studentId,
        regulation: eligForm.regulation,
        academicStanding: eligForm.academicStanding,
        latestResultStatus: eligForm.latestResultStatus,
        creditsEarned: Number(eligForm.creditsEarned),
        activeBacklogs: Number(eligForm.activeBacklogs),
        detentionReason: eligForm.detentionReason.trim() || null,
      }));
      const res = await apiFetch<{ message: string }>(
        '/api/admin/progression/student-eligibility',
        {
          method: 'POST',
          body: JSON.stringify({ updates }),
        }
      );
      setMsg(res.message);
      setEditingTargetIds(null);
      await Promise.all([loadPreview(), loadHistory()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update student eligibility.');
    } finally {
      setSavingElig(false);
    }
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleForm) return;
    setSavingRule(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/admin/progression/rules', {
        method: 'POST',
        body: JSON.stringify({
          code: ruleForm.code as 'R22' | 'R20' | 'R18',
          minAttendancePercent: Number(ruleForm.minAttendancePercent),
          sem2To3MinCredits: Number(ruleForm.sem2To3MinCredits),
          sem4To5MinCredits: Number(ruleForm.sem4To5MinCredits),
          sem6To7MinCredits: Number(ruleForm.sem6To7MinCredits),
          maxBacklogsForPromotion:
            ruleForm.maxBacklogsForPromotion === null || ruleForm.maxBacklogsForPromotion === undefined
              ? null
              : Number(ruleForm.maxBacklogsForPromotion),
          requireResultPublished: Boolean(ruleForm.requireResultPublished),
        }),
      });
      setMsg(res.message);
      setShowRuleEditor(false);
      await Promise.all([loadPreview(), loadHistory()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update regulation rules.');
    } finally {
      setSavingRule(false);
    }
  }

  async function handleExecutePromotion(e: React.FormEvent) {
    e.preventDefault();
    if (!preview?.toSemester) {
      setErr('Final semester (Semester 8) cannot be promoted further.');
      return;
    }
    if (!confirmChecked) {
      setErr('Please check the explicit promotion confirmation checkbox first.');
      return;
    }
    if (eligibleSelectedCount === 0) {
      setErr('Select at least one eligible student to promote.');
      return;
    }

    setPromoting(true);
    setErr(null);
    setMsg(null);
    setLastPromotionSummary(null);
    try {
      const selectedIds = preview.students
        .filter((s) => s.bucket === 'eligible' && selectedStudentIds.has(s.studentId))
        .map((s) => s.studentId);

      const res = await apiFetch<{
        message: string;
        batch: {
          batchCode: string;
          promotedCount: number;
          detainedCount: number;
          failedCount: number;
          pendingCount: number;
          skippedCount: number;
          staffAssignmentsUpdated: number;
        };
      }>('/api/admin/progression/promote', {
        method: 'POST',
        body: JSON.stringify({
          fromSemesterId: selectedSemesterId,
          departmentId: selectedDeptId || null,
          regulation,
          selectedStudentIds: selectedIds,
          updateStaffAssignments,
          confirmationNote: confirmationNote.trim() || null,
          confirmPromotion: true,
        }),
      });

      setMsg(res.message);
      setLastPromotionSummary(res.batch);
      setConfirmationNote('');
      setConfirmChecked(false);
      await Promise.all([loadPreview(), loadHistory()]);
      onPromoted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Bulk promotion failed.');
    } finally {
      setPromoting(false);
    }
  }

  async function handleInspectBatch(batch: PromotionBatchSummary) {
    setErr(null);
    try {
      const res = await apiFetch<{ items: BatchDetailItem[] }>(
        `/api/admin/progression/batches/${batch.id}`
      );
      setInspectingBatch({ batch, items: res.items });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load promotion batch details.');
    }
  }

  async function handleConfirmRollback(e: React.FormEvent) {
    e.preventDefault();
    if (!rollbackTarget) return;
    if (rollbackReason.trim().length < 3) {
      setErr('Please provide a clear rollback reason (min 3 characters).');
      return;
    }
    setRollingBack(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/admin/progression/batches/${rollbackTarget.id}/rollback`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: rollbackReason.trim() }),
        }
      );
      setMsg(res.message);
      setRollbackTarget(null);
      setRollbackReason('');
      await Promise.all([loadPreview(), loadHistory()]);
      onPromoted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to roll back promotion batch.');
    } finally {
      setRollingBack(false);
    }
  }

  const toggleAllEligibleFiltered = (checked: boolean) => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      for (const s of filteredStudents) {
        if (s.bucket !== 'eligible') continue;
        if (checked) next.add(s.studentId);
        else next.delete(s.studentId);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-blue-700" />
            JNTUH Academic Year & Semester Progression
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Evaluate JNTUH regulation eligibility (attendance, credits, backlogs, results) across all 7 departments.
            Historical attendance records are strictly immutable and preserved per semester.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowRuleEditor((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {showRuleEditor ? 'Hide Regulation Rules' : `Configure ${regulation} Rules`}
        </button>
      </div>

      {msg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 flex items-center justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}
      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => setErr(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}

      {lastPromotionSummary && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-blue-950 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              Promotion Batch Executed: <span className="font-mono-tabular">{lastPromotionSummary.batchCode}</span>
            </div>
            <button
              type="button"
              onClick={() => setLastPromotionSummary(null)}
              className="text-blue-800 underline"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Promoted</div>
              <div className="font-bold text-emerald-700 text-sm tabular-nums">
                {lastPromotionSummary.promotedCount}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Detained</div>
              <div className="font-bold text-amber-700 text-sm tabular-nums">
                {lastPromotionSummary.detainedCount}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Failed</div>
              <div className="font-bold text-red-700 text-sm tabular-nums">
                {lastPromotionSummary.failedCount}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Pending</div>
              <div className="font-bold text-slate-700 text-sm tabular-nums">
                {lastPromotionSummary.pendingCount}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Excluded/Skipped</div>
              <div className="font-bold text-slate-700 text-sm tabular-nums">
                {lastPromotionSummary.skippedCount}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-2">
              <div className="text-[11px] text-slate-500">Staff Synced</div>
              <div className="font-bold text-blue-700 text-sm tabular-nums">
                {lastPromotionSummary.staffAssignmentsUpdated}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* JNTUH Regulation Rule Editor */}
      {showRuleEditor && ruleForm && (
        <form
          onSubmit={handleSaveRule}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                JNTUH {ruleForm.code} Promotion Thresholds
              </h2>
              <p className="text-slate-500">
                Enforced server-side before any student is marked eligible for promotion.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="block font-medium text-slate-600 mb-1">Min Attendance (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={ruleForm.minAttendancePercent}
                onChange={(e) =>
                  setRuleForm({ ...ruleForm, minAttendancePercent: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600 mb-1">Sem 2 → 3 Min Credits</label>
              <input
                type="number"
                min={0}
                max={100}
                value={ruleForm.sem2To3MinCredits}
                onChange={(e) =>
                  setRuleForm({ ...ruleForm, sem2To3MinCredits: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600 mb-1">Sem 4 → 5 Min Credits</label>
              <input
                type="number"
                min={0}
                max={150}
                value={ruleForm.sem4To5MinCredits}
                onChange={(e) =>
                  setRuleForm({ ...ruleForm, sem4To5MinCredits: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600 mb-1">Sem 6 → 7 Min Credits</label>
              <input
                type="number"
                min={0}
                max={200}
                value={ruleForm.sem6To7MinCredits}
                onChange={(e) =>
                  setRuleForm({ ...ruleForm, sem6To7MinCredits: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600 mb-1">
                Max Backlogs (blank = unlimited)
              </label>
              <input
                type="number"
                min={0}
                max={50}
                value={ruleForm.maxBacklogsForPromotion ?? ''}
                onChange={(e) =>
                  setRuleForm({
                    ...ruleForm,
                    maxBacklogsForPromotion:
                      e.target.value === '' ? null : Number(e.target.value),
                  })
                }
                placeholder="Unlimited"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={ruleForm.requireResultPublished}
                onChange={(e) =>
                  setRuleForm({ ...ruleForm, requireResultPublished: e.target.checked })
                }
              />
              Block promotion while semester results are marked Pending
            </label>
            <button
              type="submit"
              disabled={savingRule}
              className="px-4 py-2 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {savingRule ? 'Saving...' : `Save ${ruleForm.code} Rules`}
            </button>
          </div>
        </form>
      )}

      {/* Scope Selectors & Transition Preview */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 mb-1">Current Academic Year</label>
            <select
              value={selectedYearId}
              onChange={(e) => setSelectedYearId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
            >
              {sortedYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label} ({y.academicSession})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Current Semester</label>
            <select
              value={selectedSemesterId}
              onChange={(e) => setSelectedSemesterId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
            >
              {yearSemesters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Department Scope</label>
            <select
              value={selectedDeptId}
              onChange={(e) => setSelectedDeptId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
            >
              <option value="">All 7 Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">JNTUH Regulation</label>
            <select
              value={regulation}
              onChange={(e) => setRegulation(e.target.value as 'R22' | 'R20' | 'R18')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
            >
              <option value="R22">R22 (20 / 40 / 60 Credits · 65% Att.)</option>
              <option value="R20">R20 (20 / 48 / 72 Credits · 65% Att.)</option>
              <option value="R18">R18 (20 / 48 / 72 Credits · 65% Att.)</option>
            </select>
          </div>
        </div>

        {preview && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
                <div className="text-[11px] text-slate-500">From Current Stage</div>
                <div className="font-bold text-slate-900">
                  {preview.fromSemester.yearLabel} · {preview.fromSemester.label}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-blue-700 shrink-0" />
              {preview.toSemester ? (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <div className="text-[11px] text-blue-700">Target Next Stage</div>
                  <div className="font-bold text-blue-950">
                    {preview.toSemester.yearLabel} · {preview.toSemester.label}
                    {preview.toSemester.yearNumber > preview.fromSemester.yearNumber
                      ? ` (${preview.toSemester.yearLabel}, Sem 1)`
                      : ''}
                  </div>
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-900 font-semibold">
                  Final JNTUH Semester (Semester 8) — No further auto-promotion
                </div>
              )}
            </div>

            <div className="grid grid-cols-5 gap-2 text-center text-xs">
              <div className="bg-white border border-slate-200 rounded-lg px-3 py-1.5">
                <div className="text-[10px] text-slate-500">Reviewed</div>
                <div className="font-bold text-slate-900 tabular-nums">{preview.counts.total}</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                <div className="text-[10px] text-emerald-700">Eligible</div>
                <div className="font-bold text-emerald-800 tabular-nums">{preview.counts.eligible}</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                <div className="text-[10px] text-amber-700">Detained</div>
                <div className="font-bold text-amber-800 tabular-nums">{preview.counts.detained}</div>
              </div>
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                <div className="text-[10px] text-red-700">Failed</div>
                <div className="font-bold text-red-800 tabular-nums">{preview.counts.failed}</div>
              </div>
              <div className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-1.5">
                <div className="text-[10px] text-slate-600">Pending</div>
                <div className="font-bold text-slate-800 tabular-nums">{preview.counts.pending}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Seven-Department Breakdown */}
      {preview && preview.departmentSummaries.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-900">
              Department-Wise Eligibility & Target Semester Readiness
            </h2>
            <span className="text-[11px] text-slate-500">
              {preview.departmentSummaries.length} department(s) in scope
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Department</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Total</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Eligible</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Detained</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Failed</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Pending</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Next Sem Class & Subjects</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.departmentSummaries.map((d) => (
                  <tr key={d.departmentId}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      <span className="font-mono-tabular font-bold">{d.departmentCode}</span> · {d.departmentName}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.total}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700 font-semibold">
                      {d.eligible}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-amber-700 font-semibold">
                      {d.detained}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-red-700 font-semibold">
                      {d.failed}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{d.pending}</td>
                    <td className="px-4 py-2.5 text-right">
                      {preview.toSemester ? (
                        <span className="text-slate-600">
                          {d.targetClassReady ? 'Class Ready' : 'Auto-Create Class'} ·{' '}
                          <span className="font-semibold">{d.targetSubjectsCount}</span> subject(s)
                        </span>
                      ) : (
                        <span className="text-slate-400">Final Semester</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Student Eligibility Review & Editor */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs">
            {(
              [
                { id: 'all', label: `All (${preview?.counts.total ?? 0})` },
                { id: 'eligible', label: `Eligible (${preview?.counts.eligible ?? 0})` },
                { id: 'detained', label: `Detained (${preview?.counts.detained ?? 0})` },
                { id: 'failed', label: `Failed (${preview?.counts.failed ?? 0})` },
                { id: 'pending', label: `Pending (${preview?.counts.pending ?? 0})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setBucketTab(tab.id)}
                className={`px-3 py-1.5 rounded-md font-medium ${
                  bucketTab === tab.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search roll no or name..."
                className="rounded-lg border border-slate-300 pl-8 pr-3 py-1.5 w-52"
              />
            </div>
            {filteredStudents.length > 0 && (
              <button
                type="button"
                onClick={openBulkEditForFiltered}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-lg font-medium text-slate-700 hover:bg-slate-50"
              >
                <Edit3 className="h-3.5 w-3.5" />
                Bulk Update Filtered Results
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
              <tr>
                <th className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all eligible filtered students"
                    checked={
                      filteredStudents.some((s) => s.bucket === 'eligible') &&
                      filteredStudents
                        .filter((s) => s.bucket === 'eligible')
                        .every((s) => selectedStudentIds.has(s.studentId))
                    }
                    onChange={(e) => toggleAllEligibleFiltered(e.target.checked)}
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold">Roll No & Student</th>
                <th className="px-3 py-2.5 font-semibold">Dept / Class</th>
                <th className="px-3 py-2.5 font-semibold">Attendance</th>
                <th className="px-3 py-2.5 font-semibold">Credits / Backlogs</th>
                <th className="px-3 py-2.5 font-semibold">Result Status</th>
                <th className="px-3 py-2.5 font-semibold">JNTUH Evaluation</th>
                <th className="px-3 py-2.5 font-semibold text-right">Edit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loadingPreview ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    Evaluating JNTUH student eligibility across departments...
                  </td>
                </tr>
              ) : filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    No students match the current semester, department, or status filter.
                  </td>
                </tr>
              ) : (
                filteredStudents.slice(0, 250).map((stu) => (
                  <tr key={stu.studentId} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        disabled={stu.bucket !== 'eligible'}
                        checked={stu.bucket === 'eligible' && selectedStudentIds.has(stu.studentId)}
                        onChange={(e) => {
                          setSelectedStudentIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(stu.studentId);
                            else next.delete(stu.studentId);
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono-tabular font-semibold text-slate-900">
                        {stu.rollNumber}
                      </div>
                      <div className="text-slate-600">{stu.fullName}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{stu.departmentCode}</div>
                      <div className="text-[11px] text-slate-500">{stu.className}</div>
                    </td>
                    <td className="px-3 py-2.5 font-mono-tabular">
                      {stu.attendancePercentage !== null ? (
                        <span
                          className={
                            stu.attendancePercentage >= (preview?.rule.minAttendancePercent ?? 65)
                              ? 'text-emerald-700 font-semibold'
                              : 'text-red-700 font-semibold'
                          }
                        >
                          {stu.attendancePercentage}% ({stu.presentSessionsCount}/{stu.conductedSessionsCount})
                        </span>
                      ) : (
                        <span className="text-slate-400">No sessions</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono-tabular">
                      <div>{stu.creditsEarned} cr</div>
                      <div className="text-[11px] text-slate-500">
                        {stu.activeBacklogs} backlog(s)
                      </div>
                    </td>
                    <td className="px-3 py-2.5 uppercase font-semibold text-[11px]">
                      {stu.latestResultStatus.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2.5 max-w-xs">
                      <span
                        className={`inline-block px-2 py-0.5 rounded font-semibold uppercase text-[10px] ${
                          stu.bucket === 'eligible'
                            ? 'bg-emerald-100 text-emerald-800'
                            : stu.bucket === 'detained'
                              ? 'bg-amber-100 text-amber-800'
                              : stu.bucket === 'failed'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {stu.bucket}
                      </span>
                      <div className="text-[11px] text-slate-600 mt-0.5">{stu.eligibilityReason}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => openSingleEdit(stu)}
                        className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 text-slate-700 font-medium"
                      >
                        Update
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {filteredStudents.length > 250 && (
            <div className="px-4 py-2 text-[11px] text-slate-500 bg-slate-50 border-t border-slate-200">
              Showing first 250 of {filteredStudents.length} students in table view. Bulk promotion processes all selected students seamlessly.
            </div>
          )}
        </div>
      </div>

      {/* Inline Student Eligibility Editor Modal/Card */}
      {editingTargetIds && (
        <form
          onSubmit={handleSaveEligibility}
          className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold text-blue-950">
              Update JNTUH Result, Credits & Standing — {editingLabel}
            </div>
            <button
              type="button"
              onClick={() => setEditingTargetIds(null)}
              className="text-blue-800 underline"
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Regulation</label>
              <select
                value={eligForm.regulation}
                onChange={(e) =>
                  setEligForm({ ...eligForm, regulation: e.target.value as 'R22' | 'R20' | 'R18' })
                }
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
              >
                <option value="R22">R22</option>
                <option value="R20">R20</option>
                <option value="R18">R18</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Result Status</label>
              <select
                value={eligForm.latestResultStatus}
                onChange={(e) =>
                  setEligForm({
                    ...eligForm,
                    latestResultStatus: e.target.value as JntuhResultStatus,
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
              >
                <option value="passed">Passed</option>
                <option value="promoted_with_backlogs">Promoted with Backlogs</option>
                <option value="failed">Failed</option>
                <option value="detained">Detained</option>
                <option value="pending">Pending</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Academic Standing</label>
              <select
                value={eligForm.academicStanding}
                onChange={(e) =>
                  setEligForm({
                    ...eligForm,
                    academicStanding: e.target.value as AcademicStanding,
                  })
                }
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
              >
                <option value="active">Active</option>
                <option value="detained">Detained</option>
                <option value="graduated">Graduated</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Credits Earned</label>
              <input
                type="number"
                min={0}
                max={300}
                value={eligForm.creditsEarned}
                onChange={(e) =>
                  setEligForm({ ...eligForm, creditsEarned: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Active Backlogs</label>
              <input
                type="number"
                min={0}
                max={60}
                value={eligForm.activeBacklogs}
                onChange={(e) =>
                  setEligForm({ ...eligForm, activeBacklogs: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white font-mono-tabular"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Detention Reason</label>
              <input
                type="text"
                value={eligForm.detentionReason}
                onChange={(e) => setEligForm({ ...eligForm, detentionReason: e.target.value })}
                placeholder="Optional note"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingElig}
              className="px-4 py-2 bg-blue-700 text-white font-semibold rounded-lg hover:bg-blue-800 disabled:opacity-50"
            >
              {savingElig ? 'Saving...' : 'Save Eligibility Record'}
            </button>
          </div>
        </form>
      )}

      {/* Explicit Promotion Execution Card */}
      {preview?.toSemester && (
        <form
          onSubmit={handleExecutePromotion}
          className="bg-white border-2 border-slate-900 rounded-xl p-5 space-y-4 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-700" />
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Confirm Academic Promotion: {preview.fromSemester.label} → {preview.toSemester.label}
                </h2>
                <p className="text-slate-500">
                  Runs inside an atomic database transaction. Only eligible selected students are promoted;
                  detained, failed, and pending students stay in {preview.fromSemester.label}.
                </p>
              </div>
            </div>
            <div className="text-right font-mono-tabular">
              <div className="text-slate-500">Selected Eligible</div>
              <div className="text-lg font-bold text-emerald-700">{eligibleSelectedCount}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-slate-800 font-medium">
                <input
                  type="checkbox"
                  checked={updateStaffAssignments}
                  onChange={(e) => setUpdateStaffAssignments(e.target.checked)}
                />
                Carry forward authorized staff assignments to target semester classes
              </label>
              <label className="flex items-start gap-2 text-slate-900 font-semibold">
                <input
                  type="checkbox"
                  checked={confirmChecked}
                  onChange={(e) => setConfirmChecked(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I have reviewed eligible ({eligibleSelectedCount}), detained ({preview.counts.detained}),
                  failed ({preview.counts.failed}), and pending ({preview.counts.pending}) students and confirm
                  promoting {eligibleSelectedCount} student(s) while preserving all historical attendance.
                </span>
              </label>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <input
                type="text"
                value={confirmationNote}
                onChange={(e) => setConfirmationNote(e.target.value)}
                placeholder="Optional senate/examination order note (logged in audit)"
                className="flex-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <button
                type="submit"
                disabled={promoting || !confirmChecked || eligibleSelectedCount === 0}
                className="px-5 py-2.5 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
              >
                {promoting
                  ? 'Executing Promotion...'
                  : `Confirm & Promote ${eligibleSelectedCount} Student(s)`}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Rollback Confirmation Card */}
      {rollbackTarget && (
        <form
          onSubmit={handleConfirmRollback}
          className="bg-amber-50 border border-amber-300 rounded-xl p-5 space-y-3 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold text-amber-950 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              Roll Back Promotion Batch {rollbackTarget.batchCode} ({rollbackTarget.promotedCount} student(s))
            </div>
            <button
              type="button"
              onClick={() => {
                setRollbackTarget(null);
                setRollbackReason('');
              }}
              className="text-amber-800 underline"
            >
              Cancel
            </button>
          </div>
          <p className="text-amber-900">
            This restores promoted students back to {rollbackTarget.fromYearLabel} ·{' '}
            {rollbackTarget.fromSemesterLabel} with their previous credits, backlogs, and standing.
            Historical attendance records are never modified.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              required
              minLength={3}
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              placeholder="Enter mandatory rollback reason (min 3 characters)"
              className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2"
            />
            <button
              type="submit"
              disabled={rollingBack}
              className="px-4 py-2 bg-amber-800 text-white font-semibold rounded-lg hover:bg-amber-900 disabled:opacity-50"
            >
              {rollingBack ? 'Rolling Back...' : 'Confirm Safe Rollback'}
            </button>
          </div>
        </form>
      )}

      {/* Batch Detail Inspector */}
      {inspectingBatch && (
        <div className="bg-white border border-slate-300 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between text-xs">
            <div className="font-bold">
              Batch Details: {inspectingBatch.batch.batchCode} ({inspectingBatch.batch.fromSemesterLabel} →{' '}
              {inspectingBatch.batch.toSemesterLabel})
            </div>
            <button
              type="button"
              onClick={() => setInspectingBatch(null)}
              className="text-slate-300 hover:text-white underline"
            >
              Close
            </button>
          </div>
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-semibold">Roll No</th>
                  <th className="px-4 py-2 font-semibold">Student</th>
                  <th className="px-4 py-2 font-semibold">Dept</th>
                  <th className="px-4 py-2 font-semibold">Outcome</th>
                  <th className="px-4 py-2 font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inspectingBatch.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-2 font-mono-tabular font-semibold">{item.rollNumber}</td>
                    <td className="px-4 py-2">{item.fullName}</td>
                    <td className="px-4 py-2">{item.departmentCode}</td>
                    <td className="px-4 py-2 uppercase font-semibold text-[11px]">{item.outcome}</td>
                    <td className="px-4 py-2 text-slate-600">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Promotion Batch History & Safe Rollback */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-700" />
          <h2 className="text-sm font-bold text-slate-900">Promotion Batch History & Rollback</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Batch Code</th>
                <th className="px-4 py-2.5 font-semibold">Transition</th>
                <th className="px-4 py-2.5 font-semibold">Scope & Reg.</th>
                <th className="px-4 py-2.5 font-semibold">Counts</th>
                <th className="px-4 py-2.5 font-semibold">Promoted By & Time (IST)</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    No academic promotions have been executed yet.
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2.5 font-mono-tabular font-semibold text-slate-900">
                      {b.batchCode}
                    </td>
                    <td className="px-4 py-2.5">
                      {b.fromSemesterLabel} → {b.toSemesterLabel}
                    </td>
                    <td className="px-4 py-2.5">
                      {b.departmentCode} · {b.regulation}
                    </td>
                    <td className="px-4 py-2.5 font-mono-tabular">
                      <span className="text-emerald-700 font-semibold">{b.promotedCount} promoted</span>
                      {' · '}
                      <span className="text-amber-700">{b.detainedCount} det.</span>
                      {' · '}
                      <span className="text-red-700">{b.failedCount} fail</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div>{b.promotedByEmail}</div>
                      <div className="text-[11px] font-mono-tabular text-slate-500">{b.createdAtIST}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`uppercase font-semibold text-[11px] ${
                          b.status === 'completed' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {b.status.replace('_', ' ')}
                      </span>
                      {b.rollbackReason && (
                        <div className="text-[11px] text-slate-500">{b.rollbackReason}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleInspectBatch(b)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50"
                      >
                        <Eye className="h-3 w-3" />
                        Inspect
                      </button>
                      {b.status === 'completed' && b.promotedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setRollbackTarget(b);
                            setRollbackReason('');
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-amber-300 text-amber-800 rounded hover:bg-amber-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Rollback
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Promotion Audit Log */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-slate-700" />
          <h2 className="text-sm font-bold text-slate-900">Academic Progression Audit Trail</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Timestamp (IST)</th>
                <th className="px-4 py-2.5 font-semibold">Action</th>
                <th className="px-4 py-2.5 font-semibold">Administrator</th>
                <th className="px-4 py-2.5 font-semibold">Summary & Affected Roll Numbers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {promoAudits.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                    No progression audit entries recorded yet.
                  </td>
                </tr>
              ) : (
                promoAudits.map((a) => {
                  const rolls = Array.isArray(a.details?.affectedRollNumbers)
                    ? (a.details.affectedRollNumbers as string[])
                    : [];
                  return (
                    <tr key={a.id}>
                      <td className="px-4 py-2.5 font-mono-tabular text-slate-500 whitespace-nowrap">
                        {a.createdAtIST}
                      </td>
                      <td className="px-4 py-2.5 font-mono-tabular font-semibold text-slate-900">
                        {a.action}
                      </td>
                      <td className="px-4 py-2.5">{a.actorEmail || 'system'}</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {a.details?.batchCode ? (
                          <span className="font-mono-tabular font-semibold text-slate-800">
                            {String(a.details.batchCode)}
                          </span>
                        ) : null}
                        {a.details?.promotedCount !== undefined && (
                          <span>
                            {' · '}Promoted: {String(a.details.promotedCount)}
                          </span>
                        )}
                        {a.details?.restoredCount !== undefined && (
                          <span>
                            {' · '}Restored: {String(a.details.restoredCount)}
                          </span>
                        )}
                        {rolls.length > 0 && (
                          <div className="text-[11px] font-mono-tabular text-slate-500 mt-0.5">
                            Rolls: {rolls.slice(0, 12).join(', ')}
                            {rolls.length > 12 ? ` (+${rolls.length - 12} more)` : ''}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
