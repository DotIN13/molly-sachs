import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo
import numpy as np
from loguru import logger

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.deepseek.llm import DeepSeekLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.llm_service import FunctionCallParams

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter

from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.frames.frames import (
    TextFrame,
    AudioRawFrame,
    Frame,
    TranscriptionFrame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    LLMMessagesAppendFrame,
    LLMMessagesUpdateFrame,
    LLMRunFrame,
    OutputTransportMessageFrame,
    InterruptionFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    UserSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)

import database
import hypogum_client
import speaker_id
from prompts import render_prompt

# Settings that require tearing down and rebuilding the pipeline
_RESTART_KEYS = {
    "gemini_api_key", "cartesia_api_key", "soniox_api_key",
    "llm_provider", "llm_model",
    "openai_api_key", "anthropic_api_key", "deepseek_api_key",
    "stt_provider", "stt_language",
    "tts_provider", "tts_voice", "tts_volume", "tts_speed", "tts_emotion", "tts_language",
    # The speaker gate is a pipeline member, so switching it on or off means
    # rebuilding rather than flipping a flag on a live session.
    "speaker_gate_enabled",
    # Toggling the hypogum backend adds/removes the memory + run tools and
    # swaps the system prompt, so the pipeline must rebuild.
    "hypogum_base_url",
}


@dataclass
class SessionState:
    """Mutable state for a single WebRTC pipeline session.  Processors hold a
    reference to this object so that live toggles (voice_mode, speak_text) are
    visible without restarting the pipeline."""
    conversation_id: str
    user_id: str
    voice_mode: bool = False
    prefs: dict = field(default_factory=dict)

    @classmethod
    async def create(cls, user_id: str, conversation_id: str) -> "SessionState":
        from db.settings import Settings
        prefs = await Settings(user_id).load()
        return cls(conversation_id=conversation_id, user_id=user_id, prefs=prefs)


class PipelineRestartRequested(Exception):
    """Raised when session_state_updated changes a setting that requires
    rebuilding the pipeline (API keys, STT/TTS provider, etc.)."""

    def __init__(self, changes: dict):
        super().__init__(f"Pipeline restart required for: {list(changes.keys())}")
        self.changes = changes


# Provider default models when the user leaves the model field blank.
_LLM_DEFAULT_MODELS = {
    "google": "gemini-3.1-flash-lite",
    "openai": "gpt-4.1",
    "anthropic": "claude-sonnet-4-6",
    "deepseek": "deepseek-chat",
}


def _build_llm(prefs: dict):
    """Instantiate the chat LLM service for the user's selected provider.

    All four services subclass pipecat's LLMService and speak the universal
    LLMContext, so they're drop-in interchangeable in the pipeline and with the
    tool list. A blank ``llm_model`` falls back to the provider's default."""
    provider = (prefs.get("llm_provider") or "google").strip().lower()
    model = (prefs.get("llm_model") or "").strip() or \
        _LLM_DEFAULT_MODELS.get(provider) or _LLM_DEFAULT_MODELS["google"]
    if provider == "openai":
        return OpenAILLMService(
            api_key=prefs.get("openai_api_key", ""),
            settings=OpenAILLMService.Settings(model=model),
        )
    if provider == "anthropic":
        return AnthropicLLMService(
            api_key=prefs.get("anthropic_api_key", ""),
            settings=AnthropicLLMService.Settings(model=model),
        )
    if provider == "deepseek":
        return DeepSeekLLMService(
            api_key=prefs.get("deepseek_api_key", ""),
            settings=DeepSeekLLMService.Settings(model=model),
        )
    return GoogleLLMService(
        api_key=prefs.get("gemini_api_key", ""),
        settings=GoogleLLMService.Settings(model=model),
    )


async def _fetch_persona(hypogum_url: str | None) -> str:
    """Molly's persona, read live from the user's hypogum instance.

    Kept out of this repo on purpose — it's the user's own writing about their
    own companion. Returns "" (→ the bundled default persona) when no hypogum
    is configured, none is written, or the instance is down.
    """
    if not hypogum_url:
        return ""
    return await hypogum_client.fetch_prompt("persona", base_url=hypogum_url)


def _build_messages(past_messages: list, timezone: str | None = None,
                    memory_enabled: bool = True, persona: str = "") -> list:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S %A")
    if timezone:
        try:
            tz = ZoneInfo(timezone)
            now_str = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S %A")
        except Exception:
            pass
    system_prompt = render_prompt(
        "system_prompt.md", memory_enabled=memory_enabled, now=now_str,
        persona=persona.strip(),
    )
    result = [{"role": "system", "content": system_prompt}]
    for msg in past_messages:
        # "tool" rows are display-only records of tool calls/results for the
        # chat transcript — never feed them back to the LLM (they aren't valid
        # tool-response turns; live tool-calling context is managed by pipecat).
        if msg["role"] == "tool":
            continue
        role = "assistant" if msg["role"] == "tip" else msg["role"]
        result.append({"role": role, "content": msg["content"]})
    return result


