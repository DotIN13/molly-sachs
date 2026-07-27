"""DeepSeek with thinking mode kept on, and its reasoning carried back.

DeepSeek's v4 models think by default, and the API refused a follow-up with
"The `reasoning_content` in the thinking mode must be passed back to the API".
pipecat never carries it: the assistant message its aggregator writes for a tool
call is ``{"role": "assistant", "tool_calls": [...]}`` and nothing else — see
``llm_response_universal.py::_handle_function_call_in_progress`` — so the chain
of thought that produced the call is dropped before the next request, and
DeepSeek is asked to continue a reasoning it can no longer see.

So this keeps it. Reasoning deltas are teed off the stream as they arrive and
remembered against the tool call ids from the same completion; on the way out,
any assistant message carrying one of those calls gets its ``reasoning_content``
put back.

Honest limits: the reported 400 could not be reproduced by hand — four shapes of
raw request (plain multi-turn, single tool round, pipecat's exact
content-less assistant message, and multi-round tool calling) were all accepted.
What this fixes is the cause the API's own error names, which pipecat
demonstrably does not satisfy. If it happens again, ``_last_skeleton`` is logged
with the rejection, which says exactly which messages went out and which of them
carried reasoning.
"""

from loguru import logger
from pipecat.services.deepseek.llm import DeepSeekLLMService


class DeepSeekReasoningLLMService(DeepSeekLLMService):
    """DeepSeek, echoing each tool call's reasoning back as thinking mode wants."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Not capped. Any ceiling is a rule for forgetting the reasoning of a
        # call that may still be in the context, which is the exact failure this
        # class exists to prevent. An entry is a few hundred bytes and the dict
        # lives only as long as the pipeline session, so growth is bounded by the
        # conversation rather than by an arbitrary number.
        self._reasoning_by_call: dict[str, str] = {}
        self._last_skeleton: list[str] = []

    async def get_chat_completions(self, context):
        """Stream a completion, remembering the reasoning that comes with it."""
        try:
            stream = await super().get_chat_completions(context)
        except Exception as e:
            # The one failure worth explaining rather than just re-raising.
            if "reasoning_content" in str(e):
                logger.error(
                    "[deepseek] rejected for missing reasoning_content. Messages sent: {}",
                    " | ".join(self._last_skeleton),
                )
            raise
        return self._remember_reasoning(stream)

    async def _remember_reasoning(self, stream):
        """Pass chunks through untouched; keep the reasoning they carry.

        The mapping is built at the end rather than per delta because reasoning
        and tool call ids arrive interleaved, and it is the whole completion's
        reasoning that belongs to the calls it produced.
        """
        reasoning: list[str] = []
        call_ids: list[str] = []
        try:
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta is not None:
                    part = getattr(delta, "reasoning_content", None)
                    if part:
                        reasoning.append(part)
                    for call in delta.tool_calls or ():
                        if call.id and call.id not in call_ids:
                            call_ids.append(call.id)
                yield chunk
        finally:
            # In a finally so an interruption mid-stream still records what the
            # model had already committed to, which the context now holds.
            if reasoning and call_ids:
                text = "".join(reasoning)
                for call_id in call_ids:
                    self._reasoning_by_call[call_id] = text

    def build_chat_completion_params(self, params_from_context):
        """Reattach reasoning to the assistant messages that made tool calls."""
        params = super().build_chat_completion_params(params_from_context)
        messages = params.get("messages")
        if not messages:
            return params

        restored = 0
        out = []
        for message in messages:
            calls = message.get("tool_calls") if isinstance(message, dict) else None
            if (calls and message.get("role") == "assistant"
                    and not message.get("reasoning_content")):
                text = next(
                    (self._reasoning_by_call[c["id"]] for c in calls
                     if isinstance(c, dict) and self._reasoning_by_call.get(c.get("id"))),
                    None,
                )
                if text:
                    # Copied, not mutated: these dicts belong to the context and
                    # are reused on every subsequent request.
                    message = {**message, "reasoning_content": text}
                    restored += 1
            out.append(message)

        params["messages"] = out
        self._last_skeleton = [
            f"{m.get('role', '?')}"
            f"{'+tools' if m.get('tool_calls') else ''}"
            f"{'+reasoning' if m.get('reasoning_content') else ''}"
            for m in out if isinstance(m, dict)
        ]
        if restored:
            logger.debug("[deepseek] carried reasoning back on {} message(s)", restored)
        return params
