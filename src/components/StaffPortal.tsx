import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckCircle2,
  ClipboardList,
  FileBarChart,
  LayoutDashboard,
  LogOut,
  Plus,
  QrCode,
  Users,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getDefaultQrBaseUrl } from '../lib/qrUrl';
import { AuthMeResponse, Department, Semester } from '../types';
import { ReportsPanel } from './ReportsPanel';

interface StaffPortalProps {
  me: AuthMeResponse;
  departments: Department[];
  semesters: Semester[];
  onLogout: () => void;
}

interface StaffDailySlot {
  slot: 'morning' | 'afternoon';
  label: string;
  startTime: string;
  endTime: string;
  startTime12h: string;
  endTime12h: string;
  status: 'scheduled' | 'active' | 'closed' | 'cancelled';
  totalSessions: number;
  presentCount: number;
}

interface StaffDashboardData {
  scope: { canCreateSessions: boolean };
  todayIST: string;
  todayDayEval?: {
    dateIST: string;
    dayStatus: string;
    isWorkingDay: boolean;
    isHoliday: boolean;
    holidayTitle: string | null;
    holidayReason: string | null;
    overrideTitle: string | null;
    overrideReason: string | null;
  };
  dailySchedule?: {
    morning: StaffDailySlot;
    afternoon: StaffDailySlot;
  } | null;
  assignedDepartments: Department[];
  assignedClasses: Array<{ id: string; departmentId: string; displayName: string }>;
  assignedSubjects: Array<{ id: string; departmentId: string; code: string; name: string }>;
  todaySessions: Array<{
    id: string;
    sessionCode: string;
    departmentCode: string;
    className: string;
    subjectCode: string;
    subjectName: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    status: string;
    presentCount: number;
  }>;
  metrics: {
    assignedStudents: number;
    presentToday: number;
    absentToday: number;
    activeSessions: number;
  };
}