def _one_line(value: str | None) -> str:
    """Collapse a memory field to a single line of single-spaced text."""
    return " ".join((value or "").split())


def _title_cell(value: str | None) -> str:
    """A title safe to place before the ``": "`` that separates it from the
    snippet. A title of its own containing ``": "`` would otherwise make the
    transcript card end the title early and fold the rest into the snippet."""
    return _one_line(value).replace(": ", " - ")


def make_search_memory(user_id: str, hypogum_url: str | None, send_fn=None):
    """Factory returning a search_memory callable that queries the user's
    hypogum instance (the memory brain) via semantic search. Captures the
    per-user hypogum base URL (and optional send_fn) in its closure."""

    async def search_memory(params: FunctionCallParams, query: str):
        """Search the user's long-term memory. Call this BEFORE answering.

        Searching first is the default, not something to do only when the user
        asks you to remember. Call it whenever the reply could touch the user
        themselves: their past activity, habits, preferences, tools, projects,
        goals, the people they work with, or anything they have told you in an
        earlier conversation. Call it before giving advice or an opinion about
        their work, so the answer is grounded in their actual situation.

        Skip it only for a pure greeting, a general-knowledge question with no
        connection to the user, or an immediate follow-up to a search you just
        ran. When unsure, search: an empty result costs one quick call, while
        answering without context that existed is the failure this tool exists
        to prevent.

        The memory stores categorized facts about the user: traits (personality),
        preferences (tools, workflows, habits), interests (topics they care about),
        skills (technical abilities), goals (learning or achievement targets),
        relationships (workplaces, teams, people), ownerships (projects, assets),
        weaknesses (areas for improvement), and events (past activities).

        Args:
            query: A natural-language search string to find semantically similar memories.
        """
        try:
            results = await hypogum_client.search_memory(query, limit=8, base_url=hypogum_url)

            search_lines = [f"search-memory \"{query[:100]}\" → {len(results)} results"]
            for r in results:
                label = r.get("category") or r.get("type") or "?"
                search_lines.append(f"  [{label}] \"{(r.get('title') or r.get('snippet',''))[:70]}\"")
            logger.info("\n".join(search_lines))

            # One memory per line, with internal whitespace collapsed. The same
            # string is what the transcript's tool card renders, and it splits
            # on newlines to show each hit as its own item — a snippet
            # containing a newline would run two memories together there.
            context_str = "\n".join(
                f"[{r.get('category') or r.get('type') or 'memory'}] "
                f"{_title_cell(r.get('title'))}: {_one_line(r.get('snippet'))}"
                for r in results
            ).strip()
            if not context_str:
                context_str = "No relevant memories found yet."

            await params.result_callback(context_str)
        except Exception as e:
            await params.result_callback(f"Error searching memory: {e!s}")

    return search_memory


def make_grep_memory(hypogum_url: str | None, send_fn=None):
    """Factory for the `grep_memory` tool — literal search over memory pages.

    The complement to `search_memory`: embeddings blur exact strings (a name, a
    date, a URL, a project slug), grep nails them. Deliberately shaped like the
    grep every coding agent knows — arg named `pattern`, results printed with
    ripgrep's path heading and `12:`/`13-` line prefixes — so the model reaches
    for it with the habits it already has, including the natural follow-up of
    `read_memory_page` on a promising path."""

    async def grep_memory(params: FunctionCallParams, pattern: str):
        """Search memory for an exact string or regex, with surrounding lines.

        Use this when you know the literal text to look for and want precision:
        a person's name, a project or tool name, a date like "2026-03", a URL,
        a filename. Also use it as a second pass when `search_memory` returned
        something close but not the exact page you need.

        Use `search_memory` instead when the question is fuzzy ("what sports
        does he like") — that one matches by meaning, this one by characters.

        Results come back grep-style: the page path on its own line, then its
        lines as `12: text` where the match is and `13- text` for surrounding
        context. If a page looks relevant but the excerpt is cut off, read it
        in full with `read_memory_page(path)`.

        Args:
            pattern: Literal text or a regular expression (case-insensitive).
        """
        try:
            blocks = await hypogum_client.grep_memory(pattern, limit=8, base_url=hypogum_url)

            logger.info("grep-memory \"{}\" → {} pages: {}", pattern[:100], len(blocks),
                        ", ".join(b.get("file", "") for b in blocks[:5]))

            if not blocks:
                await params.result_callback(f"No memory line matches \"{pattern}\".")
                return
            await params.result_callback(
                "\n\n".join(f"{b.get('file', '')}\n{b.get('block', '')}"
                            for b in blocks).strip()
            )
        except Exception as e:
            await params.result_callback(f"Error grepping memory: {e!s}")

    return grep_memory


