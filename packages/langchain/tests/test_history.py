import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from astropods_adapter_core.types import HistoryInput, HistoryMessageInput, StreamOptions
from astropods_adapter_langchain import LangChainAdapter

OPTIONS = StreamOptions(conversation_id="conv-1", user_id="user-1")

EDIT = HistoryInput(
    messages=[
        HistoryMessageInput(id="h1", role="user", content="q1"),
        HistoryMessageInput(id="h2", role="assistant", content="a1"),
    ],
    is_complete=True,
)


def _agent():
    checkpointer = InMemorySaver()
    agent = create_agent(model=FakeListChatModel(responses=["ok"]), tools=[], checkpointer=checkpointer)
    return agent, checkpointer


def _thread(checkpointer) -> list[str]:
    checkpoint = checkpointer.get({"configurable": {"thread_id": "conv-1"}})
    return [m.content for m in checkpoint["channel_values"]["messages"]] if checkpoint else []


async def _seed(adapter, hooks):
    await adapter.stream("q1", hooks, OPTIONS)
    await adapter.stream("q2", hooks, OPTIONS)


def _with_history(history: HistoryInput) -> StreamOptions:
    return StreamOptions(conversation_id="conv-1", user_id="user-1", history=history)


@pytest.mark.asyncio
async def test_an_edit_replaces_the_checkpointer_thread_with_the_given_history(hooks):
    agent, checkpointer = _agent()
    adapter = LangChainAdapter(agent)
    await _seed(adapter, hooks)

    await adapter.stream("q2 edited", hooks, _with_history(EDIT))

    hooks.on_error.assert_not_called()
    assert _thread(checkpointer) == ["q1", "a1", "q2 edited", "ok"]


@pytest.mark.asyncio
async def test_an_empty_history_starts_the_thread_over(hooks):
    agent, checkpointer = _agent()
    adapter = LangChainAdapter(agent)
    await _seed(adapter, hooks)

    await adapter.stream("q1 edited", hooks, _with_history(HistoryInput(messages=[], is_complete=True)))

    assert _thread(checkpointer) == ["q1 edited", "ok"]


@pytest.mark.asyncio
async def test_a_send_without_history_keeps_the_thread(hooks):
    agent, checkpointer = _agent()
    adapter = LangChainAdapter(agent)
    await _seed(adapter, hooks)

    await adapter.stream("q3", hooks, OPTIONS)

    assert _thread(checkpointer) == ["q1", "ok", "q2", "ok", "q3", "ok"]


@pytest.mark.asyncio
async def test_supports_history_false_leaves_the_thread_alone(hooks):
    agent, checkpointer = _agent()
    adapter = LangChainAdapter(agent, supports_history=False)
    await _seed(adapter, hooks)

    await adapter.stream("q2 edited", hooks, _with_history(EDIT))

    assert _thread(checkpointer) == ["q1", "ok", "q2", "ok", "q2 edited", "ok"]


def test_declares_history_support_by_default_and_not_when_opted_out():
    agent, _ = _agent()
    assert LangChainAdapter(agent).get_config()["supports_history"] is True
    assert LangChainAdapter(agent, supports_history=False).get_config()["supports_history"] is False


class SaverWithoutDelete(BaseCheckpointSaver):
    """Inherits BaseCheckpointSaver's adelete_thread, which raises NotImplementedError."""

    def __init__(self):
        super().__init__()
        self._inner = InMemorySaver()

    async def aget_tuple(self, config):
        return await self._inner.aget_tuple(config)

    def alist(self, config, **kwargs):
        return self._inner.alist(config, **kwargs)

    async def aput(self, config, checkpoint, metadata, new_versions):
        return await self._inner.aput(config, checkpoint, metadata, new_versions)

    async def aput_writes(self, config, writes, task_id, task_path=""):
        return await self._inner.aput_writes(config, writes, task_id, task_path)

    def get_next_version(self, current, channel):
        return self._inner.get_next_version(current, channel)


def _adapter_without_delete():
    agent = create_agent(model=FakeListChatModel(responses=["ok"]), tools=[], checkpointer=SaverWithoutDelete())
    return LangChainAdapter(agent)


def test_does_not_declare_history_support_when_the_checkpointer_cannot_delete_threads():
    assert _adapter_without_delete().get_config()["supports_history"] is False, (
        "the chat would offer editing for an agent whose memory the adapter cannot reset"
    )


@pytest.mark.asyncio
async def test_history_turns_still_answer_when_the_checkpointer_cannot_delete_threads(hooks):
    adapter = _adapter_without_delete()
    await adapter.stream("q1", hooks, StreamOptions(conversation_id="conv-1", user_id="user-1"))

    # The sidecar resends history on every send until the agent writes a reply.
    for prompt in ("q2 edited", "q3"):
        await adapter.stream(prompt, hooks, StreamOptions(conversation_id="conv-1", user_id="user-1", history=EDIT))

    assert hooks.on_error.call_args_list == [], "every history-bearing turn failed, so the conversation never recovers"


def test_declares_history_support_without_a_checkpointer():
    agent = create_agent(model=FakeListChatModel(responses=["ok"]), tools=[])
    assert LangChainAdapter(agent).get_config()["supports_history"] is True


def test_an_explicit_history_flag_wins_over_the_checkpointer():
    agent = create_agent(model=FakeListChatModel(responses=["ok"]), tools=[], checkpointer=SaverWithoutDelete())
    assert LangChainAdapter(agent, supports_history=True).get_config()["supports_history"] is True
    memory_agent, _ = _agent()
    assert LangChainAdapter(memory_agent, supports_history=False).get_config()["supports_history"] is False
