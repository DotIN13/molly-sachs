import { API_URL, isElectron } from '../config'

let captureIntervalId: ReturnType<typeof setInterval> | null = null;
let currentConfig = {
  screenActive: false,
  cameraActive: false,
  captureInterval: 60 // in seconds
};

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
    
    // Set a safety timeout in case loadedmetadata doesn't fire
    const timeoutId = setTimeout(() => {
      video.pause();
      video.srcObject = null;
      reject(new Error("Capture timed out waiting for video metadata."));
    }, 5000);

    video.onloadedmetadata = () => {
      video.play().then(() => {
        // Wait a short delay to allow stream rendering to stabilize
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
  const response = await fetch(`${API_URL}/api/observations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type,
      image_base64: base64Data,
      timestamp,
      window_titles: windowTitles
    })
  });
  if (!response.ok) {
    throw new Error(`Upload API rejected: ${response.statusText}`);
  }
  return await response.json();
}

/**
 * Execute Screen and Camera capture sequences
 */
export async function triggerObservationsCapture() {
  if (!isElectron) return;
  if (currentConfig.screenActive) {
    try {
      console.log("[Molly Observer] Calling getDesktopSources via electronAPI...");
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI) {
        console.error("[Molly Observer] electronAPI is not available — not running in Electron!");
        return;
      }
      const sources = await electronAPI.getDesktopSources();
      console.log("[Molly Observer] Sources returned:", sources?.length, sources?.map((s: any) => ({ id: s.id, name: s.name })));
      if (sources && sources.length > 0) {
        const screenSource = sources.find((s: any) => s.id.startsWith('screen:')) || sources[0];
        const windowTitles = sources
          .filter((s: any) => s.id?.startsWith('window:'))
          .map((s: any) => s.name)
          .filter(Boolean);
        console.log("[Molly Observer] Using source:", screenSource.id, screenSource.name, "Windows:", windowTitles.length);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
            }
          } as any
        });
        console.log("[Molly Observer] Stream obtained:", stream.id, "tracks:", stream.getVideoTracks().length);
        
        try {
          const base64 = await captureStreamToBase64(stream);
          console.log("[Molly Observer] Captured base64 length:", base64.length);
          const result = await uploadCapture('screen', base64, windowTitles);
          console.log("[Molly Observer] Screen capture persisted successfully:", result);
        } finally {
          stream.getTracks().forEach(track => track.stop());
        }
      } else {
        console.warn("[Molly Observer] No screen source available for capturing.");
      }
    } catch (err) {
      console.error("[Molly Observer] Screen capture failed:", err);
    }
  }

  if (currentConfig.cameraActive) {
    try {
      console.log("[Molly Observer] Capture camera initiated...");
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
        console.log("[Molly Observer] Camera snap persisted successfully.");
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }
    } catch (err) {
      console.error("[Molly Observer] Camera capture failed:", err);
    }
  }
}

/**
 * Start or re-schedule observations capture scheduler
 */
export function startObservers(config: { screenActive: boolean, cameraActive: boolean, captureInterval: number }) {
  if (!isElectron) return;
  currentConfig = { ...config };
  
  if (captureIntervalId) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }
  
  if (!config.screenActive && !config.cameraActive) {
    console.log("[Molly Observer] Both observers disabled. Scheduler inactive.");
    return;
  }
  
  console.log(`[Molly Observer] Scheduler started (Interval: ${config.captureInterval}s, Screen: ${config.screenActive}, Camera: ${config.cameraActive})`);
  
  // Perform an initial capture immediately
  triggerObservationsCapture();
  
  captureIntervalId = setInterval(() => {
    triggerObservationsCapture();
  }, config.captureInterval * 1000);
}

/**
 * Terminate scheduler completely
 */
export function stopObservers() {
  if (captureIntervalId) {
    clearInterval(captureIntervalId);
    captureIntervalId = null;
  }
  console.log("[Molly Observer] Scheduler stopped.");
}

/**
 * Update capture scheduler configuration dynamically
 */
export function updateObserverConfig(config: { screenActive: boolean, cameraActive: boolean, captureInterval: number }) {
  if (!isElectron) return;
  console.log("[Molly Observer] Configuration updated:", config);
  startObservers(config);
}