def make_add_memory(user_id: str, hypogum_url: str | None, send_fn=None):
    """Factory returning an add_memory callable.

    Rather than writing a structured memory page directly, it drops the user's
    statement into hypogum's ingest inbox. The memory *ingest agent* picks it up
    next cycle, decides the category, and merges it into the wiki (dedup +
    evidence). Molly just captures the raw fact — categorization is agent-side."""

    async def add_memory(params: FunctionCallParams, fact: str):
        """Remember something the user revealed about themselves.

        The raw statement is queued for the memory ingest agent, which decides
        the category (trait, preference, interest, skill, goal, relationship,
        ownership, weakness, event) and folds it into long-term memory. You do
        NOT categorize — just capture the fact clearly, in the user's own terms.

        Be proactive: call this whenever the user shares something about
        themselves, their preferences, plans, work, or life — better to record
        than to forget.

        Only ever record facts about the *user*. Never record anything about
        yourself — your own life, work, past or feelings are part of who you
        are, not something this store holds. Writing them here would corrupt a
        record of real facts about a real person with invented ones.

        Args:
            fact: A concise, self-contained sentence capturing what the user said.
        """
        try:
            result = await hypogum_client.submit_note(fact, base_url=hypogum_url)
            logger.info("Memory note queued for ingest: {} [{}]",
                        fact[:100], result.get("queued", ""))
            await params.result_callback(f"记下了,稍后会整理进记忆:{fact}")
        except Exception as e:
            logger.error("Error queueing memory note: {}", e)
            await params.result_callback(f"Failed to store memory: {e!s}")

    return add_memory


_RUN_TERMINAL = {"done", "error", "timeout", "aborted"}

# Hold references to fire-and-forget background tasks so they aren't garbage
# collected mid-flight (see asyncio.create_task docs).
_BG_TASKS: set[asyncio.Task] = set()


def make_run_task(hypogum_url: str | None, *, task_holder: dict, send_fn=None):
    """Factory for the `run_task` tool — voice-driven autonomy.

    Enqueues a freeform run on the user's hypogum agent, returns immediately,
    then, when the run completes, injects a result briefing into the LLM context
    and triggers one inference so Molly narrates the outcome in her own words.

    `task_holder` is a mutable dict whose "task" key is set to the PipelineTask
    after the pipeline is built, so completion can push frames into the pipeline.
    """

    async def _poll_and_narrate(run_id: str, task_desc: str):
        """Poll the run to completion, then inject a result briefing into the LLM
        context and trigger one inference so Molly narrates the outcome in her own
        words (context-consistent, natural phrasing). The generated reply flows
        through the normal pipeline → AssistantBroadcaster (persist + broadcast)
        → TTS, so no manual DB write or TTS frame is needed here."""
        status = "queued"
        deadline = time.time() + 1900  # ~31 min ceiling
        try:
            run = None
            while time.time() < deadline:
                await asyncio.sleep(5)
                run = await hypogum_client.get_run(run_id, base_url=hypogum_url)
                if not run:
                    continue
                status = run.get("status", "queued")
                if status in _RUN_TERMINAL:
                    break
            else:
                run = None
                status = "timeout"

            # Assemble a briefing for the model. We inject it as a user-role turn
            # (guaranteed to reach the LLM and trigger a natural reply); it is NOT
            # persisted to the DB — only the assistant's generated narration is.
            if status == "done":
                summary = (run or {}).get("summary")
                try:
                    arts = await hypogum_client.list_artifacts(limit=5, base_url=hypogum_url)
                except Exception:
                    arts = []
                art_titles = "、".join(
                    (a.get("title") or a.get("name") or a.get("id", "")) for a in arts[:3]
                )
                brief = (
                    f"[后台任务完成通知] 你之前交给后台 agent 的任务「{task_desc}」已经完成（状态：done）。"
                    f"结果摘要：{summary or '（无摘要）'}。"
                    f"{('产出物：' + art_titles + '。') if art_titles else ''}"
                    "请你现在主动、自然、口语化地把这个结果告诉用户，简短一点，"
                    "并可以顺带问一句是否需要查看结果。"
                )
            else:
                brief = (
                    f"[后台任务完成通知] 你之前交给后台 agent 的任务「{task_desc}」这次没能完成"
                    f"（状态：{status}）。请你自然地把这个情况告诉用户，并询问是否要再试一次。"
                )

            if send_fn:
                await send_fn({"type": "run_done", "run_id": run_id, "status": status})

            task = task_holder.get("task")
            if task is not None:
                try:
                    await task.queue_frames([
                        LLMMessagesAppendFrame(
                            messages=[{"role": "user", "content": brief}],
                            run_llm=True,
                        )
                    ])
                except Exception as e:
                    logger.warning("run narrate trigger failed: {}", e)
            else:
                logger.warning("run {} done but pipeline task gone; skip narrate", run_id)
            logger.info("run {} narrate-triggered ({}): {}", run_id, status, task_desc[:60])
        except Exception as e:
            logger.error("run narrate failed for {}: {}", run_id, e)

    async def run_task(params: FunctionCallParams, task_description: str):
        """Delegate a preparatory task to the user's hypogum agent, which runs it
        in the background and produces artifacts (drafts, research, files, etc.).

        Use this when the user asks you to *do* something that takes real work —
        draft an email, research a topic, gather/organize material, prepare a
        document. It returns immediately; the result is narrated when ready.

        Args:
            task_description: A clear, self-contained instruction for the agent.
        """
        try:
            run = await hypogum_client.submit_run(task_description, base_url=hypogum_url)
            run_id = run.get("id")
            if not run_id:
                await params.result_callback("Failed to start the task (no run id).")
                return
            bg = asyncio.create_task(_poll_and_narrate(run_id, task_description))
            _BG_TASKS.add(bg)
            bg.add_done_callback(_BG_TASKS.discard)
            logger.info("run_task queued {}: {}", run_id, task_description[:80])
            await params.result_callback(
                f"好的，我已经让后台开始处理「{task_description}」了，完成后我告诉你。"
            )
        except Exception as e:
            logger.error("run_task failed: {}", e)
            await params.result_callback(f"启动任务失败：{e!s}")

    return run_task


