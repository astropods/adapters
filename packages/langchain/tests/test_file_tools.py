import pytest
from astropods_messaging import Attachment, Message, User

from astropods_adapter_core import ServeOptions
from astropods_adapter_core.bridge import MessagingBridge
from astropods_adapter_langchain import LangChainAdapter, file_tools


def test_exposes_the_four_file_tools():
    assert [t.name for t in file_tools()] == ["inspect_file", "read_file", "read_table", "create_file"]


# End to end through the real bridge, adapter, create_agent, and read_table tool; only the model is fake.
@pytest.mark.asyncio
async def test_a_later_message_in_a_thread_reads_the_threads_earlier_file(tmp_path, monkeypatch):
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage, ToolMessage

    monkeypatch.setenv("AGENT_FILES_DIR", str(tmp_path))
    path = str(tmp_path / "upload-1.blob")
    (tmp_path / "upload-1.blob").write_text("region,amount\nEast,100\nWest,200\n")
    tool_results: list[str] = []

    class ToolCallingFake(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, *args, **kwargs):
            if isinstance(messages[-1], ToolMessage):
                tool_results.append(str(messages[-1].content))
            return super()._generate(messages, *args, **kwargs)

    turn = [
        AIMessage(content="", tool_calls=[{"name": "read_table", "args": {"path": path}, "id": "c1"}]),
        AIMessage(content="done"),
    ]
    model = ToolCallingFake(messages=iter(turn * 3))
    bridge = MessagingBridge(LangChainAdapter(create_agent(model, tools=file_tools())), ServeOptions(server_address="test:9090"))
    upload = Attachment(type=Attachment.Type.FILE, filename="deals.csv", storage_key="upload-1")

    def message(conversation_id: str, attachments=()) -> Message:
        return Message(
            conversation_id=conversation_id, content="total it by region", platform="slack",
            user=User(id="U1"), attachments=list(attachments),
        )

    await bridge._handle_message(message("C1-1700000000.000100", [upload]))
    await bridge._handle_message(message("C1-1700000000.000100"))
    await bridge._handle_message(message("C2-1700000000.000200"))

    assert len(tool_results) == 3
    assert "East" in tool_results[0]
    assert "East" in tool_results[1]
    assert "created in this conversation" in tool_results[2]
