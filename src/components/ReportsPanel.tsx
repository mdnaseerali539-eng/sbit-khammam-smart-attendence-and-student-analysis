import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Search } from 'lucide-react';
import { apiFetch, downloadAuthenticatedBlob } from '../lib/api';
import { AttendanceReportRow, exportAttendancePdf } from '../lib/pdfExport';
import { Department, Semester } from '../types';

interface ReportsPanelProps {
  collegeName: string;
  generatedBy: string;
  departments: Department[];
  semesters: Semester[];
  subjects?: Array<{ id: string; code: string; name: string }>;
  classes?: Array<{ id: string; displayName: string }>;
}

export const ReportsPanel: React.FC<ReportsPanelProps> = ({
  collegeName,
  generatedBy,
  departments,
  semesters,
  subjects = [],
  classes = [],
}) => {
  const [reportType, setReportType] = useState('daily');
  const [date, setDate] = useState('');
  const [month, setMonth] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [semesterId, setSemesterId] = useState('');
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<AttendanceReportRow[]>([]);
  const [summary, setSummary] = useState<{
    totalRecords: number;
    presentCount: number;
    absentCount: number;
    percentage: number;
    hasData?: boolean;
    message?: string | null;
  }>({
    totalRecords: 0,
    presentCount: 0,
    absentCount: 0,
    percentage: 0,
    hasData: false,
    message: 'No attendance data available',
  });
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    p.set('reportType', reportType);
    p.set('page', String(page));
    p.set('limit', '25');
    if (date) p.set('date', date);
    if (month) p.set('month', month);
    if (departmentId) p.set('departmentId', departmentId);
    if (semesterId) p.set('semesterId', semesterId);
    if (classId) p.set('classId', classId);
    if (subjectId) p.set('subjectId', subjectId);
    if (search.trim()) p.set('search', search.trim());
    return p;
  }, [reportType, page, date, month, departmentId, semesterId, classId, subjectId, search]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = buildParams();
      const res = await apiFetch<{
        items: AttendanceReportRow[];
        summary: {
          totalRecords: number;
          presentCount: number;
          absentCount: number;
          percentage: number;
          hasData?: boolean;
          message?: string | null;
        };
        pagination: { page: number; total: number; totalPages: number };
      }>(`/api/reports/attendance?${p.toString()}`);
      setRows(res.items);
      setSummary(res.summary);
      setPagination(res.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  async function handleExcelExport() {
    try {
      const p = buildParams();
      await downloadAuthenticatedBlob(
        `/api/reports/export/excel?${p.toString()}`,
        `SBIST-Attendance-${reportType}.xlsx`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Excel export failed.');
    }
  }

  function handlePdfExport() {
    exportAttendancePdf({
      collegeName,
      reportTitle: `${reportType.toUpperCase()} ATTENDANCE REPORT`,
      generatedBy,
      rows,
      summary,
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Attendance Reports & Exports</h2>
          <p className="text-xs text-slate-500">
            Server-side aggregated reports across Daily, Monthly, Department, Class, Subject, Student, and Semester dimensions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePdfExport}
            disabled={rows.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <FileText className="h-3.5 w-3.5 text-red-600" />
            Export PDF
          </button>
          <button
            type="button"
            onClick={handleExcelExport}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Export Excel (.xlsx)
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Report Dimension</label>
          <select
            value={reportType}
            onChange={(e) => {
              setReportType(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
          >
            <option value="daily">Daily Attendance</option>
            <option value="monthly">Monthly Attendance</option>
            <option value="department">Department-wise</option>
            <option value="class">Class-wise</option>
            <option value="subject">Subject-wise</option>
            <option value="student">Individual Student</option>
            <option value="semester">Semester-wise</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Specific Date (IST)</label>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (e.target.value) setMonth('');
              setPage(1);
            }}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Month (YYYY-MM)</label>
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              if (e.target.value) setDate('');
              setPage(1);
            }}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Department</label>
          <select
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
          >
            <option value="">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Semester</label>
          <select
            value={semesterId}
            onChange={(e) => {
              setSemesterId(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
          >
            <option value="">All Semesters</option>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {classes.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Class / Section</label>
            <select
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
            >
              <option value="">All Classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
        )}

        {subjects.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Subject</label>
            <select
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
            >
              <option value="">All Subjects</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Student Name / Roll No</label>
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search student..."
              className="w-full rounded-lg border border-slate-300 pl-8 pr-2.5 py-1.5 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-xs text-slate-500">Matched Records</div>
          <div className="text-xl font-bold text-slate-900 mt-1 tabular-nums">{summary.totalRecords}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-xs text-slate-500">Present / Excused</div>
          <div className="text-xl font-bold text-emerald-700 mt-1 tabular-nums">{summary.presentCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-xs text-slate-500">Absent</div>
          <div className="text-xl font-bold text-red-700 mt-1 tabular-nums">{summary.absentCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-xs text-slate-500">Attendance Rate</div>
          {summary.hasData === false || summary.totalRecords === 0 ? (
            <div className="text-xs font-semibold text-slate-600 mt-2">
              {summary.message || 'No attendance data available'}
            </div>
          ) : (
            <div className="text-xl font-bold text-slate-900 mt-1 tabular-nums">{summary.percentage}%</div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Paginated Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">Roll No</th>
                <th className="px-4 py-3 font-semibold">Student Name</th>
                <th className="px-4 py-3 font-semibold">Department</th>
                <th className="px-4 py-3 font-semibold">Subject</th>
                <th className="px-4 py-3 font-semibold">Timestamp (IST)</th>
                <th className="px-4 py-3 font-semibold">Method</th>
                <th className="px-4 py-3 font-semibold text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Loading report records...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No attendance records match the current filters.
                  </td>
                </tr>
              ) : (
                rows.map((r, idx) => (
                  <tr key={`${r.sessionCode}-${r.rollNumber}-${idx}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono-tabular font-medium text-slate-900">
                      {r.rollNumber || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-slate-800">{r.studentName}</td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {r.departmentCode} · {r.semesterLabel}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {r.subjectCode || 'DAILY'} · {r.subjectName || 'Daily Session'}
                    </td>
                    <td className="px-4 py-2.5 font-mono-tabular text-slate-600">{r.markedAtIST}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.verificationMethod}</td>
                    <td className="px-4 py-2.5 text-right font-semibold">
                      <span
                        className={
                          r.status === 'present'
                            ? 'text-emerald-700'
                            : r.status === 'excused'
                              ? 'text-blue-700'
                              : 'text-red-700'
                        }
                      >
                        {r.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} records)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1 rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