def make_read_memory_page(hypogum_url: str | None, send_fn=None):
    """Factory for the `read_memory_page` tool — read one memory page in full."""

    async def read_memory_page(params: FunctionCallParams, path: str):
        """Read the full content of a specific memory page.

        Use after `search_memory` or `grep_memory` surfaces a page whose full
        details you need, or when the user asks about a specific remembered
        topic. Returns the page's title and body text.

        Args:
            path: The memory page path (e.g. "goals/learn_trading.md"), as
                returned by `search_memory` or `grep_memory`.
        """
        try:
            page = await hypogum_client.read_memory_page(path, base_url=hypogum_url)
            if not page:
                await params.result_callback(f"No memory page found at {path}.")
                return
            title = (page.get("title") or path).strip()
            body = (page.get("body") or page.get("content") or "").strip()
            await params.result_callback(f"# {title}\n\n{body}" if body else title)
        except Exception as e:
            await params.result_callback(f"Error reading memory page: {e!s}")

    return read_memory_page


def make_fetch_calendar(hypogum_url: str | None, send_fn=None):
    """Factory for the `fetch_calendar` tool — look up the user's schedule."""

    async def fetch_calendar(params: FunctionCallParams,
                             from_date: str = "", to_date: str = ""):
        """Look up the user's calendar events (observed, planned, suggested).

        Use when the user asks about their schedule, upcoming events, what they
        did on a given day, or when you need to plan around their time.

        Args:
            from_date: Optional start date (YYYY-MM-DD) to filter from. Empty = no lower bound.
            to_date: Optional end date (YYYY-MM-DD) to filter to. Empty = no upper bound.
        """
        try:
            entries = await hypogum_client.fetch_calendar(
                frm=from_date or None, to=to_date or None, base_url=hypogum_url)
            if not entries:
                await params.result_callback("No calendar entries found.")
                return
            lines = []
            for e in entries[:30]:
                when = e.get("start") or e.get("date") or "?"
                lines.append(
                    f"[{e.get('bucket', '?')}] {when} — {e.get('title', '(untitled)')}")
            await params.result_callback("\n".join(lines))
        except Exception as e:
            await params.result_callback(f"Error fetching calendar: {e!s}")

    return fetch_calendar


def make_list_artifacts(hypogum_url: str | None, send_fn=None):
    """Factory for the `list_artifacts` tool — list agent-produced deliverables."""

    async def list_artifacts(params: FunctionCallParams):
        """List recent deliverables (artifacts) produced by background agent runs.

        Use when the user asks what files or results the agent has produced, or
        to reference a past deliverable.
        """
        try:
            arts = await hypogum_client.list_artifacts(limit=20, base_url=hypogum_url)
            if not arts:
                await params.result_callback("No artifacts yet.")
                return
            lines = []
            for a in arts[:20]:
                label = (a.get("title") or a.get("name") or a.get("id") or "?").strip()
                when = (a.get("created") or "")[:10]
                lines.append(f"- {label}{f' ({when})' if when else ''}")
            await params.result_callback("\n".join(lines))
        except Exception as e:
            await params.result_callback(f"Error listing artifacts: {e!s}")

    return list_artifacts


class MicFilterProcessor(FrameProcessor):
    """Filters outgoing microphone audio if voice mode is inactive."""
    def __init__(self, session: SessionState):
        super().__init__()
        self._session = session

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._session.voice_mode:
                return
        await self.push_frame(frame, direction)


