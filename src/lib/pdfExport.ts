import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface AttendanceReportRow {
  rollNumber: string | null;
  studentName: string;
  departmentCode: string;
  yearLabel: string;
  semesterLabel: string;
  className: string;
  subjectCode: string;
  subjectName: string;
  sessionCode: string;
  attendanceDate: string;
  markedAtIST: string;
  status: string;
  verificationMethod: string;
}

export function exportAttendancePdf(params: {
  collegeName: string;
  reportTitle: string;
  generatedBy: string;
  rows: AttendanceReportRow[];
  summary: {
    totalRecords: number;
    presentCount: number;
    absentCount: number;
    percentage: number;
    hasData?: boolean;
    message?: string | null;
  };
}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text(params.collegeName, 40, 42);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  const istNow =
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date()) + ' IST';

  doc.text(
    `Smart Attendance Management System  |  ${params.reportTitle}  |  Generated: ${istNow}  |  By: ${params.generatedBy}`,
    40,
    60
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  const rateText =
    params.summary.hasData === false || params.summary.totalRecords === 0
      ? params.summary.message || 'No attendance data available'
      : `${params.summary.percentage}%`;
  doc.text(
    `Total Records: ${params.summary.totalRecords}    Present: ${params.summary.presentCount}    Absent: ${params.summary.absentCount}    Attendance Rate: ${rateText}`,
    40,
    80
  );

  autoTable(doc, {
    startY: 96,
    head: [
      [
        'Roll No',
        'Student Name',
        'Dept',
        'Class',
        'Subject',
        'Date (IST)',
        'Timestamp (IST)',
        'Status',
        'Verification',
      ],
    ],
    body: params.rows.map((r) => [
      r.rollNumber || '-',
      r.studentName,
      r.departmentCode,
      r.className,
      `${r.subjectCode || 'DAILY'} · ${r.subjectName || 'Daily Session'}`,
      r.attendanceDate,
      r.markedAtIST,
      r.status.toUpperCase(),
      r.verificationMethod,
    ]),
    styles: { fontSize: 8, cellPadding: 4, textColor: [15, 23, 42] },
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 40, right: 40 },
  });

  doc.save(`SBIST-Attendance-Report.pdf`);
}
