// Phase 2: Molly no longer observes. Hypogum owns all screen/camera capture,
// dedup, and ingest. These functions are retained as no-op stubs so existing
// call sites keep working; they intentionally do nothing.
//
// The Screen/Camera tabs now read observations directly from the user's
// hypogum instance (see ../hypogum.ts).

interface ObserverConfig {
  screenActive: boolean
  cameraActive: boolean
  screenInterval: number
  cameraInterval: number
}

export async function triggerObservationsCapture(): Promise<void> {
  /* no-op — hypogum captures */
}

export function startObservers(_config: ObserverConfig): void {
  /* no-op — hypogum captures */
}

export function stopObservers(): void {
  /* no-op — hypogum captures */
}

export function updateObserverConfig(_config: ObserverConfig): void {
  /* no-op — hypogum captures */
}