class SpeakerGateProcessor(FrameProcessor):
    """Keeps speech that is not the enrolled voice out of the rest of the pipeline.

    Sits *before* the STT service, with the VAD ahead of it, so a television has
    three fewer ways to matter: its audio is never transcribed (no bill), never
    reaches the aggregator (no interruption, no reply), and never lands in the
    chat log or in memory.

    **Audio is withheld, not dropped.** Dropping while undecided would eat the
    first second of your own sentence and STT would never hear those words. So
    audio is buffered until there is a verdict, then either replayed to STT in
    order or discarded wholesale. The replay is one burst, which a streaming STT
    absorbs before catching up live, so the delay lands on the front of the
    utterance rather than on the answer.

    **VAD frames are released at once while she is silent, withheld while she is
    speaking.** Silent, there is nothing to protect and a turn should start the
    instant you speak. Speaking, withholding them until the verdict is what
    stops a television from cutting her off, at the cost of your own barge-in
    arriving a fraction of a second later.

    Whichever way it is unsure — too little audio, no model, a scoring error —
    it lets speech through. Refusing to listen is the worse failure.
    """

    # Enough speech to judge on. This doubles as how long barge-in is delayed
    # while she is speaking, so it wants to be the shortest window that still
    # separates voices rather than the most confident one — but not shorter.
    # Measured against the default 0.5 threshold, scores fall as the window
    # narrows even though the separation holds: at 0.6s the enrolled voice
    # scored as low as 0.499, which would have rejected its owner. At 0.8s the
    # floor was 0.605 while another voice peaked at 0.331, leaving room on both
    # sides. Matches speaker_id.MIN_SECONDS so anything too short to judge is
    # never judged at all.
    _DECIDE_AFTER = 0.8

    def __init__(self, reference, threshold: float, sample_rate: int = 16000,
                 send_fn=None):
        super().__init__()
        self._reference = reference
        self._threshold = threshold
        self._rate = sample_rate
        self._send_fn = send_fn
        self._bot_speaking = False
        self._reset()

    def _reset(self) -> None:
        """Start a fresh stretch of speech with no verdict and nothing held."""
        self._scored = bytearray()      # audio measured for the verdict
        self._withheld: list[Frame] = []  # frames waiting on it, in order
        self._verdict: bool | None = None
        # Whether the start of this stretch already reached the aggregator. If
        # it did, its stop has to reach it as well even on a rejection, or the
        # turn it opened never closes.
        self._start_forwarded = False

    @property
    def _withholding(self) -> bool:
        """True while VAD frames should wait for a verdict."""
        return self._bot_speaking

    async def _release(self) -> None:
        """Forward everything held back, in the order it arrived."""
        held, self._withheld = self._withheld, []
        for frame in held:
            if isinstance(frame, VADUserStartedSpeakingFrame):
                self._start_forwarded = True
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)

    async def _settle(self) -> None:
        """Score what has been heard, then release or discard what is held."""
        await self._decide()
        if self._verdict:
            await self._release()
        else:
            self._withheld.clear()

    async def _decide(self) -> None:
        """Score the speech heard so far. Sets a verdict; never raises."""
        try:
            emb = await asyncio.to_thread(
                speaker_id.embed, speaker_id.pcm_to_float(bytes(self._scored)), self._rate)
        except Exception as e:
            logger.warning("speaker gate: scoring failed, letting it through: {}", e)
            self._verdict = True
            return

        if emb is None:
            self._verdict = True        # no opinion is not a rejection
            return

        score = speaker_id.similarity(self._reference, emb)
        self._verdict = score >= self._threshold
        logger.info("speaker gate: {:.3f} vs {:.2f} → {}", score, self._threshold,
                    "accept" if self._verdict else "reject")
        if self._send_fn and not self._verdict:
            try:
                await self._send_fn({"type": "speech_rejected", "score": round(score, 3)})
            except Exception:
                pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            # She has stopped, so nothing is being protected any more; anything
            # still waiting on a verdict may as well go now.
            if self._verdict is None:
                await self._release()

        elif isinstance(frame, VADUserStartedSpeakingFrame):
            self._reset()
            if self._withholding:
                self._withheld.append(frame)
                return
            self._start_forwarded = True

        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            # Speech ended before the window filled: judge on what there is,
            # because a short "嗯" still deserves an answer.
            if self._verdict is None and self._scored:
                await self._settle()
            # A rejection still has to close a turn it was allowed to open.
            if self._verdict is False and not self._start_forwarded:
                return

        elif isinstance(frame, UserSpeakingFrame):
            if self._verdict is None and self._withholding:
                self._withheld.append(frame)
                return
            if self._verdict is False:
                return

        elif isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if self._verdict is False:
                return                  # someone else; STT never sees it
            if self._verdict is None:
                self._scored.extend(frame.audio)
                self._withheld.append(frame)
                # The verdict lands as soon as there is enough to judge on, so
                # what is held can never exceed one window's worth of audio.
                if len(self._scored) >= int(self._DECIDE_AFTER * self._rate) * 2:
                    await self._settle()
                return

        elif isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            # A second net: while she is silent the VAD frames and the leading
            # audio go straight through, so STT can already have produced words
            # for a voice that is then rejected.
            if self._verdict is False:
                return

        await self.push_frame(frame, direction)


