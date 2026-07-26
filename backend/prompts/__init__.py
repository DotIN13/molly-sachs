"""Jinja2 prompt templates for the chat pipeline.

Molly's system prompt lives in ``system_prompt.md`` rather than as string
literals in ``bot.py``, so it can be read and edited as prose instead of as
concatenated Python. Mirrors the same arrangement in hypogum.
"""

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

PROMPTS_DIR = Path(__file__).resolve().parent

_env = Environment(
    loader=FileSystemLoader(str(PROMPTS_DIR)),
    autoescape=False,
    keep_trailing_newline=True,
    trim_blocks=True,
    lstrip_blocks=True,
    # A prompt silently missing a variable is worse than a loud failure: the
    # model would just get a blank where the instruction should be.
    undefined=StrictUndefined,
)


def render_prompt(name: str, **variables) -> str:
    """Render a template by filename, e.g. ``render_prompt("system_prompt.md")``."""
    return _env.get_template(name).render(**variables)
