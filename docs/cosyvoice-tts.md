# CosyVoice TTS: provider integration and voice management

**Status:** Implemented; unverified against a live account
**Date:** 2026-07-26
**Owner:** tzhang3

## One sentence

**Molly can speak through Aliyun Model Studio's CosyVoice instead of Cartesia, and can
create, list, select and delete its own cloned voices from the Settings panel** — so a user
in China gets a low-latency domestic TTS path and a voice that sounds like whoever they
recorded.

---

## Locked decisions

| Decision | Choice | Consequence |
|---|---|---|
| **Cartesia stays** | CosyVoice is added as a *second* provider, not a replacement | `tts_provider` selects between them; Cartesia remains the default, so nothing changes for existing users. |
| **Use the SDK** | Wrap `dashscope`'s `SpeechSynthesizer` rather than speaking the WebSocket protocol | The SDK owns run-task/continue-task/finish-task and reconnection. Our job shrinks to bridging its threads onto asyncio. |
| **Default region** | Beijing (`wss://dashscope.aliyuncs.com/api-ws/v1/inference`, the SDK's own default) | Singapore cannot serve the v3.5 family. `cosyvoice_base_url` overrides it for users who need Singapore. |
| **Default model** | `cosyvoice-v3.5-flash` | Newest and cheapest, but it has **no system voices** — the default install cannot speak until a voice is cloned. This is what forced voice management into scope. |
| **Optional dependency** | `dashscope` imported lazily, inside the functions that need it | A Cartesia-only install boots fine without it. |
| **Voice management lives in Molly** | Not "go copy an id out of the Model Studio console" | Cloning is the *only* path to sound on v3.5, so making the user leave the app would make the default configuration unusable. |

---

## What the service actually is

CosyVoice is **WebSocket-only — there is no HTTP REST synthesis endpoint.** That single fact
drives most of the design: we can't do a request/response call, we get a callback stream on a
thread the SDK owns, and cancellation is a protocol message rather than dropping a socket.

Model families, as of 2026-07:

| Model | Region | System voices? | Notes |
|---|---|---|---|
| `cosyvoice-v3.5-flash` / `-plus` | **Beijing only** | **No** | Newest. `voice` must be a cloned or designed id. A system voice name fails *at synthesis time*, not at construction — the error surfaces as silence-then-`ErrorFrame`, not a startup failure. |
| `cosyvoice-v3-flash` / `-plus` | Beijing, Singapore | Yes (e.g. `longanyang`) | The way to get sound out without cloning first. |
| `cosyvoice-v2` | Beijing, Singapore | Yes (`*_v2` suffix) | Previous generation. |

Voice cloning limits, from the Model Studio docs: WAV (16-bit) / MP3 / M4A, ≤ 10 MB, 10–20 s
recommended and 60 s maximum, up to 1000 voices per account **per model series**, and unused
voices are reclaimed after a year.

---

## Architecture

```
Settings panel (SettingsModal.tsx)
  ├── tts_provider: cartesia | cosyvoice
  └── when cosyvoice:
        model select  →  DashScope key  →  CosyVoicePicker  →  base URL override
                                              │
                            GET/POST/DELETE /api/tts/cosyvoice/voices
                                              │
                                    cosyvoice_voices.py
                                              │
                            dashscope VoiceEnrollmentService  (HTTP)
                                              ▼
                                     Aliyun Model Studio
                                              ▲
                                              │  (WebSocket)
                             dashscope SpeechSynthesizer
                                              │
                                    cosyvoice_tts.py
                                              │
   bot.py  ──builds──►  CosyVoiceTTSService (Pipecat TTSService)  ──►  WebRTC
```

Two entirely separate transports to the same vendor: voice *management* is ordinary HTTP
through `VoiceEnrollmentService`; voice *synthesis* is WebSocket through `SpeechSynthesizer`.
They share only the API key.

### The interesting part: threads → asyncio

`SpeechSynthesizer` delivers audio by calling `on_data` from its own reader thread. Pipecat
wants an async generator. `cosyvoice_tts.py:_synthesize` bridges them with an
`asyncio.Queue` fed via `loop.call_soon_threadsafe`:

| Callback | Queued | Consumer does |
|---|---|---|
| `on_data(bytes)` | the chunk | `yield` it |
| `on_complete()` | `None` | break — end of stream |
| `on_error(msg)` | a `RuntimeError` **instance** | `raise` it |
| `on_close()` | `None` | break — the safety net |

Putting the exception *object* on the queue and re-raising it consumer-side is what makes a
synthesis failure surface out of `run_tts` as an `ErrorFrame`, instead of being swallowed in a
thread nobody awaits. `on_close` queueing `None` guarantees the consumer is released even when
the connection drops without either terminal callback — otherwise a dropped socket hangs the
pipeline forever.

Interruption calls `streaming_cancel` (v2+; older models would raise, hence the swallowed
`except`). The synthesizer handle is stored per-synthesis precisely so `cancel`/`stop` have
something to cancel.

Audio is requested as `PCM_24000HZ_MONO_16BIT` because the pipeline already runs at 24 kHz —
no resampler sits between the model and the transport.

### Setting translation

Cartesia and CosyVoice disagree about units, so `bot.py` maps the shared sliders:

| Molly setting | Cartesia | CosyVoice |
|---|---|---|
| `tts_speed` | multiplier | `speech_rate`, same 0.5–2.0 multiplier — passed through |
| `tts_volume` | gain, ~1.0 nominal | `volume`, 0–100 with 50 nominal — `round(v * 50)` clamped to 0–100 |
| `tts_emotion` | `generation_config` | not supported — ignored |

---

## Voice management

### API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/tts/cosyvoice/voices` | — | `{voices: [{voice_id, status, created, modified}]}` |
| `POST` | `/api/tts/cosyvoice/voices` | multipart: `prefix`, `target_model`, and either `sample` (file) or `url` | `{voice_id}` |
| `DELETE` | `/api/tts/cosyvoice/voices/{voice_id}` | — | `{status: "ok"}` |

All three read the **saved** DashScope key out of the user's settings — never a key posted
from the form. That's why the key field sits *above* the picker in the panel and why the
`no_key` message says to save first.

`list_voices` normalises each entry through `_as_voice()`, which accepts several key spellings
(`voice_id` / `voiceId` / `id`, `gmt_create` / `gmtCreate` / …). The SDK documents the response
shape only as "id, creation time, modification time, and status", and the names have moved
between versions; accepting the plausible set beats guessing one and rendering blanks.

### Errors

`VoiceError` carries a short code. `main.py:_voice_error` splits them: a known code is a
**400** and the UI translates it; anything else is a **502** with the upstream text truncated
to 300 chars, so an SDK stack trace never lands in the panel.

| Code | Meaning | Checked where |
|---|---|---|
| `no_key` | no saved DashScope key | before any network call |
| `bad_prefix` | not `^[a-z0-9]{1,9}$` | before any network call |
| `no_audio` | neither file nor URL given | before any network call |
| `too_large` | sample over 10 MB | before any network call |
| `bad_format` | extension not wav/mp3/m4a | before any network call |
| *(anything else)* | upstream rejection | 502 |

Everything cheap is validated locally, so a malformed request never costs a round trip.

### The open question: uploading a local file

**`create_voice` takes a URL, not a file** — the service fetches the sample itself. A desktop
app has a local recording, so `clone_voice` encodes uploaded bytes as
`data:{mime};base64,{...}` and passes that as the URL.

**This is documented for Qwen-TTS and not for CosyVoice, and it is unverified** — there is no
DashScope key in the dev environment to test it. Consequences, deliberately:

* the URL field stays in the UI as the guaranteed path;
* the generic upstream error text tells the user to host the file and paste a URL instead;
* if inline audio turns out to be rejected, the fix is contained to `clone_voice` (upload to
  OSS first, or proxy through a Molly-hosted temporary URL) and nothing above it changes.

---

## Settings and secrets

| Key | Secret? | Default |
|---|---|---|
| `tts_provider` | no | `cartesia` |
| `dashscope_api_key` | **yes** — in `SECRET_KEYS`, Fernet-encrypted | `""` |
| `cosyvoice_model` | no | `cosyvoice-v3.5-flash` |
| `cosyvoice_voice` | no | `""` |
| `cosyvoice_base_url` | no | `""` (SDK default = Beijing) |

Resolution order is the existing three-tier one: DB secrets → DB plain → `os.environ[KEY.upper()]`
→ hardcoded default. `GET /api/settings` returns `dashscope_key_configured` as a boolean and
never the key itself.

Changing any CosyVoice setting triggers a **full WebRTC reconnect** from `App.tsx`
(`hasPipelineChanged` covers `ttsProvider`, `cosyvoiceModel`, `cosyvoiceVoice`,
`cosyvoiceBaseUrl`, `dashscopeKey`), so a voice selected right after cloning takes effect
immediately. The datachannel `_RESTART_KEYS` path in `bot.py` is not involved.

---

## Frontend

`CosyVoicePicker.tsx` renders, in one column: a refresh control, a free-text voice id, the
account's voice list with select + delete, and a collapsible clone form.

Two choices worth recording:

* **The free-text field survives alongside the list.** A voice created in the Model Studio
  console, or by voice *design* rather than cloning, is perfectly valid and needn't appear in
  our list first. Removing the field would make those unreachable.
* **The list loads on demand, not on mount.** This matches `ModelPicker`, and avoids the
  `react-hooks/set-state-in-effect` lint rule the repo enforces — the same rule that shaped
  `ModelPicker`'s fetch-in-`openPicker()` design.

12 i18n keys per locale under `settings.*`, including the nested `settings.voiceError.*` map
that the error codes above index into; unknown codes fall back to `voiceError.upstream`.

### Bug fixed en route

`AuthContext.authFetch` unconditionally set `Content-Type: application/json`. A `FormData`
body must set its own `multipart/form-data; boundary=…`, so **every** upload through
`authFetch` would have failed — this was latent, the clone form is just the first caller.
Now it leaves `FormData` bodies alone.

---

## Verification status

Verified locally:

* the three routes are registered exactly once each, with the expected methods;
* FastAPI accepts the multipart signature — a `TestClient` round-trip passes both the
  file form and the URL-only form;
* all six rejection paths return the documented code;
* `create_voice` / `list_voices` / `delete_voice` exist on the installed SDK with the
  signatures we call;
* `tsc --noEmit` clean; eslint clean on the new component.

**Not verified — needs a DashScope key:**

1. **CosyVoice has never actually synthesized.** The whole WebSocket path is untested against
   a live account.
2. **Inline `data:` URI cloning** (see above).
3. **The `list_voices` response shape** — `_as_voice` guesses defensively but has never seen a
   real payload.

Note for whoever picks this up: `main.py` could not be imported in the dev interpreter —
`pwdlib` and `python-jose` aren't installed and molly-sachs has no venv (hypogum and tutor do).
Verification worked around it by replicating the route signatures against a bare FastAPI app.

---

## Next steps

* Run one real synthesis end to end; confirm interruption cancels cleanly mid-utterance.
* Clone one voice from a local file and settle the `data:` URI question. If it fails, add an
  upload-then-URL hop inside `clone_voice`.
* Consider a "preview this voice" button in the picker — synthesizing one sentence on demand
  is the only way to choose between several cloned voices without starting a call.
* `language_hints` on `create_voice` is unused; worth passing the user's `tts_language` once
  the basic path is proven.

---

## File map

| File | Role |
|---|---|
| `backend/cosyvoice_tts.py` | `CosyVoiceTTSService` — the Pipecat service and the thread→asyncio bridge |
| `backend/cosyvoice_voices.py` | list / clone / delete, validation, `VoiceError` |
| `backend/main.py` | the three routes, `_dashscope_key`, `_voice_error` |
| `backend/bot.py` | provider branch and setting translation |
| `backend/db/settings.py` | `dashscope_api_key` in `SECRET_KEYS`, CosyVoice defaults |
| `frontend/src/components/CosyVoicePicker.tsx` | the picker + clone form |
| `frontend/src/components/SettingsModal.tsx` | provider select, CosyVoice section |
| `frontend/src/contexts/AuthContext.tsx` | the `FormData` fix |
| `frontend/src/i18n/locales/{en,zh}.json` | 12 keys each |
