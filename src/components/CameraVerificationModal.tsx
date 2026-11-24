import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, AlertTriangle, ShieldCheck, X, RefreshCw } from 'lucide-react';
import { analyzeVideoFrame, ensureFaceModelsLoaded, FrameAnalysisResult } from '../lib/faceEngine';
import { apiFetch, ApiError } from '../lib/api';

interface CameraVerificationModalProps {
  mode: 'enroll' | 'verify';
  sessionId?: string;
  sessionLabel?: string;
  locationRequired?: boolean;
  livenessRequired?: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onRequestAssistedFallback?: (sessionId: string, reason: string, type: 'location_bypass' | 'liveness_assisted') => void;
}

export const CameraVerificationModal: React.FC<CameraVerificationModalProps> = ({
  mode,
  sessionId,
  sessionLabel,
  locationRequired = false,
  livenessRequired = true,
  onClose,
  onSuccess,
  onRequestAssistedFallback,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const [consentAccepted, setConsentAccepted] = useState(mode === 'verify');
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<FrameAnalysisResult | null>(null);
  const [samples, setSamples] = useState<number[][]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Liveness tracking states (real landmark checks)
  const [blinkDetected, setBlinkDetected] = useState(false);
  const [headTurnDetected, setHeadTurnDetected] = useState(false);
  const earHistoryRef = useRef<number[]>([]);
  const yawHistoryRef = useRef<number[]>([]);

  // Location state (requested ONLY during verify mode if enabled)
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<string>(
    locationRequired ? 'Requesting campus location...' : 'Campus location check optional'
  );
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'verify' || !locationRequired) return;
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setLocationStatus(
          `GPS captured (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`
        );
        setLocationError(null);
      },
      (err) => {
        setLocationError(
          `Location permission denied or unavailable (${err.message}). GPS is not perfect proof of physical presence; you can request staff-assisted attendance if needed.`
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }, [mode, locationRequired]);

  useEffect(() => {
    if (!consentAccepted) return;
    let cancelled = false;

    async function startCameraAndModels() {
      try {
        await ensureFaceModelsLoaded();
        if (cancelled) return;
        setModelsReady(true);

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraReady(true);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unable to access camera';
        setCameraError(`Camera initialization failed: ${msg}. Please allow camera permission.`);
      }
    }

    startCameraAndModels();

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [consentAccepted]);

  // Continuous live frame analysis loop
  useEffect(() => {
    if (!cameraReady || !modelsReady || submitting) return;
    let busy = false;

    const id = window.setInterval(async () => {
      if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
      busy = true;
      try {
        const res = await analyzeVideoFrame(videoRef.current, false);
        setAnalysis(res);

        if (res.faceCount === 1 && res.ear !== null && res.yawRatio !== null) {
          earHistoryRef.current.push(res.ear);
          if (earHistoryRef.current.length > 25) earHistoryRef.current.shift();
          const maxEar = Math.max(...earHistoryRef.current);
          const minEar = Math.min(...earHistoryRef.current);
          // Natural blink shows a dip in Eye Aspect Ratio
          if (maxEar - minEar >= 0.045 || minEar < 0.23) {
            setBlinkDetected(true);
          }

          yawHistoryRef.current.push(res.yawRatio);
          if (yawHistoryRef.current.length > 25) yawHistoryRef.current.shift();
          const minYaw = Math.min(...yawHistoryRef.current);
          const maxYaw = Math.max(...yawHistoryRef.current);
          if (maxYaw - minYaw >= 0.08) {
            setHeadTurnDetected(true);
          }
        }
      } catch {
        // Skip transient frame read issues
      } finally {
        busy = false;
      }
    }, 260);

    timerRef.current = id;
    return () => window.clearInterval(id);
  }, [cameraReady, modelsReady, submitting]);

  async function handleCaptureEnrollmentSample() {
    if (!videoRef.current || submitting) return;
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const res = await analyzeVideoFrame(videoRef.current, true);
      if (res.faceCount !== 1 || !res.descriptor) {
        setErrorMsg(res.guidanceMessage);
        return;
      }
      if (!res.lightingOk || !res.centeringOk || !res.sizeOk) {
        setErrorMsg(res.guidanceMessage);
        return;
      }
      const nextSamples = [...samples, res.descriptor];
      setSamples(nextSamples);

      if (nextSamples.length >= 3) {
        const resp = await apiFetch<{ message: string }>('/api/student/biometrics/enroll', {
          method: 'POST',
          body: JSON.stringify({
            consentGiven: true,
            descriptors: nextSamples,
          }),
        });
        onSuccess(resp.message);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Enrollment sample failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyAndMarkAttendance() {
    if (!videoRef.current || !sessionId || submitting) return;
    setErrorMsg(null);
    setErrorCode(null);

    if (locationRequired && !coords) {
      setErrorMsg('Campus location coordinates are required before verifying your face.');
      setErrorCode('LOCATION_REQUIRED');
      return;
    }

    if (livenessRequired && !blinkDetected) {
      setErrorMsg('Please blink naturally once so the liveness check detects eye motion.');
      return;
    }

    setSubmitting(true);
    try {
      const frame1 = await analyzeVideoFrame(videoRef.current, true);
      if (frame1.faceCount !== 1 || !frame1.descriptor) {
        setErrorMsg(frame1.guidanceMessage);
        return;
      }
      if (!frame1.lightingOk || !frame1.centeringOk || !frame1.sizeOk) {
        setErrorMsg(frame1.guidanceMessage);
        return;
      }

      // Capture a second frame 350ms apart to verify real non-static frame variance
      await new Promise((r) => setTimeout(r, 350));
      const frame2 = await analyzeVideoFrame(videoRef.current, true);
      if (frame2.faceCount !== 1 || !frame2.descriptor) {
        setErrorMsg(frame2.guidanceMessage);
        return;
      }

      let sqDiff = 0;
      for (let i = 0; i < 128; i++) {
        const d = frame1.descriptor[i] - frame2.descriptor[i];
        sqDiff += d * d;
      }
      const frameVariance = Math.sqrt(sqDiff);

      const resp = await apiFetch<{ message: string; record: { markedAtIST: string } }>(
        '/api/student/attendance/mark',
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            descriptor: frame2.descriptor,
            livenessPassed: livenessRequired ? blinkDetected && frameVariance > 0.0001 : true,
            livenessSignals: {
              blinkDetected,
              headTurnDetected,
              frameVariance,
            },
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
          }),
        }
      );

      onSuccess(`${resp.message} (${resp.record.markedAtIST})`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message);
        setErrorCode(err.code || null);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Verification failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-6">
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden max-h-[94vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {mode === 'enroll' ? 'Biometric Face Enrollment' : 'Live Camera Attendance Verification'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'enroll'
                ? 'Swarna Bharathi Institute of Science and Technology · Encrypted 128D Template'
                : sessionLabel || 'Active Class Session'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close camera modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {!consentAccepted ? (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-blue-700 shrink-0 mt-0.5" />
                <div className="space-y-2 text-sm text-slate-700">
                  <p className="font-semibold text-slate-900">
                    Informed Biometric Consent & Privacy Notice (SBIST-BIO-2026-v1)
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-xs leading-relaxed text-slate-600">
                    <li>
                      Your browser extracts a mathematical 128-dimensional facial descriptor locally. Raw
                      photographs are never stored on the server.
                    </li>
                    <li>
                      The descriptor template is encrypted with AES-256-GCM on the server and used strictly
                      for Swarna Bharathi Institute of Science and Technology attendance verification.
                    </li>
                    <li>
                      Biometric templates are never sent back to frontend JavaScript and may be deleted or
                      re-enrolled by you or an administrator at any time.
                    </li>
                  </ul>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-slate-700 rounded-lg border border-slate-300 hover:bg-slate-100"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => setConsentAccepted(true)}
                  className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  I Consent & Continue to Camera
                </button>
              </div>
            </div>
          ) : (
            <>
              {mode === 'verify' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-700">
                    Location Check: {locationError ? 'Unavailable / Denied' : locationStatus}
                  </span>
                  {locationError && (
                    <span className="text-amber-700">{locationError}</span>
                  )}
                </div>
              )}

              <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-900 border border-slate-200">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="h-full w-full object-cover scale-x-[-1]"
                />
                {/* Centering guide */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className={`h-52 w-40 sm:h-60 sm:w-48 rounded-full border-2 transition-colors ${
                      analysis?.faceCount === 1 &&
                      analysis.lightingOk &&
                      analysis.centeringOk &&
                      analysis.sizeOk
                        ? 'border-emerald-400'
                        : 'border-white/70 border-dashed'
                    }`}
                  />
                </div>
                {(!modelsReady || !cameraReady) && !cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 text-white text-sm gap-2">
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    <span>{modelsReady ? 'Starting camera stream...' : 'Loading local face recognition models...'}</span>
                  </div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 p-4 text-center text-sm text-red-300">
                    {cameraError}
                  </div>
                )}
              </div>

              {/* Real-time Guidance & Checks Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">1. Face Detection</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {analysis
                      ? analysis.faceCount === 1
                        ? '1 Face Detected'
                        : analysis.faceCount === 0
                          ? 'No Face Visible'
                          : `${analysis.faceCount} Faces (Rejected)`
                      : 'Analyzing...'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">2. Lighting & Framing</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {analysis?.lightingOk && analysis.centeringOk && analysis.sizeOk
                      ? 'Optimal Lighting & Frame'
                      : analysis?.guidanceMessage || 'Align face in oval'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">
                    {mode === 'enroll' ? '3. Enrollment Samples' : '3. Liveness Check'}
                  </div>
                  <div className="font-semibold text-slate-900 mt-1 tabular-nums">
                    {mode === 'enroll'
                      ? `${samples.length} / 3 Samples Captured`
                      : livenessRequired
                        ? blinkDetected
                          ? 'Blink Verified'
                          : 'Please Blink Naturally'
                        : 'Optional'}
                  </div>
                </div>
              </div>

              {mode === 'verify' && (
                <p className="text-xs text-slate-500 leading-relaxed">
                  Liveness transparency: Browser checks verify live eye blink (EAR) and frame-to-frame
                  descriptor variance, while identity matching compares your 128D face vector against your
                  encrypted template on the backend. Basic camera liveness reduces static photo spoofing
                  but is not certified hardware-grade anti-spoofing; staff-assisted verification is
                  available whenever needed.
                </p>
              )}

              {errorMsg && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="space-y-1.5">
                    <p>{errorMsg}</p>
                    {mode === 'verify' &&
                      sessionId &&
                      onRequestAssistedFallback &&
                      (errorCode === 'OUTSIDE_GEOFENCE' ||
                        errorCode === 'LOCATION_REQUIRED' ||
                        errorCode === 'LIVENESS_FAILED' ||
                        errorCode === 'FACE_MISMATCH') && (
                        <button
                          type="button"
                          onClick={() =>
                            onRequestAssistedFallback(
                              sessionId,
                              errorMsg,
                              errorCode === 'OUTSIDE_GEOFENCE' || errorCode === 'LOCATION_REQUIRED'
                                ? 'location_bypass'
                                : 'liveness_assisted'
                            )
                          }
                          className="font-semibold text-blue-700 underline hover:text-blue-900"
                        >
                          Submit Staff-Assisted Verification Request Instead
                        </button>
                      )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                {mode === 'verify' && sessionId && onRequestAssistedFallback ? (
                  <button
                    type="button"
                    onClick={() =>
                      onRequestAssistedFallback(
                        sessionId,
                        'Camera, lighting, or GPS check could not complete; requesting staff-assisted verification.',
                        'liveness_assisted'
                      )
                    }
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 underline"
                  >
                    Camera/Location issue? Request Staff-Assisted Verification
                  </button>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  {mode === 'enroll' ? (
                    <button
                      type="button"
                      disabled={!cameraReady || !modelsReady || submitting}
                      onClick={handleCaptureEnrollmentSample}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                    >
                      <Camera className="h-4 w-4" />
                      {submitting
                        ? 'Processing...'
                        : samples.length === 2
                          ? 'Capture Final Sample (3/3)'
                          : `Capture Sample (${samples.length + 1}/3)`}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!cameraReady || !modelsReady || submitting}
                      onClick={handleVerifyAndMarkAttendance}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {submitting ? 'Verifying Identity...' : 'Verify Face & Mark Present'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
