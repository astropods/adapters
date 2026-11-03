from typing import Any, Callable, Optional

from langchain_core.tools import BaseTool, StructuredTool, ToolException
from pydantic import BaseModel, Field


class _PathInput(BaseModel):
    path: str


class _PageInput(BaseModel):
    path: str
    offset: int = Field(0, ge=0)


class _TablePageInput(BaseModel):
    path: str
    sheet: Optional[str] = Field(None, description="XLSX sheet name; defaults to the first sheet")
    offset: int = Field(0, ge=0, description="Data row to start at; 0 is the first row after the header")
    limit: Optional[int] = Field(None, ge=1, le=500)


class _CreateFileInput(BaseModel):
    name: str = Field(description="File name with extension, no directories")
    content: str
    mime_type: Optional[str] = None


def _tool(name: str, description: str, schema: type[BaseModel], fn: Callable[..., Any]) -> BaseTool:
    # A ToolException goes back to the model as the tool's result; any other error would end the run.
    def run(**kwargs: Any) -> Any:
        try:
            return fn(**{k: v for k, v in kwargs.items() if v is not None})
        except Exception as err:
            raise ToolException(str(err)) from err

    return StructuredTool.from_function(
        func=run, name=name, description=description, args_schema=schema, handle_tool_error=True
    )


def file_tools() -> list[BaseTool]:
    """Tools that read the files a user attaches and return a file, for ``create_agent(tools=...)``."""
    try:
        from astropods_adapter_core import (
            FILE_TOOL_DESCRIPTIONS,
            create_file,
            inspect_file,
            read_file_page,
            read_table,
        )
    except ImportError as err:
        raise ImportError("file_tools() needs astropods-adapter-core 0.11.0 or later") from err
    return [
        _tool("inspect_file", FILE_TOOL_DESCRIPTIONS["inspect_file"], _PathInput, inspect_file),
        _tool("read_file", FILE_TOOL_DESCRIPTIONS["read_file"], _PageInput, read_file_page),
        _tool("read_table", FILE_TOOL_DESCRIPTIONS["read_table"], _TablePageInput, read_table),
        _tool("create_file", FILE_TOOL_DESCRIPTIONS["create_file"], _CreateFileInput, create_file),
    ]
