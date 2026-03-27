from __future__ import annotations

import io
from typing import Any


class OpenAIVoice:
    """Voice provider backed by OpenAI Whisper (STT).

    Pass an instance to ``LangChainAdapter`` to enable audio support::

        from astropods_adapter_langchain import LangChainAdapter, OpenAIVoice

        adapter = LangChainAdapter(executor, voice=OpenAIVoice())
        adapter = LangChainAdapter(executor, voice=OpenAIVoice(model="whisper-1"))

    ``OPENAI_API_KEY`` is read from the environment automatically.
    """

    def __init__(self, model: str = "whisper-1") -> None:
        self._model = model

    async def listen(self, data: bytes, config: Any) -> str:
        """Transcribe audio bytes to text."""
        from openai import AsyncOpenAI

        client = AsyncOpenAI()
        f = io.BytesIO(data)
        f.name = "audio.webm"
        result = await client.audio.transcriptions.create(model=self._model, file=f)
        return result.text
