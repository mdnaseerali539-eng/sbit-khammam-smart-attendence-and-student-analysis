import * as faceapi from '@vladmandic/face-api';

let modelsLoaded = false;
let modelsLoadingPromise: Promise<void> | null = null;

export async function ensureFaceModelsLoaded(): Promise<void> {
  if (modelsLoaded) return;
  if (!modelsLoadingPromise) {
    modelsLoadingPromise = (async () => {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      ]);
      modelsLoaded = true;
    })().catch((err) => {
      modelsLoadingPromise = null;
      throw err;
    });
  }
  return modelsLoadingPromise;
}

export interface FrameAnalysisResult {
  faceCount: number;
  brightness: number; // 0..255
  lightingOk: boolean;
  centeringOk: boolean;
  sizeOk: boolean;
  guidanceMessage: string;
  ear: number | null; // Eye Aspect Ratio for blink detection
  yawRatio: number | null; // Nose-to-eye horizontal ratio for head turn
  descriptor: number[] | null;
  box: { x: number; y: number; width: number; height: number } | null;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function computeEyeAspectRatio(eye: faceapi.Point[]): number {
  if (eye.length < 6) return 0.3;
  const v1 = dist(eye[1], eye[5]);
  const v2 = dist(eye[2], eye[4]);
  const h = dist(eye[0], eye[3]);
  if (h === 0) return 0.3;
  return (v1 + v2) / (2.0 * h);
}

function measureRegionBrightness(
  video: HTMLVideoElement,
  box?: { x: number; y: number; width: number; height: number }
): number {
  const canvas = document.createElement('canvas');
  const w = 96;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;
  ctx.drawImage(video, 0, 0, w, h);

  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  if (box && video.videoWidth > 0 && video.videoHeight > 0) {
    sx = Math.max(0, Math.floor((box.x / video.videoWidth) * w));
    sy = Math.max(0, Math.floor((box.y / video.videoHeight) * h));
    sw = Math.max(8, Math.min(w - sx, Math.floor((box.width / video.videoWidth) * w)));
    sh = Math.max(8, Math.min(h - sy, Math.floor((box.height / video.videoHeight) * h)));
  }

  const imageData = ctx.getImageData(sx, sy, sw, sh).data;
  let totalLuma = 0;
  const pixelCount = imageData.length / 4;
  for (let i = 0; i < imageData.length; i += 4) {
    totalLuma += 0.2126 * imageData[i] + 0.7152 * imageData[i + 1] + 0.0722 * imageData[i + 2];
  }
  return pixelCount > 0 ? totalLuma / pixelCount : 128;
}

export async function analyzeVideoFrame(
  video: HTMLVideoElement,
  withDescriptor = false
): Promise<FrameAnalysisResult> {
  await ensureFaceModelsLoaded();

  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.45,
  });

  if (withDescriptor) {
    const detections = await faceapi
      .detectAllFaces(video, detectorOptions)
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length === 0) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: 0,
        brightness,
        lightingOk: brightness >= 45,
        centeringOk: false,
        sizeOk: false,
        guidanceMessage:
          brightness < 45
            ? 'Poor lighting detected. Move to a brighter area and face the camera.'
            : 'No face detected. Position your face clearly inside the camera frame.',
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
      };
    }

    if (detections.length > 1) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: detections.length,
        brightness,
        lightingOk: brightness >= 45,
        centeringOk: false,
        sizeOk: false,
        guidanceMessage: `Multiple faces detected (${detections.length}). Only one person may appear in the frame.`,
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
      };
    }

    const det = detections[0];
    const box = det.detection.box;
    const brightness = measureRegionBrightness(video, box);
    const lightingOk = brightness >= 45 && brightness <= 245;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const centerX = (box.x + box.width / 2) / vw;
    const centerY = (box.y + box.height / 2) / vh;
    const widthRatio = box.width / vw;

    const centeringOk = centerX > 0.25 && centerX < 0.75 && centerY > 0.2 && centerY < 0.8;
    const sizeOk = widthRatio >= 0.16 && widthRatio <= 0.75;

    const leftEye = det.landmarks.getLeftEye();
    const rightEye = det.landmarks.getRightEye();
    const ear = (computeEyeAspectRatio(leftEye) + computeEyeAspectRatio(rightEye)) / 2;

    const nose = det.landmarks.getNose();
    const jaw = det.landmarks.getJawOutline();
    const leftEdge = jaw[0]?.x ?? box.x;
    const rightEdge = jaw[16]?.x ?? box.x + box.width;
    const noseTip = nose[3]?.x ?? box.x + box.width / 2;
    const faceSpan = Math.max(1, rightEdge - leftEdge);
    const yawRatio = (noseTip - leftEdge) / faceSpan;

    let guidanceMessage = 'Face aligned and ready.';
    if (!lightingOk) {
      guidanceMessage =
        brightness < 45
          ? 'Poor lighting detected. Increase ambient light on your face.'
          : 'Overexposed lighting detected. Avoid direct glare behind you.';
    } else if (!sizeOk) {
      guidanceMessage =
        widthRatio < 0.16
          ? 'Move slightly closer to the camera.'
          : 'Move slightly back from the camera.';
    } else if (!centeringOk) {
      guidanceMessage = 'Center your face inside the alignment guide.';
    }

    return {
      faceCount: 1,
      brightness,
      lightingOk,
      centeringOk,
      sizeOk,
      guidanceMessage,
      ear,
      yawRatio,
      descriptor: Array.from(det.descriptor),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  } else {
    const detections = await faceapi
      .detectAllFaces(video, detectorOptions)
      .withFaceLandmarks();

    if (detections.length === 0) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: 0,
        brightness,
        lightingOk: brightness >= 45,
        centeringOk: false,
        sizeOk: false,
        guidanceMessage:
          brightness < 45
            ? 'Poor lighting detected. Move to a brighter area.'
            : 'No face detected. Position your face in the frame.',
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
      };
    }

    if (detections.length > 1) {
      return {
        faceCount: detections.length,
        brightness: 128,
        lightingOk: true,
        centeringOk: false,
        sizeOk: false,
        guidanceMessage: `Multiple faces detected (${detections.length}). Ensure only your face is visible.`,
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
      };
    }

    const det = detections[0];
    const box = det.detection.box;
    const brightness = measureRegionBrightness(video, box);
    const lightingOk = brightness >= 45 && brightness <= 245;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const centerX = (box.x + box.width / 2) / vw;
    const centerY = (box.y + box.height / 2) / vh;
    const widthRatio = box.width / vw;
    const centeringOk = centerX > 0.25 && centerX < 0.75 && centerY > 0.2 && centerY < 0.8;
    const sizeOk = widthRatio >= 0.16 && widthRatio <= 0.75;

    const leftEye = det.landmarks.getLeftEye();
    const rightEye = det.landmarks.getRightEye();
    const ear = (computeEyeAspectRatio(leftEye) + computeEyeAspectRatio(rightEye)) / 2;

    const nose = det.landmarks.getNose();
    const jaw = det.landmarks.getJawOutline();
    const leftEdge = jaw[0]?.x ?? box.x;
    const rightEdge = jaw[16]?.x ?? box.x + box.width;
    const noseTip = nose[3]?.x ?? box.x + box.width / 2;
    const yawRatio = (noseTip - leftEdge) / Math.max(1, rightEdge - leftEdge);

    let guidanceMessage = 'Face detected. Follow the liveness prompt.';
    if (!lightingOk) {
      guidanceMessage =
        brightness < 45 ? 'Poor lighting detected. Increase light.' : 'Excessive glare detected.';
    } else if (!sizeOk) {
      guidanceMessage = widthRatio < 0.16 ? 'Move closer to camera.' : 'Move slightly back.';
    } else if (!centeringOk) {
      guidanceMessage = 'Center your face in the frame.';
    }

    return {
      faceCount: 1,
      brightness,
      lightingOk,
      centeringOk,
      sizeOk,
      guidanceMessage,
      ear,
      yawRatio,
      descriptor: null,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  }
}
