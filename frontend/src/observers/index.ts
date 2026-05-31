import { API_URL, isElectron, getStoredToken, refreshAccessToken } from '../config'

let screenTimerId: ReturnType<typeof setInterval> | null = null
let cameraTimerId: ReturnType<typeof setInterval> | null = null

let currentConfig = {
  screenActive: false,
  cameraActive: false,
  screenInterval: 60,
  cameraInterval: 120,
}

/**
 * Capture frame from a MediaStream to JPEG base64
 */
function captureStreamToBase64(stream: MediaStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    
    const timeoutId = setTimeout(() => {
      video.pause();
      video.srcObject = null;
      reject(new Error("Capture timed out waiting for video metadata."));
    }, 5000);

    video.onloadedmetadata = () => {
      video.play().then(() => {
        setTimeout(() => {
          clearTimeout(timeoutId);
          const canvas = document.createElement('canvas');
          const MAX_DIM = 1920;
          let w = video.videoWidth || 1280;
          let h = video.videoHeight || 720;
          if (w > MAX_DIM || h > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(dataUrl);
          } else {
            reject(new Error("Failed to create canvas 2D context."));
          }
          video.pause();
          video.srcObject = null;
        }, 400);
      }).catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    };
    
    video.onerror = (e) => {
      clearTimeout(timeoutId);
      reject(e);
    };
  });
}

/**
 * Upload the JPEG base64 payload to the FastAPI observations API
 */
async function uploadCapture(type: 'screen' | 'camera', base64Data: string, windowTitles: string[] = []) {
  const timestamp = new Date().toISOString();
  const makeHeaders = (token: string | null): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) h['Authorization'] = `Bearer ${token}`
    return h
  }
  const body = JSON.stringify({
    type,
    image_base64: base64Data,
    timestamp,
    window_titles: windowTitles
  })

  const token = getStoredToken()
  let response = await fetch(`${API_URL}/api/observations`, {
    method: 'POST',
    headers: makeHeaders(token),
    body,
  })

  if (response.status === 401) {
    const newToken = await refreshAccessToken()
    if (newToken) {
      response = await fetch(`${API_URL}/api/observations`, {
        method: 'POST',
        headers: makeHeaders(newToken),
        body,
      })
    }
  }

  if (!response.ok) {
    throw new Error(`Upload API rejected: ${response.statusText}`);
  }
  return await response.json();
}

async function captureScreen() {
  try {
    console.log("[Molly Observer] Capturing screen...");
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      console.error("[Molly Observer] electronAPI is not available — not running in Electron!");
      return;
    }
    const sources = await electronAPI.getDesktopSources();
    console.log("[Molly Observer] Sources returned:", sources?.length);
    if (sources && sources.length > 0) {
      const screenSource = sources.find((s: any) => s.id.startsWith('screen:')) || sources[0];
      const windowTitles = sources
        .filter((s: any) => s.id?.startsWith('window:'))
        .map((s: any) => s.name)
        .filter(Boolean);
      console.log("[Molly Observer] Using source:", screenSource.id, screenSource.name);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id,
          }
        } as any
      });
      try {
        const base64 = await captureStreamToBase64(stream);
        console.log("[Molly Observer] Captured base64 length:", base64.length);
        const result = await uploadCapture('screen', base64, windowTitles);
        console.log("[Molly Observer] Screen capture persisted:", result);
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }
    } else {
      console.warn("[Molly Observer] No screen source available.");
    }
  } catch (err) {
    console.error("[Molly Observer] Screen capture failed:", err);
  }
}

async function captureCamera() {
  try {
    console.log("[Molly Observer] Capturing camera...");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    try {
      const base64 = await captureStreamToBase64(stream);
      await uploadCapture('camera', base64);
      console.log("[Molly Observer] Camera snap persisted.");
    } finally {
      stream.getTracks().forEach(track => track.stop());
    }
  } catch (err) {
    console.error("[Molly Observer] Camera capture failed:", err);
  }
}

export async function triggerObservationsCapture() {
  if (!isElectron) return;
  if (currentConfig.screenActive) await captureScreen();
  if (currentConfig.cameraActive) await captureCamera();
}

function clearTimers() {
  if (screenTimerId) { clearInterval(screenTimerId); screenTimerId = null; }
  if (cameraTimerId) { clearInterval(cameraTimerId); cameraTimerId = null; }
}

export function startObservers(config: {
  screenActive: boolean
  cameraActive: boolean
  screenInterval: number
  cameraInterval: number
}) {
  if (!isElectron) return;
  currentConfig = { ...config };
  clearTimers();

  if (!config.screenActive && !config.cameraActive) {
    console.log("[Molly Observer] Both observers disabled. Scheduler inactive.");
    return;
  }

  console.log("[Molly Observer] Scheduler: screen=", config.screenActive,
    `every ${config.screenInterval}s`, "camera=", config.cameraActive,
    `every ${config.cameraInterval}s`);

  if (config.screenActive) {
    captureScreen();
    screenTimerId = setInterval(captureScreen, config.screenInterval * 1000);
  }
  if (config.cameraActive) {
    captureCamera();
    cameraTimerId = setInterval(captureCamera, config.cameraInterval * 1000);
  }
}

export function stopObservers() {
  clearTimers();
  console.log("[Molly Observer] Scheduler stopped.");
}

export function updateObserverConfig(config: {
  screenActive: boolean
  cameraActive: boolean
  screenInterval: number
  cameraInterval: number
}) {
  if (!isElectron) return;
  console.log("[Molly Observer] Configuration updated:", config);
  startObservers(config);
}
