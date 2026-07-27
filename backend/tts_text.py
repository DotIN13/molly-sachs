"""Sentence aggregation for TTS that doesn't wait on a character that never comes.

pipecat splits an LLM's stream into sentences before synthesising, and on
sentence-ending punctuation it does not emit right away: it sets a lookahead
flag and waits for the next *non-whitespace* character before asking NLTK
whether that really was a boundary. The wait exists to tell "$29." from
"$29. Next" — a genuine ambiguity in Latin text where a full stop is also a
decimal point and an abbreviation mark.

A reply that is one sentence never provides that character. The trailing "。"
sets the flag, the stream ends, and nothing is synthesised until
``LLMFullResponseEndFrame`` flushes the buffer — so speech starts only once the
whole reply has finished generating. Molly's replies are short by instruction,
frequently a single sentence, so this was most of them.

There is nothing to disambiguate for "。", "！", "？" and their kin: they are
sentence ends and nothing else, which is why pipecat itself keeps them in
``UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION``. This aggregator emits on those
immediately and leaves Latin punctuation to the original lookahead path.
"""

from collections.abc import AsyncIterator

from pipecat.utils.string import UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION
from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator


class EagerSentenceAggregator(SimpleTextAggregator):
    """Emits a sentence as soon as punctuation that can only end one arrives."""

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        """Yield finished sentences, without a lookahead where none is needed."""
        if self._aggregation_type != AggregationType.SENTENCE:
            async for aggregation in super().aggregate(text):
                yield aggregation
            return

        for char in text:
            if char in UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION:
                self._text += char
                # A previous character may have armed the lookahead; this
                # sentence is over either way, so it must not stay armed and
                # swallow the start of the next one.
                self._needs_lookahead = False
                sentence, self._text = self._text, ""
                if sentence.strip():
                    yield Aggregation(text=sentence.strip(" "),
                                      type=AggregationType.SENTENCE)
                continue

            # Latin punctuation still needs NLTK and the lookahead, so hand
            # single characters back to the original implementation.
            async for aggregation in super().aggregate(char):
                yield aggregation