class AudioLevelProcessor(FrameProcessor):
    """Calculates microphone audio level, sends to frontend (~10 msg/sec), and gates noise when bot is speaking."""
    def __init__(self, transport: SmallWebRTCTransport):
        super().__init__()
        self._transport = transport
        self._frame_count = 0
        self._bot_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            self._frame_count += 1
            audio = frame.audio
            level = 0.0
            if audio is not None and len(audio) > 0:
                samples = np.frombuffer(audio, dtype=np.int16).astype(np.float64)
                rms = float(np.sqrt(np.mean(np.square(samples))))
                level = min(1.0, rms / 8000.0)
            if self._frame_count % 10 == 0:
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={
                        "type": "audio_level",
                        "level": level
                    })
                )
        await self.push_frame(frame, direction)


class TTSFilterProcessor(FrameProcessor):
    """Filters outgoing TTS audio if the assistant should remain silent."""
    def __init__(self, session: SessionState):
        super().__init__()
        self._session = session

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, AudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if not self._session.voice_mode and self._session.prefs.get("speak_text", "true") != "true":
                return
        await self.push_frame(frame, direction)


class UserBroadcaster(FrameProcessor):
    """Intercepts and broadcasts user voice transcriptions to the frontend instantly."""
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str,
                 user_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id
        self._user_id = user_id

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TranscriptionFrame):
                if not getattr(frame, "interim_results", False):
                    await database.app.add_message(
                        self._conversation_id, "user", frame.text, self._user_id
                    )
                    await self._transport._client.send_message(
                        OutputTransportMessageFrame(message={
                            "type": "transcript",
                            "text": frame.text,
                            "user": frame.user_id
                        })
                    )
        await self.push_frame(frame, direction)


class AssistantBroadcaster(FrameProcessor):
    """Intercepts and broadcasts assistant response text chunks to the frontend instantly."""
    def __init__(self, transport: SmallWebRTCTransport, conversation_id: str,
                 user_id: str):
        super().__init__()
        self._transport = transport
        self._conversation_id = conversation_id
        self._user_id = user_id
        self._buffer = []

    def set_conversation_id(self, cid: str):
        self._conversation_id = cid

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._buffer = []
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "start"}))
            elif isinstance(frame, TextFrame) and not isinstance(frame, TranscriptionFrame):
                self._buffer.append(frame.text)
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "chunk", "text": frame.text}))
            elif isinstance(frame, LLMFullResponseEndFrame):
                full_text = "".join(self._buffer)
                if full_text.strip():
                    await database.app.add_message(
                        self._conversation_id, "assistant", full_text, self._user_id
                    )
                await self._transport._client.send_message(
                    OutputTransportMessageFrame(message={"type": "end"}))
        await self.push_frame(frame, direction)


class ToolCallBroadcaster(FrameProcessor):
    """Records every LLM tool call + its result and streams them to the frontend
    so they render as tool cards inside the chat transcript.

    Observes the function-call frames the LLM service emits downstream:
      • FunctionCallInProgressFrame → live "tool running" card
      • FunctionCallResultFrame     → fill in the result + persist a `tool` row
    The persisted rows are display-only (skipped by `_build_messages`)."""

    def __init__(self, transport: SmallWebRTCTransport, session: "SessionState"):
        super().__init__()
        self._transport = transport
        self._session = session

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, FunctionCallInProgressFrame):
            await self._transport._client.send_message(
                OutputTransportMessageFrame(message={
                    "type": "tool_start",
                    "tool_call_id": frame.tool_call_id,
                    "name": frame.function_name,
                    "args": frame.arguments,
                }))
        elif isinstance(frame, FunctionCallResultFrame):
            result = frame.result
            result_str = result if isinstance(result, str) else json.dumps(
                result, ensure_ascii=False, default=str)
            payload = {
                "name": frame.function_name,
                "args": frame.arguments,
                "result": result_str,
            }
            try:
                await database.app.add_message(
                    self._session.conversation_id, "tool",
                    json.dumps(payload, ensure_ascii=False),
                    self._session.user_id,
                )
            except Exception as e:
                logger.warning("tool record persist failed: {}", e)
            await self._transport._client.send_message(
                OutputTransportMessageFrame(message={
                    "type": "tool_result",
                    "tool_call_id": frame.tool_call_id,
                    **payload,
                }))
        await self.push_frame(frame, direction)