export const StaffPortal: React.FC<StaffPortalProps> = ({
  me,
  departments,
  semesters,
  onLogout,
}) => {
  const [nav, setNav] = useState<'dashboard' | 'sessions' | 'students' | 'corrections' | 'reports'>(
    'dashboard'
  );
  const [dash, setDash] = useState<StaffDashboardData | null>(null);
  const [sessions, setSessions] = useState<StaffDashboardData['todaySessions']>([]);
  const [students, setStudents] = useState<
    Array<{
      id: string;
      fullName: string;
      rollNumber: string;
      departmentCode: string;
      className: string;
      presentCount: number;
      absentCount?: number;
      totalSessions: number;
      attendancePercentage: number;
      hasData?: boolean;
      message?: string | null;
    }>
  >([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentPage, setStudentPage] = useState(1);
  const [studentPagination, setStudentPagination] = useState({ page: 1, total: 0, totalPages: 1 });

  const [selectedRosterSession, setSelectedRosterSession] = useState<string | null>(null);
  const [roster, setRoster] = useState<
    Array<{
      studentId: string;
      fullName: string;
      rollNumber: string;
      attendanceStatus: string;
      verificationMethod: string | null;
      markedAtIST: string | null;
    }>
  >([]);

  const [corrections, setCorrections] = useState<
    Array<{
      id: string;
      studentName: string;
      rollNumber: string;
      sessionCode: string;
      subjectName: string;
      requestedStatus: string;
      reason: string;
      status: string;
      createdAtIST: string;
    }>
  >([]);

  // New session form
  const [newSesDept, setNewSesDept] = useState('');
  const [newSesClass, setNewSesClass] = useState('');
  const [newSesSubj, setNewSesSubj] = useState('');
  const [newSesDate, setNewSesDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newSesStart, setNewSesStart] = useState('09:30');
  const [newSesEnd, setNewSesEnd] = useState('10:30');

  // Correction request form
  const [corrStudentId, setCorrStudentId] = useState('');
  const [corrSessionId, setCorrSessionId] = useState('');
  const [corrStatus, setCorrStatus] = useState<'present' | 'absent' | 'excused'>('present');
  const [corrReason, setCorrReason] = useState('');

  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionQr, setSessionQr] = useState<{
    label: string;
    token: string;
    url: string;
    dataUrl: string;
  } | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await apiFetch<StaffDashboardData>('/api/staff/dashboard');
      setDash(res);
      if (res.todayIST) setNewSesDate(res.todayIST);
      if (res.assignedDepartments[0]) {
        const targetDeptId = newSesDept || res.assignedDepartments[0].id;
        if (!newSesDept) {
          setNewSesDept(targetDeptId);
        }
        if (!newSesClass) {
          const matchingCls = res.assignedClasses.find((c) => c.departmentId === targetDeptId);
          if (matchingCls) setNewSesClass(matchingCls.id);
        }
        if (!newSesSubj) {
          const matchingSub = res.assignedSubjects.find((s) => s.departmentId === targetDeptId);
          if (matchingSub) setNewSesSubj(matchingSub.id);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load staff dashboard.');
    }
  }, [newSesDept, newSesClass, newSesSubj]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: StaffDashboardData['todaySessions'] }>('/api/staff/sessions');
      setSessions(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions.');
    }
  }, []);

  const loadStudents = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        page: String(studentPage),
        limit: '25',
        ...(studentSearch.trim() ? { search: studentSearch.trim() } : {}),
      });
      const res = await apiFetch<{
        items: typeof students;
        pagination: typeof studentPagination;
      }>(`/api/staff/students?${p.toString()}`);
      setStudents(res.items);
      setStudentPagination(res.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load students.');
    }
  }, [studentPage, studentSearch]);

  const loadCorrections = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: typeof corrections }>('/api/staff/correction-requests');
      setCorrections(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load correction requests.');
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    loadSessions();
    loadCorrections();
  }, [loadDashboard, loadSessions, loadCorrections]);

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    if (!newSesDept || !newSesClass || !newSesSubj) {
      setError('Please select a valid department, class, and subject.');
      return;
    }
    try {
      await apiFetch('/api/staff/sessions', {
        method: 'POST',
        body: JSON.stringify({
          departmentId: newSesDept,
          classId: newSesClass,
          subjectId: newSesSubj,
          sessionDate: newSesDate,
          startTime: newSesStart,
          endTime: newSesEnd,
          status: 'active',
        }),
      });
      setMsg('Attendance session created and activated.');
      loadSessions();
      loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session.');
    }
  }

  async function handleSessionStatus(sessionId: string, status: string) {
    setError(null);
    try {
      await apiFetch(`/api/staff/sessions/${sessionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      loadSessions();
      loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update session.');
    }
  }

  async function handleOpenRoster(sessionId: string) {
    setSelectedRosterSession(sessionId);
    try {
      const res = await apiFetch<{ roster: typeof roster }>(`/api/staff/sessions/${sessionId}/roster`);
      setRoster(res.roster);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster.');
    }
  }

  async function handleAssistStudent(studentId: string) {
    if (!selectedRosterSession) return;
    setError(null);
    setMsg(null);
    try {
      await apiFetch('/api/staff/attendance/assist', {
        method: 'POST',
        body: JSON.stringify({
          studentId,
          sessionId: selectedRosterSession,
          reason: 'Staff-assisted classroom verification due to device/camera/location constraint.',
        }),
      });
      setMsg('Staff-assisted attendance marked.');
      handleOpenRoster(selectedRosterSession);
      loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assist attendance.');
    }
  }

  async function handleGenerateSessionQr(sessionId: string) {
    setError(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ qr: { token: string; label: string } }>(
        `/api/staff/sessions/${sessionId}/qr`,
        { method: 'POST' }
      );
      const baseUrl = getDefaultQrBaseUrl().replace(/\/+$/, '');
      const url = `${baseUrl}/?attendQr=${encodeURIComponent(res.qr.token)}`;
      const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      setSessionQr({
        label: res.qr.label,
        token: res.qr.token,
        url,
        dataUrl,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate session QR code.');
    }
  }

  async function handleSubmitCorrection(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await apiFetch('/api/staff/correction-requests', {
        method: 'POST',
        body: JSON.stringify({
          studentId: corrStudentId,
          sessionId: corrSessionId,
          requestedStatus: corrStatus,
          reason: corrReason,
        }),
      });
      setCorrReason('');
      setMsg('Correction request submitted to Super Admin.');
      loadCorrections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit correction request.');
    }
  }

  const collegeName =
    me.collegeSettings?.collegeName || 'Swarna Bharathi Institute of Science and Technology';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 bg-slate-900 text-white flex flex-col justify-between shrink-0">
        <div className="p-5 space-y-6">
          <div className="flex items-center gap-3">
            <img
              src={
                me.collegeSettings?.logoUrl ||
                '/src/assets/images/sbist_college_crest_1795533458624.jpg'
              }
              alt="College Logo"
              referrerPolicy="no-referrer"
              className="h-10 w-10 rounded-lg object-contain bg-white p-0.5 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-xs font-bold leading-snug line-clamp-2">{collegeName}</div>
              <div className="text-[11px] text-slate-400">Staff Portal</div>
            </div>
          </div>

          <nav className="flex lg:flex-col gap-1 overflow-x-auto">
            {[
              { id: 'dashboard', label: 'Class Overview', icon: LayoutDashboard },
              { id: 'sessions', label: 'Sessions & Roster', icon: CheckCircle2 },
              { id: 'students', label: 'Assigned Students', icon: Users },
              { id: 'corrections', label: 'Correction Requests', icon: ClipboardList },
              { id: 'reports', label: 'Reports & Exports', icon: FileBarChart },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setNav(item.id as typeof nav)}
                className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                  nav === item.id
                    ? 'bg-white text-slate-900'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium truncate">{me.profile.fullName}</div>
            <div className="text-[11px] text-slate-400 truncate">{me.profile.email}</div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="p-2 text-slate-300 hover:text-white rounded-lg hover:bg-slate-800"
            title="Sign Out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-4 sm:p-8 space-y-6 overflow-x-hidden">
        {msg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
            {msg}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
            {error}
          </div>
        )}

        {nav === 'dashboard' && dash && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Faculty Class Management</h1>
              <p className="text-xs text-slate-500">
                Scoped to your assigned departments, classes, and subjects · Today (IST): {dash.todayIST}
              </p>
            </div>

            {dash.todayDayEval?.isHoliday && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3.5 text-xs text-amber-950">
                <span className="font-bold">
                  Today is a holiday: {dash.todayDayEval.holidayTitle}.
                </span>{' '}
                Attendance sessions are automatically cancelled for today.
                {dash.todayDayEval.holidayReason ? ` Reason: ${dash.todayDayEval.holidayReason}` : ''}
              </div>
            )}

            {dash.dailySchedule && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[dash.dailySchedule.morning, dash.dailySchedule.afternoon].map((slot) => (
                  <div
                    key={slot.slot}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="font-bold text-slate-900 text-sm">{slot.label}</div>
                      <div className="font-mono-tabular text-slate-500">
                        {slot.startTime12h} – {slot.endTime12h} IST
                      </div>
                      <div className="text-slate-600">
                        Scoped classes: {slot.totalSessions} · Present: {slot.presentCount}
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded text-[11px] font-bold uppercase ${
                        slot.status === 'active'
                          ? 'bg-blue-100 text-blue-800'
                          : slot.status === 'scheduled'
                            ? 'bg-slate-100 text-slate-800'
                            : slot.status === 'cancelled'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {slot.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Assigned Students</div>
                <div className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                  {dash.metrics.assignedStudents}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Present Today</div>
                <div className="text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
                  {dash.metrics.presentToday}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Absent Today</div>
                <div className="text-2xl font-bold text-red-700 mt-1 tabular-nums">
                  {dash.metrics.absentToday}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Active Sessions</div>
                <div className="text-2xl font-bold text-blue-700 mt-1 tabular-nums">
                  {dash.metrics.activeSessions}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h2 className="text-sm font-bold text-slate-900">Assigned Scope</h2>
                <div className="text-xs space-y-2 text-slate-700">
                  <div>
                    <span className="font-semibold">Departments:</span>{' '}
                    {dash.assignedDepartments.map((d) => d.code).join(', ') || 'None'}
                  </div>
                  <div>
                    <span className="font-semibold">Classes:</span>{' '}
                    {dash.assignedClasses.map((c) => c.displayName).join(', ') || 'None'}
                  </div>
                  <div>
                    <span className="font-semibold">Subjects:</span>{' '}
                    {dash.assignedSubjects.map((s) => `${s.code} (${s.name})`).join(', ') || 'None'}
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h2 className="text-sm font-bold text-slate-900">Today's Sessions</h2>
                {dash.todaySessions.length === 0 ? (
                  <p className="text-xs text-slate-500">No sessions scheduled today for your classes.</p>
                ) : (
                  <div className="divide-y divide-slate-100 text-xs">
                    {dash.todaySessions.map((s) => (
                      <div key={s.id} className="py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold text-slate-900">
                            {s.subjectCode || 'DAILY'} · {s.className}
                          </div>
                          <div className="text-slate-500 font-mono-tabular">
                            {s.startTime}–{s.endTime} · Present: {s.presentCount}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setNav('sessions');
                            handleOpenRoster(s.id);
                          }}
                          className="text-blue-700 font-medium hover:underline"
                        >
                          View Roster ({s.status})
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {nav === 'sessions' && dash && (
          <div className="space-y-6">
            {dash.scope.canCreateSessions && (
              <form
                onSubmit={handleCreateSession}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <div className="flex items-center gap-2">
                  <Plus className="h-4 w-4 text-blue-700" />
                  <h2 className="text-sm font-bold text-slate-900">Create Attendance Session</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                  <select
                    value={newSesDept}
                    onChange={(e) => {
                      const deptId = e.target.value;
                      setNewSesDept(deptId);
                      const firstCls = dash.assignedClasses.find((c) => c.departmentId === deptId);
                      const firstSub = dash.assignedSubjects.find((s) => s.departmentId === deptId);
                      setNewSesClass(firstCls?.id || '');
                      setNewSesSubj(firstSub?.id || '');
                    }}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {dash.assignedDepartments.length === 0 && (
                      <option value="" disabled>
                        No assigned departments
                      </option>
                    )}
                    {dash.assignedDepartments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code}
                      </option>
                    ))}
                  </select>
                  <select
                    value={newSesClass}
                    onChange={(e) => setNewSesClass(e.target.value)}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {dash.assignedClasses.filter((c) => !newSesDept || c.departmentId === newSesDept).length === 0 && (
                      <option value="" disabled>
                        No classes in department
                      </option>
                    )}
                    {dash.assignedClasses
                      .filter((c) => !newSesDept || c.departmentId === newSesDept)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                  </select>
                  <select
                    value={newSesSubj}
                    onChange={(e) => setNewSesSubj(e.target.value)}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {dash.assignedSubjects.filter((s) => !newSesDept || s.departmentId === newSesDept).length === 0 && (
                      <option value="" disabled>
                        No subjects in department
                      </option>
                    )}
                    {dash.assignedSubjects
                      .filter((s) => !newSesDept || s.departmentId === newSesDept)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </option>
                      ))}
                  </select>
                  <input
                    type="date"
                    value={newSesDate}
                    onChange={(e) => setNewSesDate(e.target.value)}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2"
                  />
                  <input
                    type="time"
                    value={newSesStart}
                    onChange={(e) => setNewSesStart(e.target.value)}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2"
                  />
                  <input
                    type="time"
                    value={newSesEnd}
                    onChange={(e) => setNewSesEnd(e.target.value)}
                    required
                    className="rounded-lg border border-slate-300 px-2.5 py-2"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Create & Activate Session
                </button>
              </form>
            )}

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Class Attendance Sessions</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Code</th>
                      <th className="px-4 py-3 font-semibold">Class & Subject</th>
                      <th className="px-4 py-3 font-semibold">Date & Time (IST)</th>
                      <th className="px-4 py-3 font-semibold">Present</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5 font-mono-tabular font-medium">{s.sessionCode}</td>
                        <td className="px-4 py-2.5">
                          {s.className} · {s.subjectCode}
                        </td>
                        <td className="px-4 py-2.5 font-mono-tabular">
                          {s.sessionDate} · {s.startTime}–{s.endTime}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums font-semibold">{s.presentCount}</td>
                        <td className="px-4 py-2.5 uppercase font-semibold">{s.status}</td>
                        <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleOpenRoster(s.id)}
                            className="text-blue-700 font-medium hover:underline"
                          >
                            Roster
                          </button>
                          {s.status === 'active' && (
                            <button
                              type="button"
                              onClick={() => handleGenerateSessionQr(s.id)}
                              className="inline-flex items-center gap-1 text-indigo-700 font-medium hover:underline"
                            >
                              <QrCode className="h-3.5 w-3.5" />
                              Attendance QR
                            </button>
                          )}
                          {s.status !== 'active' && s.status !== 'cancelled' && (
                            <button
                              type="button"
                              onClick={() => handleSessionStatus(s.id, 'active')}
                              className="text-emerald-700 font-medium hover:underline"
                            >
                              Activate
                            </button>
                          )}
                          {s.status === 'active' && (
                            <button
                              type="button"
                              onClick={() => handleSessionStatus(s.id, 'closed')}
                              className="text-slate-700 font-medium hover:underline"
                            >
                              Close
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {sessionQr && (
              <div className="bg-white border border-indigo-200 rounded-xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="space-y-1.5 text-xs">
                  <div className="inline-block px-2 py-0.5 rounded bg-indigo-50 text-indigo-800 font-bold uppercase text-[10px]">
                    Classroom Attendance Check-In QR
                  </div>
                  <h3 className="text-sm font-bold text-slate-900">{sessionQr.label}</h3>
                  <p className="text-slate-600">
                    Students scan this QR code, enter only their Hall Ticket Number, and verify their live face to mark attendance and open their Student Dashboard.
                  </p>
                  <div className="font-mono-tabular text-slate-500">Token: {sessionQr.token}</div>
                  <div className="flex flex-wrap gap-3 pt-1">
                    <a
                      href={sessionQr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 font-medium hover:underline"
                    >
                      Open Check-In Link
                    </a>
                    <button
                      type="button"
                      onClick={() => setSessionQr(null)}
                      className="text-slate-500 hover:text-slate-900"
                    >
                      Close QR
                    </button>
                  </div>
                </div>
                <img
                  src={sessionQr.dataUrl}
                  alt={`Attendance QR for ${sessionQr.label}`}
                  className="h-44 w-44 border border-slate-200 rounded-lg p-2 bg-white shrink-0"
                />
              </div>
            )}

            {selectedRosterSession && (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">
                    Session Roster (Present & Absent Students)
                  </h3>
                  <button
                    type="button"
                    onClick={() => setSelectedRosterSession(null)}
                    className="text-xs text-slate-500 hover:text-slate-900"
                  >
                    Close Roster
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Roll No</th>
                        <th className="px-4 py-3 font-semibold">Student Name</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                        <th className="px-4 py-3 font-semibold">Timestamp (IST)</th>
                        <th className="px-4 py-3 font-semibold text-right">Staff-Assisted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {roster.map((r) => (
                        <tr key={r.studentId}>
                          <td className="px-4 py-2.5 font-mono-tabular font-medium">{r.rollNumber}</td>
                          <td className="px-4 py-2.5">{r.fullName}</td>
                          <td className="px-4 py-2.5 font-semibold">
                            <span
                              className={
                                r.attendanceStatus === 'present'
                                  ? 'text-emerald-700'
                                  : 'text-red-700'
                              }
                            >
                              {r.attendanceStatus.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono-tabular text-slate-500">
                            {r.markedAtIST || '-'}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {r.attendanceStatus !== 'present' ? (
                              <button
                                type="button"
                                onClick={() => handleAssistStudent(r.studentId)}
                                className="text-blue-700 font-medium hover:underline"
                              >
                                Mark Assisted Present
                              </button>
                            ) : (
                              <span className="text-slate-400">{r.verificationMethod}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {nav === 'students' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-bold text-slate-900">Assigned Students</h2>
              <input
                type="text"
                value={studentSearch}
                onChange={(e) => {
                  setStudentSearch(e.target.value);
                  setStudentPage(1);
                }}
                placeholder="Search name or roll number..."
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs w-64"
              />
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Roll No</th>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Class</th>
                      <th className="px-4 py-3 font-semibold text-right">Present / Total</th>
                      <th className="px-4 py-3 font-semibold text-right">Percentage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {students.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5 font-mono-tabular font-medium">{s.rollNumber}</td>
                        <td className="px-4 py-2.5">{s.fullName}</td>
                        <td className="px-4 py-2.5">{s.className}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {s.presentCount} / {s.totalSessions}
                        </td>
                        <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                          {s.hasData === false || s.totalSessions === 0 ? (
                            <span className="font-normal text-slate-500">
                              {s.message || 'No attendance data available'}
                            </span>
                          ) : (
                            `${s.attendancePercentage}%`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
                <span>
                  Page {studentPagination.page} of {studentPagination.totalPages} ({studentPagination.total} students)
                </span>
                <div className="space-x-2">
                  <button
                    type="button"
                    disabled={studentPage <= 1}
                    onClick={() => setStudentPage((p) => p - 1)}
                    className="px-3 py-1 border border-slate-300 rounded disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={studentPage >= studentPagination.totalPages}
                    onClick={() => setStudentPage((p) => p + 1)}
                    className="px-3 py-1 border border-slate-300 rounded disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {nav === 'corrections' && (
          <div className="space-y-6">
            <form
              onSubmit={handleSubmitCorrection}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <h2 className="text-sm font-bold text-slate-900">Request Attendance Correction</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <select
                  value={corrStudentId}
                  onChange={(e) => setCorrStudentId(e.target.value)}
                  required
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="">Select Student</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.rollNumber} · {s.fullName}
                    </option>
                  ))}
                </select>
                <select
                  value={corrSessionId}
                  onChange={(e) => setCorrSessionId(e.target.value)}
                  required
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="">Select Session</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.sessionCode} · {s.subjectCode} ({s.sessionDate})
                    </option>
                  ))}
                </select>
                <select
                  value={corrStatus}
                  onChange={(e) => setCorrStatus(e.target.value as typeof corrStatus)}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="present">Mark Present</option>
                  <option value="excused">Mark Excused</option>
                  <option value="absent">Mark Absent</option>
                </select>
              </div>
              <textarea
                required
                minLength={8}
                rows={2}
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
                placeholder="Mandatory reason for correction request..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Submit Correction Request
              </button>
            </form>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Submitted & Student Exception Requests</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Student</th>
                      <th className="px-4 py-3 font-semibold">Session</th>
                      <th className="px-4 py-3 font-semibold">Reason</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {corrections.map((c) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2.5">
                          {c.rollNumber} · {c.studentName}
                        </td>
                        <td className="px-4 py-2.5 font-mono-tabular">
                          {c.sessionCode} ({c.subjectName})
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{c.reason}</td>
                        <td className="px-4 py-2.5 font-semibold uppercase">{c.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {nav === 'reports' && (
          <ReportsPanel
            collegeName={collegeName}
            generatedBy={`${me.profile.fullName} (Staff)`}
            departments={dash?.assignedDepartments || departments}
            semesters={semesters}
            subjects={dash?.assignedSubjects || []}
            classes={dash?.assignedClasses || []}
          />
        )}
      </main>
    </div>
  );
};