async def start_pipecat_session(
    connection: SmallWebRTCConnection,
    session: SessionState,
):
    """Initializes and starts a single WebRTC Pipecat pipeline session."""
    conv_id = session.conversation_id
    user_id = session.user_id
    prefs = session.prefs
    try:
        transport = SmallWebRTCTransport(
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_filter=RNNoiseFilter(),
                audio_out_enabled=True
            ),
            webrtc_connection=connection
        )

        @transport.event_handler("on_app_message")
        async def _early_session_state(transport, message, _sender):
            if isinstance(message, dict) and message.get("type") == "session_state_updated":
                changes = message.get("changes", {})
                if not isinstance(changes, dict):
                    return
                if "voice_mode" in changes:
                    session.voice_mode = bool(changes["voice_mode"])
                if "speak_text" in changes:
                    session.prefs["speak_text"] = "true" if changes["speak_text"] else "false"

        hypogum_url = prefs.get("hypogum_base_url") or None
        llm = _build_llm(prefs)
        # Memory + autonomy tools activate only when a hypogum backend is set.
        # Without one, Molly is a plain chat client (no tools, base prompt).
        memory_enabled = bool(hypogum_url)
        task_holder: dict = {}  # lets the run_task narrator reach the PipelineTask
        # Used by the tools and by the speaker gate, so it cannot live inside
        # the memory branch.
        _send = lambda msg: transport._client.send_message(
            OutputTransportMessageFrame(message=msg))
        tools = []
        if memory_enabled:
            tools = [
                make_search_memory(user_id, hypogum_url, send_fn=_send),
                make_grep_memory(hypogum_url, send_fn=_send),
                make_add_memory(user_id, hypogum_url, send_fn=_send),
                make_read_memory_page(hypogum_url, send_fn=_send),
                make_fetch_calendar(hypogum_url, send_fn=_send),
                make_list_artifacts(hypogum_url, send_fn=_send),
                make_run_task(hypogum_url, task_holder=task_holder, send_fn=_send),
            ]
        stt_provider = prefs.get("stt_provider", "soniox")
        stt_language = prefs.get("stt_language", "zh")
        if stt_provider == "cartesia":
            stt = CartesiaSTTService(
                api_key=prefs.get("cartesia_api_key"),
                settings=CartesiaSTTService.Settings(
                    model="ink-whisper",
                    language=stt_language,
                ),
            )
        else:
            stt = SonioxSTTService(
                api_key=prefs.get("soniox_api_key"),
                settings=SonioxSTTService.Settings(
                    language=stt_language,
                ),
            )

        tts_provider = prefs.get("tts_provider", "cartesia")
        if tts_provider == "cartesia":
            tts_voice = prefs.get("tts_voice", "6eb8965c-e295-47bd-a9e4-3eeebb3abcff")
            tts_volume = float(prefs.get("tts_volume", "1.0"))
            tts_speed = float(prefs.get("tts_speed", "1.0"))
            tts_emotion = prefs.get("tts_emotion")
            if not tts_emotion or tts_emotion == "neutral":
                tts_emotion = None
            generation_config = GenerationConfig(
                volume=tts_volume, speed=tts_speed, emotion=tts_emotion
            )
            tts_language = prefs.get("tts_language", "en")
            tts = CartesiaTTSService(
                api_key=prefs.get("cartesia_api_key"),
                settings=CartesiaTTSService.Settings(
                    model="sonic-3.5",
                    voice=tts_voice,
                    language=tts_language,
                    generation_config=generation_config
                )
            )
        elif tts_provider == "cosyvoice":
            from cosyvoice_tts import DEFAULT_MODEL, CosyVoiceTTSService
            # Cartesia takes speed as a multiplier and volume as a gain; CosyVoice
            # uses the same 0.5–2.0 multiplier for rate but a 0–100 scale for
            # volume, so the shared tts_volume setting is mapped onto it.
            tts = CosyVoiceTTSService(
                api_key=prefs.get("dashscope_api_key", ""),
                model=prefs.get("cosyvoice_model") or DEFAULT_MODEL,
                voice=prefs.get("cosyvoice_voice", ""),
                speech_rate=float(prefs.get("tts_speed", "1.0")),
                volume=max(0, min(100, round(float(prefs.get("tts_volume", "1.0")) * 50))),
                base_url=prefs.get("cosyvoice_base_url") or None,
            )
        else:
            raise ValueError(f"Unknown tts_provider: {tts_provider!r}")

        past_messages = await database.app.get_messages(conv_id, user_id)
        formatted_messages = _build_messages(
            past_messages, prefs.get("timezone"), memory_enabled,
            await _fetch_persona(hypogum_url))

        context = LLMContext(messages=formatted_messages, tools=tools)
        vad_params = VADParams(
            start_secs=0.2, stop_secs=0.8, confidence=0.75, min_volume=0.1,
        )
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                # No vad_analyzer: the VAD now runs as its own processor ahead
                # of the speaker gate and STT, so nothing this side of it ever
                # sees audio from a voice that was rejected. The turn strategy
                # is unchanged — it reacts to VAD frames either way, and the
                # aggregator hands every frame to the turn controller
                # regardless of whether it owns a VAD.
                user_turn_strategies=UserTurnStrategies(
                    start=[VADUserTurnStartStrategy()],
                ),
            ),
        )

        mic_filter = MicFilterProcessor(session)
        # Ahead of the speaker gate on purpose: the gate needs speech
        # boundaries to score against, and it must keep receiving them even
        # for the audio it withholds. A VAD downstream of the gate would be
        # starved by exactly the frames the gate is deciding about.
        vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=vad_params))
        tts_filter = TTSFilterProcessor(session)
        user_broadcaster = UserBroadcaster(transport, conv_id, user_id)
        assistant_broadcaster = AssistantBroadcaster(transport, conv_id, user_id)
        tool_broadcaster = ToolCallBroadcaster(transport, session)
        audio_level = AudioLevelProcessor(transport)

        # Three things have to line up, and all three are reasons to stay out of
        # the path entirely rather than to sit in it doing nothing: the user has
        # to have asked for it, there has to be a voice to compare against, and
        # the model has to be on disk.
        speaker_gate = None
        gate_wanted = prefs.get("speaker_gate_enabled", "false").lower() == "true"
        reference = speaker_id.decode(prefs.get("speaker_reference", ""))
        if gate_wanted and reference is not None and speaker_id.available():
            speaker_gate = SpeakerGateProcessor(
                reference,
                threshold=float(prefs.get("speaker_threshold", "0.5")),
                send_fn=_send,
            )
            logger.info("Speaker gate active (threshold {})",
                        prefs.get("speaker_threshold", "0.5"))

        pipeline = Pipeline([
            transport.input(),
            audio_level,
            mic_filter,
            vad,
            *([speaker_gate] if speaker_gate else []),
            stt,
            user_broadcaster,
            user_aggregator,
            llm,
            tool_broadcaster,
            assistant_broadcaster,
            tts,
            tts_filter,
            transport.output(),
            assistant_aggregator,
        ])

        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=True,
                enable_metrics=True,
                enable_usage_metrics=True,
            )
        )
        # Let the run_task narrator speak completion updates through this task.
        task_holder["task"] = task

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("Client connected to WebRTC")

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, client):
            logger.info("Client disconnected from WebRTC — cancelling pipeline task")
            await task.cancel()
            logger.info("Pipeline task cancelled after client disconnect")

        @transport.event_handler("on_app_message")
        async def on_app_message(transport, message, _sender):
            nonlocal conv_id
            if isinstance(message, dict) and message.get("type") == "chat":
                text = message.get("text")
                if text:
                    logger.info("Chat message received: {}", text)
                    await database.app.add_message(conv_id, "user", text, user_id)
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}]),
                        LLMRunFrame()
                    ])
            elif isinstance(message, dict) and message.get("type") == "switch_conversation":
                new_id = message.get("conversation_id")
                if new_id and new_id != conv_id:
                    if not await database.app.verify_conversation_owner(new_id, user_id):
                        logger.warning("Switch conversation denied: user {} does not own {}", user_id[:8], new_id)
                        return
                    logger.info("Switching conversation: {} -> {}", conv_id, new_id)
                    conv_id = new_id
                    session.conversation_id = new_id
                    user_broadcaster.set_conversation_id(new_id)
                    assistant_broadcaster.set_conversation_id(new_id)
                    msgs = await database.app.get_messages(new_id, user_id)
                    formatted = _build_messages(
                        msgs, session.prefs.get("timezone"), memory_enabled,
                        await _fetch_persona(hypogum_url))
                    await task.queue_frames([
                        InterruptionFrame(),
                        LLMMessagesUpdateFrame(messages=formatted, run_llm=False),
                    ])
                    await transport._client.send_message(
                        OutputTransportMessageFrame(message={
                            "type": "messages",
                            "messages": [{"role": m["role"], "content": m["content"]} for m in msgs]
                        })
                    )
            elif isinstance(message, dict) and message.get("type") == "session_state_updated":
                changes = message.get("changes", {})
                if not isinstance(changes, dict):
                    return

                restart_keys = _RESTART_KEYS & set(changes.keys())
                if restart_keys:
                    session.prefs.update(changes)
                    raise PipelineRestartRequested(changes)

                if "timezone" in changes:
                    session.prefs["timezone"] = str(changes["timezone"])
                    msgs = await database.app.get_messages(conv_id, user_id)
                    formatted = _build_messages(
                        msgs, session.prefs.get("timezone"), memory_enabled,
                        await _fetch_persona(hypogum_url))
                    await task.queue_frames([
                        LLMMessagesUpdateFrame(messages=formatted, run_llm=False),
                    ])

                logger.info("Session state updated: {}", {k: v for k, v in changes.items()
                            if k not in _RESTART_KEYS})

        runner = PipelineRunner()
        logger.info("Pipecat WebRTC Assistant running...")
        await runner.run(task)
        logger.info("Pipecat runner.run() returned")
    except PipelineRestartRequested:
        raise
    except asyncio.CancelledError:
        logger.info("Pipecat session cancelled.")
    except Exception as e:
        logger.exception("Pipecat task failed: {}", e)
    finally:
        logger.info("Pipecat session cleanup complete")
